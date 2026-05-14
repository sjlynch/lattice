export function renderPushInstructions(projectPath: string): string {
  return `# Push to remote

Project: \`${projectPath}\`

## Steps

1. \`cd "${projectPath}"\`
2. Run \`git status\`. If there are uncommitted changes, stage and commit them
   with a concise message that describes the diff:
   \`\`\`
   git add -A
   git commit -m "<concise summary of the changes>"
   \`\`\`
   If the working tree is already clean, skip the commit step.
3. Push to the remote: \`git push\`. If push fails because the upstream isn't
   set, run \`git push -u origin HEAD\` instead.
4. Report a one-line summary of what you committed (if anything) and the push
   result. Then stop — the Lattice harness closes this terminal automatically
   once you stop.
`;
}
