Analyze this codebase specifically to catch likely bugs before users do. Focus on defects that can produce wrong behavior, data loss, crashes, hangs, confusing UI states, security/privacy leaks, or hard-to-debug operational failures.

Read the relevant source, tests, docs, and recent git history before filing anything. Prioritize concrete, reproducible issues over speculative cleanup. For each bug you find, add a task to the Lattice task board for this active project with the exact files or code paths involved, the failure mode, expected behavior, and a suggested fix or regression test.

Do not create duplicate tasks. If something is only a refactor or product idea, leave it out unless it directly prevents or exposes a user-visible bug.