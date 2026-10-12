---
name: new-project
description: Starting a new project or app from an empty or nearly empty folder - choosing a stack, scaffolding, first structure, tooling and a runnable first version. Use when the workspace has no real code yet or the user asks to "create/start/set up" a project.
---

# New project

## Clarify just enough
- Pin down what is being built, the platform (web, CLI, desktop, mobile, game, library, API) and any stack the user already wants. If the choice of stack materially changes the result and the user gave no hint, ask one short question; otherwise pick a mainstream, well-supported default and say why.

## Scaffold
- Prefer the ecosystem's official generator in non-interactive mode (e.g. `npm create vite@latest app -- --template react-ts`, `dotnet new`, `cargo new`, `uv init`, `django-admin startproject`). Pass flags so it never waits for input.
- Pin a current stable version of the language/runtime; add a `.gitignore`, formatter/linter config and a test setup from the start.
- Keep the first structure small and conventional for the stack; don't invent layers the app doesn't need yet.

## First working slice
- Build one thin end-to-end feature that runs, with one real test.
- Provide scripts for the common tasks: run, build, test, lint.
- Verify: install dependencies, build, run the tests, and start-and-stop the app if possible (commands must terminate).

## Hand-off
- Write a short README: what it is, prerequisites, how to run/test.
- Record lasting decisions (stack, architecture, conventions) in `.project-ai/decisions.md` once the user agrees with them.
- Summarize the structure and the next logical steps.
