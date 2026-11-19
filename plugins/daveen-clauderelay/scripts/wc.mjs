#!/usr/bin/env node
// wc: work-continuity CLI. Tasks, checkpoints, resume, branch audit. Works with or without Argent.
//   wc status | doctor | resume [--task ID]
//   wc task new --title T [--branch B] [--objective O] [--id ID] | task list | task show ID | task update ID [--status S ...]
//   wc checkpoint --task ID [--from file.json | --stdin] [--based-on SEQ]
//   wc audit [--register] | wc reconcile
// Add --json for machine output and --cwd DIR to act on another folder.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as C from '../lib/core.mjs';

const CLI = C.posix(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const pos = [], f = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const [k, v] = a.slice(2).split(/=(.*)/s);
  if (v !== undefined) f[k] = v;
  else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) f[k] = argv[++i];
  else f[k] = true;
}
const cwd = resolve(f.cwd || process.cwd());
const out = (human, data) => console.log(f.json ? JSON.stringify(data, null, 2) : human);
const die = (m, code = 1) => { console.error(`wc: ${m}`); process.exit(code); };
const strip = (d) => { const { _token, ...rest } = d.argent ?? {}; return { ...d, argent: rest }; };

function readInput() {
  try {
    if (f.from) return JSON.parse(readFileSync(resolve(String(f.from)), 'utf8').replace(/^﻿/, ''));
    if (f.stdin) return JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch (e) { die(`cannot read checkpoint JSON: ${e.message}`); }
  const a = (x) => (x ? String(x).split('|').map((s) => s.trim()).filter(Boolean) : undefined);
  return { summary: f.summary, completed: a(f.done), remaining: a(f.remaining), decisions: a(f.decisions), blockers: a(f.blockers),
    nextAction: f.next, files: a(f.files), context: f.context };
}

async function resolveTask(det, id) {
  const db = C.loadTasks(det.info.key);
  const t = id ? db.tasks[id] : (det.git ? C.taskForBranch(det.info.key, det.info.branch) : null);
  if (!t) die(id ? `no task ${id} in project ${det.info.key}` : `no open task for branch ${det.info.branch}; pass --task ID or register one with: task new`, 2);
  return t;
}

async function main() {
  const [cmd, sub, arg] = pos;
  const det = await C.detectAll(cwd);
  const { info } = det;

  if (!cmd || cmd === 'status') {
    const t = det.git ? C.taskForBranch(info.key, info.branch) : null;
    const cp = t ? C.readLatest(info.key, t.id) : null;
    const s = [`Operating mode: ${C.MODE_NAME[det.mode]}`,
      `ARGENT: ${det.argent.state.toUpperCase()}   CLAUDE-MEM: ${det.mem.available ? (det.mem.worker ? 'AVAILABLE' : 'INSTALLED (worker offline)') : 'NOT AVAILABLE'}   GIT: ${det.git ? 'AVAILABLE' : 'NOT A REPO'}   FALLBACK STORAGE: AVAILABLE`,
      `Project: ${info.name} (${info.key})${det.git ? `\nBranch: ${info.branch} -> ${info.target}` : ''}`,
      t ? `Task: ${t.id} "${t.title}" [${t.status}]\nLast checkpoint: ${cp ? `#${cp.seq} at ${cp.at}` : 'none'}` : 'Task: none for this branch'].join('\n');
    return out(s, { mode: det.mode, argent: strip({ argent: det.argent }).argent, mem: det.mem, git: det.git, project: info.key, branch: info.branch, task: t, checkpoint: cp?.seq ?? null });
  }

  if (cmd === 'doctor') {
    const { diagnose } = await import('../lib/doctor.mjs');
    const r = await diagnose(cwd);
    return out(r.text, r);
  }

  if (cmd === 'resume') {
    const r = C.buildResume(det, { taskId: f.task || (sub && sub !== 'resume' ? sub : undefined), cliPath: CLI });
    return out(r.text, { text: r.text, task: r.task });
  }

  if (cmd === 'task') {
    if (sub === 'new') {
      if (!f.title || f.title === true) die('--title is required');
      let id = f.id, source = 'local', argentMeta = det.argent.installed ? { pending: true } : null;
      const branch = f.branch === undefined ? (det.git && info.branch !== info.target ? info.branch : null) : (f.branch === 'none' ? null : f.branch);
      if (det.mode === 'A') {      // Argent is authoritative: its id wins
        const r = await C.argentCall(det.argent, 'POST', '/work/tasks', { project: info.key, title: f.title, branch, objective: f.objective, id });
        if (r?.status && r.status < 300 && r.json?.id) { id = r.json.id; source = 'argent'; argentMeta = { pending: false, syncedAt: C.nowIso() }; }
      }
      const r = C.createTask(info, { id, title: f.title, branch, targetBranch: f.target, objective: f.objective, nextAction: f.next, status: f.status, source, argent: argentMeta });
      return out(`${r.existed ? 'Task already exists for this branch' : 'Registered task'}: ${r.task.id} "${r.task.title}" [${r.task.status}] branch ${r.task.branch ?? '-'} (rev ${r.task.rev})`, r);
    }
    if (sub === 'list') {
      const db = C.loadTasks(info.key);
      const rows = Object.values(db.tasks).filter((t) => f.all || C.OPEN.has(t.status));
      return out(rows.length ? rows.map((t) => `${t.id}  [${t.status}]  ${t.branch ?? '-'}  rev ${t.rev}  ${t.title}`).join('\n') : '(no open tasks)', rows);
    }
    if (sub === 'show') { const t = await resolveTask(det, arg || f.task); return out(JSON.stringify(t, null, 2), t); }
    if (sub === 'update') {
      const id = arg || f.task; if (!id) die('task update needs an id');
      const patch = { title: f.title, objective: f.objective, nextAction: f.next, branch: f.branch, targetBranch: f.target, status: f.status };
      for (const k of Object.keys(patch)) if (patch[k] === undefined || patch[k] === true) delete patch[k];
      try {
        const t = C.updateTask(info, id, patch, { expectedRev: f.rev, confirmedIntegrated: f['confirmed-integrated'], reason: f.reason, supersededBy: f['superseded-by'] });
        return out(`Updated ${t.id} [${t.status}] rev ${t.rev}`, t);
      } catch (e) { die(e.message, e.code === 'E_CONFLICT' ? 3 : 1); }
    }
    die('usage: task new|list|show|update');
  }

  if (cmd === 'checkpoint') {
    const t = await resolveTask(det, f.task);
    const input = readInput();
    try {
      const r = C.saveCheckpoint(info, t.id, input, { kind: f.kind === 'auto' ? 'auto' : 'manual', basedOn: f['based-on'] ?? null, session: f.session || process.env.CLAUDE_SESSION_ID || null });
      if (r.diverged) return die(`checkpoint #${r.seq} was based on an older checkpoint (latest is #${r.latestSeq}). It is preserved in history (diverged) but did NOT replace the latest. Run: resume, merge the two, then save again with --based-on ${r.latestSeq}.`, 3);
      let note = '';
      if (det.mode === 'A') {
        const a = await C.argentCall(det.argent, 'POST', `/work/tasks/${encodeURIComponent(t.id)}/checkpoint`, r.checkpoint);
        const ok = !!(a?.status && a.status < 300);
        note = ok ? ' Mirrored to Argent.' : ' Argent did not accept it; kept locally and flagged for reconcile.';
        if (!ok) C.setArgent(info, t.id, { pending: true });
      } else if (det.mode === 'B') note = ' Argent registry unavailable: saved locally, will reconcile later.';
      return out(`Checkpoint #${r.seq} saved for ${t.id} (${r.checkpoint.git?.dirty ? 'working tree dirty' : 'clean'}, HEAD ${r.checkpoint.git?.commit?.slice(0, 8) ?? '-'}).${note}`, r);
    } catch (e) { die(e.message, e.code === 'E_TESTS' ? 4 : 1); }
  }

  if (cmd === 'audit') {
    const a = C.audit(info);
    if (f.register && det.git) {
      for (const r of a.rows) if (r.flag === 'UNTRACKED-UNMERGED') {
        const t = C.createTask(info, { title: r.subject || r.branch, branch: r.branch, objective: `Registered from audit: ${r.subject}`, status: r.current ? 'active' : 'paused', nextAction: 'Review branch state and decide: continue, merge or close.', argent: det.argent.installed ? { pending: true } : null }).task;
        r.registered = t.id;
      }
    }
    const txt = a.rows.length ? a.rows.map((r) => `${r.flag.padEnd(26)} ${r.branch}${r.current ? ' *' : ''}  +${r.ahead}  ${r.task ?? '-'}${r.status ? `[${r.status}]` : ''}${r.registered ? ` (registered ${r.registered})` : ''}  ${r.subject}`).join('\n') : (a.note || '(no branches besides target)');
    return out(txt + (a.orphanTasks?.length ? `\nOpen tasks whose branch no longer exists: ${a.orphanTasks.map((o) => `${o.id}(${o.branch})`).join(', ')}` : ''), a);
  }

  if (cmd === 'reconcile') {
    if (det.mode !== 'A') return out(`Argent Work Registry not operational (${det.argent.state}); nothing to reconcile. Pending tasks stay local.`, { reconciled: 0 });
    const db = C.loadTasks(info.key); let n = 0;
    for (const t of Object.values(db.tasks)) if (t.argent?.pending) {
      const r = await C.argentCall(det.argent, 'POST', '/work/tasks', { project: info.key, id: t.id, title: t.title, branch: t.branch, objective: t.objective, status: t.status });
      if (r?.status && r.status < 300) { C.setArgent(info, t.id, { pending: false, syncedAt: C.nowIso() }); n++; }
    }
    return out(`Reconciled ${n} task(s) to Argent.`, { reconciled: n });
  }

  die(`unknown command "${cmd}". Try: status, doctor, resume, task, checkpoint, audit, reconcile`);
}
main().catch((e) => die(e.message));
