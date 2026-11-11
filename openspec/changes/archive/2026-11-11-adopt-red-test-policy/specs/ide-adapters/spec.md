# Spec Delta

## ADDED Requirements

### Requirement: Verify skills name the verification command
The installed factory-build, factory-tdd, and factory-verify skills SHALL name `idefactory verify run`, including `--red` for a failing test on a `code` item. They SHALL tell the session to stop when the result is `vacuous-red` or `infrastructure-failure`. They SHALL NOT instruct the session to send a pass boolean, a red object, or a verification object on an attempt transition.

#### Scenario: Verify skill does not invent a payload
- **WHEN** the installed factory-verify skill is read
- **THEN** it names `idefactory verify run`
- **AND** it does not instruct the session to attach a pass boolean to an attempt transition

#### Scenario: Build skill stops on vacuous red
- **WHEN** the installed factory-build skill is read
- **THEN** it tells the session to stop on `vacuous-red` and on `infrastructure-failure`
