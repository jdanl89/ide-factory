# Design

## Context

`stageForState` in `src/lib/orchestrate.mjs` requests the security-reviewer when `securityProfile` is `security-sensitive` or a check name matches the security pattern. `classifyTask` in `src/lib/classify.mjs` sets that profile, and adds security checks, when the task text matches words such as "auth" or "security". The implementer is the first role that is not reviewer, scribe, or security-reviewer, so an architect-classified item is implemented by the architect. Rejection notes already land on `attempt.evidence.review.notes` in `src/lib/attempt.mjs`. `renderPacket` in `src/lib/queue.mjs` does not read other attempts. See proposal.md for why a small fix still pays for that path.

## Goals / Non-Goals

**Goals:**

- A human-set `quick` or `full` route, default `full`, stored on the work item.
- Quick requests engineer, then reviewer, then complete, and ignores security inferred from task text.
- The next implementer packet quotes prior rejection notes for the same work item.

**Non-Goals:**

- Changing red-test rules, setup, or the security stage's evidence requirements once that stage is actually requested.
- A planning pipeline in front of OpenSpec, or per-task worktrees.
- Persisting a classifier suggestion as if the human had chosen it.

## Decisions

### Where the route is stored

Sync reads two human inputs. A line `factory-route: quick` or `factory-route: full` at the start of `tasks.md`, before the first checkbox, is the change default. `factory.route` under a checkbox overrides it. Both use the existing simple YAML reader in `classify.mjs`. The stored field is `item.factory.route`. Omitted means `full`. Any other value fails sync and writes nothing, same as an unreadable tasks file.

The classifier may print `suggested route: quick` when the title looks like a bug fix and the route was not set. It does not write that suggestion onto the item. Printing was chosen over a stored `suggestedRoute` so a later reader cannot mistake it for the selected route.

### What quick changes in classification

For `route: quick`, `classifyTask` does not infer `securityProfile: security-sensitive` and does not add `threat-review`, `dependency-audit`, or other security-patterned checks from the task text. Explicit `factory.securityProfile` and explicit `factory.checks` are kept. The role list is `engineer`, `reviewer`, `scribe`. Scribe stays in the list because `complete` already updates scribe history. It is not a separate requested stage. `stageForState` then sees no inferred security profile, so it does not request the security-reviewer.

For `route: full`, classification is unchanged.

`stageForState` also takes the route: a quick item's implementer is `engineer` even if a stale role list still names the architect. The explicit-security check stays. This is defense in depth against a hand-edited work item.

Quick does not skip the reviewer and does not skip `complete`.

### Prior rejections

When rendering an implementer packet, read `.factory/attempts/*.json` for the same `change` and `taskId` whose state is `rejected` or whose `evidence.review.verdict` is `REJECT`, ordered by `createdAt`. Append a "Prior rejections" section with each attempt id and `evidence.review.notes`. Include a security-reviewer rejection note from `evidence.securityReview` when that verdict is `REJECT`. Reviewer and security-reviewer packets do not get the section. No notes means no section.

The section is text in the packet. It is not an approval file and not a work-queue item. `humanGateAllows` is unchanged.

factory-build tells the implementer to read that section and address it. factory-run says a quick route still requires the reviewer.

## Risks / Trade-offs

- [A quick task whose title says "auth" skips a security review the human would have wanted] → The default route stays `full`. Quick is opt-in, and an explicit `securityProfile` or security check in the factory block still requests the security-reviewer.
- [Old attempts with empty notes produce an empty section] → Omit a rejection that has no notes and no attempt id. An attempt id with empty notes is still listed, so the implementer knows a rejection happened.
- [Reading every attempt file on each packet is extra I/O] → The directory is the project's own attempts. No index is added in this change.

## Migration Plan

1. Parse and store the route, with sync tests, before changing `stageForState`.
2. Change classification and the stage function together so a quick item cannot infer security in one place and still request it in the other.
3. Add the packet section and the skill sentences.

Existing work items have no `route` field. Readers treat a missing route as `full`, so no migration rewrite is required. Rollback is reverting the readers. A stored `route: quick` becomes an ignored field.

## Open Questions

None. The default, the tasks.md line, and the decision not to persist the suggestion are specified.
