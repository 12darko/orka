---
name: refactoring
description: Restructuring existing code without changing its behavior - extracting, renaming, splitting files, removing duplication, modernizing APIs. Use when the goal is cleaner code rather than new behavior.
---

# Refactoring

## Rules
- Behavior must not change. If you notice a bug, report it (or fix it in a separate, clearly labeled step) instead of silently changing behavior mid-refactor.
- Get a safety net first: run the existing tests. If the code you touch has no tests, add characterization tests that pin the current behavior before changing it.
- Small, verifiable steps: one kind of change at a time (rename, then extract, then move), running the build/tests between steps.

## Techniques
- Rename: search every usage (code, tests, configs, docs, reflection/string references, serialized names) before renaming. Keep public API names unless the user wants a breaking change.
- Extract function/class/module when a piece has one clear responsibility and a good name. Don't extract single-use trivia.
- Remove duplication only when the copies change for the same reason; similar-looking code with different reasons to change can stay separate.
- Replace conditionals with polymorphism or lookup tables only when it clearly simplifies.
- Delete dead code confidently once search confirms it is unused (including dynamic usage).

## Finish
- Build, type-check and run tests. Summarize the structural change and confirm behavior is unchanged (and how you know).
