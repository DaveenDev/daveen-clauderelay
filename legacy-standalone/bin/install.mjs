#!/usr/bin/env node
// Installs the work-continuity layer into Claude Code's USER configuration (%USERPROFILE%\.claude, or CLAUDE_CONFIG_DIR).
//   node bin/install.mjs --global-continuity   install / update (idempotent)
//   node bin/install.mjs --check-continuity    diagnostics, writes nothing
//   node bin/install.mjs --remove-continuity   remove ONLY continuity-owned config (hooks + CLAUDE.md block + installed code)
// Flags: --dry-run (show, write nothing)   --purge-data (with --remove-continuity: also delete saved tasks/checkpoints)
// Independent of Argent. Never touches claude-mem, its hooks, its worker or its database. Other hooks/permissions are preserved.
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, copyFileSync, readdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { CFG, ROOT, readJson } from '../lib/core.mjs';
import { HOOKS, HOOK_MARK, BEGIN, END, hookCommand, claudeMdPath, settingsPath, instructions } from '../lib/config.mjs';
import { diagnose, inspectSettings } from '../lib/doctor.mjs';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = resolve(ROOT());
const log = (s) => console.log(`${DRY ? '[dry-run] ' : ''}${s}`);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const isOurs = (h) => String(h?.command ?? '').includes(HOOK_MARK);

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.wc-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
function backup(file) {
  if (!existsSync(file)) return;
  copyFileSync(file, `${file}.continuity-backup-${Date.now()}`);
  const mine = readdirSync(dirname(file)).filter((f) => f.startsWith(`${file.split(/[\\/]/).pop()}.continuity-backup-`)).sort();
  for (const old of mine.slice(0, -3)) rmSync(join(dirname(file), old), { force: true });   // keep the 3 newest
}

// Every hook command that is not ours, as a flat list: install/remove must leave this list byte-identical.
const foreignCommands = (s) => Object.entries(s.hooks ?? {}).flatMap(([ev, gs]) => (gs ?? []).flatMap((g) => (g.hooks ?? []).filter((h) => !isOurs(h)).map((h) => `${ev}|${g.matcher ?? ''}|${JSON.stringify(h)}`)));

function copyCode() {
  if (same(SRC, DEST)) return log(`code already lives at ${DEST}`);
  log(`copy code -> ${DEST} (bin, lib, hooks; saved data is never touched)`);
  if (DRY) return;
  for (const d of ['bin', 'lib', 'hooks']) cpSync(join(SRC, d), join(DEST, d), { recursive: true, force: true });
  if (existsSync(join(SRC, 'README.md'))) copyFileSync(join(SRC, 'README.md'), join(DEST, 'README.md'));
}

function writeSettings(mutator) {
  const raw = existsSync(settingsPath()) ? readFileSync(settingsPath(), 'utf8') : '';
  let s = {};
  if (raw.trim()) { try { s = JSON.parse(raw); } catch (e) { console.error(`settings.json is not valid JSON (${e.message}); fix it first. Nothing was changed.`); process.exit(1); } }
  const before = foreignCommands(s);
  mutator(s);
  if (JSON.stringify(foreignCommands(s)) !== JSON.stringify(before)) { console.error('internal safety check failed: other hooks would change. Aborting, nothing written.'); process.exit(1); }
  const out = JSON.stringify(s, null, 2) + '\n';
  if (out === raw) return log('settings.json already up to date');
  log(`update ${settingsPath()} (backup alongside)`);
  if (DRY) return;
  backup(settingsPath());
  atomicWrite(settingsPath(), out);
  JSON.parse(readFileSync(settingsPath(), 'utf8'));          // re-read to prove it is still valid
}

const stripOurs = (groups) => (groups ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);

function installSettings() {
  writeSettings((s) => {
    s.hooks ??= {};
    for (const [ev, specs] of Object.entries(HOOKS)) {
      const groups = stripOurs(s.hooks[ev]);                  // idempotent: drop our old entries, add the current ones
      for (const sp of specs) groups.push({ ...(sp.matcher ? { matcher: sp.matcher } : {}), hooks: [{ type: 'command', command: hookCommand(ev), timeout: sp.timeout }] });
      s.hooks[ev] = groups;
    }
  });
}
function removeSettings() {
  writeSettings((s) => {
    for (const ev of Object.keys(s.hooks ?? {})) { s.hooks[ev] = stripOurs(s.hooks[ev]); if (!s.hooks[ev].length) delete s.hooks[ev]; }
    if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  });
}

function claudeMd(remove) {
  const f = claudeMdPath();
  const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const re = new RegExp(`\\n?${esc(BEGIN)}[\\s\\S]*?${esc(END)}\\n?`);
  let next = cur.replace(re, '\n');
  if (!remove) next = `${next.trimEnd()}\n\n${BEGIN}\n${instructions()}\n${END}\n`;
  next = next.replace(/^\n+/, '');
  if (next === cur) return log('CLAUDE.md already up to date');
  log(`${remove ? 'remove' : 'write'} continuity block in ${f} (backup alongside)`);
  if (DRY) return;
  backup(f);
  atomicWrite(f, next);
}

async function main() {
  if (args.has('--check-continuity')) {
    const r = await diagnose(process.cwd());
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  }
  console.log(`Work continuity ${args.has('--remove-continuity') ? 'removal' : 'install'}${DRY ? ' (dry run)' : ''}\n  claude config: ${CFG()}\n  continuity dir: ${DEST}\n`);
  if (args.has('--remove-continuity')) {
    removeSettings();
    claudeMd(true);
    if (!same(SRC, DEST)) {
      log('remove installed code (bin, lib, hooks)');
      if (!DRY) for (const d of ['bin', 'lib', 'hooks']) rmSync(join(DEST, d), { recursive: true, force: true });
    } else log('running from the install folder: code left in place');
    if (args.has('--purge-data')) { log('delete saved tasks and checkpoints'); if (!DRY) for (const d of ['projects', 'state']) rmSync(join(DEST, d), { recursive: true, force: true }); }
    else log('saved tasks/checkpoints kept (add --purge-data to delete them)');
    console.log('\nclaude-mem and all other hooks, permissions and settings were left untouched.');
    return;
  }
  if (!args.has('--global-continuity')) { console.log('Usage: node bin/install.mjs --global-continuity | --check-continuity | --remove-continuity  [--dry-run] [--purge-data]'); return; }
  copyCode();
  installSettings();
  claudeMd(false);
  if (!DRY) { mkdirSync(join(DEST, 'projects'), { recursive: true }); const r = await diagnose(process.cwd()); console.log(`\n${r.text}`); if (!r.ok) process.exit(1); }
  console.log('\nNew Claude Code sessions (Desktop and CLI) pick this up; restart sessions that are already running.');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
