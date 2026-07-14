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
import type { AgentHarness } from '../../harnesses';
import { useHarnessAvailability } from '../../hooks/useHarnessAvailability';
import { McpServerRow } from './mcp/McpServerRow';
import { McpImportSection } from './mcp/McpImportSection';
import { McpAddCustom } from './mcp/McpAddCustom';

// Codex/Pi per-harness toggle map. Claude keeps the legacy `mcpOverrides`.
type HarnessOverrides = NonNullable<UserSettings['mcpHarnessOverrides']>;

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type McpTabHandle = {
  // Per-project MCP enables to persist on Save (undefined if untouched, so an
  // unrelated save doesn't rewrite the file). Carries `mcpOverrides` (Claude)
  // and/or `mcpHarnessOverrides` (Codex/Pi), each only when its own toggles were
  // touched. Secrets / imports / custom-server defs persist immediately on their
  // own and are NOT part of this patch.
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
  const [harnessOverrides, setHarnessOverrides] = useState<HarnessOverrides>({});
  // MCP-tab Playwright headed/headless (default headless). Cross-harness — one
  // switch for the whole Playwright row, mirroring the QA lane's eye toggle.
  const [playwrightHeaded, setPlaywrightHeaded] = useState(false);
  const [headedTouched, setHeadedTouched] = useState(false);
  const [redacted, setRedacted] = useState<RedactedMcpSecrets>({});
  const [hints, setHints] = useState<McpSecretHints>({});
  const [envPresence, setEnvPresence] = useState<McpEnvPresence>({});
  const { harnessAvail } = useHarnessAvailability();
  // Only patch each map when the user actually flipped one of its toggles, so
  // an unrelated save doesn't rewrite the file. `overridesTouched` guards the
  // Claude map (`mcpOverrides`, incl. the GLOBAL Playwright toggle);
  // `harnessTouched` guards the Codex/Pi map (`mcpHarnessOverrides`). The QA
  // lane's separate QA-only `qaPlaywright` toggle lives elsewhere and is never
  // touched from this tab.
  const [overridesTouched, setOverridesTouched] = useState(false);
  const [harnessTouched, setHarnessTouched] = useState(false);
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
    setHarnessTouched(false);
    setHeadedTouched(false);
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
      setHarnessOverrides(settings.mcpHarnessOverrides ?? {});
      setPlaywrightHeaded(settings.mcpPlaywrightHeaded === true);
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
        const patch: Partial<UserSettings> = {};
        if (overridesTouched) patch.mcpOverrides = overrides;
        if (harnessTouched) patch.mcpHarnessOverrides = harnessOverrides;
        if (headedTouched) patch.mcpPlaywrightHeaded = playwrightHeaded;
        return Object.keys(patch).length > 0 ? patch : undefined;
      },
    }),
    [
      overridesTouched,
      overrides,
      harnessTouched,
      harnessOverrides,
      headedTouched,
      playwrightHeaded,
    ],
  );

  // Per-harness enable state: Claude reads the legacy `mcpOverrides` map;
  // Codex/Pi read the nested `mcpHarnessOverrides` map. Default OFF everywhere.
  const isEnabledFor = (s: McpServerEntry, harness: AgentHarness): boolean =>
    harness === 'claude'
      ? !!overrides[s.id]
      : !!harnessOverrides[harness]?.[s.id];

  const toggle = (s: McpServerEntry, harness: AgentHarness, next: boolean) => {
    if (harness === 'claude') {
      setOverridesTouched(true);
      setOverrides((prev) => ({ ...prev, [s.id]: next }));
      return;
    }
    setHarnessTouched(true);
    setHarnessOverrides((prev) => ({
      ...prev,
      [harness]: { ...(prev[harness] ?? {}), [s.id]: next },
    }));
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
            the <strong>Claude, Codex, and Pi</strong> sessions it launches for{' '}
            <strong>{folderName(activeFolder)}</strong> — plus a <code>claude</code>{' '}
            you start yourself at the project root. Each server has an independent
            switch per harness, so enabling it for one never loads it into
            another. Keys are stored once and shared across harnesses; every
            toggle is <em>per-project</em> and applies to <em>new</em>{' '}
            Lattice-launched sessions. Everything starts off — nothing loads until
            you turn it on.
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
                enabledFor={(h) => isEnabledFor(s, h)}
                onToggle={(h, next) => toggle(s, h, next)}
                harnessAvail={harnessAvail}
                playwrightHint={s.id === 'playwright'}
                headed={s.id === 'playwright' ? playwrightHeaded : undefined}
                onHeadedChange={
                  s.id === 'playwright'
                    ? (next) => {
                        setHeadedTouched(true);
                        setPlaywrightHeaded(next);
                      }
                    : undefined
                }
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
