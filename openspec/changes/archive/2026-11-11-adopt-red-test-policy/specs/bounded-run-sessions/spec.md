# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit stop reason
Every run result SHALL persist and print exactly one stop reason. The reason SHALL be one of `all-done`, `blocked`, `rejected`, `lockout`, `needs-complete`, `needs-agent`, `human-gate`, `max-tasks`, `max-agent-steps`, `wall-clock`, `max-failures`, `unchanged-state`, `invalid-budget`, `invalid-session`, `host-usage-unavailable`, `max-tokens`, `max-cost`, `vacuous-red`, `infrastructure-failure`, `baseline`, or `retry-cap`.

#### Scenario: Wall-clock stop is named
- **WHEN** a run stops because the wall-clock budget is exhausted
- **THEN** the command output contains `wall-clock`
- **AND** the session file stores `wall-clock`

#### Scenario: Vacuous red is named
- **WHEN** a run stops because a red run exited zero
- **THEN** the command output contains `vacuous-red`
- **AND** the session file stores `vacuous-red`

### Requirement: Run exit codes
An emitted agent-step or complete request SHALL use the needs-agent exit code. A budget stop, `unchanged-state`, `vacuous-red`, `infrastructure-failure`, `baseline`, or `retry-cap` SHALL use the success exit code and SHALL NOT print an orchestration request. An invalid budget, corrupt session, clock regression, missing required host metric, or HALT SHALL use the error exit code and SHALL NOT print an orchestration request.

#### Scenario: Exhausted budget exits success
- **WHEN** the agent-step budget is already exhausted
- **THEN** the process exits with code 0
- **AND** the output contains no orchestration request

#### Scenario: Invalid budget exits error
- **WHEN** the failure budget is not a positive integer
- **THEN** the process exits with code 1
- **AND** the output contains no orchestration request

#### Scenario: Vacuous red exits success
- **WHEN** a run stops with `vacuous-red`
- **THEN** the process exits with code 0
- **AND** the output contains no orchestration request

### Requirement: Exhausted session stays exhausted
A later process SHALL NOT open a zeroed session when the latest session stopped for `max-agent-steps`, `max-tasks`, `wall-clock`, `max-failures`, `unchanged-state`, `max-tokens`, `max-cost`, `vacuous-red`, or `retry-cap`. A new session SHALL be opened only when the invocation passes `--new-run`, and the closed session file SHALL remain. A stop for `infrastructure-failure` or `baseline` SHALL NOT by itself keep the next human-started run from retrying that check.

#### Scenario: Next process does not reset
- **WHEN** the latest session stop reason is `max-agent-steps` and the invocation omits `--new-run`
- **THEN** the run does not create a session with a zero agent-step count
- **AND** it prints no orchestration request

#### Scenario: Human opens a new session
- **WHEN** the human passes `--new-run` after a budget stop
- **THEN** a new run id is stored with an agent-step count of zero
- **AND** the previous session file remains

#### Scenario: Retry cap stays stopped
- **WHEN** the latest session stop reason is `retry-cap` and the invocation omits `--new-run`
- **THEN** the run prints no orchestration request

#### Scenario: Infrastructure failure can be retried
- **WHEN** the latest session stop reason is `infrastructure-failure` and the human starts run again without `--new-run`
- **THEN** the run retries the failed check instead of keeping the previous stop

### Requirement: Skill re-entry preserves the session
Every factory-run skill shipped in this repository SHALL tell the IDE to invoke the run command again without `--new-run`. Each copy SHALL name `max-agent-steps`, `max-tasks`, `wall-clock`, `max-failures`, `unchanged-state`, `vacuous-red`, `infrastructure-failure`, `baseline`, and `retry-cap` as stop conditions. It SHALL say that only the human may pass `--new-run` after `vacuous-red` or `retry-cap`.

#### Scenario: Skill does not reset the budget
- **WHEN** a shipped factory-run skill is read
- **THEN** it does not instruct the IDE to pass `--new-run`
- **AND** it names `max-agent-steps` and `unchanged-state` as stop conditions

#### Scenario: Skill names the red stops
- **WHEN** a shipped factory-run skill is read
- **THEN** it names `vacuous-red` and `retry-cap` as stops that wait for the human to pass `--new-run`
