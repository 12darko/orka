---
name: documentation
description: Writing or updating READMEs, API docs, code comments, changelogs, architecture notes and setup guides. Use when the user asks for docs or when a change makes existing docs wrong.
---

# Documentation

## Know the reader
- A README is for someone new to the project: what it is, how to install, configure and run it, how to test, where things are. Put the quickest path to a working setup first.
- API docs are for callers: purpose, parameters, return values, errors, an example.
- Comments are for maintainers: explain *why* (intent, constraints, non-obvious decisions), not what the code already says.

## Accuracy
- Every command, path, setting and example must match the code. Check scripts in package.json / Makefile / project files, and run commands when practical.
- Update docs in the same change as the behavior they describe; remove docs for removed features.
- Follow the project's existing doc style, language and heading structure.

## Style
- Short sentences, active voice, concrete examples, code blocks with the right language tag.
- Use lists and tables for options and reference material; prose for explanations.
- No marketing tone, no filler. Link instead of repeating.
