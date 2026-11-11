---
name: factory-verify
description: >
  Run the verification profile checks before claiming a factory work item is done.
  Use when factory-build is finishing and no verification-before-completion skill is installed.
---

# Factory verify

<!-- idefactory:owned -->

The IDE session model does the work.

1. Read the work item `verificationProfile` and `checks` from the packet or `.factory/work/items/`.
2. Map each required check to a project command (unit, build, playwright, docs, etc.).
3. Run each command in the project. Do not describe a run you did not start.
4. Read the exit code and the failing lines. A skipped check is not a pass.
5. Record a failing test, when the task class is `code`, with `idefactory verify run <attemptId> --check <kind> --red`.
6. Record the passing run with `idefactory verify run <attemptId> --check <kind>`.
7. Do not put a verification result on an attempt transition. The verification command writes the record.
8. Stop when the command names `vacuous-red` or `infrastructure-failure`.
9. Claim ready for review only when required checks passed.
