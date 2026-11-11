# Spec Delta

## MODIFIED Requirements

### Requirement: Doctor
`idefactory doctor` SHALL exit non-zero when `.factory/` or a required adapter file is missing, including `.cline/rules/factory.md` and `.cline/skills/factory-coordinator/SKILL.md`. It SHALL also exit non-zero when the install has no recorded test decision, or when governance policy version is 2 and no principal verifier argv is configured. It SHALL exit zero when the required files exist, a test decision is recorded, and a policy version 2 install has a verifier argv.

#### Scenario: Missing install
- **WHEN** doctor runs in an empty directory
- **THEN** the exit code is non-zero

#### Scenario: Healthy install
- **WHEN** doctor runs after init and setup has recorded a test argv or an explicit no-test decision, and policy version is not 2 without a verifier
- **THEN** the exit code is zero

#### Scenario: Missing Cline adapter
- **WHEN** doctor runs in a project that has factory state and is missing `.cline/rules/factory.md` or `.cline/skills/factory-coordinator/SKILL.md`
- **THEN** the exit code is non-zero
- **AND** the report names the missing Cline path

#### Scenario: Missing test decision
- **WHEN** doctor runs after init and the install has no test argv and no explicit no-test decision
- **THEN** the exit code is non-zero
- **AND** the report names the missing test decision

#### Scenario: Strict install without a verifier
- **WHEN** governance policy version is 2 and no principal verifier argv is configured
- **THEN** the exit code is non-zero
- **AND** the report names the missing verifier

### Requirement: Doctor policy report
Doctor SHALL report the governance policy version. Policy version 1 SHALL NOT by itself warn that gate approvals are unbound from a verified principal, and that version SHALL NOT by itself make the exit non-zero.

#### Scenario: Policy version is reported
- **WHEN** doctor runs on a healthy install
- **THEN** the report names the governance policy version

#### Scenario: Policy version 1 warning
- **WHEN** doctor runs on a healthy install whose governance policy version is 1
- **THEN** the exit code is zero
- **AND** the report does not warn that approvals are unbound from a verified principal
