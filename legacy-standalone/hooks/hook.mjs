#!/usr/bin/env node
// Claude Code hook entry for work-continuity. Usage: node hook.mjs <EventName>
// Fail-soft by design: any error, timeout or odd input exits 0 with no output, so a Claude session is never blocked by it.
// Coexists with claude-mem (plugin-owned hooks) and Argent hooks; it does not read or write their data.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as C from '../lib/core.mjs';

const event = process.argv[2];
const CLI = C.posix(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wc.mjs'));
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NUDGE_EVERY_EDITS = 30;
const STOP_MIN_EDITS = 3;

const bail = setTimeout(() => process.exit(0), 8000);   // hard ceiling, well under the registered hook timeouts
const done = () => { clearTimeout(bail); process.exit(0); };
const emit = (o) => { process.stdout.write(JSON.stringify(o)); };
const context = (name, text) => emit({ hookSpecificOutput: { hookEventName: name, additionalContext: text } });

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  await new Promise((res) => {
    const t = setTimeout(res, 1500);
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => { clearTimeout(t); res(); });
    process.stdin.on('error', res);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/** Mechanical safety net: store Git facts for the branch's task without any narrative. Never overwrites a manual checkpoint. */
function autoSnapshot(info, sid) {
  if (info.kind !== 'git') return;
  const t = C.taskForBranch(info.key, info.branch);
  if (!t) return;
  const g = C.gitState(info, { diffLimit: 0 });
  const cp = C.readLatest(info.key, t.id);
  if (!g.dirty && cp) return;                                // nothing new to protect
  C.saveCheckpoint(info, t.id, {}, { kind: 'auto', session: sid });
}

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const sid = input.session_id || 'unknown';

  if (event === 'SessionStart') {
    C.pruneSessions();
    const det = await C.detectAll(cwd);
    const s = C.loadSession(sid);
    s.edits = 0; s.stopReminded = false; s.source = input.source ?? null;
    const t = det.git ? C.taskForBranch(det.info.key, det.info.branch) : null;
    const hasAnything = t || Object.values(C.loadTasks(det.info.key).tasks).some((x) => C.OPEN.has(x.status));
    if (!det.git && !hasAnything) return done();             // plain folder with no history: stay silent
    const r = C.buildResume(det, { cliPath: CLI });
    s.seenSeq = t ? (C.readLatest(det.info.key, t.id)?.seq ?? 0) : null;
    C.saveSession(s);
    if (!hasAnything && det.info.branch === det.info.target) return done();   // clean repo on the target branch, no tasks
    return context('SessionStart', r.text);
  }

  const info = C.identify(cwd);

  if (event === 'PreToolUse') {
    if (info.kind !== 'git' || !EDIT_TOOLS.has(input.tool_name)) return done();
    const s = C.loadSession(sid);
    const last = s.nudges[info.top];
    if (last && Date.now() - last < 5 * 60 * 1000) return done();           // checked recently: skip all Git work
    s.nudges[info.top] = Date.now();
    C.saveSession(s);
    if (info.branch === info.target || info.branch === 'HEAD') return done();
    if (C.taskForBranch(info.key, info.branch)) return done();
    return context('PreToolUse', `[work-continuity] Branch ${info.branch} has no registered task. Every development branch needs one so work survives an account switch. Register it now (one command, does not touch Git): node "${CLI}" task new --title "<what this branch does>"`);
  }

  if (event === 'PostToolUse') {
    if (!EDIT_TOOLS.has(input.tool_name)) return done();
    const s = C.loadSession(sid);
    s.edits += 1; s.lastEditAt = Date.now();
    C.saveSession(s);
    if (s.edits % NUDGE_EVERY_EDITS === 0 && info.kind === 'git') {
      const t = C.taskForBranch(info.key, info.branch);
      if (t) return context('PostToolUse', `[work-continuity] ${s.edits} edits this session. If you reached a stable point, save a checkpoint for ${t.id} (node "${CLI}" checkpoint --task ${t.id} --from <file.json>).`);
    }
    return done();
  }

  if (event === 'PreCompact') { autoSnapshot(info, sid); return done(); }

  if (event === 'Stop') {
    if (input.stop_hook_active || info.kind !== 'git') return done();      // never loop; non-git has nothing to enforce
    const s = C.loadSession(sid);
    if (s.stopReminded || s.edits < STOP_MIN_EDITS) return done();
    const t = C.taskForBranch(info.key, info.branch);
    const cp = t ? C.readLatest(info.key, t.id) : null;
    const fresh = cp && s.lastEditAt && Date.parse(cp.at) >= s.lastEditAt;
    if (fresh) return done();
    if (!C.gitState(info, { diffLimit: 0 }).dirty) return done();          // everything committed: Git already holds the work
    s.stopReminded = true; C.saveSession(s);                                // once per session, then never again
    const how = t ? `node "${CLI}" checkpoint --task ${t.id} --from <file.json> --based-on ${cp?.seq ?? 0}`
      : `node "${CLI}" task new --title "<title>"  then  checkpoint`;
    return emit({ decision: 'block', reason: `[work-continuity] You edited files this session and have uncommitted changes with no fresh checkpoint. If work is unfinished, save one before stopping: ${how}. If it is finished or throwaway, just stop again.` });
  }

  if (event === 'SessionEnd') {
    autoSnapshot(info, sid);
    const s = C.loadSession(sid); s.endedAt = C.nowIso(); s.endReason = input.reason ?? null; C.saveSession(s);
    return done();
  }
  done();
}

main().then(done, done);
