---
name: factory-build
description: >
  Implement one factory work item test-first and hand it to a different role
  for review. Use when the user says /factory-build, implement the next task,
  or asks the engineer to build an OpenSpec task. The IDE session model does the work.
---

# Factory build

Implement exactly one work item.

<!-- idefactory:owned -->

## Scope

1. Run `idefactory next` or use the work item the human named.
2. Start or resume an attempt: `idefactory attempt start <change> <id>` when needed.
3. Read only the implementing role's charter and history. The packet names the path. Do not read other charters.
4. Read the OpenSpec proposal, design, and the delta spec that covers the task.
5. If `HALT` exists, stop.

## Method

**Prefer common tools.** If the work creates or scaffolds an app, use the ecosystem standard generator before inventing files by hand. Examples: `npm create vite@latest` for a Vite/React SPA, framework CLIs, official templates. Only hand-roll a toolchain when the OpenSpec design requires it.

Write a failing test before production code when the task class is `code` and the profile includes a test check (`unit`, `integration`, `playwright`, `contract`, or `unit-*`). Record it with `idefactory verify run <attemptId> --check <kind> --red`, then implement until green and record the passing run with `idefactory verify run <attemptId> --check <kind>`. A `lightweight` item does not require a failing test.

Do not put a verification result on an attempt transition. Stop when the command names `vacuous-red` or `infrastructure-failure`.

If a skill named `test-driven-development` is installed, follow that skill for the test cycle. Otherwise follow `factory-tdd`.

Record red evidence on the attempt, then implement until green. Read the packet's Prior rejections section and address every note before asking for review again.

Run verification profile checks before claiming done. Follow `factory-verify`.

If the command fails, follow `systematic-debugging` when that skill is installed, otherwise `factory-debug`.

## Review

Review is a different role: the reviewer. The implementer does not approve their own work.

Spawn a reviewer subagent with only the reviewer charter. Acceptance requires red evidence and verification evidence. Rejection uses `idefactory lockout`.

Transition the attempt to accepted or rejected with distinct implementerId and reviewerId.

## Finish

```bash
idefactory complete <change> <id> --attempt <attemptId>
```

Do not hand-edit backlog status. `complete` marks the work item done and checks the OpenSpec checkbox when gates pass.

Ask the scribe only if complete cannot update histories. Do not truncate older notes.

The IDE session model does the work. Do not publish, deploy, or spend.
