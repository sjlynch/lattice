import { forwardRef, useImperativeHandle } from 'react';
import { type OpengrepProjectSettings } from '../../api';
import { useConfirm } from '../shared/ConfirmDialog';
import { settingsFromDraft } from './tools/toolsTabUtils';
import { useOpengrepToolsState } from './tools/useOpengrepToolsState';
import { OpengrepEngineSection } from './tools/OpengrepEngineSection';
import { OpengrepPacksSection } from './tools/OpengrepPacksSection';
import { OpengrepScanFilterSection } from './tools/OpengrepScanFilterSection';
import { OpengrepScanNowSection } from './tools/OpengrepScanNowSection';

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type ToolsTabHandle = {
  // Per-project Opengrep settings to persist on Save, or `undefined` when
  // untouched / not yet loaded (the clobber-guard every tab uses).
  getOpengrepProjectPatch: () => OpengrepProjectSettings | undefined;
  // Machine-global pack enables, same contract.
  getOpengrepGlobalPatch: () => { packs: Record<string, boolean> } | undefined;
};

// Settings → Tools: the Opengrep (SAST) engine + rule packs (machine-global,
// applied immediately from the buttons here) and this project's scan filter
// (persisted on Save with the rest of the dialog). Future pre-run tools
// (`npm audit`, `tsc`, test runners) join this tab. State + effects live in
// `tools/useOpengrepToolsState.ts`, each section in its own `tools/` component.
export const ToolsTab = forwardRef<ToolsTabHandle, Props>(function ToolsTab(
  { active, open, activeFolder },
  ref,
) {
  const tools = useOpengrepToolsState(open, activeFolder);
  const { draft, packDraft, packLoaded, packTouched, projectLoaded, projectTouched } = tools;

  const { confirm } = useConfirm();

  useImperativeHandle(
    ref,
    () => ({
      getOpengrepProjectPatch: () =>
        projectLoaded && projectTouched ? settingsFromDraft(draft) : undefined,
      getOpengrepGlobalPatch: () =>
        packLoaded && packTouched ? { packs: { ...packDraft } } : undefined,
    }),
    [draft, packDraft, packLoaded, packTouched, projectLoaded, projectTouched],
  );

  if (!active) return null;

  return (
    <>
      <OpengrepEngineSection
        status={tools.status}
        statusError={tools.statusError}
        actionError={tools.actionError}
        runAction={tools.runAction}
      />
      <OpengrepPacksSection
        status={tools.status}
        packDraft={packDraft}
        packLoaded={packLoaded}
        packLoadError={tools.packLoadError}
        setPackEnabled={tools.setPackEnabled}
        runAction={tools.runAction}
        confirm={confirm}
      />
      <OpengrepScanFilterSection
        activeFolder={activeFolder}
        draft={draft}
        projectLoaded={projectLoaded}
        projectLoadError={tools.projectLoadError}
        patchDraft={tools.patchDraft}
      />
      <OpengrepScanNowSection
        activeFolder={activeFolder}
        status={tools.status}
        scanning={tools.scanning}
        scanResult={tools.scanResult}
        scanError={tools.scanError}
        onScan={tools.onScan}
      />
    </>
  );
});
