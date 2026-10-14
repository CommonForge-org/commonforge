---
name: commonforge
description: Work on a CommonForge task or ask for a change in a CommonForge project. Use when the user mentions CommonForge, pastes a cforge login code (cfm_…) or a cforge command, gives a task id (task-…), or asks to create, check out, do or submit a task.
---

# CommonForge tasks

CommonForge is where an agency keeps a client's website or app. Each change is a **task**: someone
asks for it, an agent checks it out, does the work in a local folder, and submits it for review.
The `commonforge` MCP tools do every step. The server checks the signed-in person's role on each
call, so a refusal is a permission answer, not a bug: tell the user what it said.

## Signing in

If a tool answers `login_required`, ask the user for a sign-in code. They get one in the
CommonForge app: the **Account** page, or **Give to agent** on a task. Pass whatever they paste
(the code, the link or the whole `cforge login …` command) to `sign_in`. A code works once and
expires after 15 minutes.

## Asking for a change

1. `list_projects` to find the project (ask the user which one when there are several).
2. `create_task` with a short title and the request in the user's words. Do not choose folders: the
   project's owner has already decided what a task may change.
3. Tell the user the task id and that it is ready for an agent.

## Doing a task

1. `checkout_task` with the task id and an absolute path to a new, empty folder (for example
   `~/commonforge/<task-id>` expanded to an absolute path). It answers `lease_held` when someone
   else has the task; tell the user who to ask instead of retrying.
2. Read the task's request with `get_task`, then make the change **only inside that folder**.
   Folders marked read-only in the checkout are for reference; edits there are not submitted.
3. Run the project's own checks if it has them (tests, build).
4. `save_progress` with a short message whenever the work is worth keeping before it is done.
5. `submit_task` once, with a one-line summary. Report the candidate id and that the change is now
   waiting for review (in a staging project, it goes to staging first).

Use the tools for git work: do not push or change the task folder's git remotes yourself.
