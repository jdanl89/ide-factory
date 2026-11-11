# Proposal

## Why

Every work item goes through the same role sequence, including security review when the classifier sees words like "security" or "auth". A one-file bug fix pays for that sequence, and a rejection's reason stays on the old attempt, so the next attempt starts as if the review never happened. Small changes need a shorter route, and a new attempt needs the rejection that caused it.

## What Changes

- Add an opt-in delivery route, `quick` or `full`. Full stays the default. Quick runs engineer, then reviewer, then complete. It does not request the architect, test-engineer, or security-reviewer. The security stage still runs when the human's `factory` block sets `securityProfile` to `security-sensitive` or lists a security-patterned check. Words in the task title do not start that stage on a quick route.
- The human sets the route with a `factory.route` field on the OpenSpec task, or with a change-level default. The classifier may suggest `quick` for a small fix. It does not switch the route by itself.
- When a reviewer or security reviewer rejects an attempt, the next implementer packet for that same work item includes the stored rejection notes from earlier attempts. The notes are appended. They are not a new queue and they do not authorize the next attempt.

## Capabilities

### New Capabilities

- `delivery-route`: Choose a full or quick role sequence per change or task, defaulting to full. A quick route skips architect, test-engineer, and inferred security review. An explicit security profile or security-patterned check in the human's factory block still runs the security stage.

### Modified Capabilities

- `guided-build`: The implementer packet for a later attempt includes the rejection notes stored on earlier attempts for the same work item.

## Impact

- `src/lib/classify.mjs` and `src/lib/orchestrate.mjs` (role sequence for a run), plus the packet built by `idefactory next` and `idefactory run`.
- Attempt review notes already stored by `src/lib/attempt.mjs`. The packet gains those notes. No new work queue.
- Factory-build and factory-run skill text, so the implementer is told to read the rejection notes and a quick route is not treated as permission to skip review.
- Tests in `test/orchestration.test.mjs` and `test/queue.test.mjs`.

## Out of scope

- Setup, test-command detection, and governance mode. That is `add-guided-setup`.
- Red-test classification, the per-kind red record, the baseline run, and the retry cap. That is `adopt-red-test-policy`.
- A multi-stage planning pipeline (goals, research, design, phasing, structure), per-task git worktrees, or a new artifact tree beside OpenSpec.
- Letting the agent choose the route, merge a pull request, or treat a rejection note as an approval.
