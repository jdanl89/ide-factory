# Spec Delta

## MODIFIED Requirements

### Requirement: CLI-run attestation
A verification command SHALL execute one registered argv without a shell, capture its exit code, and write the evidence record itself. The caller SHALL NOT supply the pass boolean for that record. A red run SHALL store a record only for an assertion failure, and only under that check kind.

#### Scenario: Command exits zero
- **WHEN** the verification command runs a registered check and the process exits zero before the timeout
- **THEN** the attempt stores an evidence record whose exit code is zero and whose pass result is derived from that exit
- **AND** the record names the runner and its version

#### Scenario: Command exits non-zero
- **WHEN** the verification command runs a registered check without the red flag and the process exits non-zero
- **THEN** the attempt stores that exit code and the record is not passing evidence

#### Scenario: Red run
- **WHEN** the verification command records a red result and the process exits non-zero after tests have run
- **THEN** the record is stored under that check kind
- **AND** a caller-supplied red object is not stored

## ADDED Requirements

### Requirement: Red records do not replace other kinds
A stored red record for one check kind SHALL NOT replace a stored red record for a different kind.

#### Scenario: Second kind is added
- **WHEN** a red assertion failure is already stored for `unit` and a red run then records `integration`
- **THEN** the attempt still has the `unit` red record
- **AND** it also has the `integration` red record

### Requirement: Infrastructure failure is not red
A red run SHALL NOT store a red record when the argv cannot be started, the run times out, or the runner reports that no tests executed. The command SHALL exit non-zero and SHALL name the result `infrastructure-failure`.

#### Scenario: Command cannot start
- **WHEN** a red run's argv cannot be started
- **THEN** no red record is stored
- **AND** the result is named `infrastructure-failure`

#### Scenario: No tests executed
- **WHEN** a red run exits non-zero and the runner reports that no tests executed
- **THEN** no red record is stored
- **AND** the result is named `infrastructure-failure`

### Requirement: Vacuous red stores nothing
When a red run exits zero, the factory SHALL NOT store a red record, SHALL exit non-zero, and SHALL name the result `vacuous-red`.

#### Scenario: Red run already passes
- **WHEN** a red run exits zero
- **THEN** no red record is stored
- **AND** the result is named `vacuous-red`
