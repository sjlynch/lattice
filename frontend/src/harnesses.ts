export type AgentHarness = 'claude' | 'pi' | 'codex';
export type HarnessChoice = AgentHarness | 'interleave';

export type HarnessAvailability = Record<AgentHarness, boolean>;

export const ALL_AGENT_HARNESSES: readonly AgentHarness[] = [
  'claude',
  'pi',
  'codex',
] as const;

export const ALL_HARNESS_CHOICES: readonly HarnessChoice[] = [
  ...ALL_AGENT_HARNESSES,
  'interleave',
] as const;

export const HARNESS_LABELS: Record<HarnessChoice | 'default', string> = {
  default: 'Default',
  claude: 'Claude',
  pi: 'Pi',
  codex: 'Codex',
  interleave: 'Interleave',
};

export function isAgentHarness(value: unknown): value is AgentHarness {
  return value === 'claude' || value === 'pi' || value === 'codex';
}

export function normalizeAgentHarness(value: unknown): AgentHarness {
  return isAgentHarness(value) ? value : 'claude';
}

export function isHarnessChoice(value: unknown): value is HarnessChoice {
  return isAgentHarness(value) || value === 'interleave';
}

export function harnessLabel(value: HarnessChoice | 'default' | null | undefined): string {
  return HARNESS_LABELS[value ?? 'default'];
}

export function availableAgentHarnesses(
  harnessAvail: HarnessAvailability,
  selected?: AgentHarness | null,
): AgentHarness[] {
  const options: AgentHarness[] = ['claude'];
  if (harnessAvail.pi || selected === 'pi') options.push('pi');
  if (harnessAvail.codex || selected === 'codex') options.push('codex');
  return options;
}

export function availableHarnessChoices(
  harnessAvail: HarnessAvailability,
  selected?: HarnessChoice | null,
): HarnessChoice[] {
  const options: HarnessChoice[] = availableAgentHarnesses(
    harnessAvail,
    isAgentHarness(selected) ? selected : null,
  );
  if (harnessAvail.pi || selected === 'interleave') options.push('interleave');
  return options;
}
