// What the continuity layer registers in Claude Code's user configuration. One place, shared by installer and doctor.
import { join } from 'node:path';
import { CFG, ROOT, posix } from './core.mjs';

export const HOOK_MARK = '/work-continuity/hooks/hook.mjs';       // how we recognise our own hook commands
export const BEGIN = '<!-- work-continuity:begin (managed by work-continuity/bin/install.mjs) -->';
export const END = '<!-- work-continuity:end -->';
const EDITS = 'Edit|Write|MultiEdit|NotebookEdit';

/** event -> [{matcher?, timeout}]. Blocking events return context to Claude, so they are synchronous but fail-soft. */
export const HOOKS = {
  SessionStart: [{ matcher: 'startup|resume|clear|compact', timeout: 15 }],
  PreToolUse: [{ matcher: EDITS, timeout: 10 }],
  PostToolUse: [{ matcher: EDITS, timeout: 10 }],
  PreCompact: [{ timeout: 15 }],
  Stop: [{ timeout: 15 }],
  SessionEnd: [{ timeout: 15 }],
};

export const hookCommand = (event) => `node "${posix(join(ROOT(), 'hooks', 'hook.mjs'))}" ${event}`;
export const claudeMdPath = () => join(CFG(), 'CLAUDE.md');
export const settingsPath = () => join(CFG(), 'settings.json');

export function instructions() {
  const cli = `node "${posix(join(ROOT(), 'bin', 'wc.mjs'))}"`;
  return `# Argent Continuity (global, applies to every project)
Machine-wide work continuity so unfinished development survives account switches and new sessions. It works with Argent
Safehouse when its Work Registry is available and without it otherwise. claude-mem answers "what happened before",
the task record answers "what is the current task and what remains", and Git answers "what actually exists".
Project-specific conventions and architecture rules always take precedence over this section.

Rules:
1. Always identify the current project and branch (SessionStart injects them; run \`${cli} status\` if unsure).
2. Always retrieve the task and latest checkpoint before resuming work (\`${cli} resume\`).
3. Search historical memory (claude-mem mem-search: search, then timeline, then get_observations) when the briefing is not enough. Never replay a whole old conversation.
4. Every independent development branch has a task: \`${cli} task new --title "..."\`. Existing unmerged branches: \`${cli} audit --register\`.
5. Switching accounts or starting a new session is NOT a new task. Resume the existing one.
6. Before intentionally ending unfinished work, or when a limit is near, save a checkpoint (see below).
7. Never discard uncommitted changes during recovery. Never reset, clean, checkout over or stash someone's work without explicit approval.
8. Never report a test as passing unless it was actually executed. The checkpoint tool rejects passed tests that were not run.
9. Never close an unmerged task. Only \`merged\` (verified against Git) or an explicit \`abandoned\` / \`superseded\` with a reason closes one.
10. Always reconcile the checkpoint with real Git state; where they disagree, Git wins and the discrepancy is reported.
11. Use Argent when its Work Registry is operational (the briefing says mode A).
12. Use the local fallback when it is not (modes B and C). Never lose a checkpoint because Argent is offline.

Saving a checkpoint: write a JSON file with the Write tool (never through shell backticks or heredocs), then run it.
Fields: summary, completed[], remaining[], decisions[], problems[], blockers[], nextAction, files[], context,
tests{executed[], passed[], failed[], required[]}. Git facts (commit, staged, modified, untracked, diff) are captured by the tool itself.
  ${cli} checkpoint --task <id> --from <file.json> --based-on <seq shown by resume>
If it reports a diverged checkpoint, another session saved newer work: run resume, merge, and save again.
Closing a task: \`${cli} task update <id> --status merged\` (verified by Git, or --confirmed-integrated "<evidence>" for squash merges).
Diagnostics: \`${cli} doctor\`.`;
}
