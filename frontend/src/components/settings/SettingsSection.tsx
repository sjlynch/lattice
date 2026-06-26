import type { ReactNode } from 'react';
import { SettingsInfo } from './SettingsInfo';

type SettingsSectionProps = {
  title: ReactNode;
  infoLabel?: string;
  info?: ReactNode;
  children: ReactNode;
};

// Shared presentational chrome for settings sections that use the standard
// title row + optional SettingsInfo popover. Keep this structural-only so each
// caller owns its controls and behavior.
export function SettingsSection({
  title,
  infoLabel,
  info,
  children,
}: SettingsSectionProps) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title-row">
            <div className="settings-section-title">{title}</div>
            {infoLabel && info ? (
              <SettingsInfo label={infoLabel}>{info}</SettingsInfo>
            ) : null}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

type CheckboxSettingsSectionProps = Omit<SettingsSectionProps, 'children'> & {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
};

export function CheckboxSettingsSection({
  checked,
  onChange,
  label,
  ...sectionProps
}: CheckboxSettingsSectionProps) {
  return (
    <SettingsSection {...sectionProps}>
      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
    </SettingsSection>
  );
}
