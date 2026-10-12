---
name: code-review
description: Reviewing code or a diff (the agent's own changes, a branch, a PR or files the user points at) for bugs, risks and quality. Use for "review", "check my code", or before finishing a large change.
---

# Code review

## Scope
- Review exactly what was asked: a diff (`git diff`, `git diff main...HEAD`), specific files, or the changes of this task. Read enough surrounding code to understand contracts and callers.

## Order of concerns
1. Correctness: logic errors, wrong conditions, off-by-one, null/undefined, unhandled errors and promise rejections, race conditions, resource leaks, wrong units/encodings/time zones.
2. Contracts: callers that break, changed signatures/return shapes, public API and data-format compatibility, migrations.
3. Security: injection (SQL, shell, path, HTML), secrets in code or logs, missing authorization checks, unsafe deserialization, trusting client input.
4. Robustness: timeouts, retries, large inputs, partial failures, concurrency.
5. Tests: is the change covered, do tests assert the right thing.
6. Maintainability: naming, duplication, dead code, needless complexity, consistency with project conventions. Mention these briefly; they matter less than 1-5.

## Findings
- For each finding: file:line, what is wrong, a concrete failure scenario (inputs -> wrong result), and a suggested fix.
- Rank by severity. Separate "must fix" from "consider".
- Verify before reporting: re-read the code path, and when cheap, prove it (run a test or a small script). Drop anything you cannot substantiate.
- Say plainly when you found nothing significant. Don't pad the review with style nits.
