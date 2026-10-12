---
name: debugging
description: Finding and fixing the root cause of a bug, crash, failing test, wrong output or error message. Use whenever something "doesn't work" and the cause is not yet known.
---

# Debugging

## 1. Reproduce
- Turn the report into a concrete failing case: the exact command, input, test or steps, and the expected vs actual result.
- Run it yourself when possible and read the full error: message, stack trace, first failing assertion. The first error is usually the real one; later ones are often consequences.
- If you cannot reproduce it, say so and gather more facts before changing code.

## 2. Localize
- Follow the stack trace to the frames in project code (not library code).
- Form a hypothesis that explains *all* symptoms, then find the cheapest check that could prove it wrong: read the code path, add a temporary log/print, run a smaller case, check git history (`git log -p` on the file) for a recent change.
- Change one thing at a time. If a hypothesis fails, discard it - don't stack fixes on top of a wrong theory.
- Check the boring causes early: wrong file/branch/config, stale build output, environment variables, off-by-one, null/undefined, async ordering, time zones, encodings, case-sensitive paths.

## 3. Fix the root cause
- Fix where the bug originates, not where it surfaces. Avoid masking fixes (catch-and-ignore, extra null checks that hide invalid state, retry loops) unless you explain why they are right.
- Keep the fix minimal and in the style of the surrounding code.
- Look for the same bug elsewhere (search for the pattern) and mention it.

## 4. Prove it
- Add or update a test that fails before the fix and passes after, when the project has tests.
- Re-run the original reproduction and the related test suite. Remove temporary logging.

## Report
- Cause (one or two sentences, with file:line), the fix, and how it was verified. Say clearly if anything is unverified.
