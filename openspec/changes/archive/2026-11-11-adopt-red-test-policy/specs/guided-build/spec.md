# Spec Delta

## MODIFIED Requirements

### Requirement: Method and review
The work packet and factory skills SHALL require a failing test before production code only when the work item's task class is `code` and its verification profile includes a test check. A `lightweight` item SHALL NOT require a failing test. For a `code` item the skills SHALL name `idefactory verify run --check <kind> --red` for the failing test and `idefactory verify run --check <kind>` for the passing run. The skills SHALL NOT tell the session to attach a pass boolean to an attempt transition. Verification evidence SHALL still be produced by the verification command before review, and review SHALL still be a role other than the implementer.

#### Scenario: Build skill
- **WHEN** the factory-build skill is read for a `code` work item whose profile includes a test check
- **THEN** it requires `idefactory verify run` with `--red` before production code, a later passing `idefactory verify run`, and a different role for review

#### Scenario: Build skill for a lightweight item
- **WHEN** the factory-build skill is read for a `lightweight` work item
- **THEN** it does not require a failing test before production code

### Requirement: Attempt lifecycle
Each started work item SHALL have a persisted attempt whose state transitions reject illegal stage changes. Review notes are accepted from the reviewer. Red, verification, and security check records SHALL be retained only when the verification command wrote them. A `code` attempt SHALL NOT enter `verifying` until each required test kind has a stored failing red record. A `lightweight` attempt MAY enter `verifying` from `implementing` with no red record.

#### Scenario: Illegal transition
- **WHEN** an attempt transition skips from assigned directly to accepted
- **THEN** the command exits with an illegal-transition error

#### Scenario: Caller-supplied check result
- **WHEN** an attempt transition includes a caller-supplied red, verification, or security result
- **THEN** the transition is rejected and the attempt does not store that result

#### Scenario: Code attempt needs every test kind
- **WHEN** a `code` attempt requires `unit` and `integration` and only `unit` has a stored failing red record
- **THEN** the transition into `verifying` is rejected

#### Scenario: Lightweight attempt skips red
- **WHEN** a `lightweight` attempt transitions from `implementing` to `verifying` with no red record
- **THEN** the transition is accepted

### Requirement: Finalize accepted work
Complete SHALL require an accepted attempt, or a matching recoverable finalization journal, and, for every required check, a schema-valid passing attestation whose exit code is zero and whose source revision equals the current clean HEAD. A `code` item SHALL also have a stored failing CLI red record for each required test kind. A `lightweight` item SHALL NOT require a red record.

#### Scenario: Successful completion
- **WHEN** complete receives an accepted `code` attempt with distinct role identifiers, a schema-valid passing attestation for every required check at the current clean HEAD, a stored failing red record for each required test kind, and a verification profile whose `humanGate` is false
- **THEN** the matching journal is ready to commit, the OpenSpec checkbox is checked, scribe and identity records are current, the attempt is finalized, and the work item is done
- **AND** the atomic work-item done update was the final correctness-critical write
- **AND** the journal includes the durable commit target and frozen `finalizedAt` applied last, not as a pre-commit target

#### Scenario: Missing evidence
- **WHEN** required verification evidence is absent
- **THEN** complete fails and does not claim the work item is finalized

#### Scenario: Forged pass boolean
- **WHEN** an attempt carries a caller-supplied check object whose pass boolean is true and no verification-command attestation
- **THEN** complete fails and the work item remains unfinished

#### Scenario: Unknown or unmapped check
- **WHEN** a required check kind is absent from the registry or has no argv mapping
- **THEN** complete fails and the work item remains unfinished

#### Scenario: Stale source revision
- **WHEN** a required attestation names a source revision other than the current clean HEAD
- **THEN** complete fails and the work item remains unfinished

#### Scenario: Lightweight completion without red
- **WHEN** complete receives an accepted `lightweight` attempt that meets every passing-attestation requirement and has no red record
- **THEN** the missing red record does not fail completion

#### Scenario: Code completion missing one red kind
- **WHEN** a `code` item requires `unit` and `integration` and the attempt has a failing red record for `unit` only
- **THEN** complete fails and the work item remains unfinished

## ADDED Requirements

### Requirement: Task class
Each work item SHALL have task class `code` or `lightweight`. An explicit `factory.taskType` of one of those two values SHALL win. When it is omitted, inferred kind `docs` SHALL be `lightweight` and every other inferred kind SHALL be `code`. Any other explicit value SHALL fail sync and SHALL NOT write the work item. A required test kind SHALL be `unit`, `integration`, `playwright`, `contract`, or a kind whose name starts with `unit-`.

#### Scenario: Docs default to lightweight
- **WHEN** a task has no `factory.taskType` and its inferred kind is docs
- **THEN** the work item's task class is `lightweight`

#### Scenario: Explicit class wins
- **WHEN** a task's inferred kind is docs and `factory.taskType` is `code`
- **THEN** the work item's task class is `code`

#### Scenario: Invalid class fails sync
- **WHEN** `factory.taskType` is any value other than `code` or `lightweight`
- **THEN** sync fails and does not write that work item

### Requirement: Baseline before implement
Before the first implement request of a run, the factory SHALL run each mapped test command once.

#### Scenario: Baseline runs before implement
- **WHEN** a run is about to emit its first implement request and has not baselined the current HEAD
- **THEN** it runs each mapped test command before that request

### Requirement: Baseline infrastructure failure
When a baseline command cannot start, times out, or reports that no tests executed, run SHALL stop with reason `infrastructure-failure`, SHALL print no implement request, and SHALL name setup in the output.

#### Scenario: Baseline command cannot start
- **WHEN** the baseline command cannot start
- **THEN** run prints no implement request
- **AND** the stop reason is `infrastructure-failure`
- **AND** the output names setup

### Requirement: Baseline assertion failure
When a baseline command exits non-zero after tests ran, run SHALL stop with reason `baseline` and SHALL NOT store a red record. `--accept-baseline` for that HEAD SHALL record the human's acceptance and SHALL allow the implement request. A later run whose baseline commands exit zero SHALL continue without `--accept-baseline`.

#### Scenario: Accepted baseline
- **WHEN** the baseline exits non-zero after tests ran and the human passes `--accept-baseline` for that HEAD
- **THEN** the run may emit the implement request
- **AND** no red record is stored for the baseline

#### Scenario: Green baseline continues
- **WHEN** a later run's baseline commands exit zero
- **THEN** the run continues without `--accept-baseline`

### Requirement: Retry cap
The fourth identical infrastructure failure, the fourth `vacuous-red`, or the fourth review rejection of the same attempt SHALL be refused. Run SHALL then stop with reason `retry-cap` and SHALL emit no further request for that attempt until the human passes `--new-run`.

#### Scenario: Fourth identical infrastructure failure
- **WHEN** the same attempt has already recorded three identical infrastructure failures and a fourth is attempted
- **THEN** the fourth result is not stored as red
- **AND** the stop reason is `retry-cap`
- **AND** no orchestration request is printed
