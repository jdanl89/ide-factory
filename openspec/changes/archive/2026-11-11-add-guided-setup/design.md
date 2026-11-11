# Design

## Context

`idefactory init` copies `templates/factory/config.json` and `templates/factory/checks.json` with `writeIfMissing`, then never updates them. The template sets governance policy version 2 and maps `unit` to `npm test`. It does not set `governance.principalVerifier`. `upgrade` refreshes adapter files only. `doctor` exits zero after those files exist, and warns when policy version is 1. See proposal.md for why that blocks a new project.

Setup answers have to become check argv entries. The registry rejects a shell command string (`src/lib/verification-evidence.mjs`). Policy version 2 calls the configured verifier from `src/lib/principal.mjs` during approve, lockout resolve, and complete.

## Goals / Non-Goals

**Goals:**

- One command, `idefactory setup`, writes the test decision and the governance mode.
- The terminal and the chat skill use that same command. The skill cannot write a command the human has not confirmed.
- New installs start at policy version 1 with an empty check map.
- `doctor` fails closed until the test decision exists, and until a policy version 2 install has a verifier argv.

**Non-Goals:**

- Classifying red versus infrastructure failures, or changing when a task requires a failing test.
- Choosing a quick or full delivery route.
- Migrating this repository's existing policy version 2 config. `writeIfMissing` leaves it alone.

## Decisions

### Setup is a separate command

`init` and `upgrade` stay non-interactive and keep their current exit codes. They print the setup gap when the test decision or a required verifier is missing. Prompting inside `init` was rejected because scripts and cloud agents have no terminal.

`setup` takes the writer lease, the same as other mutations. A second writer gets the existing lease error.

### Detection is print-only until confirmed

`idefactory setup --detect` prints a JSON list of proposed kinds and argv arrays, in the spec order, and writes nothing. It does not take the writer lease. The terminal walkthrough and the factory-setup skill both start from that JSON. The skill shows it to the human and runs the writing form only after a confirmation or a correction.

The alternative, letting the skill infer the command from the repo itself, was rejected. The manifest table would live twice and drift.

Unrecognized manifests produce an empty list. Setup then asks, or exits non-zero when there is no terminal and no explicit decision.

### Flag form

A writing invocation names the governance mode and one or more maps:

```text
idefactory setup --governance lightweight --map unit --argv dotnet --argv test
idefactory setup --governance strict --map unit --argv dotnet --argv test --verifier-argv node --verifier-argv scripts/verify-principal.mjs
idefactory setup --governance lightweight --no-test
```

`--map` starts a kind. Following `--argv` values belong to that kind until the next `--map`. This matches the registry's argv array and does not require a shell parser. The interactive prompt splits the typed command on whitespace, which cannot represent an argument that itself contains a space. That case uses the flag form. The prompt says so.

`--no-test` stores `governance.testDecision: "none"` and removes a `unit` argv if the human is replacing one. Any stored check argv counts as a test decision, so an existing project that already maps `unit` stays healthy without running setup.

Lightweight writes `governance.policyVersion: 1` and removes `governance.principalVerifier` if a previous strict setup wrote it. Strict writes policy version 2 and `principalVerifier` `{ provider, timeoutMs, argv }`. The provider string defaults to `local` when the human does not name one. Timeout stays 5000. Strict with no verifier argv writes nothing.

Replacement is per kind. Kinds the invocation does not name are left in the registry.

### Which stack is `unit`

`--detect` marks the first stack in spec order as the default `unit` and the rest as `unit-<id>`. The human can name a different unit stack in the prompt or with `--map unit`. Dropped stacks are omitted from the invocation, so they are not written. An existing kind that this invocation does not mention is not deleted, except `unit` under `--no-test`.

### Doctor

`doctor` already warns on unmapped profile kinds and still exits zero for those warnings. It additionally exits non-zero when no check argv exists and `governance.testDecision` is not `"none"`, or when policy version is 2 and `principalVerifier.argv` is missing or empty. Policy version 1 no longer emits the unbound-principal warning. The version is still printed.

### Adapters

Add `templates/skills/factory-setup/SKILL.md` and a `factory-setup` command beside the other factory commands. `install.mjs` already copies every skill directory and the command list. The coordinator skill routes a human request to set up the factory, or a doctor report of a missing test decision or verifier, to factory-setup. It still stops and tells the human to run `init` when `.factory/team.md` is missing.

The skill's required sequence is `--detect`, show the proposal, wait for the human, then the writing command. It does not edit `checks.json` or `config.json` itself.

### New-install templates

`templates/factory/config.json` sets policy version 1 and omits `principalVerifier`. `templates/factory/checks.json` keeps `schemaVersion: 1` and sets `checks` to `{}`. Profiles stay as they are. Unmapped profile kinds remain warnings.

## Risks / Trade-offs

- [Existing consumer installs that copied policy version 2 and never configured a verifier start failing `doctor`] → `upgrade` prints the gap and the `setup` command. Their registry is not rewritten until they confirm.
- [Whitespace splitting drops arguments that contain spaces] → The flag form is the supported way to pass those arguments. The prompt says so.
- [An agent runs `setup --detect` and then the writing command without asking] → The skill forbids that, and the writing command is the only path that mutates config. A non-interactive writing command is an explicit human or skill invocation, same as `approve`.
- [`doctor` fails a brand-new init until setup runs] → `init` exits zero and prints the command. The failure is the point of the readiness check.

## Migration Plan

1. Change the templates and the install assertions together, so a new init matches policy version 1 and an empty check map.
2. Teach `doctor` the two new failures and drop the policy version 1 warning.
3. Add `setup`, including `--detect`, then the skill and command copies.
4. Update the README install section to run `idefactory setup` after `init`.

Rollback is reverting the template and the doctor rules. Existing configs are untouched, so rollback does not restore a config setup already wrote. The human re-runs setup to change it back.

## Open Questions

None. The stack order, the default `unit` stack, and the `--no-test` marker are specified.
