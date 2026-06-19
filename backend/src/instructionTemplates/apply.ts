// The one substitution engine shared by every instruction-template renderer.
//
// Templates are plain markdown with `{{token}}` placeholders for the dynamic
// (non-generic) parts — task title, IDs, callback URLs, computed blocks, etc.
// `applyTemplate` does a single pass over the TEMPLATE only: each `{{token}}`
// is replaced by its value from `values`. Replacement text is never re-scanned,
// so a value that itself contains `{{…}}` (e.g. a workflow step prompt with an
// unresolved variable) is left intact. An unknown token is left verbatim so a
// typo in a user-edited template stays visible instead of silently vanishing.

export const TEMPLATE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function applyTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(TEMPLATE_TOKEN_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}
