// Python relative-import translation. Python relative imports surface as e.g.
// `.foo` or `..foo.bar` (leading dots indicate parent packages; remaining text
// is the dotted sub-package). Translate them into ordinary fs-relative specs so
// the rest of the resolver treats them like any other relative path.

export function normalizePythonRelativeImport(spec: string): string {
  let dots = 0;
  while (dots < spec.length && spec[dots] === '.') dots++;
  if (dots === 0) return spec;

  const rest = spec.slice(dots).replace(/\./g, '/');
  // 1 dot → './rest' (current package); 2 → '../rest'; 3 → '../../rest'.
  const parents = '../'.repeat(Math.max(0, dots - 1));
  const combined = `${parents}${rest}`;
  if (!combined) return '.';
  return combined.startsWith('.') ? combined : `./${combined}`;
}
