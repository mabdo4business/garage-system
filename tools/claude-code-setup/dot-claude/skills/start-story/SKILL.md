---
description: Start work on a backlog story from docs/implementation-plan.md (e.g. /start-story I1-05). Plans before coding.
disable-model-invocation: true
---

Start story $ARGUMENTS.

1. Find $ARGUMENTS in `docs/roadmap.md`. If its status is `proposed`, stop: its track's decision (D-34, D-35 or D-36)
   is not recorded yet. Read the story in `docs/implementation-plan.md` (Track A) or its row in `docs/roadmap.md`
   (Tracks B–D): goal, scope, acceptance tests, dependencies and the
   owner decisions it needs. Check `docs/decisions.md`. If a required decision is still open, stop and ask me — do not
   assume an answer.
2. Read only the spec sections the story cites in `docs/spec/`.
3. Make sure the working tree is clean and create a branch `story/$ARGUMENTS-<short-name>` from the current increment
   branch. In `docs/roadmap.md` set the story to `in progress`, fill Branch, and update "Current position".
4. Present a plan and wait for my approval:
   - migration(s): tables, constraints, indexes, grants to `garage_app`
   - commands: name, lock order, audit actions, outbox topics, idempotency
   - permissions and handlers
   - UI screens and i18n keys (Arabic and English)
   - the test list mapped to every acceptance criterion, including negative, authorization and concurrency cases
5. After approval, follow the `add-migration` and `add-command` skills, implement, run `npm run check`, then ask the
   `integrity-reviewer` subagent to review. Fix findings, re-run `npm run check`, set the story to `done (unmerged)`
   with today's date in `docs/roadmap.md`, and commit (roadmap included) with the story ID in the message. Report what passed using the actual test output.
