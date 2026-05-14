Please do a thorough review of this codebase and file all findings as tasks on the Lattice board. Read every source file before writing anything. Check the current status of the task board before beginning, do not create duplicate tasks.

## Step 1 — Full exploration

Read all source files, the README, any docs/, examples/, or tests/ directories, the build/package config, and all entry-point files. Don't skim — read completely. Then check git log for recent commits so you understand what's new vs. original, and what's actively in flux.

## Step 2 — Review across these dimensions

### Value proposition and fit
- What problem does this project solve, and for whom? Is that clearly legible from the README and first screen/entry point?
- Does it solve the problem more correctly, more simply, or for a more specific audience than established alternatives — or does it just exist alongside them?
- Is the scope coherent? Does the project try to solve problems that belong in the caller/user, or does it leave core parts of the problem to the caller when it shouldn't?
- Who is the intended user, and does every major design decision actually serve that user — or does it serve the implementer?

### The happy path
- Walk the primary workflow end to end as the target user would. Does it feel complete and intentional, or does it peter out?
- How quickly can a new user reach a working result with only the README? Where does that onboarding break down?
- What is the "aha moment" — the point where the user sees the value — and is anything in the way of reaching it?
- Does the simplest use case require understanding internals, reading source, or making non-obvious decisions?

### Unmet needs and capability gaps
Frame this as a product manager thinking about the first month of real usage:
- What will every user inevitably try to do that they can't? What workarounds will they build in week one?
- What is the most likely reason a user abandons this for an alternative after trying it?
- Are there obvious adjacent jobs-to-be-done — things a user needs right before or right after the core workflow — that this doesn't address but probably should?
- Does the product handle the second-most-common use case, or only the happy path?
- What does the user have to do *outside* this product to complete their task end to end?

### Architecture & hidden bugs
Look for issues that will create user-visible failures or debugging frustration:
- Config, parameters, or inputs that exist on one code path but are silently ignored on another
- State or resources that are never reset on error, abort, or retry
- Silent precedence when mutually exclusive options are both provided
- Errors that are swallowed, logged but not propagated, or returned in a shape the caller can't act on
- Anything a user would spend 30+ minutes debugging without a clear error message or warning
- Copy-paste implementations that have already diverged

### DX and documentation
- Is the README actually about this project, or is it a placeholder?
- Does the stated dev/install setup work end to end from a clean start?
- Are any public interfaces, config keys, commands, or callbacks confusingly named or underdocumented?
- Are there warnings for obvious misuse or misconfiguration?
- Are limitations, known gaps, or non-obvious behaviors documented anywhere?

## Step 3 — File everything to Lattice

As you find issues, add them to the Lattice board using the batch API. Group related issues into coherent tasks. For each task include:
- A specific title (not "improve X" but "Gap: no way to export results without writing custom glue code")
- The exact file and line if it's a bug
- A concrete fix or acceptance criteria
- Whether it's a bug, missing capability, DX improvement, or product/scope issue

Don't file vague tasks. Every task should be actionable by a developer who has never seen this conversation.