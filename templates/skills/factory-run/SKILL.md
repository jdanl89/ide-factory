---
name: factory-run
description: >
  Bounded multi-task factory orchestration. Use when the user says /factory-run,
  run the factory until a gate, or asks the squad to carry an OpenSpec change
  through multiple work items. Human-started only. The IDE session model does the work.
---

# Factory run

Human-started bounded orchestration for one OpenSpec change.

<!-- idefactory:owned -->

## Loop

1. If `HALT` exists, stop.
2. Run:

```bash
idefactory run --change <name> --until human-gate
```

Each iteration resumes the persisted run session for the change. Do not reset budgets from this loop.

Optional: `--max-tasks N`, `--max-agent-steps N`, and other run flags the human configured.

3. Interpret the exit code:
   - `0` — stopped cleanly (all done, human-gate, or a persisted stop such as `max-agent-steps`, `max-tasks`, `wall-clock`, `max-failures`, `unchanged-state`, `vacuous-red`, `infrastructure-failure`, `baseline`, or `retry-cap`). Summarize and stop. Do not continue after `vacuous-red` or `retry-cap`.
   - `1` — error (lockout, blocked deps, rejection, invalid session or budget). Report and stop.
   - `2` — needs an agent step. Read the orchestration request JSON.

4. For exit `2`:
   - Spawn **one** IDE subagent for the request role (Cursor Task tool when available).
   - Prompt contains only that role's charter, history, the request, and named OpenSpec files.
   - Use `modelProfile` as a host hint when supported; never call a model HTTP API.
   - After the subagent returns, record evidence with `idefactory attempt transition`.
   - If the request action is `complete`, run `idefactory complete <change> <id> --attempt <id>`.

5. Repeat from step 2 until exit `0` or `1`. A `quick` route still requires the reviewer. It does not skip review or complete.

## Stop conditions

Persisted budget and state stops: `max-agent-steps`, `max-tasks`, `wall-clock`, `max-failures`, `unchanged-state`, `vacuous-red`, `infrastructure-failure`, `baseline`, and `retry-cap`. `infrastructure-failure` and `baseline` can be retried by the next human-started run. `vacuous-red` and `retry-cap` wait until the human passes `--new-run`. Other clean stops include all work items done or human-gate (true profile `humanGate`). Hard stops include halt, lockout, rejected review, failed verification evidence, and invalid session or budget errors.

## New session (human only)

After a sticky budget stop, `vacuous-red`, or `retry-cap`, the closed session stays in force until the **human** explicitly opens a new run, for example:

```bash
idefactory run --change <name> --new-run
```

Only the human may add that flag after `vacuous-red`, `retry-cap`, or another sticky stop; the factory-run loop never passes it.

## Pull requests

The only legal pull-request steps are `idefactory pr open <change>`, `idefactory pr comment <attemptId>`, and `idefactory pr capture <change>`.
The agent never merges. It does not open or edit a pull request through the Cursor pull-request tool or a hand-written `gh pr create` or `gh pr edit`.

`sync-tasks`, `run`, `approve`, `complete`, `verify`, `ci scaffold`, and archive or spec sync run only after the human asks for that action.

## Never

- Do not start this loop unattended or on a timer.
- Do not wrap `s4c watch` or any Ralph execute loop.
- Do not modify `.squad/` if present.
- Do not invent an OpenSpec product change.
