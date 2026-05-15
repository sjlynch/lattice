export function renderSubmitScript(callbackUrl: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');

async function main() {
  const file = process.argv[2];
  const prompt = file
    ? fs.readFileSync(file, 'utf8')
    : fs.readFileSync(0, 'utf8');
  const response = await fetch(${JSON.stringify(callbackUrl)}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('submit failed: ' + response.status + ' ' + text);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;
}
