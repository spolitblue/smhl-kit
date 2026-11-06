#!/usr/bin/env node
/**
 * verify.mjs — 工具箱自检：数据完整性 + 面板能否真的在浏览器里跑起来。
 *
 *   node verify.mjs
 *
 * 面板渲染检查用本机 Chromium 内核浏览器（Edge / Chrome）无头模式 dump DOM，
 * 找不到浏览器时自动跳过那一步，只做静态检查。
 */

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRIES = join(HERE, 'data', 'entries.json');
const DASHBOARD = join(HERE, 'dashboard.html');
const TEMPLATE = join(HERE, 'dashboard.template.html');

const c = (code, s) => `\u001b[${code}m${s}\u001b[0m`;
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? c(32, '  ✓') : c(31, '  ✗')} ${label}${detail ? c(90, `  ${detail}`) : ''}`);
  if (!ok) failures++;
};
const step = (t) => console.log(`\n${c(1, t)}`);

/* ---------------- 1. 数据完整性 ---------------- */
step('1. 数据完整性');

if (!existsSync(ENTRIES)) {
  console.log(c(31, '  找不到 data/entries.json，请先跑 node parse.mjs'));
  process.exit(1);
}
const data = JSON.parse(readFileSync(ENTRIES, 'utf8'));
const entries = data.entries;

check('entries.json 可解析', true, `${entries.length} 条`);
check('条目数 > 0', entries.length > 0);
check('每条都有 id / name / section',
  entries.every((e) => e.id && e.name && e.section));
check('id 无重复', new Set(entries.map((e) => e.id)).size === entries.length);
// 主链接可能缺失（上游确实有这种行，链接放在“平台”列），但必须有链接可点
const noLink = entries.filter((e) => !e.url && !e.sourceUrl &&
  !(e.platforms ?? []).some((p) => p.url));
check('每条都能点到某个链接（主链接/源码/平台链接）', noLink.length === 0,
  noLink.map((e) => e.id).join(', ') ||
  `无主链接但平台列有链接: ${entries.filter((e) => !e.url && !e.sourceUrl).map((e) => e.id).join(', ') || '无'}`);
check('类别都已识别', entries.every((e) => e.category && e.category !== 'unknown'),
  entries.filter((e) => e.category === 'unknown').length + ' 条未知');

const anomaliesPath = join(HERE, 'data', 'anomalies.json');
if (existsSync(anomaliesPath)) {
  const a = JSON.parse(readFileSync(anomaliesPath, 'utf8'));
  const hard = a.anomalies.filter((x) => x.type !== 'missing-primary-url');
  check('无硬性解析异常（列数/序号/重复）', hard.length === 0,
    hard.length ? hard.map((x) => x.type).join(', ') : `软性提示 ${a.anomalies.length - hard.length} 条`);
}

/* ---------------- 2. 上游快照 vs 解析结果 ---------------- */
step('2. 上游快照一致性');

const README = join(HERE, '..', 'social-media-hacker-list', 'README.md');
if (existsSync(README)) {
  const lines = readFileSync(README, 'utf8').split(/\r?\n/);
  const rowCount = lines.filter((l) => /^\|\s*\d+\.\s*\|/.test(l)).length;
  check('README 表格行数 == 解析条目数', rowCount === entries.length,
    `README ${rowCount} 行 / 解析 ${entries.length} 条`);
} else {
  console.log(c(90, '  – 跳过（找不到上游 README.md）'));
}

const upstreamPath = join(HERE, 'data', 'upstream.json');
if (existsSync(upstreamPath)) {
  const u = JSON.parse(readFileSync(upstreamPath, 'utf8'));
  check('upstream.json 记录了 commit', !!u.commit, (u.commit ?? '').slice(0, 7) + ` (${u.branch})`);
}

/* ---------------- 3. 面板静态检查 ---------------- */
step('3. 面板静态检查');

check('dashboard.template.html 存在', existsSync(TEMPLATE));
if (existsSync(DASHBOARD)) {
  const html = readFileSync(DASHBOARD, 'utf8');
  check('dashboard.html 已生成', true, `${(html.length / 1024).toFixed(0)} KB`);
  check('已注入数据（无残留占位符）', !html.includes('__SMHL_DATA__'));
  const m = html.match(/<script id="smhl-data" type="application\/json">([\s\S]*?)<\/script>/);
  check('内嵌 JSON 区块存在', !!m);
  if (m) {
    const payload = JSON.parse(m[1]);
    check('内嵌条目数与数据文件一致', payload.entries.length === entries.length,
      `${payload.entries.length} vs ${entries.length}`);
  }
  check('未把原始 </script> 注入（转义生效）', !/<\/script>/.test(m ? m[1] : ''));
} else {
  check('dashboard.html 已生成（跑 node smhl.mjs export html）', false);
}

/* ---------------- 4. 浏览器无头渲染 ---------------- */
step('4. 浏览器渲染');

const CANDIDATES = [
  process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Google/Chrome/Application/chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
  process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean);
const browser = CANDIDATES.find((p) => existsSync(p));

if (!browser || !existsSync(DASHBOARD)) {
  console.log(c(90, `  – 跳过（没找到 Edge/Chrome${existsSync(DASHBOARD) ? '' : '，或面板未生成'}）`));
} else {
  const profile = mkdtempSync(join(tmpdir(), 'smhl-verify-'));
  const r = spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--virtual-time-budget=8000', '--dump-dom',
    'file:///' + DASHBOARD.replace(/\\/g, '/'),
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const dom = r.stdout ?? '';
  check('浏览器成功 dump DOM', dom.length > 1000, `${(dom.length / 1024).toFixed(0)} KB`);
  if (dom.length > 1000) {
    const cards = (dom.match(/class="card"/g) ?? []).length;
    check('渲染出的卡片数与数据一致', cards === entries.length, `${cards} vs ${entries.length}`);
    check('搜索框已就位', dom.includes('id="q"'));
    check('平台下拉已填充', dom.includes('YouTube (24)') || /<option value="YouTube"/.test(dom));
    check('统计行已渲染', /id="count"[^>]*>[\s\S]{0,80}?显示/.test(dom));
    // 空状态是 <div class="empty">；注意正文里出现该文案不代表渲染结果为空
    const main = dom.match(/<main id="list">([\s\S]*?)<\/main>/);
    check('列表区未落入空状态', !!main && !main[1].includes('class="empty"'),
      main ? `${(main[1].match(/class="card"/g) ?? []).length} 张卡片` : '找不到 <main id="list">');
  }
  if (r.stderr && /Error|Uncaught/.test(r.stderr) && !/DevTools|GPU|Vulkan|voice|registration/i.test(r.stderr)) {
    console.log(c(90, '  （浏览器 stderr 摘要）' + r.stderr.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ')));
  }
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

/* ---------------- 结果 ---------------- */
console.log('');
if (failures) {
  console.log(c(31, `自检失败：${failures} 项`));
  process.exitCode = 1;
} else {
  console.log(c(32, '自检通过：全部检查项正常'));
}
