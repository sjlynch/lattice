import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

const assets = [
  {
    from: path.join(backendRoot, 'src', 'workflowRuns', 'create-task-template.cjs'),
    to: path.join(backendRoot, 'dist', 'workflowRuns', 'create-task-template.cjs'),
  },
  {
    from: path.join(backendRoot, 'src', 'latticeApiDocs', 'LATTICE_API.template.md'),
    to: path.join(backendRoot, 'dist', 'latticeApiDocs', 'LATTICE_API.template.md'),
  },
  {
    from: path.join(backendRoot, 'src', 'latticeApiDocs', 'LATTICE_API_RECIPES.template.md'),
    to: path.join(backendRoot, 'dist', 'latticeApiDocs', 'LATTICE_API_RECIPES.template.md'),
  },
];

// Idempotent: skip the copy when the destination already matches the
// source byte-for-byte. fs.copyFile unconditionally updates mtime, which
// the dev runner's fs.watch('dist') picks up as a change — that would
// restart the backend, which calls copy-assets again, infinite loop.
// Compare contents to break the cycle.
async function readIfExists(p) {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

for (const { from, to } of assets) {
  const [src, dst] = await Promise.all([fs.readFile(from), readIfExists(to)]);
  if (dst && dst.equals(src)) continue;
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, src);
}
