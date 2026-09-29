// Codex's hosted code runner records an `exec` custom-tool call in its
// rollout. Its nested shell/patch calls can bypass the CLI's activity hooks.
// Read only literal arguments to those tools; never execute the agent's JS or
// guess paths from unrelated strings in the script.
import ts from 'typescript';

export type CodexCodeTool = { tool_name: string; tool_input: Record<string, unknown> };
const MAX_CODE_LENGTH = 256 * 1024;
const MAX_TOOLS = 64;

export function codexCodeTools(code: string): CodexCodeTool[] {
  if (code.length > MAX_CODE_LENGTH) return [];
  const source = ts.createSourceFile('activity.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: CodexCodeTool[] = [];

  const literal = (node: ts.Expression): unknown => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return literal(node.expression);
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map((e) => literal(e));
      return values.every((v) => v !== undefined) ? values : undefined;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const value: Record<string, unknown> = Object.create(null);
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) return undefined;
        const name = prop.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return undefined;
        const v = literal(prop.initializer);
        // Unrelated dynamic options (timeouts, etc.) do not obscure a literal
        // cmd/workdir, but an unknown workdir makes relative paths unsafe.
        if (v === undefined && name.text === 'workdir') return undefined;
        value[name.text] = v;
      }
      return { ...value };
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (out.length >= MAX_TOOLS) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const member = node.expression;
      if (ts.isIdentifier(member.expression) && member.expression.text === 'tools' && node.arguments[0]) {
        const input = literal(node.arguments[0]);
        if (member.name.text === 'exec_command' && input && typeof input === 'object' && !Array.isArray(input)) {
          out.push({ tool_name: 'exec_command', tool_input: input as Record<string, unknown> });
        } else if (member.name.text === 'apply_patch' && typeof input === 'string') {
          out.push({ tool_name: 'apply_patch', tool_input: { command: input } });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// Only the code-runner call itself needs this fallback. Native tool calls keep
// using their hooks, so ordinary Codex sessions do not report each read twice.
export function codexRolloutCodeCall(row: unknown): { id: string; tools: CodexCodeTool[] } | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.type !== 'response_item' || !r.payload || typeof r.payload !== 'object') return null;
  const p = r.payload as Record<string, unknown>;
  if (p.type !== 'custom_tool_call' || p.name !== 'exec' || typeof p.input !== 'string'
    || typeof p.call_id !== 'string') return null;
  return { id: p.call_id, tools: codexCodeTools(p.input) };
}
