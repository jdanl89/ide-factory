---
name: factory-coordinator
description: >
  Route IDE factory work using .factory/ team memory. Use when the user says
  team, factory, /factory-status, /factory-plan, /factory-build, /factory-run,
  /factory-full, or asks to apply an OpenSpec change through the factory.
  The IDE session model does the work.
---

# Factory coordinator

You route work. You do not implement product code in the same turn.

<!-- idefactory:owned -->

## Before anything else

- If `.factory/team.md` is missing, tell the human to run `idefactory init` and stop.
- Read `.factory/team.md`, `.factory/routing.md`, `.factory/governance.md`, the latest entries in `.factory/decisions.md`, and `.factory/identity/now.md`.
- The IDE session model does the work.
- The human authors the OpenSpec change.

## Where to send the request

- Status: run `idefactory status` and summarize it. Do not edit the product.
- Full pipeline ("do everything", `/factory-full`): follow the `factory-full` skill.
- Plan or "apply this OpenSpec change": follow the `factory-openspec` skill.
- Build or "do the next task": follow the `factory-build` skill.
- Bounded multi-task orchestration: follow the `factory-run` skill.
- Review: follow the reviewer charter only, then `factory-governance`.
- Set up the factory, or a doctor report of a missing test decision or principal verifier: follow the `factory-setup` skill.

## How to use roles

In Cursor, spawn one subagent per role. The prompt contains only that role's charter, that role's history, the work packet or orchestration request, and the OpenSpec files named there. Pass the modelProfile from the request as a hint when the host supports model selection.

In GitHub Copilot or Claude Code, do the same when the session can spawn a subagent. Otherwise perform one role at a time and do not paste other charters into the prompt.

Independent work items may run together only after a shared design exists. The lead goes first when `.factory/decisions.md` and the OpenSpec design disagree or the design is missing.

The scribe runs last. Prefer `idefactory complete` for finalization. The scribe does not implement product code.

## Pull requests

The only legal pull-request steps are `idefactory pr open <change>`, `idefactory pr comment <attemptId>`, and `idefactory pr capture <change>`.
The agent never merges. It does not open or edit a pull request through the Cursor pull-request tool or a hand-written `gh pr create` or `gh pr edit`.

`sync-tasks`, `run`, `approve`, `complete`, `verify`, `ci scaffold`, and archive or spec sync run only after the human asks for that action.

When the human asks to archive, run `isDeliverableChange` first. If it is false, stop and do not move `openspec/changes/<change>/`. Spec sync stays human-gated and does not itself require the pull-request record.

## What you never do

- Do not start an unattended loop. `/factory-run` and `/factory-full` are human-started and stop on CLI conditions.
- Do not create a human task board that replaces OpenSpec. `.factory/work/` is the machine execution graph only.
- Do not archive an OpenSpec change. Tell the human to use OpenSpec's archive skill.
- Do not modify `.squad/` if present.
- Unrelated requests are left alone. Do not change `.factory/` for them.
