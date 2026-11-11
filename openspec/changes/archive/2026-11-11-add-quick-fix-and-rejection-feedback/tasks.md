# Tasks

## 1. Route parsing

- [x] 1.1 Parse `factory-route: quick|full` before the first checkbox in `tasks.md`, and `factory.route` under a checkbox. Store `factory.route` on the work item. Missing means `full`. A task value overrides the change line. Any other value fails sync and does not write that item. Verify `test/queue.test.mjs` for the default, the override, and the rejected value.
- [x] 1.2 Print `suggested route: quick` for an unset route whose title looks like a bug fix, and do not store the suggestion. Verify the sync output contains the suggestion and the written work item route is `full`.

## 2. Quick and full sequences

- [x] 2.1 For route `quick`, stop inferring `securityProfile` and security-patterned checks from task text. Keep an explicit `factory.securityProfile` and explicit `factory.checks`. Set the role list to engineer, reviewer, and scribe. Route `full` keeps today's inference. Verify a classify test: a quick item titled "fix auth" does not request a security profile, and the same title on a full item does.
- [x] 2.2 Make `stageForState` use the engineer as the implementer for a quick item, and request the security-reviewer only for an explicit security profile or an explicit security-patterned check. Verify `test/orchestration.test.mjs`: a quick "auth" item's next request is the engineer and then the reviewer, and a quick item with `securityProfile: security-sensitive` requests the security-reviewer before the reviewer.

## 3. Prior rejections

- [x] 3.1 When printing an implementer packet, append prior rejection notes for the same change and task, in `createdAt` order, each with its attempt id, including a security-reviewer `REJECT` note. Omit the section when there is no prior rejection. Do not add the section to a reviewer packet. Verify `test/queue.test.mjs` for both packets, and that a completion test still fails when the only new input is that note and no approval exists.
- [x] 3.2 Tell factory-build to read the prior-rejection section and address it, and tell factory-run that a quick route still requires the reviewer. Update every IDE copy the installer ships. Verify the installed factory-build skill contains the prior-rejection instruction and the installed factory-run skill says the reviewer is still required on a quick route.
