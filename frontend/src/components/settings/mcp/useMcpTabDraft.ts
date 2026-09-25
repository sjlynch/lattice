import { useCallback, useEffect, useState } from 'react';
import {
  fetchMcpCatalog,
  fetchMcpEnvPresence,
  fetchMcpSecrets,
  fetchUserSettingsStrict,
  type McpEnvPresence,
  type McpSecretHints,
  type McpServerEntry,
  type RedactedMcpSecrets,
  type UserSettings,
} from '../../../api';
import type { AgentHarness } from '../../../harnesses';

// The catalog id of the Playwright server — the only row with a "Show browser"
// (headed) switch.
export const PLAYWRIGHT_SERVER_ID = 'playwright';

// Codex/Pi per-harness toggle map. Claude keeps the legacy `mcpOverrides`.
type HarnessOverrides = NonNullable<UserSettings['mcpHarnessOverrides']>;

// The MCP tab's loaded catalog/secret state plus its per-project draft (the
// enable maps, the Playwright headed switch, the lattice-only checkbox), each
// draft value paired with a touched flag so `getPatch()` only carries what the
// user actually changed. (Re)loads everything each time `open` turns true.
export function useMcpTabDraft(open: boolean, activeFolder: string) {
  const [catalog, setCatalog] = useState<McpServerEntry[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [harnessOverrides, setHarnessOverrides] = useState<HarnessOverrides>({});
  // MCP-tab Playwright headed/headless (default headless). Cross-harness — one
  // switch for the whole Playwright row, mirroring the QA lane's eye toggle.
  const [playwrightHeaded, setPlaywrightHeadedValue] = useState(false);
  const [headedTouched, setHeadedTouched] = useState(false);
  const [redacted, setRedacted] = useState<RedactedMcpSecrets>({});
  const [hints, setHints] = useState<McpSecretHints>({});
  const [envPresence, setEnvPresence] = useState<McpEnvPresence>({});
  // Only patch each map when the user actually flipped one of its toggles, so
  // an unrelated save doesn't rewrite the file. `overridesTouched` guards the
  // Claude map (`mcpOverrides`, incl. the GLOBAL Playwright toggle);
  // `harnessTouched` guards the Codex/Pi map (`mcpHarnessOverrides`). The QA
  // lane's separate QA-only `qaPlaywright` toggle lives elsewhere and is never
  // touched from this tab.
  const [overridesTouched, setOverridesTouched] = useState(false);
  const [harnessTouched, setHarnessTouched] = useState(false);
  // `taskAgentsLatticeMcpOnly` (default ON — absent reads as true): task
  // worktree sessions get only the Lattice server. Its own touched flag, like
  // the maps above, so an unrelated save never writes it.
  const [latticeOnly, setLatticeOnlyValue] = useState(true);
  const [latticeOnlyTouched, setLatticeOnlyTouched] = useState(false);
  // `loaded` flips only on a SUCCESSFUL load (same clobber-guard as Tools):
  // the enable patches are whole maps, so a lenient "settings → {}" load
  // followed by one toggle + Save would rewrite `mcpOverrides` as a one-key
  // map and silently turn every other server off. A failed load shows
  // `error` and leaves the toggles unmounted, so no patch can be produced.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    setOverridesTouched(false);
    setHarnessTouched(false);
    setHeadedTouched(false);
    setLatticeOnlyTouched(false);
    (async () => {
      const [{ servers }, settings, secrets, env] = await Promise.all([
        fetchMcpCatalog(),
        activeFolder
          ? fetchUserSettingsStrict(activeFolder)
          : Promise.resolve({} as UserSettings),
        fetchMcpSecrets(),
        fetchMcpEnvPresence(),
      ]);
      if (cancelled) return;
      setCatalog(servers);
      setOverrides(settings.mcpOverrides ?? {});
      setHarnessOverrides(settings.mcpHarnessOverrides ?? {});
      setPlaywrightHeadedValue(settings.mcpPlaywrightHeaded === true);
      setLatticeOnlyValue(settings.taskAgentsLatticeMcpOnly !== false);
      setRedacted(secrets.redacted);
      setHints(secrets.hints);
      setEnvPresence(env.presence);
      setLoaded(true);
    })().catch((err) => {
      // Keep `loaded` false: no toggles, no patch, nothing to clobber.
      if (!cancelled) setError(`Could not load MCP settings: ${(err as Error).message}`);
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeFolder]);

  // Per-project MCP enables to persist on Save (undefined if untouched).
  const getPatch = useCallback((): Partial<UserSettings> | undefined => {
    const patch: Partial<UserSettings> = {};
    if (overridesTouched) patch.mcpOverrides = overrides;
    if (harnessTouched) patch.mcpHarnessOverrides = harnessOverrides;
    if (headedTouched) patch.mcpPlaywrightHeaded = playwrightHeaded;
    if (latticeOnlyTouched) patch.taskAgentsLatticeMcpOnly = latticeOnly;
    return Object.keys(patch).length > 0 ? patch : undefined;
  }, [
    overridesTouched,
    overrides,
    harnessTouched,
    harnessOverrides,
    headedTouched,
    playwrightHeaded,
    latticeOnlyTouched,
    latticeOnly,
  ]);

  // Per-harness enable state: Claude reads the legacy `mcpOverrides` map;
  // Codex/Pi read the nested `mcpHarnessOverrides` map. Default OFF everywhere.
  // An explicit override wins; with none, the entry's own default applies.
  // That is off for every third-party server and ON for Lattice's own
  // first-party board server (`defaultEnabled`) — so its switches must read
  // as on until the user actually turns them off. Mirrors the backend's
  // `harnessToggleOn` (mcp/registry.ts).
  const isEnabledFor = (s: McpServerEntry, harness: AgentHarness): boolean =>
    harness === 'claude'
      ? (overrides[s.id] ?? !!s.defaultEnabled)
      : (harnessOverrides[harness]?.[s.id] ?? !!s.defaultEnabled);

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

  const setPlaywrightHeaded = (next: boolean) => {
    setHeadedTouched(true);
    setPlaywrightHeadedValue(next);
  };

  const setLatticeOnly = (next: boolean) => {
    setLatticeOnlyTouched(true);
    setLatticeOnlyValue(next);
  };

  return {
    catalog,
    playwrightHeaded,
    latticeOnly,
    redacted,
    hints,
    envPresence,
    loaded,
    error,
    setError,
    reloadCatalog,
    reloadSecrets,
    isEnabledFor,
    toggle,
    setPlaywrightHeaded,
    setLatticeOnly,
    getPatch,
  };
}
