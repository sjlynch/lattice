// PUSH_INSTRUCTIONS.md — the brief for the QA-lane Push button. Leaf module: a
// plain-markdown default with `{{token}}` placeholders. See ../defs.ts for the
// catalog entry (token docs) and ../CLAUDE.md for the subsystem overview.

export const DEFAULT_PUSH_TEMPLATE = `# Push to remote

Project: \`{{project_path}}\`

## Steps

1. \`cd "{{project_path}}"\`
2. Run \`git status\`. If there are uncommitted changes, stage and commit them
   with a concise message that describes the diff:
   \`\`\`
   git add -A
   git commit -m "<concise summary of the changes>"
   \`\`\`
   If the working tree is already clean, skip the commit step.

   **If the commit fails with an identity error** ("Author identity unknown" /
   "Please tell me who you are"), keep going — but
   **never fix it with \`git config\`**: \`--global\` rewrites the user's
   machine, \`--local\` rewrites this repo. Read the identity the repo already
   uses and pass it to the one command, which persists nothing:

   \`\`\`
   git log -1 --format="%an <%ae>"
   git -c user.name="<name>" -c user.email="<email>" commit -m "<message>"
   \`\`\`

   Mention in your report that you did this, so the user can set their
   identity properly if they want to.
3. Push to the remote: \`git push\`. If push fails because the upstream isn't
   set, run \`git push -u origin HEAD\` instead.
4. Report a one-line summary of what you committed (if anything) and the push
   result. Then stop — the Lattice harness closes this terminal automatically
   once you stop.
`;
