# daveen-clauderelay

> Hand unfinished development work between Claude accounts and sessions. Tasks, checkpoints and a Git-verified resume.

Hit a usage limit, switched Claude accounts, or opened a fresh session? **ClaudeRelay** keeps a per-project record of
*what the current task is*, *what is done*, *what remains* and *what to do next*, then checks that record against the
real Git state when you resume. Git always wins over a written summary.

- **Plugin:** `daveen-clauderelay` **Marketplace:** `daveen-claudekit` **Version:** 0.1.0
- **Requires:** Windows, Node.js 18+, Git. No npm dependencies, no database, no network service.
- **Optional:** works with [claude-mem](https://github.com/thedotmack/claude-mem) and Argent Safehouse when present. It requires neither.

## Why

Three sources of truth, each answering a different question:

| Source | Answers |
|---|---|
| claude-mem | "What happened before?" |
| ClaudeRelay task + checkpoint | "What is the current task, and what remains?" |
| Git | "What actually exists on disk?" |

ClaudeRelay is the middle one. It never replays whole conversations. It stores a compact, structured handoff and
reconciles it with Git on every resume.

## Features

- **Tasks per branch.** Every independent development branch gets a task (`wc-001`, `wc-002`, ...). Switching accounts or starting a new session is *not* a new task: you resume the existing one.
- **Checkpoints.** Save summary, completed, remaining, decisions, problems, blockers, next action, files, context and test results. Git facts (commit, staged, modified, untracked, diff) are captured by the tool, never taken from the caller.
- **Git-verified resume.** A compact briefing shows the last checkpoint and a *drift* report: branch changed, new commits since the checkpoint, files changed or now clean. Where they disagree, Git wins.
- **Honest test reporting.** A checkpoint that lists tests as passed or failed without listing them as executed is rejected.
- **Safe closing.** An unmerged task cannot be closed. `merged` is verified against Git (or confirmed with evidence for squash merges). `abandoned` and `superseded` need a reason.
- **Divergence protection.** If two sessions save checkpoints, the older one is kept in history but does not overwrite the latest. A task revision guard saves stale updates aside instead of applying them.
- **Concurrent-session safe.** Cross-process locking and atomic writes, so a Desktop and a CLI session can work in the same project.
- **Branch audit.** Lists unmerged branches, flags untracked ones, closed-but-unmerged tasks and orphaned tasks; `--register` creates tasks for the untracked ones.
- **Automatic safety net (hooks).** Fail-soft hooks nudge you to register a task, save an auto snapshot before compaction and at session end, and remind you once at Stop if you have uncommitted edits and no fresh checkpoint.
- **Diagnostics.** `wc doctor` checks settings, plugin state, duplicate legacy hooks, claude-mem, Argent, storage and Git.
- **Read-only toward everything else.** Git is only read, never changed. claude-mem is never modified (a health probe only).

## Install

In Claude Code (Desktop or CLI):

```text
/plugin marketplace add "E:\DEVELOPER (WEB)\ANTROPIC-PLUGINS and SKILLS\CLAUDE-RELAY Plugin"
/plugin install daveen-clauderelay@daveen-claudekit
```

Restart open sessions afterwards, then verify:

```text
node "<plugin>/scripts/wc.mjs" doctor
```

**On another PC:** copy this folder, or push it to a Git repo and add it as `owner/repo`
(`/plugin marketplace add owner/repo`), then run the same install command.

**Upgrading from the old standalone installer** (`legacy-standalone/`): remove it first with
`node legacy-standalone/bin/install.mjs --remove-continuity` so hooks are not duplicated. Your saved data in
`~/.claude/work-continuity/` is kept and reused.

## Quick start

The SessionStart briefing (marked `[daveen-clauderelay]`) prints the exact CLI path. Examples below use `wc` for
`node "<plugin>/scripts/wc.mjs"`.

```text
wc status                                   # mode, project, branch, task
wc task new --title "Add invoice export"    # register the current branch as a task
wc resume                                   # briefing: last checkpoint + drift vs Git
wc checkpoint --task wc-001 --from cp.json --based-on 1
wc task update wc-001 --status merged       # Git-verified close
```

In Claude, the **`relay`** skill (`daveen-clauderelay:relay`) loads these rules automatically when you resume work,
switch accounts, end a session mid-task, or audit branches.

## CLI reference

| Command | Purpose |
|---|---|
| `status` | Operating mode, project, branch and current task |
| `doctor` | Diagnostics for config, plugin, claude-mem, Argent, storage, Git |
| `resume [--task ID]` | Continuation briefing, with drift against real Git state |
| `task new --title T [--branch B] [--objective O] [--id ID] [--next N]` | Register a task (defaults to the current non-target branch) |
| `task list [--all]` | Open tasks (all tasks with `--all`) |
| `task show ID` | Full task record |
| `task update ID [--status S] [--next N] [--title T] [--rev R]` | Update a task. `--rev` guards against stale writes |
| `checkpoint --task ID [--from file.json \| --stdin] [--based-on SEQ]` | Save a checkpoint |
| `audit [--register]` | List unmerged branches and flag problems; `--register` creates missing tasks |
| `reconcile` | Push locally pending tasks to Argent when its Work Registry exists |

Global flags: `--json` for machine output, `--cwd DIR` to act on another folder.

**Statuses:** `planned`, `active`, `paused`, `blocked`, `review-ready` (open) and `merged`, `abandoned`, `superseded` (closed).

**Closing a task**
- `--status merged`: verified against Git. For squash merges or deleted branches add `--confirmed-integrated "<evidence>"`.
- `--status abandoned --reason "..."` or `--status superseded --reason "..." [--superseded-by ID]`.

### Checkpoint file

Write the JSON with an editor or the Write tool, then pass it with `--from`:

```json
{
  "summary": "Export endpoint done, CSV escaping still open",
  "completed": ["Route and handler", "Unit tests for happy path"],
  "remaining": ["Escape commas and quotes", "Docs"],
  "decisions": ["Stream rows instead of buffering"],
  "problems": [],
  "blockers": [],
  "nextAction": "Write failing test for quoted fields",
  "files": ["src/export.js"],
  "context": "Branch feature/invoice-export",
  "tests": { "executed": ["npm test"], "passed": ["npm test"], "failed": [], "required": ["e2e export"] }
}
```

If a save reports a **diverged** checkpoint, another session saved newer work: run `resume`, merge the two, then save
again with the new `--based-on`.

## Operating modes

| Mode | Meaning |
|---|---|
| **A** | Argent Work Registry operational. Argent is authoritative; ClaudeRelay mirrors to it. |
| **B** | Argent installed but its registry is unavailable. Local fallback; run `reconcile` later. |
| **C** | Argent not installed. Standalone local storage. |

The current Argent Wire has no Work Registry yet, so mode A is only exercised against a mock of the proposed
`/work/...` contract. Modes B and C are the everyday paths.

## Hooks

| Event | What it does |
|---|---|
| `SessionStart` | Injects the resume briefing for the current branch's task |
| `PreToolUse` (edit tools) | Reminds you to register a task when a non-target branch has none (checked at most every 5 minutes) |
| `PostToolUse` (edit tools) | Counts edits; nudges for a checkpoint every 30 edits |
| `PreCompact` | Saves a mechanical auto snapshot of Git state |
| `Stop` | One reminder per session if there are 3+ edits, uncommitted changes and no fresh checkpoint |
| `SessionEnd` | Saves an auto snapshot and records the end reason |

Hooks are fail-soft: any error, timeout or odd input exits 0 silently, so they can never block a session. Auto
snapshots never overwrite a manual checkpoint.

## Where data lives

```text
~/.claude/work-continuity/projects/<project-key>/
    project.json   tasks.json   handoffs/<task>.json   handoffs/<task>.history/
```

Respects `CLAUDE_CONFIG_DIR`, and `WC_HOME` overrides the location. It sits outside the plugin cache, so plugin
updates never lose your data. Project identity comes from the Git remote or common dir, so Desktop and CLI sessions,
subfolders and worktrees resolve to the same project.

## Repository layout

```text
.claude-plugin/marketplace.json        marketplace daveen-claudekit
plugins/daveen-clauderelay/            the plugin
    .claude-plugin/plugin.json
    hooks/hooks.json, hook.mjs         six continuity hooks
    skills/relay/SKILL.md              the relay skill
    scripts/wc.mjs                       CLI
    lib/core.mjs, doctor.mjs           store, detection, resume, audit, diagnostics
tests/scenarios.mjs                    sandbox tests, scenarios A-G
legacy-standalone/                     earlier non-plugin installer (writes into ~/.claude)
```

## Testing

```text
node tests/scenarios.mjs
```

Runs 50 checks across scenarios A-G (Argent operational, degraded, absent; claude-mem unavailable; concurrent
sessions; existing unmerged branches; plugin manifest and coexistence) in a throwaway sandbox with a fake Claude
config dir and temporary Git repos. It touches nothing real.

## Safety rules

1. Git is read, never changed. Recovery never discards uncommitted changes (no reset, clean, checkout-over or stash without approval).
2. Tests are never recorded as passing unless they were executed.
3. An unmerged task is never closed except by an explicit `abandoned` or `superseded` with a reason.
4. If a checkpoint and Git disagree, Git wins and the discrepancy is reported.
5. A checkpoint is never lost because Argent is offline.
