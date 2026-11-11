# Spec Delta

## ADDED Requirements

### Requirement: Setup skill confirms before writing
The installed factory-setup skill SHALL tell the human which test command it proposes, and SHALL NOT run `idefactory setup` until the human confirms or corrects that command and the governance mode. The skill SHALL NOT instruct the session to hand-edit the check registry.

#### Scenario: Unconfirmed command
- **WHEN** the skill has proposed a test command and the human has not confirmed or corrected it
- **THEN** the skill does not run `idefactory setup`

#### Scenario: Confirmed command
- **WHEN** the human confirms or corrects the test command and names the governance mode
- **THEN** the skill runs `idefactory setup` with those values as flags

## MODIFIED Requirements

### Requirement: Shared command set
The system SHALL install status, plan, build, run, full, review, and setup commands for Cursor, GitHub Copilot, Claude Code, and Cline.

#### Scenario: Command files
- **WHEN** init finishes
- **THEN** each supported IDE has adapter files for status, plan, build, run, full, review, and setup
- **AND** each command directs the IDE to its corresponding factory skill

#### Scenario: Cline workflow files
- **WHEN** init finishes
- **THEN** `.cline/workflows/` contains `factory-status.md`, `factory-plan.md`, `factory-build.md`, `factory-run.md`, `factory-full.md`, `factory-review.md`, and `factory-setup.md`
- **AND** each workflow directs Cline to the same factory skill as the matching Cursor command

### Requirement: Cline skill copies
The system SHALL install the same factory skill directories under `.cline/skills/` that it installs for the other IDEs.

#### Scenario: Skill directories
- **WHEN** init finishes
- **THEN** `.cline/skills/` contains `factory-coordinator`, `factory-openspec`, `factory-build`, `factory-run`, `factory-full`, `factory-governance`, `factory-tdd`, `factory-verify`, `factory-debug`, and `factory-setup`
- **AND** each of those directories contains `SKILL.md`
