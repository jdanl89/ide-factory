# Tasks

## 1. Red records per kind

- [x] 1.1 Store a red assertion failure at `evidence.reds[kind]` without removing other kinds, and stop writing `evidence.red`. Readers treat a legacy `evidence.red` as the record for its kind when `evidence.reds` is absent. Verify `test/verification-evidence.test.mjs` records `unit` and then `integration` and still has both, and that a legacy `evidence.red` for `unit` satisfies the `unit` red check.
- [x] 1.2 Require a failing red for every required test kind before a `code` attempt enters `verifying`, and allow a `lightweight` attempt to enter `verifying` with no red record. Required test kinds are `unit`, `integration`, `playwright`, `contract`, and names starting with `unit-`. Verify an attempt test rejects `verifying` when `integration` is required and only `unit` is red, and accepts it for a `lightweight` item.

## 2. Task class and completion

- [x] 2.1 Set `taskType` from `factory.taskType` when it is `code` or `lightweight`, otherwise `lightweight` for inferred kind `docs` and `code` for every other kind. Fail sync without writing the item when the explicit value is anything else. Verify `test/queue.test.mjs` or the classify test covers the docs default, an explicit override, and the rejected value.
- [x] 2.2 Make `complete` require one stored failing red per required test kind for a `code` item and no red record for a `lightweight` item. Keep the existing passing-attestation rules. Verify a completion test fails a `code` item that has `unit` and `integration` required and only a `unit` red, and completes a `lightweight` item with passing attestations and no red.

## 3. Classification, baseline, and the cap

- [x] 3.1 Classify `verify run --red`. Store a record only for a non-zero exit that is not a spawn failure, timeout, exit 127, or a runner report that no tests executed. A zero exit stores nothing, exits non-zero, and is named `vacuous-red`. Verify `test/verification-evidence.test.mjs` for an assertion failure, a missing argv, a "no tests" report, and a zero exit.
- [x] 3.2 Before the first implement request, run each mapped test command once and store `passed` or `accepted` on the session for that HEAD. Infrastructure stops with `infrastructure-failure` and names `idefactory setup`. An assertion failure stops with `baseline` and writes no red record. `--accept-baseline` records acceptance for that HEAD and allows the implement request. A later green baseline continues without the flag. Verify `test/run-session.test.mjs` for these three outcomes.
- [x] 3.3 Count identical infrastructure failures, vacuous-red results, and review rejections per attempt. The fourth refuses the write, stops with `retry-cap`, and stays stopped until `--new-run`. `infrastructure-failure` and `baseline` do not stick. All four new stop reasons exit 0 and print no orchestration request. Verify a session test reaches `retry-cap` on the fourth identical infrastructure failure and retries an `infrastructure-failure` stop on the next run without `--new-run`.

## 4. Skills

- [x] 4.1 Update factory-build, factory-tdd, factory-verify, and factory-run, including every IDE copy the installer ships. Name `idefactory verify run` and `--red`. Remove the instruction to attach a pass boolean or a verification object to an attempt transition. Tell the session to stop on `vacuous-red` and `infrastructure-failure`. factory-run names the new stops and says only the human may pass `--new-run` after `vacuous-red` or `retry-cap`. Verify a skill-text test reads the installed factory-verify skill and asserts it names `verify run` and does not mention a caller-supplied pass boolean.
