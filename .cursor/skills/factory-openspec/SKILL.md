---
name: factory-openspec
description: >
  Staff a human-authored OpenSpec change into .factory/work and the factory team.
  Use when the user says apply an OpenSpec change, /factory-plan, or asks the
  team to plan work that already has openspec/changes/<name>/.
  Do not invent a product.
---

# Factory OpenSpec

OpenSpec owns the proposal, design, delta specs, tasks, sync, and archive.
This skill only staffs a change the human already authored.

<!-- idefactory:owned -->

## Load the change

1. Use the change the human named, or `.factory/active-change.json` if it is set.
2. Read `openspec/changes/<name>/proposal.md`, `design.md`, `tasks.md`, and `specs/`.
3. Ignore `openspec/changes/archive/`. If the name is missing, stop. Do not create a change.
4. If the human wants a new product idea, stop and point them at the OpenSpec propose skill (`openspec-propose`, `/opsx-propose`, or `/opsx:propose`). That skill owns authoring.

## Check memory

The lead compares the design with `.factory/decisions.md`. If they conflict, stop and ask the human. Do not silently rewrite the proposal.

When the change is greenfield UI or app work and the design is silent on toolchain, have the architect (or lead) record a mainstream scaffold in design/tasks before build—for example Vite via `npm create vite@latest`—unless the human already chose another stack.

## Queue the work

Run:

```bash
idefactory sync-tasks <name>
```

`.factory/work/` is the only execution queue. OpenSpec `tasks.md` remains the human plan.

## Build

For each synced work item, follow `factory-build` one item at a time, or use `factory-run` for a bounded multi-item loop when the human asks.

Finalize with `idefactory complete` after review accepts. That checks the OpenSpec checkbox.

When every box is checked, tell the human to archive and sync with OpenSpec. Do not archive from this skill.

## Pull requests

The only legal pull-request steps are `idefactory pr open <change>`, `idefactory pr comment <attemptId>`, and `idefactory pr capture <change>`.
The agent never merges. It does not open or edit a pull request through the Cursor pull-request tool or a hand-written `gh pr create` or `gh pr edit`.

`sync-tasks`, `run`, `approve`, `complete`, `verify`, `ci scaffold`, and archive or spec sync run only after the human asks for that action.

When the human asks to archive, run `isDeliverableChange` first. If it is false, stop and do not move `openspec/changes/<change>/`. Spec sync stays human-gated and does not itself require the pull-request record.

The IDE session model does the work.
