---
name: factory-setup
description: >
  Record the project's test command and governance mode. Use when the user
  asks to set up the factory, or when doctor reports a missing test decision
  or a missing principal verifier.
---

# Factory setup

You confirm the test command and the governance mode with the human, then run one command. The IDE session model does the work. Do not hand-edit `.factory/checks.json` or `.factory/config.json`.

1. Run `idefactory setup --detect` and show the human each proposed command.
2. Ask which stacks to keep, which stack is `unit` when more than one is kept, and whether governance is lightweight or strict.
3. Do not run `idefactory setup` before the human confirms or corrects the command and the governance mode.
4. After that confirmation, run the writing form with an argv array, for example `idefactory setup --governance lightweight --map unit --argv dotnet --argv test`.
5. Strict governance also needs one `--verifier-argv` flag per argv part. A project with no test command uses `--no-test` instead of `--map`.

<!-- idefactory:owned -->
