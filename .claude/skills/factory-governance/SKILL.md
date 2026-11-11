---
name: factory-governance
description: >
  Enforce factory approvals, halt, and reviewer lockout. Use when work needs
  spend, publishing, deployment, a human decision, or a rejected review.
---

# Factory governance

<!-- idefactory:owned -->

## Pull requests

The only legal pull-request steps are `idefactory pr open <change>`, `idefactory pr comment <attemptId>`, and `idefactory pr capture <change>`.
The agent never merges. It does not open or edit a pull request through the Cursor pull-request tool or a hand-written `gh pr create` or `gh pr edit`.

`sync-tasks`, `run`, `approve`, `complete`, `verify`, `ci scaffold`, and archive or spec sync run only after the human asks for that action.

## Protected actions

Publishing, deploying, creating accounts, and spending money are human actions. Stop and ask the human to run:

```bash
idefactory approve <id> --note "what they are allowing"
```

A rejection is:

```bash
idefactory reject <id> --note "why"
```

Do not run those commands yourself in order to approve your own request.

## Files you do not rewrite

- Earlier entries in `.factory/decisions.md`
- Agent histories, except to append a new note
- `.factory/governance.md` baseline intent (append decisions instead)

## Lockout

When the reviewer rejects an implementation, run:

```bash
idefactory lockout create --agent <implementer-id> --reviewer reviewer --reason "what failed"
```

`idefactory lockout --agent ...` remains a create alias. Creation prints a lockout id and writes immutable event data; it does not delete product files.

Resolve an active lockout (or a legacy `*lockout*.md` basename) with a distinct resolver:

```bash
idefactory lockout resolve <id> --resolver <id> --reason "what changed"
```

The lead assigns a later attempt; the same session does not quietly continue as if the review passed.

## Halt

If `HALT` exists at the project root, stop. The human clears it with `idefactory resume`.

The IDE session model does the work.
