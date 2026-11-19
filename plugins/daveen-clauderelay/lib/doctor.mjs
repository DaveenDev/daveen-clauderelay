// Diagnostics for `wc doctor`. Read-only (the storage probe writes and removes one temp file).
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './core.mjs';

const OURS = ['/daveen-clauderelay/', '/work-continuity/hooks/hook.mjs'];   // plugin path, or the older standalone installer

export async function diagnose(cwd = process.cwd()) {
  const det = await C.detectAll(cwd);
  const sf = join(C.CFG(), 'settings.json');
  let s = {}, valid = true;
  try { s = existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : {}; } catch { valid = false; }
  const key = Object.keys(s.enabledPlugins ?? {}).find((k) => k.startsWith('daveen-clauderelay@'));
  const pluginOn = key ? s.enabledPlugins[key] !== false : false;
  const legacy = Object.entries(s.hooks ?? {}).filter(([, gs]) => (gs ?? []).some((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes('/work-continuity/hooks/hook.mjs')))).map(([e]) => e);
  const running = !!process.env.CLAUDE_PLUGIN_ROOT || /daveen-clauderelay/i.test(import.meta.url);
  let storage = 'ok';
  try {
    const d = join(C.ROOT(), 'projects'); mkdirSync(d, { recursive: true });
    const probe = join(d, `.probe-${process.pid}`); writeFileSync(probe, 'x'); rmSync(probe);
  } catch (e) { storage = `NOT WRITABLE (${e.code ?? e.message})`; }
  const rows = [
    ['Claude config dir', C.CFG() + (process.env.CLAUDE_CONFIG_DIR ? '  (from CLAUDE_CONFIG_DIR)' : '')],
    ['settings.json', valid ? 'valid JSON' : 'INVALID JSON'],
    ['daveen-clauderelay plugin', pluginOn ? `enabled (${key})` : (running ? 'code is running, but not listed as enabled in user settings (project scope or --plugin-dir is fine)' : 'NOT ENABLED')],
    ['Legacy standalone hooks', legacy.length ? `PRESENT on ${legacy.join(', ')}: duplicates the plugin; remove with the old installer --remove-continuity` : 'none (no duplicates)'],
    ['claude-mem', det.mem.available ? `${det.mem.plugin ? 'plugin ' + (det.mem.version ?? '') : 'cli only'}; hooks (plugin-owned, untouched): ${det.mem.hookEvents.join(', ') || 'n/a'}; worker ${det.mem.worker ? 'healthy' : 'OFFLINE'}; search ${det.mem.search ? 'ready' : 'unavailable'}` : 'not available (local handoff still works)'],
    ['Argent installed', det.argent.installed ? `yes (${det.argent.dir})` : 'no'],
    ['Argent Work Registry', { absent: 'n/a', offline: 'OFFLINE (wire not reachable)', 'no-registry': 'wire reachable but exposes no Work Registry', operational: 'operational' }[det.argent.state]],
    ['Fallback storage', `${C.ROOT()}  ${storage}`],
    ['Git', det.git ? `yes (project ${det.info.key})` : (C.git(cwd, ['--version']) ? 'installed; this folder is not a repo' : 'NOT FOUND')],
    ['Operating mode', C.MODE_NAME[det.mode]],
  ];
  const problems = [];
  if (!valid) problems.push('settings.json is not valid JSON');
  if (!pluginOn && !running) problems.push('daveen-clauderelay plugin not enabled');
  if (legacy.length) problems.push(`legacy standalone hooks duplicate the plugin on: ${legacy.join(', ')}`);
  if (storage !== 'ok') problems.push('fallback storage not writable');
  const w = Math.max(...rows.map((r) => r[0].length));
  const text = rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n') + `\n\n${problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'All checks passed.'}`;
  return { ok: problems.length === 0, problems, rows: Object.fromEntries(rows), mode: det.mode, text };
}
