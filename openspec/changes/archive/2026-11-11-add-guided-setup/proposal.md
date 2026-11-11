# Proposal

## Why

A new project cannot finish factory work until someone hand-edits `.factory/config.json` and `.factory/checks.json`. New installs set governance policy version 2 with no principal verifier, and the only shipped test command is `npm test`. A .NET repo, or any non-Node repo, then fails closed after the agent has already spent its token budget. Operators need a setup walkthrough that records the test command and the governance mode before the factory builds anything.

## What Changes

- Add `idefactory setup`, re-runnable after `init` or `upgrade`. In a terminal it asks two questions: the test command, and governance mode. Without a terminal it does not guess; it prints the gap and the exact command to finish setup.
- In chat, a factory-setup skill inspects the repo, agrees the test command with the human, and only then runs `idefactory setup` with those answers as flags. The skill does not hand-edit `checks.json`.
- Detect a proposed test command for .NET, Node, Python, Go, Rust, Java, Ruby, and PHP. An unrecognized stack asks for the command. A repo with more than one stack records one check kind per stack the human keeps. The stored command is an argv array, never a shell string.
- **BREAKING:** A new install sets governance policy version 1 (lightweight) and does not write a `unit` → `npm test` placeholder. Strict mode is opt-in and records policy version 2 plus a principal verifier argv.
- **BREAKING:** `idefactory doctor` exits non-zero until setup has recorded at least one test argv or an explicit "no test command", and until a strict install has a verifier. Policy version 1 no longer warns that approvals lack a verified principal.
- `init` and `upgrade` stay non-interactive. They print the setup gap when one exists and do not rewrite an existing config, decisions log, or check registry.

## Capabilities

### New Capabilities

- `guided-setup`: Detect test commands, ask the two setup questions in the terminal or accept them as flags from the chat skill, and write governance mode plus check argv entries.

### Modified Capabilities

- `project-install`: A new install records governance policy version 1 and a check registry with no placeholder `unit` command. A later init still leaves an existing config and registry unchanged.
- `human-governance`: Doctor fails closed on a missing setup decision or a strict install with no verifier, and does not warn merely because policy version is 1.
- `ide-adapters`: Install a factory-setup skill and command that asks the human to confirm the test command, then runs `idefactory setup`.

## Impact

- `src/lib/install.mjs`, `src/lib/govern.mjs`, `src/lib/run.mjs`, and a new setup module.
- `templates/factory/config.json`, `templates/factory/checks.json`, and the factory-setup skill copied to every IDE adapter.
- `test/install.test.mjs` currently expects a new config to record policy version 2. That assertion changes. `test/doctor-foundations.test.mjs` gains the readiness cases.
- Existing projects keep their current `.factory/config.json` and `.factory/checks.json` until a human runs setup. This repository's policy version 2 verifier is not rewritten.

## Out of scope

- Whether a task must record a failing test, how a vacuous or infrastructure failure is classified, and retry caps. Those belong to `adopt-red-test-policy`.
- A quick-fix route and passing rejection notes to the next attempt. Those belong to `add-quick-fix-and-rejection-feedback`.
- A hosted identity provider. Strict mode stores the verifier command the human supplies.
- Rewriting unused profile kinds (`playwright`, `sast`, and the rest) into `checks.json`. Unmapped profile kinds stay doctor warnings.
- Prompting inside `init` or `upgrade`, or blocking a cloud agent on a question it cannot answer.
