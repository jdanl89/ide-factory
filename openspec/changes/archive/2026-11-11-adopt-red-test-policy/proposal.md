# Proposal

## Why

The factory treats "write a failing test" as a gate it cannot leave. The build skill never names the command that records a red result, a single red record cannot satisfy two test kinds, and a missing or already-passing test runner is stored as if it proved something. An agent then retries until the token budget is gone. Failing tests should gate code tasks, and every other failure should stop and ask the human.

## What Changes

- Classify each work item as `code` or `lightweight`. Docs, config, and other tasks with no executable behavior are `lightweight` and do not require a failing test. A human `factory:` block can set the class.
- Store one red record per check kind. Completion of a `code` task requires one failing CLI red for each required test kind, so `unit` plus `integration` can both be recorded. A `lightweight` task requires none.
- Classify a `--red` run. A non-zero exit caused by a failing assertion is red. A command that cannot start, times out, or reports that no tests ran is an infrastructure failure and is not stored as red. A `--red` run that exits zero stores nothing and reports `vacuous-red`.
- Before the first implement request in a run, execute the mapped test commands once. An infrastructure failure stops with a pointer to setup. Known assertion failures stop for a human choice: fix them, proceed, or halt.
- Cap retries. The fourth identical infrastructure failure, vacuous-red, or review rejection on one attempt is refused. Run then stops until the human opens a new session.
- Correct the factory-verify skill so it records evidence with `idefactory verify run` and does not tell the agent to attach a pass boolean to the attempt transition.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `verification-evidence`: Red results are stored per check kind, and only an assertion failure counts. Infrastructure failure and a zero exit under `--red` store no red record.
- `guided-build`: Test-first and the completion red requirement follow the task class. A code task needs one red per required test kind. Run baselines the test commands once and stops at the retry cap.
- `bounded-run-sessions`: The closed stop-reason list adds `vacuous-red`, `infrastructure-failure`, `baseline`, and `retry-cap`. `vacuous-red` and `retry-cap` stay stopped until the human passes `--new-run`. `infrastructure-failure` and `baseline` stop the skill loop and are retried on the next human-started run.
- `ide-adapters`: The build, test-first, and verify skills name `idefactory verify run`, including `--red`, and tell the session to stop on vacuous-red or infrastructure failure instead of inventing a transition payload.

## Impact

- `src/lib/verification-evidence.mjs` (single `evidence.red` slot), `src/lib/complete.mjs` (`RED_REQUIRED_KINDS` compared to that one slot), `src/lib/attempt.mjs`, `src/lib/classify.mjs`, and `src/lib/orchestrate.mjs` or `src/lib/run.mjs` for the baseline and the cap.
- `templates/skills/factory-build/SKILL.md`, `factory-tdd`, and `factory-verify`, then every IDE copy of those skills.
- `openspec/specs/bounded-run-sessions/spec.md` lists the legal stop reasons. New reasons extend that list rather than overloading `unchanged-state`.
- Tests in `test/verification-evidence.test.mjs`, `test/orchestration.test.mjs`, and `test/run-session.test.mjs`.

## Out of scope

- Detecting the test command or choosing lightweight versus strict governance. That is `add-guided-setup`.
- A shortened role route for small changes, and copying rejection notes into the next attempt. That is `add-quick-fix-and-rejection-feedback`.
- Per-framework red adapters (bats, jest, vitest, pytest). Classification uses spawn failure, timeout, and a runner report of zero tests, not a parser per framework.
- Making red optional for a `code` task. A code task still needs a real failing test. The escape is classifying the task `lightweight`, or the human stopping at vacuous-red.
