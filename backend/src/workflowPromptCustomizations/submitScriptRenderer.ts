export function renderSubmitScript(callbackUrl: string): string {
  // Source-tagged so the customization /complete log line can identify
  // which mechanism fired (model-invoked submit vs Claude Stop hook backstop
  // vs Pi extension fetch). The latter two append their own ?source=.
  const sep = callbackUrl.includes('?') ? '&' : '?';
  const taggedUrl = `${callbackUrl}${sep}source=model-explicit-submit`;
  return `#!/usr/bin/env node
const fs = require('node:fs');

async function main() {
  const file = process.argv[2];
  const prompt = file
    ? fs.readFileSync(file, 'utf8')
    : fs.readFileSync(0, 'utf8');
  const response = await fetch(${JSON.stringify(taggedUrl)}, {
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
