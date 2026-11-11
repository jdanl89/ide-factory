# Spec Delta

## Purpose

Records the project's test command and governance mode before the factory builds anything, either by asking in a terminal or by accepting answers the human already confirmed.

## ADDED Requirements

### Requirement: Terminal setup questions
When standard input is a terminal and the invocation omits the test decision or the governance mode, `idefactory setup` SHALL ask for the missing answers and SHALL write no config until both are answered.

#### Scenario: Both questions are asked
- **WHEN** setup runs in a terminal with neither a test decision nor a governance mode
- **THEN** it asks for the test command and for lightweight or strict governance
- **AND** it writes no check registry entry and no governance mode before both answers exist

### Requirement: Non-interactive setup does not guess
When standard input is not a terminal and the test decision or the governance mode is missing, `idefactory setup` SHALL write nothing, SHALL exit non-zero, and SHALL print the missing answer together with a command that supplies it.

#### Scenario: Missing answers without a terminal
- **WHEN** setup runs without a terminal and omits the governance mode
- **THEN** it writes no config
- **AND** the exit code is non-zero
- **AND** the output names the missing governance mode and a command that supplies it

### Requirement: Stored test command is an argv
A confirmed test command SHALL be stored as a non-empty argv array under the check kind. Setup SHALL reject a shell command string and SHALL write no registry entry for that kind.

#### Scenario: Shell string is rejected
- **WHEN** the confirmed test command is a single shell string
- **THEN** setup writes no argv for that kind
- **AND** the exit code is non-zero

#### Scenario: Argv is stored
- **WHEN** the human confirms the argv `dotnet`, `test` for kind `unit`
- **THEN** the check registry maps `unit` to that argv array

### Requirement: Recognized stack proposes a command
Setup SHALL propose one fixed argv for each recognized project manifest and SHALL write that argv only after the human accepts it or the invocation names that same argv.

#### Scenario: .NET project
- **WHEN** the project contains a `.sln` or `.csproj` and no other recognized stack
- **THEN** setup proposes the argv `dotnet`, `test`

#### Scenario: Node test script
- **WHEN** `package.json` has a non-empty `scripts.test` and no other recognized stack
- **THEN** setup proposes the argv `npm`, `test`

#### Scenario: Python tests
- **WHEN** the project contains `pyproject.toml`, `pytest.ini`, or `tox.ini` and no other recognized stack
- **THEN** setup proposes the argv `pytest`

#### Scenario: Go module
- **WHEN** the project contains `go.mod` and no other recognized stack
- **THEN** setup proposes the argv `go`, `test`, `./...`

#### Scenario: Rust package
- **WHEN** the project contains `Cargo.toml` and no other recognized stack
- **THEN** setup proposes the argv `cargo`, `test`

#### Scenario: Maven project
- **WHEN** the project contains `pom.xml` and no other recognized stack
- **THEN** setup proposes the argv `mvn`, `test`

#### Scenario: Gradle project
- **WHEN** the project contains `build.gradle` or `build.gradle.kts` and no other recognized stack
- **THEN** setup proposes the argv `gradle`, `test`

#### Scenario: RSpec project
- **WHEN** the Gemfile declares RSpec and no other recognized stack
- **THEN** setup proposes the argv `bundle`, `exec`, `rspec`

#### Scenario: PHPUnit project
- **WHEN** `composer.json` declares PHPUnit and no other recognized stack
- **THEN** setup proposes the argv `vendor/bin/phpunit`

### Requirement: One check kind per kept stack
When more than one stack is recognized, setup SHALL propose one kind per stack in this order: .NET, Node, Python, Go, Rust, Maven, Gradle, Ruby, PHP. The human SHALL name which kept stack is `unit`. When they do not name one, setup SHALL use the first kept stack in that order. Each other kept stack SHALL be recorded as `unit-` plus that stack's id (`dotnet`, `node`, `python`, `go`, `rust`, `maven`, `gradle`, `ruby`, or `php`). Setup SHALL NOT write a kind the human drops.

#### Scenario: .NET and Node default
- **WHEN** the project contains a `.csproj` and a `package.json` test script, the human keeps both, and does not name a unit stack
- **THEN** `unit` maps to `dotnet`, `test`
- **AND** `unit-node` maps to `npm`, `test`

#### Scenario: Human names the unit stack
- **WHEN** both stacks are kept and the human names Node as `unit`
- **THEN** `unit` maps to `npm`, `test`
- **AND** `unit-dotnet` maps to `dotnet`, `test`

#### Scenario: Dropped stack is not written
- **WHEN** two stacks are recognized and the human keeps only the second
- **THEN** the registry contains `unit` for the kept stack
- **AND** it contains no kind for the dropped stack

### Requirement: Unrecognized stack asks
When no stack is recognized, setup SHALL NOT invent an argv. It SHALL ask for one when a terminal is available, and SHALL refuse to finish when no argv and no explicit no-test decision is given.

#### Scenario: Unknown project
- **WHEN** the project has no recognized manifest
- **THEN** setup does not write a `unit` argv on its own

### Requirement: Lightweight governance
When the human selects lightweight governance, setup SHALL set the governance policy version to 1 and SHALL NOT write a principal verifier.

#### Scenario: Lightweight selection
- **WHEN** setup completes with governance mode lightweight and a confirmed test argv
- **THEN** `.factory/config.json` records policy version 1
- **AND** it contains no principal verifier

### Requirement: Strict governance
When the human selects strict governance, setup SHALL require a non-empty verifier argv, SHALL set the governance policy version to 2, and SHALL store that verifier argv. If the verifier argv is missing, setup SHALL write no governance change.

#### Scenario: Strict selection stores the verifier
- **WHEN** setup completes with governance mode strict, a confirmed test argv, and verifier argv `node`, `scripts/verify-principal.mjs`
- **THEN** the config records policy version 2
- **AND** the principal verifier argv is `node`, `scripts/verify-principal.mjs`

#### Scenario: Strict without a verifier writes nothing
- **WHEN** governance mode is strict and no verifier argv is given
- **THEN** setup writes no policy version change
- **AND** the exit code is non-zero

### Requirement: Explicit no-test decision
The human SHALL be able to record that the project has no test command. That decision SHALL leave no `unit` argv and SHALL count as the test decision.

#### Scenario: No test command
- **WHEN** the human records that there is no test command and selects lightweight governance
- **THEN** the registry has no `unit` argv
- **AND** the project records an explicit no-test decision

### Requirement: Confirmed replacement
A later setup SHALL replace only the check kinds and governance fields the human confirms, and SHALL leave every other registry kind and unrelated config field unchanged.

#### Scenario: Replace a placeholder unit command
- **WHEN** `unit` already maps to `npm`, `test` and the human confirms `dotnet`, `test`
- **THEN** `unit` maps to `dotnet`, `test`
- **AND** every other check kind is unchanged

### Requirement: Init and upgrade do not prompt
`idefactory init` and `idefactory upgrade` SHALL NOT read setup answers from the terminal. When the test decision is missing, or the policy version is 2 and the verifier argv is missing, the command SHALL print that gap, SHALL exit zero, and SHALL NOT rewrite an existing check registry or decisions log to fill the gap.

#### Scenario: Init prints the gap
- **WHEN** init creates a new factory install
- **THEN** it prints that the test decision is missing
- **AND** it exits zero
- **AND** it does not ask a question

#### Scenario: Upgrade does not fill the registry
- **WHEN** upgrade runs and `unit` has no argv
- **THEN** the check registry is unchanged
- **AND** the output names the missing test decision
