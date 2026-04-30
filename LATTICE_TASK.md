# lines of code view

modify the code so that if the user presses the 'z' key, we show a text label above each node that shows the lines of code for that filoe. also color code the nodes and text red yellow green depending on total lines of code, i.e. >1000 would be red, >600 is yellow and the rest would be green. also make it so the text is drawn far above the node with a connecting color coded line that reaches from the node to the LOC text. also add a label to the middle top of the screen that says "View: Lines of Code" in a floating chip while the user is holding down 'z'. later on we will support additional view modes

---

**Lattice task ID:** `t_1777578717235_d12bz`
**Created:** 2026-04-30T19:51:57.235Z

## Instructions (please complete autonomously, no need to confirm with the user)

1. Implement the task described above.
2. **Commit your work** before ending the session — Lattice merges your
   branch via `git merge`, so a commit is required for changes to land:

   ```
   git add -A
   git commit -m "<concise summary of the change>"
   ```

3. End the session normally. Lattice's Stop hook will verify the commit
   and move this task to "Ready to Merge" automatically.

Please do not start, stop, or restart any dev servers — the user runs
them in their own console and your output goes to the worktree's terminal.
