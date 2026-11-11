# Spec Delta

## MODIFIED Requirements

### Requirement: Install check registry
Init SHALL write a schema-valid versioned check registry when the project has none, and that new registry SHALL contain no check argv. Init SHALL leave an existing registry byte-for-byte unchanged on reinstall.

#### Scenario: New project registry
- **WHEN** init runs in a directory that has no check registry
- **THEN** the project contains a schema-valid versioned check registry

#### Scenario: New registry has no unit command
- **WHEN** init runs in a directory that has no check registry
- **THEN** the new registry does not map `unit`

#### Scenario: Existing registry survives
- **WHEN** a check registry already exists and init runs again
- **THEN** that registry is byte-for-byte unchanged

## REMOVED Requirements

### Requirement: New install policy version
**Reason**: A new install now records policy version 1 and no principal verifier. The old requirement required version 2, and its scenario name says so.
**Migration**: The added requirement "New install uses lightweight policy" asserts policy version 1. An existing config is still left unchanged.

## ADDED Requirements

### Requirement: New install uses lightweight policy
A new init SHALL set governance policy version to 1 in `.factory/config.json` and SHALL NOT write a principal verifier. A later init SHALL leave an existing policy version unchanged.

#### Scenario: First init sets version 1
- **WHEN** init runs in a directory that has no `.factory/`
- **THEN** `.factory/config.json` records governance policy version 1
- **AND** it contains no principal verifier

#### Scenario: Reinstall keeps the policy version
- **WHEN** `config.json` already records governance policy version 2 and init runs again
- **THEN** that policy version is still 2
