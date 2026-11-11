---
name: factory-tdd
description: >
  Write a failing test before production code for a factory task. Use when
  factory-build is implementing and no test-driven-development skill is installed.
---

# Factory test-first

<!-- idefactory:owned -->

The IDE session model does the work.

1. Restate the backlog acceptance criterion as one observable behavior.
2. Write a failing test that fails because the behavior is missing, not because the test is broken.
3. Run `idefactory verify run <attemptId> --check <kind> --red` and read the failure. Stop if the command names `vacuous-red` or `infrastructure-failure`.
4. Write the minimum production code that makes the test pass.
5. Run `idefactory verify run <attemptId> --check <kind>` and keep the output.
6. Do not add production code for behavior the test does not cover yet.
7. Do not put a verification result on an attempt transition.
