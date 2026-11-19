// Work-continuity core: detection, project identity, task + checkpoint store, git reads.
// Standalone: needs only Node 18+ and git. No Argent, Beads, database or network service required.
// Git is only ever READ here; nothing in this module mutates a repository.
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, readdirSync, statSync, realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname, delimiter } from 'node:path';
import http from 'node:http';

// ── locations (all overridable so tests never touch the real machine) ──────────────────────
export const CFG = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const ROOT = () => process.env.WC_HOME || join(CFG(), 'work-continuity');
export const ARGENT_DIR = () => join(process.env.ARGENT_HOME || homedir(), 'argent-safehouse');
export const MEM_DIR = () => process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
export const posix = (p) => String(p).replace(/\\/g, '/');

// ── small utilities ───────────────────────────────────────────────────────────────────────
export const nowIso = () => new Date().toISOString();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha = (s) => createHash('sha1').update(String(s)).digest('hex');
export const slug = (s) => String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
export const safeId = (s) => String(s || 'none').replace(/[^\w.-]/g, '_').slice(0, 80);
export const err = (message, code = 'E_WC', extra = {}) => Object.assign(new Error(message), { code, ...extra });
const safeReal = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Atomic write: temp file + rename, with a short retry (Windows can briefly lock the target). */
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; }
    catch (e) { if (i >= 8) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; } sleep(20 * (i + 1)); }
  }
}

/** Cross-process lock: mkdir is atomic. A lock older than 30 s is treated as abandoned (crashed holder). */
export function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* raced */ }
      if (Date.now() - t0 > 10000) throw err('could not acquire the project lock (another session is writing)', 'E_LOCK');
      sleep(25);
    }
  }
  try { return fn(); } finally { try { rmSync(lock, { recursive: true, force: true }); } catch { /* */ } }
}

// ── git (read only) ───────────────────────────────────────────────────────────────────────
export function git(cwd, args, timeout = 6000) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).trimEnd();
  } catch { return null; }
}
export function gitOk(cwd, args, timeout = 6000) {
  try { execFileSync('git', args, { cwd, timeout, windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; }
}
const lines = (s) => (s ? s.split('\n').map((x) => x.trim()).filter(Boolean) : []);

/** Strip scheme, credentials and .git so the remote is safe to store and stable across clones. */
export function sanitizeRemote(u) {
  if (!u) return null;
  let s = String(u).trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^[^@/]*@/, '');
  s = s.replace(/^([^/:]+):(?!\d+(\/|$))/, '$1/');
  s = s.replace(/\.git$/i, '').replace(/\/+$/, '');
  return s.toLowerCase() || null;
}

/** Describe the repo that holds `cwd`, or null when it is not a Git repository. */
export function repo(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const cd = git(cwd, ['rev-parse', '--git-common-dir']) || '.git';
  const common = safeReal(resolve(cwd, cd));
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) || 'HEAD';
  const head = git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']);
  let target = git(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (target) target = target.replace(/^origin\//, '');
  else for (const c of ['main', 'master', 'trunk', 'develop']) if (git(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${c}`])) { target = c; break; }
  target ??= git(cwd, ['config', '--get', 'init.defaultBranch']) || 'main';
  const remote = sanitizeRemote(git(cwd, ['config', '--get', 'remote.origin.url']));
  const name = /(^|[\\/])\.git$/.test(common) ? basename(dirname(common)) : (remote ? basename(remote) : basename(top));
  const idSrc = remote || common.toLowerCase().replace(/\\/g, '/');
  return { kind: 'git', top: safeReal(top), common, branch, head, target, remote, name, key: `${slug(name)}-${sha(idSrc).slice(0, 8)}` };
}

/** Project identity for any folder: Git repo when there is one, otherwise the folder itself. */
export function identify(cwd) {
  const r = repo(cwd);
  if (r) return r;
  const real = safeReal(cwd);
  return { kind: 'dir', top: real, common: null, branch: null, head: null, target: null, remote: null,
    name: basename(real), key: `dir-${slug(basename(real))}-${sha(real.toLowerCase().replace(/\\/g, '/')).slice(0, 8)}` };
}

export function gitState(info, { diffLimit = 20000 } = {}) {
  const cwd = info.top;
  const cap = (a) => a.slice(0, 200);
  const staged = cap(lines(git(cwd, ['diff', '--cached', '--name-only'])));
  const modified = cap(lines(git(cwd, ['diff', '--name-only'])));
  const untracked = cap(lines(git(cwd, ['ls-files', '--others', '--exclude-standard'])));
  const base = info.head ? ['HEAD'] : [];
  const stat = git(cwd, ['diff', ...base, '--stat']) || '';
  let diff = git(cwd, ['diff', ...base], 15000) || '';
  const truncated = diff.length > diffLimit;
  if (truncated) diff = diff.slice(0, diffLimit);
  const ahead = info.head && info.target && info.branch !== info.target
    ? Number(git(cwd, ['rev-list', '--count', `${info.target}..HEAD`]) ?? NaN) : null;
  return { branch: info.branch, commit: info.head, target: info.target, staged, modified, untracked,
    dirty: !!(staged.length || modified.length || untracked.length), diffstat: stat.split('\n').slice(-12).join('\n'),
    aheadOfTarget: Number.isFinite(ahead) ? ahead : null, diff, diffTruncated: truncated, capturedAt: nowIso() };
}

export const isIntegrated = (info, branch, target) =>
  gitOk(info.top, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]) &&
  gitOk(info.top, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, target]);

// ── detection ─────────────────────────────────────────────────────────────────────────────
function httpGet(url, headers = {}, timeout = 700) {
  return new Promise((res) => {
    try {
      const req = http.get(url, { headers, timeout }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (d) => { if (body.length < 65536) body += d; });
        r.on('end', () => res({ status: r.statusCode, body }));
      });
      req.on('timeout', () => { req.destroy(); res(null); });
      req.on('error', () => res(null));
    } catch { res(null); }
  });
}

function settingsEnv() { return readJson(join(CFG(), 'settings.json'), {})?.env ?? {}; }

/**
 * Argent: marker (package.json named argent-safehouse) + CLI + hooks registered => "installed".
 * Then a real capability probe (not just an open port): GET /work/capabilities must report a Work Registry.
 * States: absent | offline | no-registry | operational.
 */
export async function detectArgent() {
  const dir = ARGENT_DIR();
  const pkg = readJson(join(dir, 'package.json'), null);
  const marker = !!pkg && /argent/i.test(pkg.name || '');
  const cli = existsSync(join(dir, 'bin', 'install.mjs'));
  let hooks = false;
  try { hooks = readFileSync(join(CFG(), 'settings.json'), 'utf8').includes('/argent-safehouse/hooks/'); } catch { /* */ }
  const installed = marker && (cli || hooks);
  if (!installed) return { installed: false, state: 'absent', dir, marker, cli, hooks };
  const env = settingsEnv();
  const port = process.env.ARGENT_PORT || env.ARGENT_PORT || '7717';
  const token = process.env.ARGENT_TOKEN || env.ARGENT_TOKEN || '';
  const hdr = token ? { 'x-argent-token': token } : {};
  const cap = await httpGet(`http://127.0.0.1:${port}/work/capabilities`, hdr);
  let state = 'offline';
  if (cap) {
    let j = null; try { j = JSON.parse(cap.body); } catch { /* */ }
    state = cap.status === 200 && j && (j.workRegistry === true || j.registry === true) ? 'operational' : 'no-registry';
  } else if (await httpGet(`http://127.0.0.1:${port}/roster`, hdr)) state = 'no-registry'; // wire answers, endpoint missing
  return { installed: true, state, dir, port, marker, cli, hooks, _token: token };
}

function onPath(exe) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of (process.env.PATH || '').split(delimiter)) for (const e of exts) if (d && existsSync(join(d, exe + e))) return join(d, exe + e);
  return null;
}

/** claude-mem: read-only inspection of the plugin, its hook file, its settings and its worker health. Never its database. */
export async function detectMem() {
  const plugins = readJson(join(CFG(), 'plugins', 'installed_plugins.json'), {})?.plugins ?? {};
  const k = Object.keys(plugins).find((x) => x.startsWith('claude-mem@'));
  const inst = k ? plugins[k]?.[0] : null;
  const enabled = k ? readJson(join(CFG(), 'settings.json'), {})?.enabledPlugins?.[k] !== false : false;
  const hooksFile = inst?.installPath ? join(inst.installPath, 'hooks', 'hooks.json') : null;
  const hookEvents = hooksFile ? Object.keys(readJson(hooksFile, {})?.hooks ?? {}) : [];
  const cli = onPath('claude-mem');
  const s = readJson(join(MEM_DIR(), 'settings.json'), {}) ?? {};
  const base = s.CLAUDE_MEM_WORKER_URL || `http://${s.CLAUDE_MEM_WORKER_HOST || '127.0.0.1'}:${s.CLAUDE_MEM_WORKER_PORT || 37777}`;
  let worker = false, mcpReady = false, version = null;
  const h = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base) ? await httpGet(`${base.replace(/\/$/, '')}/api/health`) : null;
  if (h && h.status === 200) { worker = true; try { const j = JSON.parse(h.body); mcpReady = !!j.mcpReady; version = j.version ?? null; } catch { /* */ } }
  return { available: !!(inst && enabled) || !!cli, plugin: !!inst, enabled, version: version || inst?.version || null, cli: !!cli, hookEvents, worker, search: worker && mcpReady, base };
}

export async function detectAll(cwd) {
  const [argent, mem] = await Promise.all([detectArgent(), detectMem()]);
  const info = identify(cwd);
  const mode = argent.state === 'operational' ? 'A' : argent.installed ? 'B' : 'C';
  return { mode, argent, mem, info, git: info.kind === 'git', fallback: true };
}

export const MODE_NAME = {
  A: 'ARGENT (Work Registry operational)',
  B: 'DEGRADED (Argent installed, Work Registry unavailable; local fallback)',
  C: 'STANDALONE CONTINUITY (Argent not installed)',
};

// ── project + task store ──────────────────────────────────────────────────────────────────
export const projDir = (key) => join(ROOT(), 'projects', key);
export const OPEN = new Set(['planned', 'active', 'paused', 'blocked', 'review-ready']);
export const STATUSES = ['planned', 'active', 'paused', 'blocked', 'review-ready', 'merged', 'abandoned', 'superseded'];
export const normStatus = (s) => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');

export function ensureProject(info) {
  const f = join(projDir(info.key), 'project.json');
  if (!existsSync(f)) {
    writeJsonAtomic(f, { key: info.key, name: info.name, kind: info.kind, remote: info.remote, commonDir: info.common,
      targetBranch: info.target, createdAt: nowIso() });
  }
  return f;
}

const tasksFile = (key) => join(projDir(key), 'tasks.json');
export const loadTasks = (key) => readJson(tasksFile(key), { schema: 1, rev: 0, nextSeq: 1, tasks: {} });
function mutateTasks(key, fn) {
  return withLock(projDir(key), () => {
    const db = loadTasks(key);
    const out = fn(db);
    db.rev += 1;
    writeJsonAtomic(tasksFile(key), db);
    return out;
  });
}
export const taskForBranch = (key, branch, { openOnly = true } = {}) =>
  Object.values(loadTasks(key).tasks).filter((t) => t.branch === branch && (!openOnly || OPEN.has(t.status)))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0] ?? null;

/** Register a task. A task id from Argent is preserved verbatim; otherwise wc-NNN is generated. */
export function createTask(info, f) {
  ensureProject(info);
  return mutateTasks(info.key, (db) => {
    if (f.branch) {
      const dup = Object.values(db.tasks).find((t) => t.branch === f.branch && OPEN.has(t.status));
      if (dup) return { task: dup, existed: true };
    }
    let id = f.id;
    if (id) { if (db.tasks[id]) throw err(`task ${id} already exists`, 'E_EXISTS'); }
    else do { id = `wc-${String(db.nextSeq++).padStart(3, '0')}`; } while (db.tasks[id]);
    const status = normStatus(f.status || 'active');
    if (!STATUSES.includes(status)) throw err(`unknown status ${status}`);
    const t = {
      id, project: info.name, projectKey: info.key, title: f.title || id, branch: f.branch ?? null,
      targetBranch: f.targetBranch || info.target || 'main', status, objective: f.objective || f.title || '',
      completed: [], remaining: [], decisions: [], tests: { executed: [], passed: [], failed: [], required: [] }, blockers: [],
      nextAction: f.nextAction || '', lastCheckpoint: null, source: f.source || 'local',
      argent: f.argent ?? null, rev: 1, createdAt: nowIso(), updatedAt: nowIso(),
    };
    db.tasks[id] = t;
    return { task: t, existed: false };
  });
}

/** Record whether a task is mirrored in Argent (used by reconcile). */
export function setArgent(info, id, meta) {
  return mutateTasks(info.key, (db) => {
    const t = db.tasks[id]; if (!t) throw err(`no task ${id}`, 'E_NOTASK');
    t.argent = meta; t.rev += 1; t.updatedAt = nowIso(); return t;
  });
}

const SCALARS = ['title', 'objective', 'nextAction', 'branch', 'targetBranch'];
/** Update a task. expectedRev guards against two sessions writing over each other; a stale write is saved, not applied. */
export function updateTask(info, id, patch, { expectedRev, confirmedIntegrated, reason, supersededBy } = {}) {
  return mutateTasks(info.key, (db) => {
    const t = db.tasks[id];
    if (!t) throw err(`no task ${id} in project ${info.key}`, 'E_NOTASK');
    if (expectedRev != null && Number(expectedRev) !== t.rev) {
      const f = join(projDir(info.key), 'handoffs', `${id}.conflicts`, `${nowIso().replace(/[:.]/g, '-')}.json`);
      writeJsonAtomic(f, { rejectedPatch: patch, expectedRev: Number(expectedRev), actualRev: t.rev, at: nowIso() });
      throw err(`task ${id} changed since you read it (rev ${t.rev}, you had ${expectedRev}); your update was saved to ${f} and not applied. Re-read and retry.`, 'E_CONFLICT', { current: t, saved: f });
    }
    for (const k of SCALARS) if (patch[k] !== undefined) t[k] = patch[k];
    if (patch.status !== undefined) {
      const st = normStatus(patch.status);
      if (!STATUSES.includes(st)) throw err(`unknown status ${st} (use ${STATUSES.join(', ')})`);
      if (st === 'merged') {
        const ok = t.branch && isIntegrated(info, t.branch, t.targetBranch);
        if (!ok && !confirmedIntegrated) throw err(`refusing to mark ${id} merged: ${t.branch ?? '(no branch)'} is not an ancestor of ${t.targetBranch} in Git. If it was squash-merged or the branch is gone, confirm with --confirmed-integrated "<evidence>".`, 'E_NOTMERGED');
        t.integration = { verifiedByGit: !!ok, confirmation: ok ? null : String(confirmedIntegrated), at: nowIso() };
      }
      if ((st === 'abandoned' || st === 'superseded') && !reason) throw err(`${st} needs --reason (explicit cancellation or supersession is the only way to close an unmerged task)`, 'E_REASON');
      if (st === 'abandoned' || st === 'superseded') t.closed = { reason, supersededBy: supersededBy ?? null, at: nowIso() };
      t.status = st;
    }
    t.rev += 1; t.updatedAt = nowIso();
    return t;
  });
}

// ── checkpoints ───────────────────────────────────────────────────────────────────────────
const handoffs = (key) => join(projDir(key), 'handoffs');
const latestFile = (key, id, kind) => join(handoffs(key), kind === 'auto' ? `${id}.auto.json` : `${id}.json`);
export const readLatest = (key, id, kind = 'manual') => readJson(latestFile(key, id, kind), null);
const arr = (x) => (Array.isArray(x) ? x.map(String) : x ? [String(x)] : []);

/** Reject a report that claims tests passed without having run them. */
export function validateTests(t) {
  const executed = new Set(arr(t?.executed));
  const bad = [...arr(t?.passed), ...arr(t?.failed)].filter((x) => !executed.has(x));
  if (bad.length) throw err(`tests reported passed/failed but not listed in tests.executed: ${bad.join('; ')}. Only record tests that were actually run.`, 'E_TESTS');
}

/**
 * Save a checkpoint (manual or auto). Facts about Git are captured here, never taken from the caller.
 * A manual checkpoint based on an older seq than the stored latest is kept as history but does NOT replace latest.
 */
export function saveCheckpoint(info, taskId, input = {}, { kind = 'manual', basedOn = null, session = null } = {}) {
  ensureProject(info);
  const g = info.kind === 'git' ? gitState(info) : null;
  if (kind === 'manual' && input.tests) validateTests(input.tests);
  return withLock(projDir(info.key), () => {
    const db = loadTasks(info.key);
    const t = db.tasks[taskId];
    if (!t) throw err(`no task ${taskId} in project ${info.key}`, 'E_NOTASK');
    const manual = readLatest(info.key, taskId, 'manual');
    const prev = readLatest(info.key, taskId, kind);
    const seq = Math.max(prev?.seq ?? 0, manual?.seq ?? 0) + 1;
    const diverged = kind === 'manual' && basedOn != null && manual && Number(basedOn) < manual.seq;
    const { diff, ...gitNoDiff } = g ?? {};
    const cp = {
      schema: 1, seq, kind, taskId, project: info.name, projectKey: info.key, at: nowIso(), session: session ?? null,
      basedOnSeq: basedOn != null ? Number(basedOn) : null, diverged: !!diverged,
      summary: input.summary ?? '', completed: arr(input.completed), remaining: arr(input.remaining), decisions: arr(input.decisions),
      problems: arr(input.problems), blockers: arr(input.blockers), nextAction: input.nextAction ?? '',
      tests: { executed: arr(input.tests?.executed), passed: arr(input.tests?.passed), failed: arr(input.tests?.failed), required: arr(input.tests?.required) },
      files: arr(input.files), context: input.context ?? '', git: g ? gitNoDiff : null, diffFile: null,
    };
    const hdir = join(handoffs(info.key), `${taskId}.history`);
    const pad = String(seq).padStart(4, '0');
    if (g?.diff) { mkdirSync(hdir, { recursive: true }); writeFileSync(join(hdir, `${pad}.diff`), g.diff); cp.diffFile = `${taskId}.history/${pad}.diff`; }
    writeJsonAtomic(join(hdir, `${pad}.${kind}${diverged ? '.diverged' : ''}.json`), cp);   // append-only history, never overwritten
    if (diverged) return { ok: false, diverged: true, seq, latestSeq: manual.seq, checkpoint: cp };
    writeJsonAtomic(latestFile(info.key, taskId, kind), cp);
    if (kind === 'manual') {
      t.lastCheckpoint = { seq, at: cp.at, session: cp.session };
      if (input.completed) t.completed = cp.completed;
      if (input.remaining) t.remaining = cp.remaining;
      if (input.decisions) t.decisions = cp.decisions;
      if (input.blockers) t.blockers = cp.blockers;
      if (input.tests) t.tests = cp.tests;
      if (input.nextAction) t.nextAction = cp.nextAction;
      if (input.objective) t.objective = String(input.objective);
      t.rev += 1; t.updatedAt = cp.at;
      db.rev += 1;
      writeJsonAtomic(tasksFile(info.key), db);
    }
    return { ok: true, seq, checkpoint: cp };
  });
}

// ── resume: compare a checkpoint against the real working tree ────────────────────────────
export function drift(info, cp) {
  if (!cp?.git || info.kind !== 'git') return [];
  const now = gitState(info, { diffLimit: 0 });
  const out = [];
  if (cp.git.branch !== info.branch) out.push(`branch differs: checkpoint was on ${cp.git.branch}, now on ${info.branch}`);
  if (cp.git.commit && info.head && cp.git.commit !== info.head) {
    const n = git(info.top, ['rev-list', '--count', `${cp.git.commit}..HEAD`]);
    out.push(n == null ? `HEAD is ${info.head.slice(0, 8)}, checkpoint had ${cp.git.commit.slice(0, 8)} (history rewritten or unknown)` : `${n} commit(s) since the checkpoint (${cp.git.commit.slice(0, 8)} -> ${info.head.slice(0, 8)})`);
  }
  const was = new Set([...cp.git.staged, ...cp.git.modified, ...cp.git.untracked]);
  const is = new Set([...now.staged, ...now.modified, ...now.untracked]);
  const added = [...is].filter((f) => !was.has(f)), gone = [...was].filter((f) => !is.has(f));
  if (added.length) out.push(`changed since checkpoint (not in it): ${added.slice(0, 8).join(', ')}${added.length > 8 ? ` +${added.length - 8}` : ''}`);
  if (gone.length) out.push(`listed in checkpoint but now clean (committed or reverted): ${gone.slice(0, 8).join(', ')}${gone.length > 8 ? ` +${gone.length - 8}` : ''}`);
  return out;
}

const list = (a, n = 6) => (a.length ? a.slice(0, n).join('; ') + (a.length > n ? ` (+${a.length - n} more)` : '') : '(none)');

/** One compact continuation briefing. Git state wins over any summary text. */
export function buildResume(det, { taskId, cliPath, max = 3500 } = {}) {
  const { info, mode, mem, argent } = det;
  const L = [];
  L.push(`[daveen-clauderelay] mode ${mode}: ${MODE_NAME[mode]} | claude-mem: ${mem.available ? (mem.worker ? (mem.search ? 'ready' : 'worker up') : 'installed, worker offline') : 'not available'} | git: ${det.git ? 'yes' : 'no'}`);
  L.push(`Project ${info.name}${info.kind === 'git' ? ` | branch ${info.branch} -> target ${info.target}` : ' | (not a git repo)'}`);
  const db = loadTasks(info.key);
  let t = taskId ? db.tasks[taskId] : (info.kind === 'git' ? taskForBranch(info.key, info.branch) : null);
  const open = Object.values(db.tasks).filter((x) => OPEN.has(x.status));
  if (t) {
    const cp = readLatest(info.key, t.id), auto = readLatest(info.key, t.id, 'auto');
    L.push(`Task ${t.id} "${t.title}" [${t.status}] rev ${t.rev}${t.argent?.pending ? ' (not yet in Argent)' : ''}`);
    if (t.objective && t.objective !== t.title) L.push(`Objective: ${t.objective}`);
    if (cp) {
      L.push(`Last checkpoint #${cp.seq} (${cp.at}${cp.session ? `, session ${String(cp.session).slice(0, 8)}` : ''}) - save the next one with --based-on ${cp.seq}`);
      if (cp.summary) L.push(`Summary: ${cp.summary}`);
      L.push(`Done: ${list(cp.completed)}`);
      L.push(`Remaining: ${list(cp.remaining)}`);
      if (cp.decisions.length) L.push(`Decisions: ${list(cp.decisions, 4)}`);
      if (cp.blockers.length) L.push(`Blockers: ${list(cp.blockers, 4)}`);
      L.push(`Tests run: ${list(cp.tests.executed, 4)} | passed: ${list(cp.tests.passed, 4)} | failed: ${list(cp.tests.failed, 4)} | still required: ${list(cp.tests.required, 4)}`);
      L.push(`NEXT ACTION: ${cp.nextAction || t.nextAction || '(not recorded)'}`);
      const d = drift(info, cp);
      L.push(d.length ? `Drift vs Git (trust Git): ${d.join(' | ')}` : 'Working tree matches the checkpoint.');
    } else {
      L.push(`No manual checkpoint yet. Next action on record: ${t.nextAction || '(none)'}`);
      if (auto) L.push(`Auto snapshot #${auto.seq} at ${auto.at} (mechanical Git state only): modified ${list(auto.git?.modified ?? [], 5)}`);
    }
    if (cp && auto && auto.at > cp.at) L.push(`Newer auto snapshot #${auto.seq} at ${auto.at}: modified ${list(auto.git?.modified ?? [], 5)}, untracked ${list(auto.git?.untracked ?? [], 5)}`);
  } else if (info.kind === 'git' && info.branch !== info.target && info.branch !== 'HEAD') {
    L.push(`No task registered for branch ${info.branch}. Register it before development work: node "${cliPath}" task new --title "<title>"`);
  }
  const others = open.filter((x) => x.id !== t?.id);
  if (others.length) L.push(`Other open tasks here: ${others.slice(0, 6).map((x) => `${x.id} ${x.branch ?? '-'} [${x.status}]`).join(', ')}${others.length > 6 ? ` +${others.length - 6}` : ''}`);
  if (mem.search) L.push('History: use claude-mem mem-search (search -> timeline -> get_observations) for earlier decisions; do not replay whole sessions.');
  if (mode === 'B') L.push(`Argent Work Registry unavailable (${argent.state}); checkpoints are kept locally and will be reconciled later.`);
  L.push('Rules: Git state beats summaries; account switch is not a new task; never discard uncommitted changes; never report unrun tests as passing; do not close an unmerged task.');
  L.push(`CLI: node "${cliPath}" <status|resume|task|checkpoint|audit|doctor>. Save progress by writing a JSON file with the Write tool, then: checkpoint --task <id> --from <file> --based-on <seq>. Skill: daveen-clauderelay:relay`);
  let text = L.join('\n');
  if (text.length > max) text = text.slice(0, max - 40) + '\n[...briefing truncated; run wc resume]';
  return { text, task: t ?? null, openTasks: open };
}

// ── branch audit ──────────────────────────────────────────────────────────────────────────
export function audit(info) {
  if (info.kind !== 'git') return { rows: [], note: 'not a git repository' };
  const target = info.target;
  const fmt = '%(refname:short)\t%(objectname:short)\t%(committerdate:iso8601)\t%(contents:subject)';
  const unmerged = new Set(lines(git(info.top, ['branch', '--no-merged', target, '--format=%(refname:short)'])));
  const all = lines(git(info.top, ['for-each-ref', '--format=' + fmt, 'refs/heads']));
  const db = loadTasks(info.key);
  const rows = [];
  for (const row of all) {
    const [branch, sha7, date, subject] = row.split('\t');
    if (branch === target) continue;
    const task = Object.values(db.tasks).filter((t) => t.branch === branch).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    const merged = !unmerged.has(branch);
    const ahead = Number(git(info.top, ['rev-list', '--count', `${target}..${branch}`]) ?? 0);
    let flag = 'ok';
    if (!merged && !task) flag = 'UNTRACKED-UNMERGED';
    else if (!merged && task && !OPEN.has(task.status)) flag = `CLOSED-BUT-UNMERGED(${task.status})`;
    else if (merged && task && OPEN.has(task.status)) flag = 'MERGED-TASK-STILL-OPEN';
    else if (merged && !task) flag = 'merged-no-task';
    rows.push({ branch, sha: sha7, date, subject, merged, ahead, task: task?.id ?? null, status: task?.status ?? null, flag, current: branch === info.branch });
  }
  const orphans = Object.values(db.tasks).filter((t) => OPEN.has(t.status) && t.branch && !all.some((r) => r.startsWith(t.branch + '\t')));
  return { rows, target, orphanTasks: orphans.map((t) => ({ id: t.id, branch: t.branch, status: t.status })) };
}

// ── Argent adapter (contract is proposed; the current Wire has no Work Registry yet) ───────
export async function argentCall(argent, method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((res) => {
    try {
      const req = http.request({ host: '127.0.0.1', port: argent.port, path, method, timeout: 1500,
        headers: { 'content-type': 'application/json', 'x-argent-token': argent._token || '', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (r) => {
        let b = ''; r.setEncoding('utf8'); r.on('data', (d) => { if (b.length < 1e6) b += d; });
        r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* */ } res({ status: r.statusCode, json: j }); });
      });
      req.on('timeout', () => { req.destroy(); res(null); });
      req.on('error', () => res(null));
      if (data) req.write(data);
      req.end();
    } catch { res(null); }
  });
}

// ── per-session scratch state used by hooks (never authoritative) ─────────────────────────
const sessFile = (sid) => join(ROOT(), 'state', 'sessions', `${safeId(sid)}.json`);
export const loadSession = (sid) => readJson(sessFile(sid), { sid, nudges: {}, edits: 0, lastEditAt: null, stopReminded: false, startedAt: nowIso() });
export const saveSession = (s) => { try { writeJsonAtomic(sessFile(s.sid), s); } catch { /* fail-soft */ } };
export function pruneSessions(days = 14) {
  try {
    const d = join(ROOT(), 'state', 'sessions');
    for (const f of readdirSync(d)) { const p = join(d, f); if (Date.now() - statSync(p).mtimeMs > days * 864e5) rmSync(p, { force: true }); }
  } catch { /* */ }
}
