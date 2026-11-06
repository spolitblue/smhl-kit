#!/usr/bin/env node
/**
 * smhl.mjs — social-media-hacker-list 工具箱（纯 Node 标准库，无依赖）
 *
 * 子命令：
 *   list      筛选/检索条目（可输出表格 / JSON / CSV / 仅 id / 仅 url）
 *   search    等价于 list -q，多个词是 AND
 *   show      看单条详情（含原始 Markdown 行与行号）
 *   stats     统计（支持所有筛选条件）
 *   domains   按域名聚合
 *   rand      随机抽几条，用来“今天做点啥”
 *   open      在浏览器打开某条，或打开可视化面板
 *   export    导出 json / csv / md / html / urls / ids
 *   check     链接体检（GitHub 走 api.github.com，其余走 HEAD/GET）
 *   diff      对比上一版快照，看上游增删改
 *   sync      同步上游最新快照（调用 sync.ps1）
 *   update    sync + 重新解析
 *   help      帮助
 *
 * 例：
 *   node smhl.mjs list -p YouTube --oss -n 5
 *   node smhl.mjs search scraper python --json
 *   node smhl.mjs rand -c for-developers -n 3
 *   node smhl.mjs check --only github
 *   node smhl.mjs export html
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');
const ENTRIES_PATH = join(DATA_DIR, 'entries.json');
const PREV_PATH = join(DATA_DIR, 'entries.prev.json');
const UPSTREAM_PATH = join(DATA_DIR, 'upstream.json');
const TEMPLATE_PATH = join(HERE, 'dashboard.template.html');

/* ================================================================== */
/* 终端小工具                                                          */
/* ================================================================== */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);

/** 显示宽度：CJK 与 emoji 记 2 列，保证终端表格对齐 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - displayWidth(s)));
const cut = (s, n) => {
  s = String(s ?? '');
  if (displayWidth(s) <= n) return s;
  let out = '', w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > n - 1) break;
    out += ch; w += cw;
  }
  return out + '…';
};

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  console.log(headers.map((h, i) => dim(pad(h, widths[i]))).join('  '));
  console.log(widths.map((w) => dim('-'.repeat(w))).join('  '));
  for (const r of rows) console.log(r.map((c, i) => pad(c ?? '', widths[i])).join('  '));
}

/* ================================================================== */
/* 参数解析                                                            */
/* ================================================================== */

const VALUE_FLAGS = new Set([
  '--platform', '-p', '--category', '-c', '--on', '--search', '-q', '--domain',
  '--limit', '-n', '--sort', '--out', '-o', '--only', '--concurrency', '--timeout',
  '--token', '--top', '--count', '-k',
]);

function parseFlags(argv) {
  const flags = Object.create(null);
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.length > 1 && a.startsWith('-')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      if (VALUE_FLAGS.has(name)) {
        const v = inline !== null ? inline : argv[++i];
        if (v === undefined) throw new Error(`${name} 缺少取值`);
        (flags[name] ||= []).push(v);
      } else {
        if (inline !== null) throw new Error(`${name} 不接受取值`);
        flags[name] = true;
      }
    } else pos.push(a);
  }
  return { flags, pos };
}
const multi = (f, ...names) => names.flatMap((n) => f[n] ?? []);
const one = (f, ...names) => multi(f, ...names).at(-1) ?? null;
const bool = (f, ...names) => names.some((n) => f[n] === true);
const num = (f, ...names) => {
  const v = one(f, ...names);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`需要一个整数，收到: ${v}`);
  return n;
};

/* ================================================================== */
/* 数据加载                                                            */
/* ================================================================== */

function loadData() {
  if (!existsSync(ENTRIES_PATH)) {
    fail(`找不到 ${ENTRIES_PATH}\n请先运行: node parse.mjs`);
  }
  return JSON.parse(readFileSync(ENTRIES_PATH, 'utf8'));
}

function loadUpstream() {
  if (!existsSync(UPSTREAM_PATH)) return null;
  try { return JSON.parse(readFileSync(UPSTREAM_PATH, 'utf8')); } catch { return null; }
}

function fail(msg) {
  console.error(red('[x] ') + msg);
  process.exit(1);
}

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
const norm = (s) => String(s ?? '').toLowerCase();

/* ================================================================== */
/* 筛选                                                                */
/* ================================================================== */

function filterEntries(entries, flags) {
  const platforms = multi(flags, '--platform', '-p');
  const categories = multi(flags, '--category', '-c');
  const ons = multi(flags, '--on');
  const terms = multi(flags, '--search', '-q');
  const domains = multi(flags, '--domain');
  const oss = bool(flags, '--oss');
  const closed = bool(flags, '--closed');

  const has = (hay, needles) => needles.some((n) => norm(hay).includes(norm(n)));

  return entries.filter((e) => {
    if (platforms.length && !has(e.section, platforms)) return false;
    if (categories.length && !categories.some((c) =>
      norm(e.category) === norm(c) || e.categoryZh === c || norm(e.category).includes(norm(c)))) return false;
    if (ons.length && !ons.some((t) => (e.platformNames || []).some((p) => norm(p).includes(norm(t))))) return false;
    if (oss && !e.openSource) return false;
    if (closed && e.openSource) return false;
    if (domains.length) {
      const h = `${hostOf(e.url)} ${hostOf(e.sourceUrl)}`;
      if (!has(h, domains)) return false;
    }
    for (const q of terms) {
      const blob = [e.name, e.description, e.section, e.category, e.categoryZh,
        (e.platformNames || []).join(' '), hostOf(e.url), hostOf(e.sourceUrl)].join(' ');
      if (!norm(blob).includes(norm(q))) return false;
    }
    return true;
  });
}

function sortEntries(rows, mode) {
  const out = rows.slice();
  if (mode === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === 'platform') out.sort((a, b) => a.section.localeCompare(b.section) || a.index - b.index);
  return out;
}

/* ================================================================== */
/* 输出格式                                                            */
/* ================================================================== */

const CSV_COLUMNS = ['id', 'section', 'index', 'category', 'categoryZh', 'openSource',
  'sourceUrl', 'name', 'url', 'platformNames', 'description'];

function toCsv(rows) {
  const esc = (v) => {
    const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

function toMarkdown(rows) {
  const out = ['# 社媒工具清单（筛选结果）', '', `共 ${rows.length} 条。`, ''];
  const bySection = new Map();
  for (const e of rows) {
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section).push(e);
  }
  for (const [section, group] of bySection) {
    out.push(`## ${section}`, '', '| # | 名称 | 类别 | 开源 | 平台 | 描述 |', '| --- | --- | --- | :--: | --- | --- |');
    group.forEach((e, i) => {
      out.push(`| ${i + 1} | [${e.name}](${e.url ?? ''}) | ${e.categoryZh} | ${e.openSource ? '❋' : ''} | ${(e.platformNames || []).join(', ')} | ${String(e.description ?? '').replace(/\|/g, '\\|')} |`);
    });
    out.push('');
  }
  return out.join('\n');
}

/* ================================================================== */
/* 子命令: list / search                                               */
/* ================================================================== */

function renderList(flags, extraTerms = []) {
  const data = loadData();
  if (extraTerms.length) (flags['--search'] ||= []).push(...extraTerms);

  let rows = filterEntries(data.entries, flags);
  const total = rows.length;
  rows = sortEntries(rows, one(flags, '--sort'));

  const limit = num(flags, '--limit', '-n');
  const shown = limit && limit > 0 ? rows.slice(0, limit) : rows;

  if (bool(flags, '--json')) {
    console.log(JSON.stringify({ total, returned: shown.length, entries: shown }, null, 2));
    return;
  }
  if (bool(flags, '--ids')) { shown.forEach((e) => console.log(e.id)); return; }
  if (bool(flags, '--urls')) {
    shown.forEach((e) => console.log(e.url || e.sourceUrl || ''));
    return;
  }
  if (bool(flags, '--csv')) {
    process.stdout.write('\ufeff' + toCsv(shown));
    return;
  }

  if (!shown.length) {
    console.log(dim('没有匹配的条目。放宽条件试试，或用 `node smhl.mjs stats` 看全貌。'));
    return;
  }

  const wide = bool(flags, '--wide');
  const emoji = bool(flags, '--emoji');
  printTable(
    ['#', '平台', '类别', '开源', '名称', '链接', '运行于'],
    shown.map((e, i) => [
      String(i + 1),
      e.section,
      emoji ? `${e.categoryGlyph} ${e.categoryZh}` : e.categoryZh,
      e.openSource ? '❋' : '',
      e.name,
      wide ? (e.url ?? '') : cut(e.url ?? '', 46),
      cut((e.platformNames || []).join('/'), wide ? 200 : 22),
    ]),
  );
  console.log('');
  console.log(`${bold(String(total))} / ${data.entries.length} 条` +
    (shown.length < total ? dim(`（已显示前 ${shown.length} 条，-n 可调）`) : '') +
    dim('  ·  -q 关键词  -p 平台  -c 类别  --oss 只看开源  --json 导出'));
}

/* ================================================================== */
/* 子命令: show                                                        */
/* ================================================================== */

function showEntry(pos) {
  const data = loadData();
  const key = pos.join(' ').trim();
  if (!key) fail('用法: node smhl.mjs show <id 或名称片段>');

  const exact = data.entries.filter((e) => e.id === key);
  const matches = exact.length ? exact
    : data.entries.filter((e) => norm(e.name).includes(norm(key)));

  if (!matches.length) fail(`没有匹配 “${key}” 的条目。可先 node smhl.mjs search ${key}`);

  if (matches.length > 1) {
    console.log(yellow(`“${key}” 匹配 ${matches.length} 条，请用更精确的名称或 id：`));
    printTable(['id', '名称', '平台', '链接'],
      matches.slice(0, 30).map((e) => [e.id, e.name, e.section, cut(e.url ?? '', 60)]));
    return;
  }

  const e = matches[0];
  const line = (k, v) => console.log(`${dim(pad(k, 10))} ${v}`);
  console.log('');
  console.log(`${bold(e.name)}  ${dim(`[${e.id}]`)}`);
  console.log('');
  line('平台', e.section);
  line('类别', `${e.categoryZh} (${e.category}) ${e.categoryGlyph}`);
  line('开源', e.openSource ? green('是') : '否');
  line('链接', e.url ?? dim('（无）'));
  if (e.sourceUrl) line('源码', e.sourceUrl);
  line('运行于', (e.platformNames || []).join(', ') || dim('（未标注）'));
  line('描述', e.description ?? '');
  line('出处', `README.md 第 ${e.line} 行`);
  console.log('');
  console.log(dim(e.raw));
  console.log('');
  console.log(dim(`打开: node smhl.mjs open ${e.id}`));
}

/* ================================================================== */
/* 子命令: stats / domains                                             */
/* ================================================================== */

function renderStats(flags) {
  const data = loadData();
  const rows = filterEntries(data.entries, flags);
  const total = data.entries.length;

  if (bool(flags, '--json')) {
    const count = (arr, keyFn) => {
      const m = new Map();
      for (const x of arr) { const k = keyFn(x); m.set(k, (m.get(k) ?? 0) + 1); }
      return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
    };
    console.log(JSON.stringify({
      matched: rows.length, total,
      openSource: rows.filter((e) => e.openSource).length,
      bySection: count(rows, (e) => e.section),
      byCategory: count(rows, (e) => e.categoryZh),
      byDomain: count(rows.filter((e) => e.url), (e) => hostOf(e.url)),
      byTarget: count(rows.flatMap((e) => e.platformNames ?? []), (t) => t),
    }, null, 2));
    return;
  }

  console.log(`${bold(String(rows.length))} / ${total} 条　·　开源 ${rows.filter((e) => e.openSource).length}　·　闭源 ${rows.filter((e) => !e.openSource).length}`);
  const group = (label, keyFn) => {
    const m = new Map();
    for (const x of rows) {
      const keys = keyFn(x);
      for (const k of Array.isArray(keys) ? keys : [keys]) m.set(k, (m.get(k) ?? 0) + 1);
    }
    const sorted = [...m].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return;
    console.log('');
    console.log(bold(label));
    const max = sorted[0][1];
    for (const [k, n] of sorted) {
      const bar = '█'.repeat(Math.max(1, Math.round((n / max) * 24)));
      console.log(`  ${pad(k, 18)} ${String(n).padStart(3)} ${dim(bar)}`);
    }
  };
  group('按平台', (e) => e.section);
  group('按类别', (e) => e.categoryZh);
  group('运行环境 TOP', (e) => (e.platformNames || []).length ? e.platformNames : ['(未标注)']);
}

function renderDomains(flags) {
  const data = loadData();
  const rows = filterEntries(data.entries, flags);
  const m = new Map();
  for (const e of rows) {
    const h = hostOf(e.url) || hostOf(e.sourceUrl);
    if (h) m.set(h, (m.get(h) ?? 0) + 1);
  }
  const sorted = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = num(flags, '--top') ?? sorted.length;
  if (bool(flags, '--json')) {
    console.log(JSON.stringify(Object.fromEntries(sorted.slice(0, top)), null, 2));
    return;
  }
  printTable(['条目', '域名'], sorted.slice(0, top).map(([h, n]) => [String(n), h]));
  console.log('');
  console.log(dim(`共 ${sorted.length} 个不重复域名，覆盖 ${rows.length} 条`));
}

/* ================================================================== */
/* 子命令: rand / open                                                */
/* ================================================================== */

function renderRand(flags) {
  const data = loadData();
  const rows = filterEntries(data.entries, flags);
  const n = num(flags, '--count', '-k') ?? num(flags, '--limit', '-n') ?? 1;
  if (!rows.length) { console.log(dim('没有匹配的条目。')); return; }

  const picked = [];
  const pool = rows.slice();
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  if (bool(flags, '--json')) { console.log(JSON.stringify(picked, null, 2)); return; }

  for (const e of picked) {
    console.log(`${bold(e.name)} ${dim(`[${e.section} · ${e.categoryZh}${e.openSource ? ' · 开源' : ''}]`)}`);
    if (e.description) console.log(`  ${e.description}`);
    console.log(`  ${cyan(e.url ?? e.sourceUrl ?? '')}`);
    console.log('');
  }
  console.log(dim(`从 ${rows.length} 条里随机抽了 ${picked.length} 条`));
}

function openTarget(pos, flags) {
  const target = pos.join(' ').trim();
  const data = loadData();

  if (!target || /^(dashboard|panel|面板|工具箱)$/i.test(target)) {
    const out = join(HERE, 'dashboard.html');
    if (!existsSync(out)) {
      console.log(dim('面板还没生成，先生成一次…'));
      exportHtml(out, flags);
    }
    openInBrowser('file:///' + out.replace(/\\/g, '/'));
    console.log(`已在浏览器打开 ${out}`);
    return;
  }

  const hit = data.entries.find((e) => e.id === target)
    ?? data.entries.find((e) => norm(e.name) === norm(target))
    ?? data.entries.find((e) => norm(e.name).includes(norm(target)));
  if (!hit) fail(`没有匹配 “${target}” 的条目`);
  const url = hit.url || hit.sourceUrl;
  if (!url) fail(`“${hit.name}” 没有可打开的链接`);
  openInBrowser(url);
  console.log(`已打开 ${bold(hit.name)} → ${url}`);
}

function openInBrowser(url) {
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
  else if (process.platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' });
  else spawnSync('xdg-open', [url], { stdio: 'ignore' });
}

/* ================================================================== */
/* 子命令: export                                                      */
/* ================================================================== */

function escapeForJsonScript(json) {
  return json
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function exportHtml(outPath, flags) {
  const data = loadData();
  const upstream = loadUpstream();
  if (!existsSync(TEMPLATE_PATH)) fail(`找不到面板模板 ${TEMPLATE_PATH}`);

  const payload = {
    meta: {
      ...data.meta,
      upstreamCommit: upstream?.commit ?? null,
      upstreamCommitDate: upstream?.commitDate ?? null,
      upstreamFetchedAt: upstream?.fetchedAt ?? null,
      exportedAt: new Date().toISOString(),
      filters: {
        platform: multi(flags, '--platform', '-p'),
        category: multi(flags, '--category', '-c'),
        search: multi(flags, '--search', '-q'),
        oss: bool(flags, '--oss'),
      },
    },
    entries: bool(flags, '--oss') || multi(flags, '--platform', '-p', '--category', '-c', '--search', '-q').length || multi(flags, '--on').length || multi(flags, '--domain').length
      ? filterEntries(data.entries, flags)
      : data.entries,
  };

  const tpl = readFileSync(TEMPLATE_PATH, 'utf8');
  if (!tpl.includes('__SMHL_DATA__')) fail('模板缺少 __SMHL_DATA__ 占位符');
  const html = tpl.replace('__SMHL_DATA__', escapeForJsonScript(JSON.stringify(payload)));
  writeFileSync(outPath, html, 'utf8');
  console.log(`${green('✓')} 已生成面板 ${bold(outPath)}（${payload.entries.length} 条，${(html.length / 1024).toFixed(0)} KB）`);
  return outPath;
}

function renderExport(fmt, flags) {
  const data = loadData();
  const rows = sortEntries(filterEntries(data.entries, flags), one(flags, '--sort'));
  const out = one(flags, '--out', '-o');
  const format = (fmt ?? '').toLowerCase();

  if (!format) fail('用法: node smhl.mjs export <json|csv|md|html|urls|ids> [--out 文件]');

  if (format === 'html') {
    exportHtml(out ? resolve(process.cwd(), out) : join(HERE, 'dashboard.html'), flags);
    return;
  }

  let text;
  if (format === 'json') text = JSON.stringify({ total: rows.length, entries: rows }, null, 2) + '\n';
  else if (format === 'csv') text = '\ufeff' + toCsv(rows);
  else if (format === 'md' || format === 'markdown') text = toMarkdown(rows) + '\n';
  else if (format === 'urls') text = rows.map((e) => e.url ?? '').filter(Boolean).join('\n') + '\n';
  else if (format === 'ids') text = rows.map((e) => e.id).join('\n') + '\n';
  else fail(`不支持的格式: ${fmt}（可用 json/csv/md/html/urls/ids）`);

  if (out) {
    writeFileSync(resolve(process.cwd(), out), text, 'utf8');
    console.log(`${green('✓')} 已写入 ${bold(resolve(process.cwd(), out))}（${rows.length} 条）`);
  } else {
    process.stdout.write(text);
  }
}

/* ================================================================== */
/* 子命令: check（链接体检）                                            */
/* ================================================================== */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0';
const OK_STATUS = new Set([200, 403, 406]);
const INACTIVE_DAYS = 365;

function githubRepoParts(u) {
  try {
    const url = new URL(u);
    if (url.host !== 'github.com' && url.host !== 'www.github.com') return null;
    const p = url.pathname.split('/').filter(Boolean);
    if (p.length < 2) return null;
    return { owner: p[0], repo: p[1].replace(/\.git$/, '') };
  } catch { return null; }
}

async function checkGithub(u, token, timeoutMs) {
  const parts = githubRepoParts(u);
  const headers = { 'User-Agent': 'smhl-check', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `token ${token}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${parts.owner}/${parts.repo}`, {
      headers, signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 404) return { ok: false, reason: '仓库不存在或已改名' };
    if (r.status === 403 || r.status === 429) {
      const remaining = r.headers.get('x-ratelimit-remaining');
      return { ok: false, reason: `GitHub API 限流（remaining=${remaining ?? '?'}），设置 GITHUB_TOKEN 可解` };
    }
    if (!r.ok) return { ok: false, reason: `API ${r.status}` };
    const j = await r.json();
    if (j.archived) return { ok: false, reason: '仓库已归档' };
    const days = Math.floor((Date.now() - Date.parse(j.pushed_at)) / 86400000);
    if (days >= INACTIVE_DAYS) return { ok: false, reason: `停更 ${days} 天` };
    if (j.disabled) return { ok: false, reason: '仓库已禁用' };
    return { ok: true, reason: `${days} 天前有提交`, stars: j.stargazers_count };
  } catch (err) {
    return { ok: false, reason: `请求失败: ${err.name === 'TimeoutError' ? '超时' : err.message}` };
  }
}

async function checkUrl(u, timeoutMs) {
  const opts = { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) };
  const acceptable = (status) =>
    OK_STATUS.has(status) ||
    (status === 502 && u.includes('reddit.com/')) ||
    (status === 429 && u.includes('apps.apple.com/'));
  try {
    let r = await fetch(u, { ...opts, method: 'HEAD' });
    if (acceptable(r.status)) return { ok: true, reason: `HTTP ${r.status}` };
    r = await fetch(u, { ...opts, method: 'GET' });
    if (acceptable(r.status)) return { ok: true, reason: `HTTP ${r.status} (GET)` };
    return { ok: false, reason: `HTTP ${r.status}` };
  } catch (err) {
    const why = err.name === 'TimeoutError' ? '超时' : (err.cause?.code ?? err.message);
    return { ok: false, reason: `无法访问 (${why})` };
  }
}

async function renderCheck(flags) {
  const data = loadData();
  const rows = bool(flags, '--all') ? data.entries : filterEntries(data.entries, flags);
  const only = norm(one(flags, '--only') ?? '');
  const timeoutMs = (num(flags, '--timeout') ?? 15) * 1000;
  const concurrency = Math.max(1, num(flags, '--concurrency') ?? 8);
  const token = one(flags, '--token') ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

  const jobs = [];
  for (const e of rows) {
    const isGit = (u) => !!githubRepoParts(u);
    const targets = [{ kind: '主链接', url: e.url }];
    if (bool(flags, '--all') && e.sourceUrl && e.sourceUrl !== e.url) targets.push({ kind: '源码', url: e.sourceUrl });
    for (const t of targets) {
      if (!t.url) continue;
      const kind = isGit(t.url) ? 'github' : 'web';
      if (only && only !== kind) continue;
      jobs.push({ entry: e, ...t, kind });
    }
  }

  if (!jobs.length) { console.log(dim('没有需要检查的链接。')); return; }

  const githubJobs = jobs.filter((j) => j.kind === 'github').length;
  console.log(`检查 ${jobs.length} 个链接（GitHub ${githubJobs} 个走 API，其余 ${jobs.length - githubJobs} 个走 HTTP）`);
  if (githubJobs > 55 && !token) {
    console.log(yellow(`提示：未提供 GITHUB_TOKEN，GitHub API 未认证限流为 60 次/小时，${githubJobs} 个仓库可能触发 403。`));
  }

  let done = 0, index = 0;
  const failures = [];
  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];
      const res = job.kind === 'github'
        ? await checkGithub(job.url, token, timeoutMs)
        : await checkUrl(job.url, timeoutMs);
      done++;
      if (!res.ok) failures.push({ ...job, reason: res.reason });
      if (process.stdout.isTTY && !bool(flags, '--quiet')) {
        process.stdout.write(`\r  进度 ${done}/${jobs.length}  失败 ${failures.length}   `);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (process.stdout.isTTY && !bool(flags, '--quiet')) process.stdout.write('\r' + ' '.repeat(48) + '\r');

  if (bool(flags, '--json')) {
    console.log(JSON.stringify({
      checked: jobs.length, failed: failures.length,
      ok: jobs.length - failures.length,
      failures: failures.map((f) => ({ id: f.entry.id, name: f.entry.name, kind: f.kind, url: f.url, reason: f.reason })),
    }, null, 2));
  } else if (failures.length) {
    console.log('');
    printTable(['名称', '平台', '类型', '链接', '原因'],
      failures.map((f) => [f.entry.name, f.entry.section, f.kind, cut(f.url, 48), f.reason]));
    console.log('');
    console.log(`${green('✓')} 通过 ${jobs.length - failures.length}　${failures.length ? red(`✗ 失败 ${failures.length}`) : ''}`);
  } else {
    console.log(`${green('✓')} 全部 ${jobs.length} 个链接通过`);
  }

  if (failures.length) process.exitCode = 1;
}

/* ================================================================== */
/* 子命令: diff                                                        */
/* ================================================================== */

const DIFF_FIELDS = ['name', 'url', 'sourceUrl', 'section', 'category', 'openSource', 'description'];

function renderDiff(flags) {
  if (!existsSync(PREV_PATH)) {
    fail('还没有上一版快照。先跑一次 node parse.mjs 生成基线，之后每次同步再解析就能对比了。');
  }
  const prev = JSON.parse(readFileSync(PREV_PATH, 'utf8'));
  const cur = loadData();
  const prevMap = new Map(prev.entries.map((e) => [e.id, e]));
  const curMap = new Map(cur.entries.map((e) => [e.id, e]));

  const added = cur.entries.filter((e) => !prevMap.has(e.id));
  const removed = prev.entries.filter((e) => !curMap.has(e.id));
  const changed = [];
  for (const e of cur.entries) {
    const p = prevMap.get(e.id);
    if (!p) continue;
    const diffs = DIFF_FIELDS.filter((f) => {
      const a = e[f], b = p[f];
      return Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) !== JSON.stringify(b) : a !== b;
    });
    if (diffs.length) changed.push({ entry: e, before: p, fields: diffs });
  }

  if (bool(flags, '--json')) {
    console.log(JSON.stringify({
      prevSnapshotAt: prev.meta?.generatedAt ?? null,
      currentSnapshotAt: cur.meta?.generatedAt ?? null,
      counts: { prev: prev.entries.length, current: cur.entries.length, added: added.length, removed: removed.length, changed: changed.length },
      added: added.map((e) => ({ id: e.id, name: e.name, url: e.url, section: e.section })),
      removed: removed.map((e) => ({ id: e.id, name: e.name, url: e.url, section: e.section })),
      changed: changed.map((c) => ({ id: c.entry.id, name: c.entry.name, fields: c.fields })),
    }, null, 2));
    return;
  }

  console.log(`上一版: ${dim(prev.meta?.generatedAt ?? '?')}（${prev.entries.length} 条）`);
  console.log(`当前版: ${dim(cur.meta?.generatedAt ?? '?')}（${cur.entries.length} 条）`);
  console.log('');

  if (!added.length && !removed.length && !changed.length) {
    console.log(green('✓ 没有差异'));
    return;
  }
  if (added.length) {
    console.log(green(`+ 新增 ${added.length} 条`));
    added.forEach((e) => console.log(`  + [${e.section}] ${e.name} — ${dim(e.url ?? '')}`));
  }
  if (removed.length) {
    console.log(red(`- 移除 ${removed.length} 条`));
    removed.forEach((e) => console.log(`  - [${e.section}] ${e.name}`));
  }
  if (changed.length) {
    console.log(yellow(`~ 变更 ${changed.length} 条`));
    changed.forEach((c) => {
      console.log(`  ~ [${c.entry.section}] ${c.entry.name}`);
      c.fields.forEach((f) => {
        const before = Array.isArray(c.before[f]) ? (c.before[f] ?? []).map((p) => p.name).join('/') : c.before[f];
        const after = Array.isArray(c.entry[f]) ? (c.entry[f] ?? []).map((p) => p.name).join('/') : c.entry[f];
        console.log(`      ${f}: ${red(cut(String(before ?? ''), 60))} → ${green(cut(String(after ?? ''), 60))}`);
      });
    });
  }
}

/* ================================================================== */
/* 子命令: sync / update                                               */
/* ================================================================== */

function runSync(flags, thenParse) {
  const script = join(HERE, 'sync.ps1');
  if (!existsSync(script)) fail(`找不到 ${script}`);
  const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (thenParse || bool(flags, '--parse')) args.push('-Parse');
  if (bool(flags, '--commit')) args.push('-Commit');
  const r = spawnSync(shell, args, { stdio: 'inherit' });
  if (r.error) fail(`调用 ${shell} 失败: ${r.error.message}`);
  process.exitCode = r.status ?? 1;
}

/* ================================================================== */
/* help & 路由                                                         */
/* ================================================================== */

const HELP = `social-media-hacker-list 工具箱

用法: node smhl.mjs <命令> [选项]

筛选选项（list/search/stats/domains/rand/export/check 通用）
  -p, --platform <名>    平台章节，可重复，子串匹配（YouTube / X / Reddit ...）
  -c, --category <名>    类别，可重复，中英文都认（for-developers / 面向开发者）
      --on <名>          运行环境（Android / iOS / Extension / Web / Python ...）
  -q, --search <词>      关键词，可重复，多个词是 AND（名称/描述/平台/域名）
      --domain <域名>    按链接域名过滤（github.com ...）
      --oss              只看开源
      --closed           只看闭源

命令
  list                    列出条目（默认表格）
      -n, --limit <N>      最多显示 N 条
      --sort <source|name|platform>
      --json | --csv | --ids | --urls | --wide | --emoji
  search <词...>          等价于 list -q
  show <id|名称片段>      单条详情（含 README 行号与原始行）
  stats [筛选]            统计：平台/类别/运行环境分布（--json）
  domains [筛选]          域名聚合（--top N --json）
  rand [-k N] [筛选]      随机抽几条
  open [id|名称|dashboard]  浏览器打开该条，或打开可视化面板
  export <格式> [-o 文件]  格式: json | csv | md | html | urls | ids
                          html 生成离线可视化面板（默认 dashboard.html）
  check [筛选]            链接体检
      --only <github|web>  只查某一类
      --all               连 ❋ 源码链接一起查
      --concurrency <N>    并发（默认 8）
      --timeout <秒>       单链接超时（默认 15）
      --token <token>      GitHub token，或设环境变量 GITHUB_TOKEN
      --json
  diff                    对比上一版快照（--json）
  sync [--commit]         同步上游最新快照
  update                  同步上游并重新解析
  help                    本帮助

例
  node smhl.mjs list -p YouTube --oss -n 5
  node smhl.mjs search scraper --domain github.com
  node smhl.mjs rand -c for-developers -k 3
  node smhl.mjs export md -o 我的清单.md
  node smhl.mjs export html && node smhl.mjs open dashboard
  node smhl.mjs check --only github
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, pos } = parseFlags(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || bool(flags, '--help', '-h')) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'list': return renderList(flags);
    case 'search': return renderList(flags, pos);
    case 'show': return showEntry(pos);
    case 'stats': return renderStats(flags);
    case 'domains': return renderDomains(flags);
    case 'rand': return renderRand(flags);
    case 'open': return openTarget(pos, flags);
    case 'export': return renderExport(pos[0], flags);
    case 'dashboard': {
      const out = exportHtml(join(HERE, 'dashboard.html'), flags);
      openInBrowser('file:///' + out.replace(/\\/g, '/'));
      return;
    }
    case 'check': return await renderCheck(flags);
    case 'diff': return renderDiff(flags);
    case 'sync': return runSync(flags, false);
    case 'update': return runSync(flags, true);
    default:
      console.error(red(`[x] 未知命令: ${cmd}`));
      console.log('');
      console.log(HELP);
      process.exitCode = 1;
  }
}

await main().catch((err) => {
  console.error(red('[x] ') + (err?.stack ?? err));
  process.exitCode = 1;
});
