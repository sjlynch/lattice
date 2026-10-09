// Pi's graph-activity reporter — the Pi analogue of the Claude
// (`claudeStopHook.ts` `renderClaudeHooksConfig`) and Codex (`codexStopHook.ts`)
// activity hooks. Pi has no command hooks but auto-loads
// `<cwd>/.pi/extensions/*.ts` (cwd-exact; trusted because Lattice spawns Pi with
// `--approve`) and emits `tool_execution_start` / `_end` with the tool's args.
// Modes, shared globals and the byte-exact output rule: piActivity/CLAUDE.md.
//
// The generated `lattice-activity.ts` posts the SAME Claude-shaped hook body the
// activity routes already decode (`hook_event_name`, `tool_name`, `tool_input`,
// `cwd`), so nothing server-side is Pi-specific: read/edit/write →
// `tool_input.file_path`; bash → `tool_input.command` (paths guessed + confirmed
// by the route, as for Codex — hookFiles.ts). The less obvious parts:
//   - "No session file" identifies a `@tintinweb/pi-subagents` subagent, because
//     Lattice's own Pi sessions are always persisted (pinned `--session-id`); it
//     posts as `agent_id: pi-<sessionId>` (beams on a satellite; a missed stop is
//     reaped by the graph's idle TTL).
//   - POSTs are fire-and-forget but SERIALIZED: a PostToolUse landing after its
//     Stop cancels the post-Stop removal (projectClaude/lifecycle.ts).
//   - The queue and the parent's session id live on `globalThis`: Pi loads
//     extensions with `moduleCache: false`, so a subagent re-evaluates this module.
//   - Project mode (`projectSession`, a sidebar `pi` at the project root — cf.
//     projectClaudeHooks.ts) posts to `/api/project-activity/:token`, keyed by
//     the top-level `session_id` every body carries.

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
