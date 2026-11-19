// Scenario tests A-G in a throwaway sandbox (fake Claude config dir, fake home, temp git repos). Touches nothing real.
// Run: node tests/scenarios.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'daveen-clauderelay');
const TMP = mkdtempSync(join(tmpdir(), 'wc-test-'));
const CFG = join(TMP, 'cfg'), HOMEDIR = join(TMP, 'home'), MEM = join(TMP, 'mem');
mkdirSync(CFG, { recursive: true }); mkdirSync(HOMEDIR, { recursive: true });
const GITENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const baseEnv = (extra = {}) => ({ ...process.env, ...GITENV, CLAUDE_CONFIG_DIR: CFG, ARGENT_HOME: HOMEDIR, CLAUDE_MEM_DATA_DIR: MEM, ARGENT_PORT: '59999', ARGENT_TOKEN: 'test', ...extra });

const run = (file, args, { cwd = TMP, env = {}, input } = {}) => new Promise((res) => {
  const p = spawn(process.execPath, [file, ...args], { cwd, env: baseEnv(env), windowsHide: true });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
  if (input) p.stdin.end(input); else p.stdin.end();
});
const wc = (args, o) => run(join(SRC, 'scripts', 'wc.mjs'), args, o);
const hook = (ev, payload, o) => run(join(SRC, 'hooks', 'hook.mjs'), [ev], { ...o, input: JSON.stringify(payload) });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: baseEnv(), encoding: 'utf8' }).trim();
function mkRepo(name) {
  const d = join(TMP, name); mkdirSync(d, { recursive: true });
  git(d, 'init', '-q'); git(d, 'symbolic-ref', 'HEAD', 'refs/heads/main'); writeFileSync(join(d, 'a.txt'), '1\n'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'init');
  return d;
}
let n = 0; const ok = (m) => console.log(`  ok ${++n}  ${m}`);
const sect = (m) => console.log(`\n${m}`);

// ── Scenario C: Argent completely absent; CLI session registers, a second session recovers ──
sect('Scenario C: Argent absent, standalone');
const repoC = mkRepo('clinic-platform');
git(repoC, 'checkout', '-q', '-b', 'feat/clinic-subdomain');
writeFileSync(join(repoC, 'wip.txt'), 'half done\n');                     // uncommitted work that must survive
let r = await wc(['status', '--json'], { cwd: repoC });
let j = JSON.parse(r.out);
assert.equal(j.mode, 'C'); assert.equal(j.argent.state, 'absent'); ok('mode C detected');
r = await wc(['task', 'new', '--title', 'Implement clinic subdomain support', '--objective', 'Support clinic-specific subdomains', '--json'], { cwd: repoC });
const task = JSON.parse(r.out).task; assert.match(task.id, /^wc-001$/); assert.equal(task.branch, 'feat/clinic-subdomain'); ok(`task registered ${task.id}`);
const again = JSON.parse((await wc(['task', 'new', '--title', 'dup', '--json'], { cwd: repoC })).out);
assert.equal(again.existed, true); ok('second task on same branch is not duplicated');
const cpFile = join(TMP, 'cp1.json');
writeFileSync(cpFile, JSON.stringify({ summary: 'router done', completed: ['tenant lookup'], remaining: ['tenant rendering'], decisions: ['use host header'],
  nextAction: 'Implement tenant-specific rendering', tests: { executed: ['unit: tenant lookup'], passed: ['unit: tenant lookup'], failed: [], required: ['e2e'] } }));
r = await wc(['checkpoint', '--task', task.id, '--from', cpFile, '--session', 'sessionCLI'], { cwd: repoC });
assert.equal(r.code, 0, r.err); assert.match(r.out, /Checkpoint #1/); ok('checkpoint #1 saved');
const cp = JSON.parse(readFileSync(join(CFG, 'work-continuity', 'projects', task.projectKey, 'handoffs', `${task.id}.json`), 'utf8'));
assert.ok(cp.git.untracked.includes('wip.txt')); assert.equal(cp.git.branch, 'feat/clinic-subdomain'); ok('git facts captured by the tool (untracked wip.txt)');
// "Desktop" session: different process, different session id, same project via a SUBFOLDER of the repo
mkdirSync(join(repoC, 'src'), { recursive: true });
r = await hook('SessionStart', { session_id: 'sessionDesktop', cwd: join(repoC, 'src'), source: 'startup' });
const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
assert.match(ctx, /Task wc-001/); assert.match(ctx, /NEXT ACTION: Implement tenant-specific rendering/); assert.match(ctx, /mode C/); ok('second session recovers same task + next action via SessionStart');
assert.match(ctx, /changed since checkpoint|matches the checkpoint/); ok('drift line present');
writeFileSync(join(repoC, 'newfile.txt'), 'x');
r = await wc(['resume'], { cwd: repoC }); assert.match(r.out, /changed since checkpoint \(not in it\): newfile\.txt/); ok('resume reports files changed since checkpoint');
assert.equal(readFileSync(join(repoC, 'wip.txt'), 'utf8'), 'half done\n'); ok('uncommitted file untouched');

// guards
writeFileSync(join(TMP, 'bad.json'), JSON.stringify({ tests: { executed: [], passed: ['e2e'] } }));
r = await wc(['checkpoint', '--task', task.id, '--from', join(TMP, 'bad.json')], { cwd: repoC }); assert.equal(r.code, 4); ok('passed-but-never-run test rejected');
writeFileSync(join(repoC, 'branchwork.txt'), 'b'); git(repoC, 'add', 'branchwork.txt'); git(repoC, 'commit', '-qm', 'branch-only work');
r = await wc(['resume'], { cwd: repoC }); assert.match(r.out, /1 commit\(s\) since the checkpoint/); ok('resume reports commits since checkpoint');
r = await wc(['task', 'update', task.id, '--status', 'merged'], { cwd: repoC }); assert.notEqual(r.code, 0); assert.match(r.err, /not an ancestor/); ok('cannot mark unmerged branch merged');
r = await wc(['task', 'update', task.id, '--status', 'abandoned'], { cwd: repoC }); assert.match(r.err, /--reason/); ok('abandon requires explicit reason');

// hooks: nudge, edit counting, stop-once
const repoN = mkRepo('nudge'); git(repoN, 'checkout', '-q', '-b', 'feat/untracked');
r = await hook('PreToolUse', { session_id: 's9', cwd: repoN, tool_name: 'Edit' });
assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /no registered task/); ok('PreToolUse nudges on branch without task');
r = await hook('PreToolUse', { session_id: 's9', cwd: repoN, tool_name: 'Edit' }); assert.equal(r.out, ''); ok('nudge is not repeated');
r = await hook('PreToolUse', { session_id: 's9', cwd: repoN, tool_name: 'Read' }); assert.equal(r.out, ''); ok('read-only tools never touched');
await wc(['task', 'new', '--title', 'nudge task'], { cwd: repoN });
writeFileSync(join(repoN, 'x.txt'), 'x');
for (let i = 0; i < 3; i++) await hook('PostToolUse', { session_id: 's10', cwd: repoN, tool_name: 'Write' });
r = await hook('Stop', { session_id: 's10', cwd: repoN }); assert.equal(JSON.parse(r.out).decision, 'block'); ok('Stop reminds once when dirty + no checkpoint');
r = await hook('Stop', { session_id: 's10', cwd: repoN }); assert.equal(r.out, ''); ok('Stop does not nag twice');
r = await hook('Stop', { session_id: 's11', cwd: repoN, stop_hook_active: true }); assert.equal(r.out, ''); ok('stop_hook_active never loops');
await hook('SessionEnd', { session_id: 's10', cwd: repoN, reason: 'other' });
assert.ok(existsSync(join(CFG, 'work-continuity', 'projects')) && readdirSync(join(CFG, 'work-continuity', 'projects')).length >= 2); ok('SessionEnd auto snapshot path ok');
r = await hook('SessionStart', { session_id: 'sx', cwd: TMP, source: 'startup' }); assert.equal(r.out, ''); ok('plain non-git folder: hooks stay silent');
r = await hook('SessionStart', { session_id: 'sx', cwd: repoC, source: 'startup' }, { env: { PATH: '' } });
assert.equal(r.code, 0); ok('hook fail-soft with broken PATH (exit 0)');

// ── Scenario B: Argent installed, Wire stopped ──
sect('Scenario B: Argent installed, Wire stopped');
mkdirSync(join(HOMEDIR, 'argent-safehouse', 'bin'), { recursive: true });
writeFileSync(join(HOMEDIR, 'argent-safehouse', 'package.json'), JSON.stringify({ name: 'argent-safehouse' }));
writeFileSync(join(HOMEDIR, 'argent-safehouse', 'bin', 'install.mjs'), '//');
const repoB = mkRepo('clinic-b'); git(repoB, 'checkout', '-q', '-b', 'feat/b');
r = await wc(['status', '--json'], { cwd: repoB }); j = JSON.parse(r.out);
assert.equal(j.mode, 'B'); assert.equal(j.argent.state, 'offline'); assert.equal(j.argent.installed, true); ok('installed-but-offline reported as degraded, not uninstalled');
const tb = JSON.parse((await wc(['task', 'new', '--title', 'B task', '--json'], { cwd: repoB })).out).task;
assert.deepEqual(tb.argent, { pending: true }); ok('task kept locally, flagged pending for Argent');
r = await wc(['checkpoint', '--task', tb.id, '--next', 'continue B'], { cwd: repoB }); assert.match(r.out, /saved locally, will reconcile/); ok('checkpoint saved with Wire down');
r = await wc(['resume'], { cwd: repoB }); assert.match(r.out, /mode B/); assert.match(r.out, /continue B/); ok('resume in another session restores state');

// ── Scenario A: Argent operational (mock Work Registry implementing the proposed contract) ──
sect('Scenario A: Argent operational (mock registry)');
const seen = [];
const srv = http.createServer((q, s) => {
  let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => {
    seen.push(`${q.method} ${q.url}`);
    s.setHeader('content-type', 'application/json');
    if (q.url === '/work/capabilities') return s.end(JSON.stringify({ workRegistry: true }));
    if (q.url === '/work/tasks') return s.end(JSON.stringify({ id: 'arg-042' }));
    if (q.url.endsWith('/checkpoint')) return s.end('{"ok":true}');
    s.statusCode = 404; s.end('{}');
  });
});
await new Promise((r2) => srv.listen(0, '127.0.0.1', r2));
const port = String(srv.address().port);
const repoA = mkRepo('clinic-a'); git(repoA, 'checkout', '-q', '-b', 'feat/a');
j = JSON.parse((await wc(['status', '--json'], { cwd: repoA, env: { ARGENT_PORT: port } })).out); assert.equal(j.mode, 'A'); ok('mode A when registry capability answers');
const ta = JSON.parse((await wc(['task', 'new', '--title', 'A task', '--json'], { cwd: repoA, env: { ARGENT_PORT: port } })).out).task;
assert.equal(ta.id, 'arg-042'); assert.equal(ta.source, 'argent'); ok('Argent task id preserved');
r = await wc(['checkpoint', '--task', ta.id, '--next', 'go'], { cwd: repoA, env: { ARGENT_PORT: port } }); assert.match(r.out, /Mirrored to Argent/);
assert.ok(seen.includes('POST /work/tasks/arg-042/checkpoint')); ok('checkpoint sent to Argent and mirrored locally');
// Wire goes away: same task id continues locally (switch A -> B)
r = await wc(['resume'], { cwd: repoA }); assert.match(r.out, /Task arg-042/); ok('after Wire stops, same id recovered from local mirror');
srv.close();

// ── Scenario D: claude-mem unavailable ──
sect('Scenario D: claude-mem unavailable');
r = await wc(['status', '--json'], { cwd: repoC, env: { CLAUDE_MEM_DATA_DIR: join(TMP, 'nope') } }); j = JSON.parse(r.out);
assert.equal(j.mem.worker, false); ok('worker offline detected');
r = await wc(['resume'], { cwd: repoC, env: { CLAUDE_MEM_DATA_DIR: join(TMP, 'nope') } }); assert.match(r.out, /Task wc-001/); assert.match(r.out, /NEXT ACTION/); ok('recovery still works from local checkpoint');

// ── Scenario E: concurrent sessions ──
sect('Scenario E: concurrent sessions');
const repoE = mkRepo('conc'); git(repoE, 'checkout', '-q', '-b', 'feat/e');
const te = JSON.parse((await wc(['task', 'new', '--title', 'E', '--json'], { cwd: repoE })).out).task;
const files = [1, 2, 3, 4, 5, 6].map((i) => { const f = join(TMP, `e${i}.json`); writeFileSync(f, JSON.stringify({ summary: `s${i}`, completed: [`c${i}`] })); return f; });
const results = await Promise.all(files.map((f, i) => wc(['checkpoint', '--task', te.id, '--from', f, '--session', `s${i}`], { cwd: repoE })));
assert.ok(results.every((x) => x.code === 0), results.map((x) => x.err).join('|'));
const hist = readdirSync(join(CFG, 'work-continuity', 'projects', te.projectKey, 'handoffs', `${te.id}.history`)).filter((f) => f.endsWith('.json'));
assert.equal(hist.length, 6); assert.equal(new Set(hist.map((h) => h.split('.')[0])).size, 6); ok('6 parallel checkpoints: none lost, unique sequence numbers');
r = await wc(['checkpoint', '--task', te.id, '--from', files[0], '--based-on', '2', '--session', 'stale'], { cwd: repoE });
assert.equal(r.code, 3); assert.match(r.err, /did NOT replace the latest/); ok('stale checkpoint refused as latest');
const histAfter = readdirSync(join(CFG, 'work-continuity', 'projects', te.projectKey, 'handoffs', `${te.id}.history`)).filter((f) => f.includes('diverged.json'));
assert.equal(histAfter.length, 1); ok('stale checkpoint preserved in history (diverged)');
const latest = JSON.parse(readFileSync(join(CFG, 'work-continuity', 'projects', te.projectKey, 'handoffs', `${te.id}.json`), 'utf8')); assert.equal(latest.seq, 6); ok('latest is still #6');
const t0 = JSON.parse((await wc(['task', 'show', te.id], { cwd: repoE })).out);
r = await wc(['task', 'update', te.id, '--next', 'mine', '--rev', String(t0.rev - 1)], { cwd: repoE }); assert.equal(r.code, 3); assert.match(r.err, /saved to/); ok('conflicting task update detected and saved, not applied');
r = await wc(['task', 'update', te.id, '--next', 'mine', '--rev', String(t0.rev)], { cwd: repoE }); assert.equal(r.code, 0); ok('matching rev applies');

// ── Scenario F: existing unmerged branches ──
sect('Scenario F: existing project with unfinished branches');
const repoF = mkRepo('legacy');
git(repoF, 'checkout', '-q', '-b', 'feat/old1'); writeFileSync(join(repoF, 'o1.txt'), '1'); git(repoF, 'add', '.'); git(repoF, 'commit', '-qm', 'old1 work');
git(repoF, 'checkout', '-q', 'main'); git(repoF, 'checkout', '-q', '-b', 'feat/old2'); writeFileSync(join(repoF, 'o2.txt'), '2'); git(repoF, 'add', '.'); git(repoF, 'commit', '-qm', 'old2 work');
git(repoF, 'checkout', '-q', 'main'); git(repoF, 'checkout', '-q', '-b', 'feat/merged'); git(repoF, 'checkout', '-q', 'main');
writeFileSync(join(repoF, 'dirty.txt'), 'precious'); writeFileSync(join(repoF, 'a.txt'), 'changed\n');
const before = git(repoF, 'status', '--porcelain'); const branchesBefore = git(repoF, 'branch');
r = await wc(['audit'], { cwd: repoF }); assert.match(r.out, /UNTRACKED-UNMERGED\s+feat\/old1/); assert.match(r.out, /UNTRACKED-UNMERGED\s+feat\/old2/); assert.match(r.out, /merged-no-task\s+feat\/merged/); ok('audit lists unmerged + untracked branches');
r = await wc(['audit', '--register'], { cwd: repoF }); assert.match(r.out, /registered wc-001/); assert.match(r.out, /registered wc-002/); ok('untracked branches registered');
r = await wc(['audit'], { cwd: repoF }); assert.doesNotMatch(r.out, /UNTRACKED-UNMERGED/); ok('re-audit clean');
assert.equal(git(repoF, 'status', '--porcelain'), before); assert.equal(git(repoF, 'branch'), branchesBefore); assert.equal(readFileSync(join(repoF, 'dirty.txt'), 'utf8'), 'precious'); ok('working tree, branches and uncommitted changes untouched');
git(repoF, 'stash', '-q', '-u'); git(repoF, 'merge', '-q', '--no-edit', 'feat/old1'); git(repoF, 'stash', 'pop', '-q');
r = await wc(['task', 'update', 'wc-001', '--status', 'merged'], { cwd: repoF }); assert.equal(r.code, 0, r.err); ok('merged status accepted once Git proves integration');

// ── Scenario G: plugin manifest, hook coexistence ──
sect('Scenario G: plugin manifest and coexistence');
const hj = JSON.parse(readFileSync(join(SRC, 'hooks', 'hooks.json'), 'utf8')).hooks;
assert.deepEqual(Object.keys(hj).sort(), ['PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop']); ok('hooks.json declares the six continuity events');
for (const gs of Object.values(hj)) { assert.equal(gs.length, 1); assert.equal(gs[0].hooks.length, 1); assert.ok(gs[0].hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs')); }
ok('one command per event, all via CLAUDE_PLUGIN_ROOT (no duplicates, no absolute paths)');
const pj = JSON.parse(readFileSync(join(SRC, '.claude-plugin', 'plugin.json'), 'utf8')); assert.equal(pj.name, 'daveen-clauderelay'); ok('plugin.json name is daveen-clauderelay');
const mp = JSON.parse(readFileSync(join(SRC, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8')); assert.equal(mp.name, 'daveen-claudekit'); assert.equal(mp.plugins[0].source, './plugins/daveen-clauderelay'); ok('marketplace daveen-claudekit lists daveen-clauderelay');
assert.ok(existsSync(join(SRC, 'skills', 'relay', 'SKILL.md'))); ok('skill present');
writeFileSync(join(CFG, 'settings.json'), JSON.stringify({ enabledPlugins: { 'daveen-clauderelay@daveen-claudekit': true } }));
r = await wc(['doctor'], { cwd: repoC }); assert.match(r.out, /daveen-clauderelay plugin\s+enabled/); assert.match(r.out, /none \(no duplicates\)/); ok('doctor sees plugin enabled, no legacy duplicates');
writeFileSync(join(CFG, 'settings.json'), JSON.stringify({ enabledPlugins: { 'daveen-clauderelay@daveen-claudekit': true }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/work-continuity/hooks/hook.mjs" Stop' }] }] } }));
r = await wc(['doctor'], { cwd: repoC }); assert.match(r.out, /PRESENT on Stop/); ok('doctor flags leftover standalone hooks as duplicates');

console.log(`\nAll ${n} checks passed. Sandbox: ${TMP}`);
