# Spec Delta

## ADDED Requirements

### Requirement: Implementer packet includes prior rejections
The implementer packet for a work item SHALL include the rejection notes stored on earlier attempts for that same change and task, in attempt order, each with its attempt id. A packet for any other role SHALL NOT include those notes. When no earlier attempt was rejected, the implementer packet SHALL NOT contain a prior-rejection section. Rejection notes SHALL NOT authorize accept or complete.

#### Scenario: Second attempt sees the rejection
- **WHEN** an earlier attempt for the same work item was rejected with notes and next prints an implementer packet for a new attempt
- **THEN** the packet contains those notes and the rejected attempt id

#### Scenario: Reviewer packet omits the notes
- **WHEN** next prints a reviewer packet for a work item that has a prior rejection
- **THEN** the packet does not contain those rejection notes

#### Scenario: Notes do not authorize completion
- **WHEN** a prior rejection note exists and no scoped approval exists
- **THEN** the note does not authorize accept or complete
