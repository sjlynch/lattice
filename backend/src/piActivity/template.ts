// Pi's graph-activity reporter — the Pi analogue of the Claude activity hooks
// (claudeStopHook.ts `renderClaudeHooksConfig`) and the Codex ones
// (codexStopHook.ts). Pi has no settings-driven command hooks, but it auto-loads
// any `<cwd>/.pi/extensions/*.ts` (cwd-exact; Lattice spawns Pi with
// `--approve`, so the project-local extension is trusted), and its extension API
// emits `tool_execution_start` / `tool_execution_end` with the tool's arguments.
//
// The generated `.pi/extensions/lattice-activity.ts` turns those into the SAME
// Claude-shaped hook body the activity routes already decode
// (`hook_event_name` PreToolUse/PostToolUse, `tool_name`, `tool_input`,
// `cwd`), so nothing server-side is Pi-specific:
//   - read / edit / write → `tool_input.file_path` = the tool's `path`
//   - bash                → `tool_input.command` (paths guessed + confirmed by
//                           the route, as for Codex — see hookFiles.ts)
//
// Subagents: `@tintinweb/pi-subagents` runs each subagent as its own in-process
// Pi session that loads the same cwd extensions, on an IN-MEMORY session
// manager (no session file). Lattice's own Pi sessions are always persisted
// (pinned `--session-id`), so "no session file" identifies a subagent: the
// extension then tags its events `agent_id: pi-<sessionId>` — the Claude
// convention for a subagent's tool use — so its beams hang off a satellite, and
// posts SubagentStart / SubagentStop on that session's start / shutdown. (A
// missed stop is reaped by the graph's idle TTL.)
//
// Every POST is fire-and-forget with a short timeout: a handler never delays a
// tool call, and a backend that is down or restarting just loses a beam. The
// POSTs are SERIALIZED, though (each waits for the previous one to settle), so
// they reach the route in event order the way Claude's and Codex's hook
// commands do: concurrent requests could land a turn's last PostToolUse after
// its Stop, and any non-Stop event cancels the post-Stop removal
// (projectClaude/lifecycle.ts), leaving the node up until the idle TTL. The
// queue lives on `globalThis` so a pi-subagents subagent's re-evaluated module
// (which posts under the parent's session_id) shares it.
//
// Project mode (`projectSession`): the same extension at the PROJECT ROOT, for
// a `pi` the user runs in a sidebar tab — the Pi analogue of the project's
// `.claude/settings.local.json` hooks (projectClaudeHooks.ts). It posts to
// `/api/project-activity/:token`, which keys the node by the body's
// `session_id`, so every body carries the top-level session's id. The node
// follows turns (projectClaude/lifecycle.ts): a turn's start / tool use creates
// it and its Stop (`agent_settled`) takes it down shortly after, while the
// session's start/shutdown post SessionStart/SessionEnd.
// Pi loads extensions with `moduleCache: false`, so a pi-subagents subagent
// re-evaluates this module: the parent's id is handed over on `globalThis`
// (same process) rather than a module variable.

export function renderPiActivityExtension(
  activityUrl: string,
  opts: { projectSession?: boolean } = {},
): string {
  return `// Lattice-managed — do not commit. Reports which files this Pi session (and
// any pi-subagents subagent it spawns) reads or edits to Lattice, which draws
// the agent's node, focus beams and file labels on its graph. Fire-and-forget:
// a handler never delays a tool call. Posts are sent one at a time, in order.

const ACTIVITY_URL = ${JSON.stringify(activityUrl)};
// Project mode, for a pi the user runs at the project root: bodies carry the top-level
// session's id, and its start/shutdown post SessionStart/SessionEnd.
const PROJECT_SESSION = ${opts.projectSession === true};
const MAIN_SESSION_KEY = "__latticePiProjectSessionId";
const POST_TIMEOUT_MS = 1500;
// The in-order post queue, shared by every instance of this module in the
// process (a pi-subagents subagent re-evaluates it). Bounded so a hung backend
// can't grow it without limit: past the cap a post is dropped.
const POST_QUEUE_KEY = "__latticePiActivityPostQueue";
const MAX_PENDING_POSTS = 64;
// Pi tool name -> the Claude tool name the activity route understands.
const TOOLS = { read: "Read", edit: "Edit", write: "Write", bash: "Bash" };

function send(body) {
  // The timeout starts when the request does, not when it was queued.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), POST_TIMEOUT_MS);
  return fetch(ACTIVITY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).finally(() => clearTimeout(timer));
}

// Queue a POST behind the previous one, so events arrive in the order they
// fired (a late PostToolUse must not land after the turn's Stop).
function post(body) {
  try {
    const q = globalThis[POST_QUEUE_KEY] || (globalThis[POST_QUEUE_KEY] = { tail: Promise.resolve(), pending: 0 });
    if (q.pending >= MAX_PENDING_POSTS) return;
    q.pending++;
    q.tail = q.tail
      .then(() => send(body))
      .catch(() => {})
      .finally(() => {
        q.pending--;
      });
  } catch {
    // Reporting must never throw into Pi.
  }
}

// A pi-subagents subagent runs on an in-memory session (no session file); report
// it as a subagent of this session so the graph draws it as a satellite.
function subagentFields(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    if (!sm || typeof sm.getSessionFile !== "function") return {};
    if (sm.getSessionFile()) return {};
    const id = typeof sm.getSessionId === "function" ? sm.getSessionId() : undefined;
    return id ? { agent_id: "pi-" + id, agent_type: "subagent" } : {};
  } catch {
    return {};
  }
}

function ownSessionId(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    return sm && typeof sm.getSessionId === "function" ? sm.getSessionId() : undefined;
  } catch {
    return undefined;
  }
}

// Project mode: the session the graph node belongs to — this one, or for a
// subagent the top-level session that spawned it.
function sessionFields(ctx) {
  if (!PROJECT_SESSION) return {};
  const id = subagentFields(ctx).agent_id ? globalThis[MAIN_SESSION_KEY] : ownSessionId(ctx);
  return id ? { session_id: id } : {};
}

function cwdOf(ctx) {
  return (ctx && typeof ctx.cwd === "string" && ctx.cwd) || process.cwd();
}

function toolInput(tool, args) {
  const a = args && typeof args === "object" ? args : {};
  if (tool === "Bash") {
    return typeof a.command === "string" && a.command ? { command: a.command } : null;
  }
  const p = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
  const file = p.replace(/^@/, "");
  return file ? { file_path: file } : null;
}

function report(phase, toolName, args, ctx) {
  const tool = TOOLS[toolName];
  if (!tool) return;
  const input = toolInput(tool, args);
  if (!input) return;
  post({
    hook_event_name: phase,
    tool_name: tool,
    tool_input: input,
    cwd: cwdOf(ctx),
    ...sessionFields(ctx),
    ...subagentFields(ctx),
  });
}

export default function (pi) {
  // tool_execution_end carries no args — remember them by call id.
  const argsByCall = new Map();

  pi.on("tool_execution_start", (event, ctx) => {
    if (!event) return;
    argsByCall.set(event.toolCallId, event.args);
    report("PreToolUse", event.toolName, event.args, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!event) return;
    const args = argsByCall.get(event.toolCallId);
    argsByCall.delete(event.toolCallId);
    report("PostToolUse", event.toolName, args, ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    const sub = subagentFields(ctx);
    if (sub.agent_id) {
      post({ hook_event_name: "SubagentStart", cwd: cwdOf(ctx), ...sessionFields(ctx), ...sub });
    } else if (PROJECT_SESSION) {
      const id = ownSessionId(ctx);
      if (!id) return;
      globalThis[MAIN_SESSION_KEY] = id;
      post({ hook_event_name: "SessionStart", session_id: id, cwd: cwdOf(ctx) });
    }
  });

  // Project mode: a turn's start/end, so the node shows only while the agent
  // works (the route maps these like Claude's UserPromptSubmit / Stop).
  // agent_settled, not agent_end: it waits out retries, compaction and queued
  // follow-ups. Top-level session only — a subagent's own run is a satellite.
  if (PROJECT_SESSION) {
    const turn = (phase) => (_event, ctx) => {
      if (subagentFields(ctx).agent_id) return;
      const id = ownSessionId(ctx);
      if (id) post({ hook_event_name: phase, session_id: id, cwd: cwdOf(ctx) });
    };
    pi.on("agent_start", turn("UserPromptSubmit"));
    pi.on("agent_settled", turn("Stop"));
  }

  pi.on("session_shutdown", (event, ctx) => {
    argsByCall.clear();
    const sub = subagentFields(ctx);
    if (sub.agent_id) {
      post({ hook_event_name: "SubagentStop", cwd: cwdOf(ctx), ...sessionFields(ctx), ...sub });
    } else if (PROJECT_SESSION && !(event && event.reason === "reload")) {
      // A /reload keeps the same session id; its SessionEnd would make the
      // route drop the SessionStart that follows (the recently-ended guard).
      const id = ownSessionId(ctx);
      if (id) post({ hook_event_name: "SessionEnd", session_id: id, cwd: cwdOf(ctx) });
    }
  });
}
`;
}
