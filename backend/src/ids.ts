export function generateTaskId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
