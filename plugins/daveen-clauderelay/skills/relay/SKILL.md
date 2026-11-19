---
name: relay
description: Use when resuming unfinished development work, switching Claude accounts, ending a session with work in progress, registering a branch as a task, or auditing unmerged branches. Provides the daveen-clauderelay tasks, checkpoints and Git-verified resume.
---

# daveen-clauderelay

Machine-wide handoff so unfinished work survives account switches and new sessions. claude-mem answers "what happened before", the task record answers "what is the current task and what remains", Git answers "what actually exists". Project-specific conventions always take precedence over this skill.

The CLI is `wc.mjs` in this plugin's scripts folder. The SessionStart briefing (marked `[daveen-clauderelay]`) prints its exact path; call it as `node "<that path>" <command>`.

## Rules
1. Always identify the current project and branch (`status`).
2. Retrieve the task and latest checkpoint before resuming (`resume`).
3. Search claude-mem when the briefing is not enough: search, then timeline, then get_observations. Never replay a whole old conversation.
4. Every independent development branch has a task (`task new --title "..."`). Existing unmerged branches: `audit --register`.
5. Switching accounts or starting a new session is NOT a new task. Resume the existing one.
6. Before intentionally ending unfinished work, or when a usage limit is near, save a checkpoint.
7. Never discard uncommitted changes during recovery: no reset, clean, checkout-over or stash without explicit approval.
8. Never report a test as passing unless it was executed. The tool rejects passed tests that were not run.
9. Never close an unmerged task. Only `merged` (verified against Git) or an explicit `abandoned` / `superseded` with a reason closes one.
10. Reconcile the checkpoint with real Git state. Where they disagree, Git wins and the discrepancy is reported.
11. Use Argent when its Work Registry is operational (briefing says mode A).
12. Otherwise use the local fallback (modes B and C). Never lose a checkpoint because Argent is offline.

## Saving a checkpoint
Write a JSON file with the Write tool (never through shell backticks or heredocs), then run:

`checkpoint --task <id> --from <file.json> --based-on <seq shown by resume>`

Fields: summary, completed[], remaining[], decisions[], problems[], blockers[], nextAction, files[], context, tests{executed[], passed[], failed[], required[]}. Git facts (commit, staged, modified, untracked, diff) are captured by the tool, not by you.

If it reports a diverged checkpoint, another session saved newer work: run `resume`, merge the two, save again with the new `--based-on`.

## Other commands
- `status` mode, project, branch, task. `doctor` diagnostics.
- `task list [--all]`, `task show <id>`, `task update <id> --status paused|blocked|review-ready|active --next "..."`.
- Close: `task update <id> --status merged` (Git-verified, or `--confirmed-integrated "<evidence>"` for squash merges); `--status abandoned --reason "..."`.
- `audit` lists unmerged branches and flags untracked ones. `reconcile` pushes pending tasks to Argent when its registry exists.
