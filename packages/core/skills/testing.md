---
name: testing
description: Writing, fixing or extending automated tests (unit, integration, end-to-end) and choosing what to test. Use when the user asks for tests or when a change needs test coverage.
---

# Testing

## Fit the project
- Find the existing framework and conventions before writing anything: test folder layout, file naming (`*.test.ts`, `test_*.py`, `*Tests.cs`), helpers/fixtures, mocking library, how tests are run (package.json scripts, Makefile, CI config).
- Run the existing suite first to know the baseline (what already fails is not yours to hide).

## What to test
- Behavior, not implementation: public functions, observable outputs, side effects at boundaries.
- Per unit: the normal case, edge cases (empty, zero, one, many, max, unicode, negative), invalid input and error paths, and the specific bug being fixed (a regression test).
- Prefer a few meaningful tests over many shallow ones. Each test checks one idea and its name says what it proves ("rejects expired tokens").

## How to write them
- Arrange / act / assert, with the minimum setup needed. Build test data with small factories; avoid giant shared fixtures.
- Deterministic: no real network, clock, randomness or order dependence. Inject or fake time and randomness; use temp directories for files.
- Mock only at boundaries you don't own (HTTP, DB drivers, OS). Don't mock the unit under test or simple value objects.
- Assert precisely (exact values, specific error types/messages), not just "no exception".
- Never weaken or delete an existing assertion to make a test pass unless the requirement really changed - and say so.

## Verify
- Run the new tests and watch them fail for the right reason when the behavior is missing (temporarily break the code or write the test first), then pass.
- Run the whole relevant suite before finishing and report the counts.
