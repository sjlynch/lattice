import { useState } from 'react';
import { FloatingPanel } from './FloatingPanel';
import {
  type StartupTerminal,
  type TerminalLaunchSettings,
} from '../api';
import { TerminalSettingsSections } from './settings/TerminalSettingsSections';
import { StartupTerminalsTab } from './settings/StartupTerminalsTab';
import { EnvNotesTab } from './settings/EnvNotesTab';
import { MetricsIgnoredExtsTab } from './settings/MetricsIgnoredExtsTab';
import { AgentsTab } from './settings/AgentsTab';
import { PiTab } from './settings/PiTab';
import { McpTab } from './settings/McpTab';
import { ToolsTab } from './settings/ToolsTab';
import { InstructionTemplatesTab } from './settings/InstructionTemplatesTab';
import { HarnessSystemPromptsTab } from './settings/HarnessSystemPromptsTab';
import { useSettingsDrafts } from './settings/useSettingsDrafts';
import { useSettingsController } from './settings/useSettingsController';
import { SETTINGS_TABS, type Tab } from './settings/settingsTabs';

type Props = {
  open: boolean;
  onClose: () => void;
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  terminalLaunchSettings: TerminalLaunchSettings;
  onTerminalLaunchSettingsChange: (next: TerminalLaunchSettings) => void;
  metricsIgnoredExts: string[];
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
};

export function SettingsDialog({
  open,
  onClose,
  activeFolder,
  startupTerminals,
  onStartupTerminalsChange,
  terminalLaunchSettings,
  onTerminalLaunchSettingsChange,
  metricsIgnoredExts,
  onMetricsIgnoredExtsChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('terminals');
  const drafts = useSettingsDrafts(open, activeFolder, terminalLaunchSettings);
  const { refs, saving, error, dirtyByTab, bumpDirty, save, requestClose } =
    useSettingsController({
      open,
      activeFolder,
      drafts,
      startupTerminals,
      onClose,
      onStartupTerminalsChange,
      onTerminalLaunchSettingsChange,
      onMetricsIgnoredExtsChange,
    });

  return (
    <FloatingPanel
      open={open}
      onClose={requestClose}
      title="Settings"
      defaultSize={{ width: 640, height: 640 }}
      minSize={{ width: 440, height: 400 }}
      storageKey="lattice.settings.window"
    >
      <div className="settings-scope-note">
        Global settings apply to all projects on this machine; per-project
        settings affect only the active folder.
      </div>
      <div className="settings-body">
        <div className="settings-tabs">
          {SETTINGS_TABS.map(({ id, label, Icon, scope }) => (
            <button
              key={id}
              className={`settings-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
              title={
                scope === 'global'
                  ? 'Machine-global — applies to all projects'
                  : 'Per-project — applies to the active folder'
              }
            >
              <Icon size={12} />
              {label}
              {dirtyByTab[id] && (
                <span className="settings-tab-dirty" aria-label="Unsaved changes" />
              )}
            </button>
          ))}
        </div>
        <div
          className="settings-tab-body"
          onChange={bumpDirty}
          onClick={bumpDirty}
        >
          {tab === 'terminals' && <TerminalSettingsSections drafts={drafts} />}
          <StartupTerminalsTab
            ref={refs.startupTerminals}
            active={tab === 'terminals'}
            open={open}
            startupTerminals={startupTerminals}
          />
          <HarnessSystemPromptsTab
            ref={refs.harnessSystemPrompts}
            active={tab === 'prompts'}
            open={open}
            activeFolder={activeFolder}
          />
          <InstructionTemplatesTab
            ref={refs.instructionTemplates}
            active={tab === 'prompts'}
            open={open}
            activeFolder={activeFolder}
          />
          <EnvNotesTab
            ref={refs.envNotes}
            active={tab === 'prompts'}
            open={open}
            activeFolder={activeFolder}
          />
          <MetricsIgnoredExtsTab
            ref={refs.metricsIgnoredExts}
            active={tab === 'metrics'}
            open={open}
            metricsIgnoredExts={metricsIgnoredExts}
          />
          <AgentsTab ref={refs.agents} active={tab === 'agents'} open={open} />
          <PiTab ref={refs.pi} active={tab === 'pi'} open={open} />
          <McpTab
            ref={refs.mcp}
            active={tab === 'mcp'}
            open={open}
            activeFolder={activeFolder}
          />
          <ToolsTab
            ref={refs.tools}
            active={tab === 'tools'}
            open={open}
            activeFolder={activeFolder}
          />
        </div>
      </div>
      {error && <div className="error-msg" style={{ margin: '0 16px' }}>{error}</div>}
      <div className="modal-footer">
        <button className="btn-ghost" onClick={requestClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={save}
          disabled={saving}
          title={activeFolder ? undefined : 'No project open: only the machine-global tabs are saved'}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </FloatingPanel>
  );
}
