# bounded-run-sessions Specification

## Purpose
Persists one bounded factory run so agent-step, task, wall-clock, and failure limits survive process re-entry and stop the run when they are exhausted.

## Requirements

### Requirement: Persisted run session
The run command SHALL resume the latest session for the named change across processes. The session file SHALL record schema version, run id, change name, start time, budgets, agent-step count, completed-task count, failure count, last request fingerprint, and stop reason.

#### Scenario: Re-entry keeps the same counters
- **WHEN** a session has recorded agent steps for a change and a new process runs that change
- **THEN** those agent steps are still recorded before any new request
- **AND** the run id is unchanged

#### Scenario: Session file location
- **WHEN** the first run for a change creates a session
- **THEN** the file is under `.factory/orchestration/runs/` and names that change

### Requirement: Agent-step budget
The run command SHALL persist an incremented agent-step count before emitting an agent-step request. Only an agent-step request increments that count. When the count is already at its maximum, the command SHALL emit no request and SHALL persist stop reason `max-agent-steps`.

#### Scenario: Cap holds across processes
- **WHEN** the session maximum is N and N earlier processes each emitted one agent-step request
- **THEN** the next process prints no orchestration request
- **AND** the persisted stop reason is `max-agent-steps`

#### Scenario: Complete does not consume an agent step
- **WHEN** the run emits a complete request
- **THEN** the agent-step count stays the same

### Requirement: Completed-task budget
The run command SHALL count work items finalized during the session. When that count reaches its maximum, the command SHALL emit no request and SHALL persist stop reason `max-tasks`.

#### Scenario: Finalized tasks reach the cap
- **WHEN** the session has finalized its maximum number of tasks
- **THEN** a later run prints no orchestration request
- **AND** the persisted stop reason is `max-tasks`

### Requirement: Wall-clock budget
The run command SHALL measure elapsed time from the session start time. When that elapsed time reaches the configured maximum, the command SHALL emit no request and SHALL persist stop reason `wall-clock`.

#### Scenario: Deadline reached
- **WHEN** the current time is at or after the session start plus the wall-clock budget
- **THEN** the run prints no orchestration request
- **AND** the persisted stop reason is `wall-clock`

### Requirement: Failure budget
The run command SHALL count distinct timed-out or non-passing verification results recorded after the session's failure baseline. A new session SHALL baseline every countable failure id that already exists and SHALL start at failure count zero. A recorded red result SHALL NOT increment that count. At the configured maximum, the command SHALL emit no request and SHALL persist stop reason `max-failures`.

#### Scenario: Red result is not a failure
- **WHEN** the only new check result is a recorded red result
- **THEN** the session failure count does not increase

#### Scenario: Timeouts reach the cap
- **WHEN** timed-out checks have already put the failure count at its maximum
- **THEN** the next run prints no orchestration request
- **AND** the persisted stop reason is `max-failures`

#### Scenario: New session ignores historical failures
- **WHEN** countable non-passing verification results already exist and a new run starts
- **THEN** the new session failure count is zero
- **AND** a non-passing verification result recorded during that session increments the count

### Requirement: Invalid budget
When the resolved agent-step, completed-task, wall-clock, or failure budget is missing, non-integer, or non-positive, the run command SHALL exit with an error, emit no request, and SHALL NOT create a session whose counters start at zero.

#### Scenario: Zero agent-step budget
- **WHEN** the configured maximum agent steps is zero
- **THEN** the run exits with an error
- **AND** it prints no orchestration request
- **AND** it does not leave an open session with a zero agent-step count

### Requirement: Corrupt session
When the latest session file is not valid JSON, uses an unsupported schema version, or lacks a required counter, the run command SHALL exit with an error, leave that file unchanged, and emit no request.

#### Scenario: Unreadable session file
- **WHEN** the latest session file is not valid JSON
- **THEN** the process exits with an error
- **AND** the file bytes are unchanged
- **AND** the output contains no orchestration request

### Requirement: Clock integrity
When the current time is earlier than the session start time, the run command SHALL exit with an error, persist stop reason `invalid-session`, and emit no request.

#### Scenario: Clock moves backward
- **WHEN** the current time is earlier than the session start time
- **THEN** the run prints no orchestration request
- **AND** the persisted stop reason is `invalid-session`

### Requirement: Unchanged state
When the next request would name the same attempt, role, and work-item status as the previous request, and that attempt state is unchanged, the run command SHALL emit no request and SHALL persist stop reason `unchanged-state`.

#### Scenario: Repeated request
- **WHEN** a previous run emitted a request and the attempt state and work-item status are unchanged
- **THEN** the next run prints no orchestration request
- **AND** the persisted stop reason is `unchanged-state`

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

### Requirement: Optional host usage
The run command SHALL enforce a token ceiling or a cost ceiling only when that ceiling is configured and the invocation exposes the matching host metric. A configured ceiling without its metric SHALL persist stop reason `host-usage-unavailable` and emit no request. An unconfigured ceiling SHALL NOT store a fabricated token or cost value.

#### Scenario: Host tokens reach the ceiling
- **WHEN** a token ceiling is configured and the invocation exposes a token count at or above it
- **THEN** the run prints no orchestration request
- **AND** the persisted stop reason is `max-tokens`

#### Scenario: Cost ceiling without a metric
- **WHEN** a cost ceiling is configured and the invocation exposes no cost
- **THEN** the run prints no orchestration request
- **AND** the persisted stop reason is `host-usage-unavailable`

#### Scenario: No ceiling and no metric
- **WHEN** neither a token ceiling nor a cost ceiling is configured and the invocation exposes neither metric
- **THEN** the session stores neither a token count nor a cost value
- **AND** the missing metrics do not stop the run

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

### Requirement: Halt does not touch the session
When a file named `HALT` exists in the project root, the run command SHALL exit with an error before creating or modifying a session file and SHALL emit no request.

#### Scenario: Halt before session write
- **WHEN** `HALT` exists and run executes
- **THEN** no session file is created or modified
- **AND** the output contains no orchestration request

### Requirement: Skill re-entry preserves the session
Every factory-run skill shipped in this repository SHALL tell the IDE to invoke the run command again without `--new-run`. Each copy SHALL name `max-agent-steps`, `max-tasks`, `wall-clock`, `max-failures`, `unchanged-state`, `vacuous-red`, `infrastructure-failure`, `baseline`, and `retry-cap` as stop conditions. It SHALL say that only the human may pass `--new-run` after `vacuous-red` or `retry-cap`.

#### Scenario: Skill does not reset the budget
- **WHEN** a shipped factory-run skill is read
- **THEN** it does not instruct the IDE to pass `--new-run`
- **AND** it names `max-agent-steps` and `unchanged-state` as stop conditions

#### Scenario: Skill names the red stops
- **WHEN** a shipped factory-run skill is read
- **THEN** it names `vacuous-red` and `retry-cap` as stops that wait for the human to pass `--new-run`
