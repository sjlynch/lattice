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
];

for (const { from, to } of assets) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}
