# delivery-route Specification

## Purpose
Lets a human pick a short role sequence for a small change, while a full change keeps the current roles and an explicit security request still gets a security review.

## Requirements

### Requirement: Route defaults to full
A work item SHALL have delivery route `quick` or `full`. When neither the task nor the change sets one, the route SHALL be `full`.

#### Scenario: Omitted route
- **WHEN** a task and its change set no route
- **THEN** the work item's route is `full`

### Requirement: Human sets the route
A task `factory.route` of `quick` or `full` SHALL set that task's route. A `factory-route:` line in the change's `tasks.md`, with value `quick` or `full`, SHALL be the default for tasks that omit `factory.route`. Any other value SHALL fail sync and SHALL NOT write the work item. Sync SHALL NOT change a route because of words in the task title.

#### Scenario: Task route wins
- **WHEN** the change default is `full` and the task sets `factory.route` to `quick`
- **THEN** that work item's route is `quick`

#### Scenario: Change default
- **WHEN** `tasks.md` contains `factory-route: quick` and the task omits `factory.route`
- **THEN** that work item's route is `quick`

#### Scenario: Invalid route fails sync
- **WHEN** `factory.route` is any value other than `quick` or `full`
- **THEN** sync fails and does not write that work item

#### Scenario: Suggestion does not switch the route
- **WHEN** the task title asks for a bug fix and no route is set
- **THEN** the stored route remains `full`

### Requirement: Quick role sequence
A `quick` item SHALL request the engineer, then the reviewer, then complete. It SHALL NOT request the architect or the test-engineer. It SHALL NOT request the security-reviewer because the task text inferred a security profile or a security check.

#### Scenario: Quick fix skips inferred security
- **WHEN** a `quick` item's title contains "auth" and its factory block sets no security profile and no security-patterned check
- **THEN** run does not request the security-reviewer
- **AND** the request roles are the engineer and then the reviewer

### Requirement: Explicit security still runs
A `quick` item SHALL request the security-reviewer before the reviewer when the human's factory block sets `securityProfile` to `security-sensitive` or lists a security-patterned check.

#### Scenario: Explicit security profile
- **WHEN** a `quick` item's factory block sets `securityProfile` to `security-sensitive`
- **THEN** run requests the security-reviewer before the reviewer

### Requirement: Full route is unchanged
A `full` item SHALL keep the role sequence and the security-stage trigger the factory uses today, including security inference from the task text.

#### Scenario: Full route still infers security
- **WHEN** a `full` item's title contains "auth" and no factory block overrides the profile
- **THEN** run requests the security-reviewer before the reviewer
