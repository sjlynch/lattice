import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import {
  fetchGlobalSettings,
  fetchMcpCatalog,
  fetchMcpEnvPresence,
  fetchMcpSecrets,
  fetchUserSettings,
  patchGlobalSettings,
  type McpEnvPresence,
  type McpSecretHints,
  type McpServerEntry,
  type RedactedMcpSecrets,
  type UserSettings,
} from '../../api';
import { McpServerRow } from './mcp/McpServerRow';
import { McpImportSection } from './mcp/McpImportSection';
import { McpAddCustom } from './mcp/McpAddCustom';

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type McpTabHandle = {
  // Per-project MCP enables to persist on Save (undefined if untouched, so an
  // unrelated save doesn't rewrite the file). Secrets / imports / custom-server
  // defs persist immediately on their own and are NOT part of this patch.
  getMcpUserPatch: () => Partial<UserSettings> | undefined;
};

// Servers with a one-shot validator (v1: Brave only).
const TESTABLE = new Set(['brave-search']);

// Settings → MCP tab. The single control plane: a global catalog of servers
// toggled on/off per project, with the §8 key UX, config import, and custom
// servers. All servers ship OFF — nothing here is enabled until the user opts in.
export const McpTab = forwardRef<McpTabHandle, Props>(function McpTab(
  { active, open, activeFolder },
  ref,
) {
  const [catalog, setCatalog] = useState<McpServerEntry[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [qa, setQa] = useState<{ enabled: boolean; headless: boolean }>({
    enabled: false,
    headless: true,
  });
  const [redacted, setRedacted] = useState<RedactedMcpSecrets>({});
  const [hints, setHints] = useState<McpSecretHints>({});
  const [envPresence, setEnvPresence] = useState<McpEnvPresence>({});
  // Tracked separately so saving a non-Playwright toggle never rewrites
  // `qaPlaywright` (which the QA lane also writes, possibly while this dialog
  // is open) — and vice-versa.
  const [overridesTouched, setOverridesTouched] = useState(false);
  const [qaTouched, setQaTouched] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reloadCatalog = async () => {
    const { servers } = await fetchMcpCatalog();
    setCatalog(servers);
  };
  const reloadSecrets = async () => {
    const [s, e] = await Promise.all([fetchMcpSecrets(), fetchMcpEnvPresence()]);
    setRedacted(s.redacted);
    setHints(s.hints);
    setEnvPresence(e.presence);
  };

  // (Re)load everything each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setOverridesTouched(false);
    setQaTouched(false);
    (async () => {
      const [{ servers }, settings, secrets, env] = await Promise.all([
        fetchMcpCatalog(),
        activeFolder ? fetchUserSettings(activeFolder) : Promise.resolve({} as UserSettings),
        fetchMcpSecrets(),
        fetchMcpEnvPresence(),
      ]);
      if (cancelled) return;
      setCatalog(servers);
      setOverrides(settings.mcpOverrides ?? {});
      setQa({
        enabled: settings.qaPlaywright?.enabled ?? false,
        headless: settings.qaPlaywright?.headless ?? true,
      });
      setRedacted(secrets.redacted);
      setHints(secrets.hints);
      setEnvPresence(env.presence);
      setLoaded(true);
    })().catch(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeFolder]);

  useImperativeHandle(
    ref,
    () => ({
      getMcpUserPatch: () => {
        if (!overridesTouched && !qaTouched) return undefined;
        return {
          ...(overridesTouched ? { mcpOverrides: overrides } : {}),
          ...(qaTouched ? { qaPlaywright: qa } : {}),
        };
      },
    }),
    [overridesTouched, qaTouched, overrides, qa],
  );

  const isEnabled = (s: McpServerEntry): boolean =>
    s.id === 'playwright' ? qa.enabled : !!overrides[s.id];

  const toggle = (s: McpServerEntry, next: boolean) => {
    if (s.id === 'playwright') {
      setQaTouched(true);
      setQa((prev) => ({ ...prev, enabled: next }));
    } else {
      setOverridesTouched(true);
      setOverrides((prev) => ({ ...prev, [s.id]: next }));
    }
  };

  const existingIds = new Set(catalog.map((s) => s.id));

  const addCustom = async (entry: McpServerEntry) => {
    const global = await fetchGlobalSettings();
    const customs = (global.mcpCustomServers ?? []).filter((c) => c.id !== entry.id);
    await patchGlobalSettings({ mcpCustomServers: [...customs, entry] });
    await reloadCatalog();
  };

  const removeCustom = async (id: string) => {
    const global = await fetchGlobalSettings();
    const customs = (global.mcpCustomServers ?? []).filter((c) => c.id !== id);
    await patchGlobalSettings({ mcpCustomServers: customs });
    await reloadCatalog();
  };

  if (!active) return null;

  return (
    <div className="settings-section mcp-tab">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">MCP servers</div>
          <div className="settings-section-sub">
            Curate MCP servers once here; Lattice injects the enabled ones into
            every Claude session it spawns for <strong>{folderName(activeFolder)}</strong>.
            Keys are stored once and used across all projects; each toggle is{' '}
            <em>per-project</em>. Everything starts off — nothing loads until you
            turn it on. (Codex injection is v2; Pi support arrives via a plugin.)
          </div>
        </div>
      </div>

      {!loaded && <div className="settings-section-sub">Loading…</div>}

      {loaded && (
        <>
          <div className="mcp-list">
            {catalog.map((s) => (
              <McpServerRow
                key={s.id}
                server={s}
                enabled={isEnabled(s)}
                onToggle={(next) => toggle(s, next)}
                playwrightHint={s.id === 'playwright'}
                stored={hasSecret(redacted, s)}
                hint={secretHint(hints, s)}
                envPresent={hasEnv(envPresence, s)}
                onSecretChanged={reloadSecrets}
                testable={TESTABLE.has(s.id)}
                onRemove={s.builtin ? undefined : () => void removeCustom(s.id)}
              />
            ))}
          </div>

          <McpAddCustom existingIds={existingIds} onAdd={addCustom} />
          <McpImportSection activeFolder={activeFolder} onImported={reloadCatalog} />
        </>
      )}
    </div>
  );
});

function folderName(folder: string): string {
  if (!folder) return 'this project';
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || folder;
}

// A server's declared secret env var (the built-in key). Custom servers may
// have several; the row's chip reflects the first/required one.
function primaryEnvVar(s: McpServerEntry): string | undefined {
  return s.requiresSecret?.envVar ?? s.secretEnvVars?.[0];
}

function hasSecret(redacted: RedactedMcpSecrets, s: McpServerEntry): boolean {
  const v = primaryEnvVar(s);
  return !!v && redacted[s.id]?.[v] === true;
}
function secretHint(hints: McpSecretHints, s: McpServerEntry): string | undefined {
  const v = primaryEnvVar(s);
  return v ? hints[s.id]?.[v] : undefined;
}
function hasEnv(presence: McpEnvPresence, s: McpServerEntry): boolean {
  const v = primaryEnvVar(s);
  return !!v && presence[s.id]?.[v] === true;
}
