// Diagnostics shared by `wc doctor` and `install.mjs --check-continuity`. Read-only.
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './core.mjs';
import { HOOK_MARK, HOOKS, BEGIN, END, settingsPath, claudeMdPath } from './config.mjs';

export function inspectSettings() {
  const raw = existsSync(settingsPath()) ? readFileSync(settingsPath(), 'utf8') : '';
  let s = {}, valid = true;
  try { s = raw ? JSON.parse(raw) : {}; } catch { valid = false; }
  const ours = {}, foreign = {};
  for (const [ev, groups] of Object.entries(s.hooks ?? {})) for (const g of groups ?? []) for (const h of g.hooks ?? []) {
    const bucket = String(h.command ?? '').includes(HOOK_MARK) ? ours : foreign;
    (bucket[ev] ??= []).push(h.command);
  }
  return { valid, ours, foreign, settings: s };
}

export async function diagnose(cwd = process.cwd()) {
  const det = await C.detectAll(cwd);
  const st = inspectSettings();
  const md = existsSync(claudeMdPath()) ? readFileSync(claudeMdPath(), 'utf8') : '';
  const mdOk = md.includes(BEGIN) && md.includes(END);
  const missing = Object.keys(HOOKS).filter((e) => !(st.ours[e]?.length));
  const dupes = Object.entries(st.ours).filter(([, v]) => v.length > 1).map(([e]) => e);
  let storage = 'ok';
  try {
    const d = join(C.ROOT(), 'projects'); mkdirSync(d, { recursive: true });
    const probe = join(d, `.probe-${process.pid}`); writeFileSync(probe, 'x'); rmSync(probe);
  } catch (e) { storage = `NOT WRITABLE (${e.code ?? e.message})`; }
  const memHooksInSettings = Object.values(st.foreign).flat().filter((c) => /claude-mem/.test(c)).length;
  const rows = [
    ['Claude config dir', C.CFG() + (process.env.CLAUDE_CONFIG_DIR ? '  (from CLAUDE_CONFIG_DIR)' : '')],
    ['settings.json', st.valid ? 'valid JSON' : 'INVALID JSON'],
    ['Global CLAUDE.md block', mdOk ? 'present' : 'MISSING'],
    ['Continuity hooks', missing.length ? `MISSING: ${missing.join(', ')}` : `registered (${Object.keys(st.ours).join(', ')})`],
    ['Duplicate continuity hooks', dupes.length ? `YES: ${dupes.join(', ')}` : 'none'],
    ['Other hooks preserved', `${Object.values(st.foreign).flat().length} command(s) across ${Object.keys(st.foreign).length} event(s) not owned by us`],
    ['claude-mem', det.mem.available ? `${det.mem.plugin ? 'plugin ' + (det.mem.version ?? '') : 'cli only'}; hooks (plugin-owned): ${det.mem.hookEvents.join(', ') || 'n/a'}${memHooksInSettings ? `; +${memHooksInSettings} in settings.json` : ''}; worker ${det.mem.worker ? 'healthy' : 'OFFLINE'}; search ${det.mem.search ? 'ready' : 'unavailable'}` : 'not available (local handoff still works)'],
    ['Argent installed', det.argent.installed ? `yes (${det.argent.dir})` : 'no'],
    ['Argent Work Registry', { absent: 'n/a', offline: 'OFFLINE (wire not reachable)', 'no-registry': 'wire reachable but exposes no Work Registry', operational: 'operational' }[det.argent.state]],
    ['Fallback storage', `${C.ROOT()}  ${storage}`],
    ['Git', det.git ? `yes (project ${det.info.key})` : (C.git(cwd, ['--version']) ? 'installed; this folder is not a repo' : 'NOT FOUND')],
    ['Operating mode', C.MODE_NAME[det.mode]],
  ];
  const problems = [];
  if (!st.valid) problems.push('settings.json is not valid JSON');
  if (!mdOk) problems.push('CLAUDE.md continuity block missing');
  if (missing.length) problems.push(`hooks missing: ${missing.join(', ')}`);
  if (dupes.length) problems.push(`duplicate hooks: ${dupes.join(', ')}`);
  if (storage !== 'ok') problems.push('fallback storage not writable');
  const w = Math.max(...rows.map((r) => r[0].length));
  const text = rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n') + `\n\n${problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'All continuity checks passed.'}`;
  return { ok: problems.length === 0, problems, rows: Object.fromEntries(rows), mode: det.mode, text };
}
