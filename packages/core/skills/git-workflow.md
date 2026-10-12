---
name: git-workflow
description: Git tasks - commits, branches, merges, rebases, resolving conflicts, writing commit messages, undoing mistakes, preparing a pull request. Use when the user asks for any git operation.
---

# Git workflow

## Before acting
- Check `git status`, the current branch and whether there are uncommitted changes. Never lose the user's work: stash or commit before operations that rewrite the working tree.
- Only commit, push, rebase, reset or change branches when the user asked for it. Push and history rewrites always need the user's explicit go-ahead.

## Commits
- Stage only the files that belong to the change (`git add <paths>`, not blindly `git add -A`); never commit secrets, build output or local config.
- Message: a short imperative subject (<= 72 chars, e.g. "Fix cart total for quantities"), a blank line, then why the change was made if not obvious. Follow the repo's existing style (look at `git log --oneline -15`), e.g. Conventional Commits if used.
- One logical change per commit.

## Branches and merging
- Branch names follow the repo's pattern (`feature/...`, `fix/...`).
- Prefer merge for shared branches; rebase only local, unpublished work.
- Conflicts: read both sides and the base (`git diff`, `git log --merge`), resolve by understanding intent, never by picking one side wholesale without checking. Build and test after resolving.

## Undoing
- Prefer non-destructive tools: `git revert` for published commits, `git restore <file>` for a single file, `git stash`. `git reset --hard`, `git clean -f` and force pushes destroy work - explain the consequence and get confirmation first.
- `git reflog` can recover "lost" commits; mention it when something went wrong.

## Pull requests
- Summarize what changed and why, how it was tested, and anything reviewers should look at.
