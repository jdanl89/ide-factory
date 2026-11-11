# Design

## Context

`verifyRun` in `src/lib/verification-evidence.mjs` stores a single `attempt.evidence.red` when `--red` is set and the exit code is non-zero. Any non-zero exit qualifies, including a missing binary. `complete` in `src/lib/complete.mjs` then requires that one object to match every kind in `RED_REQUIRED_KINDS` (`unit`, `integration`, `playwright`, `contract`), so a task that needs two of those kinds cannot finish. `red-confirmed` in `src/lib/attempt.mjs` checks that same single object. The factory-verify skill tells the session to put a pass boolean on the attempt transition, which `rejectCallerSuppliedCheckResults` rejects. See proposal.md for why this loops.

Run stop reasons are a closed list in the bounded-run-sessions spec and in the session code. A recorded red result does not increment the failure budget.

## Goals / Non-Goals

**Goals:**

- One failing red record per required test kind, and completion rules that follow `code` versus `lightweight`.
- Infrastructure failure and a passing `--red` run store nothing and stop the run.
- A baseline of the mapped test commands before the first implement request.
- A hard stop on the fourth identical infrastructure failure, vacuous red, or rejection of one attempt.

**Non-Goals:**

- Detecting which argv a project should use. Baseline calls whatever `checks.json` already maps, and an infrastructure failure points at `idefactory setup` when that command exists.
- A parser per test framework.
- Letting a `code` task skip red. The human classifies it `lightweight` or stops at `vacuous-red`.

## Decisions

### Red records are a map

Store red records at `evidence.reds[kind]`. A new red for one kind does not delete another. Readers treat a legacy `evidence.red` object as the record for `evidence.red.kind` when `evidence.reds` is absent, so attempts written before this change still complete. New writes do not update `evidence.red`.

`red-confirmed` and the transition into `verifying` require a failing CLI red in that map for every required test kind on a `code` item. A `lightweight` item may go from `implementing` to `verifying` with an empty map. Required test kinds are the item's required checks whose names are `unit`, `integration`, `playwright`, `contract`, or start with `unit-`.

### Classification

`verify run --red` classifies after the spawn:

- The process cannot be started, the run times out, or the exit status is 127: `infrastructure-failure`. Nothing is stored.
- The combined output reports that no tests executed (`no tests`, `0 tests`, `no test files found`, `missing script`, `not recognized as a command`). `infrastructure-failure`. Nothing is stored.
- Exit code zero: `vacuous-red`. Nothing is stored. The command exits non-zero.
- Any other non-zero exit: assertion failure. Store the record under that kind.

A compile error that the runner reports as a failed test stays an assertion failure. That is a real red. A missing runner is not.

The same classification applies to the baseline run. Baseline never writes a red record.

### Task class

`classifyTask` sets `taskType`. `factory.taskType: code|lightweight` wins. Omitted, kind `docs` becomes `lightweight` and every other kind becomes `code`. Sync rejects any other explicit value and does not write the item. The field is stored on the work item next to `verificationProfile`.

### Baseline and the retry cap

The run session stores `baseline` as `{ sourceRevision, result }` where result is `passed` or `accepted`. Before the first implement request, if the current HEAD has no matching baseline, run the mapped test argv list once.

- Infrastructure: stop `infrastructure-failure`, name `idefactory setup` in the output, do not set baseline.
- Assertion failure: stop `baseline`. `--accept-baseline` sets `accepted` for this HEAD and the same session may emit the implement request on that invocation.
- Exit zero: set `passed` and continue.

`infrastructure-failure` and `baseline` are not sticky. The factory-run skill stops because the exit code is 0. The next human-started run retries the check.

The attempt stores counts of identical infrastructure failures, vacuous-red results, and review rejections. The fourth of any one of those refuses the write, stops with `retry-cap`, and that stop is sticky until `--new-run`, same as `max-failures`. Identical means the same attempt, the same check kind, and the same classification.

### Skills

Replace the factory-verify example that passes `--evidence '{"verification":[...]}'`. The three skills name `idefactory verify run`. factory-run names the new stop reasons and still forbids the loop from adding `--new-run`.

## Risks / Trade-offs

- [A compile failure with zero reported tests is classified as infrastructure and does not count as red] → The output tells the human it is infrastructure, not a bad test. They fix the build or strengthen the test. It does not loop: the retry cap stops the fourth try.
- [Legacy attempts have `evidence.red` only] → Readers honor that object for its kind. New writes use `evidence.reds`.
- [Baseline adds a test run before any implementation] → It runs once per HEAD, not once per task. `--accept-baseline` covers a suite that is already red for reasons outside the task.
- [Exit code 0 on these stops makes `/factory-run` end] → That is the point. The skill must not immediately call run again for `vacuous-red` or `retry-cap`. The skill text says so.

## Migration Plan

1. Change storage and `complete` together, with a test that two kinds both survive and a legacy `evidence.red` still satisfies its kind.
2. Add classification, then the session stops, then the skill text.
3. No rewrite of existing attempt files.

Rollback is reverting the readers. Leaving `evidence.reds` in old attempts is harmless if the old code only reads `evidence.red`; those attempts would need a new red run after rollback. Call that out in the PR. Do not delete `evidence.reds` on rollback.

## Open Questions

None. The output phrases, the legacy field, and which stops are sticky are decided above.
