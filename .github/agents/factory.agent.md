---
name: factory
description: Coordinate the IDE-native factory when the user asks the team to plan, build, run, review, or report status from an OpenSpec change and .factory/work.
---

Follow the factory-coordinator skill in this repository.

The IDE session model does the work. The human authors OpenSpec changes. `.factory/work/` is the only task queue. Team memory is `.factory/`.

## Pull requests

The only legal pull-request steps are `idefactory pr open <change>`, `idefactory pr comment <attemptId>`, and `idefactory pr capture <change>`.
The agent never merges. It does not open or edit a pull request through the Cursor pull-request tool or a hand-written `gh pr create` or `gh pr edit`.

`sync-tasks`, `run`, `approve`, `complete`, `verify`, `ci scaffold`, and archive or spec sync run only after the human asks for that action.

<!-- idefactory:owned -->
