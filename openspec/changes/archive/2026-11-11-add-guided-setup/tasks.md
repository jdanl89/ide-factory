# Tasks

## 1. New-install templates

- [x] 1.1 Set `templates/factory/config.json` governance policy version to 1 and omit `principalVerifier`. Verify `test/install.test.mjs` asserts a new config records policy version 1 and has no principal verifier, and that a second init leaves an existing policy version 2 unchanged.
- [x] 1.2 Set `templates/factory/checks.json` to schema version 1 with an empty `checks` object. Verify a new install test asserts the registry does not map `unit`, and that a second init leaves an existing registry byte-for-byte unchanged.

## 2. Doctor readiness

- [x] 2.1 Make `doctor` exit non-zero when no check argv exists and `governance.testDecision` is not `"none"`, and when policy version is 2 and `principalVerifier.argv` is missing or empty. Name the missing test decision or the missing verifier in the report. Verify `test/doctor-foundations.test.mjs` covers both failures.
- [x] 2.2 Stop warning that policy version 1 leaves approvals unbound from a verified principal. Keep printing the policy version, and keep unmapped profile kinds as warnings that do not by themselves change the exit code. Verify a policy version 1 install with a mapped `unit` argv exits zero and the output does not contain that warning.

## 3. Setup command

- [x] 3.1 Add `idefactory setup --detect`. It prints JSON proposals for the recognized manifests in spec order, marks the first as `unit` and the rest as `unit-<id>`, writes nothing, and does not take the writer lease. Verify a fixture with a `.csproj` and a `package.json` test script proposes `dotnet test` as `unit` and `npm test` as `unit-node`, and that a directory with no manifest proposes an empty list.
- [x] 3.2 Add the writing form: `--governance lightweight|strict`, repeatable `--map <kind>` with following `--argv` values, `--no-test`, and repeatable `--verifier-argv`. Store argv arrays only. Reject a single shell string. Lightweight sets policy version 1 and removes a verifier. Strict without a verifier argv writes nothing and exits non-zero. `--no-test` sets `governance.testDecision` to `"none"` and removes `unit`. A later run replaces only the kinds it names. Verify these cases in a new `test/setup.test.mjs`, including that an unmentioned kind survives.
- [x] 3.3 When stdin is a terminal and a required answer is missing, prompt for the test command, the unit stack when more than one is kept, and the governance mode. When stdin is not a terminal and an answer is missing, write nothing, exit non-zero, and print the command that supplies the answer. Verify the non-interactive refusal with a piped or flag-omitted invocation. Verify the prompt path with a test double that supplies the two answers and asserts the written argv.
- [x] 3.4 Make `init` and `upgrade` print the missing test decision or the missing verifier, exit zero, and not rewrite an existing registry or `decisions.md`. Verify an init of an empty directory prints the gap, and an upgrade of a project with a custom decisions entry leaves that entry in place.

## 4. Chat skill and README

- [x] 4.1 Add `templates/skills/factory-setup/SKILL.md` and a `factory-setup` command for Cursor, Copilot, Claude Code, and Cline. The skill runs `idefactory setup --detect`, waits for the human to confirm or correct the command and the governance mode, then runs the writing form. It does not tell the session to hand-edit `checks.json`. Point the coordinator at this skill when the human asks to set up the factory or when doctor reports a missing test decision or verifier. Verify `test/install.test.mjs` finds `factory-setup` under `.cline/skills/` and `factory-setup.md` under `.cline/workflows/`, and that the skill text tells the session not to run setup before confirmation.
- [x] 4.2 Document `idefactory setup` in the README install section, including the lightweight default, the strict verifier flags, and `--no-test`. Verify a README test or an assertion in `test/install.test.mjs` finds `idefactory setup` and `--governance` in that section.
