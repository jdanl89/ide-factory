# project-install Specification

## Purpose
Installs factory team memory and IDE instructions into a new or existing software project without discarding work already there.

## Requirements

### Requirement: Install shared state and adapters
The system SHALL create `.factory/` team state and Cursor, GitHub Copilot, Claude Code, and Cline instruction files when `idefactory init` runs in a project.

#### Scenario: New project
- **WHEN** init runs in a directory that has no `.factory/`
- **THEN** the directory contains `.factory/team.md`, `.factory/routing.md`, `.factory/decisions.md`, `.factory/config.json`, a Cursor rule, a Cursor skill named `factory-coordinator`, a Copilot agent file, and a Claude Code skill named `factory-coordinator`

#### Scenario: Existing unrelated files
- **WHEN** init runs in a directory that already contains an application file
- **THEN** that application file is unchanged

#### Scenario: Cline adapter files
- **WHEN** init runs in a directory that has no `.factory/`
- **THEN** the directory contains `.cline/rules/factory.md`, `.cline/skills/factory-coordinator/SKILL.md`, and `.cline/workflows/factory-status.md`

### Requirement: Preserve team memory on reinstall
The system SHALL keep an existing non-empty `.factory/decisions.md` and an existing agent history that contains a session note when init runs again.

#### Scenario: Decisions survive
- **WHEN** `decisions.md` already contains an accepted decision and init runs again
- **THEN** that decision text is still present

#### Scenario: History survives
- **WHEN** an agent history contains a session note and init runs again
- **THEN** that session note is still present

### Requirement: Merge instruction files
The system SHALL insert a marked factory section into an existing `AGENTS.md`, `CLAUDE.md`, or `.github/copilot-instructions.md` and SHALL NOT replace the rest of that file.

#### Scenario: Existing AGENTS.md
- **WHEN** `AGENTS.md` already contains project text and init runs
- **THEN** the project text remains and a factory section delimited for idefactory is present

### Requirement: Leave other team systems alone
The system SHALL NOT create, modify, or delete a `.squad/` directory.

#### Scenario: Squad directory present
- **WHEN** `.squad/team.md` exists and init runs
- **THEN** `.squad/team.md` is byte-for-byte unchanged

### Requirement: Run budget defaults
When init creates `.factory/config.json`, that file SHALL include positive integer defaults for maximum agent steps, completed tasks, wall-clock duration, and tool failures. When `.factory/config.json` already exists, init SHALL leave it byte-for-byte unchanged.

#### Scenario: New project budgets
- **WHEN** init runs in a directory that has no factory config
- **THEN** the new config sets a positive maximum for agent steps, completed tasks, wall-clock duration, and tool failures

#### Scenario: Existing config preserved
- **WHEN** `.factory/config.json` already exists and init runs again
- **THEN** that file is byte-for-byte unchanged

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

### Requirement: Profile human gates
A new init SHALL write `profiles.json` with `release.humanGate` true and `security-sensitive.humanGate` true. A later init SHALL leave an existing `profiles.json` byte-for-byte unchanged.

#### Scenario: New install gates
- **WHEN** init runs in a project that has no `profiles.json`
- **THEN** `release.humanGate` is true
- **AND** `security-sensitive.humanGate` is true

#### Scenario: Existing profiles survive
- **WHEN** `profiles.json` already exists and init runs again
- **THEN** that file is byte-for-byte unchanged

### Requirement: Preserve unrelated Cline files
Init and upgrade SHALL NOT modify an existing `.cline/` file that the factory does not own.

#### Scenario: Team style rule
- **WHEN** `.cline/rules/team-style.md` already exists and init runs
- **THEN** that file is byte-for-byte unchanged

#### Scenario: Upgrade leaves a team file
- **WHEN** `.cline/rules/team-style.md` already exists and upgrade runs
- **THEN** that file is byte-for-byte unchanged

### Requirement: Instruction section names Cline
The marked factory instruction section SHALL name the Cline factory rule.

#### Scenario: Agents section
- **WHEN** init merges the factory section into `AGENTS.md`
- **THEN** that section names `.cline/rules/factory.md`

### Requirement: Preserve check registry
A later init SHALL leave an existing `.factory/checks.json` byte-for-byte unchanged.

#### Scenario: Existing registry survives reinstall
- **WHEN** `checks.json` already contains a project-specific entry and init runs again
- **THEN** that file is byte-for-byte unchanged

### Requirement: New install uses lightweight policy
A new init SHALL set governance policy version to 1 in `.factory/config.json` and SHALL NOT write a principal verifier. A later init SHALL leave an existing policy version unchanged.

#### Scenario: First init sets version 1
- **WHEN** init runs in a directory that has no `.factory/`
- **THEN** `.factory/config.json` records governance policy version 1
- **AND** it contains no principal verifier

#### Scenario: Reinstall keeps the policy version
- **WHEN** `config.json` already records governance policy version 2 and init runs again
- **THEN** that policy version is still 2
