#!/usr/bin/env node
/**
 * parse.mjs — 把 MobileFirstLLC/social-media-hacker-list 的 README.md
 * 解析成结构化数据（JSON / CSV / 汇总报告）。
 *
 * 用法:
 *   node parse.mjs
 *   node parse.mjs --input ../social-media-hacker-list/README.md --out ./data
 *
 * 设计要点:
 *   - 纯 Node 标准库，无第三方依赖。
 *   - README 的表格列为: # | 类别色块 | ❋开源链接 | 名称 | 平台 | 描述
 *   - 解析不假设列数恰好为 6：列数异常会被记录到 data/anomalies.json，不会静默丢数据。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgv(argv) {
  const out = { input: null, out: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

const argv = parseArgv(process.argv.slice(2));
if (argv.help) {
  console.log(`用法: node parse.mjs [--input README.md] [--out data] [--quiet]

  --input, -i   源 README.md 路径（默认 ../social-media-hacker-list/README.md）
  --out,   -o   输出目录（默认 ./data）
  --quiet, -q   只在出错时输出
  --help,  -h   显示帮助`);
  process.exit(0);
}

const INPUT = resolve(HERE, argv.input ?? '../social-media-hacker-list/README.md');
const OUTDIR = resolve(HERE, argv.out ?? 'data');

if (!existsSync(INPUT)) {
  console.error(`[x] 找不到输入文件: ${INPUT}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 类别图例（与 README 的 Legend 一节保持一致）                          */
/* ------------------------------------------------------------------ */

const CATEGORY_BY_GLYPH = new Map([
  ['\u{1F7EA}', 'alternative-client'],   // 🟪 替代客户端
  ['\u{1F7E7}', 'analytics-data'],       // 🟧 分析与数据
  ['\u{2B1B}',  'bots'],                 // ⬛ 机器人
  ['\u{1F7E6}', 'content-creation'],     // 🟦 内容创作
  ['\u{1F7EB}', 'for-developers'],       // 🟫 面向开发者
  ['\u{1F7E9}', 'image'],                // 🟩 图片
  ['\u{1F7E8}', 'productivity-tools'],   // 🟨 效率与工具
  ['\u{1F7E5}', 'video'],                // 🟥 视频
]);

const CATEGORY_LABEL_ZH = {
  'alternative-client': '替代客户端',
  'analytics-data': '分析与数据',
  'bots': '机器人',
  'content-creation': '内容创作',
  'for-developers': '面向开发者',
  'image': '图片',
  'productivity-tools': '效率与工具',
  'video': '视频',
  unknown: '未知类别',
};

const OPEN_SOURCE_MARK = '\u274B'; // ❋

/** 非平台章节，正文不是表格数据 */
const NON_SECTION_HEADINGS = new Set(['Legend']);

/* ------------------------------------------------------------------ */
/* Markdown 小工具                                                     */
/* ------------------------------------------------------------------ */

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** 变体选择符 / 零宽字符，比较前先剥掉 */
const NOISE_RE = /[\uFE0E\uFE0F\u200B-\u200D\u2060]/g;

const stripNoise = (s) => s.replace(NOISE_RE, '');
const stripMd = (s) =>
  s.replace(/`([^`]*)`/g, '$1')
   .replace(/\*\*([^*]*)\*\*/g, '$1')
   .replace(/\*([^*]*)\*/g, '$1')
   .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
   .trim();

/** 取出单元格里的全部 markdown 链接，并返回去掉链接后的剩余文本 */
function extractLinks(cell) {
  const links = [];
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(cell)) !== null) {
    links.push({ name: stripMd(m[1]), url: m[2] });
  }
  const rest = cell.replace(LINK_RE, ' ');
  return { links, rest };
}

/** "Web, iOS, Android" -> [{name:'Web'},{name:'iOS'},{name:'Android'}] */
function splitPlainTokens(rest) {
  return rest
    .split(/[,、]/)
    .map((t) => stripMd(t))
    .filter((t) => t.length > 0)
    .map((name) => ({ name, url: null }));
}

const slugify = (s) =>
  stripNoise(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

const source = readFileSync(INPUT, 'utf8');
const lines = source.split(/\r?\n/);

const entries = [];
const anomalies = [];
let currentSection = null;
let sectionOrder = 0;

/** 形如 | --- | :--: | 的分隔行 */
const isSeparatorRow = (cells) => cells.every((c) => /^[:\-\s]*$/.test(c));
/** 形如 | # |  |  | Name | Platform | Description | 的表头行 */
const isHeaderRow = (cells) =>
  /^#+\.?$/.test(cells[0] ?? '') ||
  (cells.some((c) => c === 'Name') && cells.some((c) => c === 'Description'));

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNo = i + 1;

  const heading = line.match(/^###\s+(.+?)\s*$/);
  if (heading) {
    const title = heading[1].trim();
    if (NON_SECTION_HEADINGS.has(title)) {
      currentSection = null;
    } else {
      currentSection = title;
      sectionOrder++;
    }
    continue;
  }

  if (!line.trimStart().startsWith('|')) continue;
  if (!currentSection) continue; // 图例/正文以外的表格，例如 Legend 里的说明表

  const raw = line.trim();
  const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
  if (isSeparatorRow(cells)) continue;
  if (isHeaderRow(cells)) continue;

  if (cells.length !== 6) {
    anomalies.push({
      type: 'column-count',
      line: lineNo,
      section: currentSection,
      columns: cells.length,
      raw,
    });
    continue;
  }

  const [idxCell, glyphCell, ossCell, nameCell, platformCell, descCell] = cells;

  const index = Number.parseInt(idxCell.replace(/\D+/g, ''), 10);
  if (!Number.isFinite(index)) {
    anomalies.push({ type: 'bad-index', line: lineNo, section: currentSection, raw });
    continue;
  }

  const glyph = stripNoise(glyphCell).trim();
  const category = CATEGORY_BY_GLYPH.get(glyph) ?? 'unknown';
  if (category === 'unknown') {
    anomalies.push({ type: 'unknown-category-glyph', line: lineNo, section: currentSection, glyph, raw });
  }

  const oss = extractLinks(ossCell);
  const ossText = stripNoise(ossCell);
  const openSource = oss.links.length > 0 || ossText.includes(OPEN_SOURCE_MARK);

  const nameParsed = extractLinks(nameCell);
  let name = nameParsed.links.length > 0 ? nameParsed.links[0].name : stripMd(nameCell);
  let url = nameParsed.links.length > 0 ? nameParsed.links[0].url : null;
  if (!url) {
    anomalies.push({ type: 'missing-primary-url', line: lineNo, section: currentSection, name, raw });
  }
  if (!name) {
    anomalies.push({ type: 'missing-name', line: lineNo, section: currentSection, raw });
    name = stripMd(nameCell) || `(unnamed #${index})`;
  }

  const plat = extractLinks(platformCell);
  const platforms = [...plat.links, ...splitPlainTokens(plat.rest)];
  if (platforms.length === 0) {
    anomalies.push({ type: 'missing-platform', line: lineNo, section: currentSection, name, raw });
  }

  const description = stripMd(descCell);

  entries.push({
    id: `${slugify(currentSection)}-${index}`,
    index,
    section: currentSection,
    sectionOrder,
    category,
    categoryGlyph: glyph,
    categoryZh: CATEGORY_LABEL_ZH[category],
    openSource,
    sourceUrl: oss.links[0]?.url ?? null,
    name,
    url,
    platforms,
    platformNames: platforms.map((p) => p.name),
    description,
    line: lineNo,
    raw,
  });
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

const byId = new Map();
for (const e of entries) {
  if (byId.has(e.id)) {
    anomalies.push({ type: 'duplicate-id', id: e.id, line: e.line, section: e.section });
  }
  byId.set(e.id, e);
}

for (const [section, group] of groupBy(entries, (e) => e.section)) {
  const seen = new Map();
  for (const e of group) {
    if (seen.has(e.index)) {
      anomalies.push({ type: 'duplicate-index', section, index: e.index, lines: [seen.get(e.index), e.line] });
    }
    seen.set(e.index, e.line);
  }
  const expected = group.length;
  if (group[0].index !== 1 || group[group.length - 1].index !== expected) {
    anomalies.push({
      type: 'index-not-contiguous',
      section,
      count: expected,
      firstIndex: group[0].index,
      lastIndex: group[group.length - 1].index,
    });
  }
}

const duplicateUrls = new Map();
for (const e of entries) {
  if (!e.url) continue;
  const key = e.url.replace(/\/+$/, '');
  duplicateUrls.set(key, [...(duplicateUrls.get(key) ?? []), e.id]);
}
for (const [url, ids] of duplicateUrls) {
  if (ids.length > 1) anomalies.push({ type: 'duplicate-url', url, ids });
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

const sectionStats = [...groupBy(entries, (e) => e.section)].map(([section, group]) => ({
  section,
  count: group.length,
  openSource: group.filter((e) => e.openSource).length,
}));

const categoryStats = [...groupBy(entries, (e) => e.category)]
  .map(([category, group]) => ({
    category,
    categoryZh: CATEGORY_LABEL_ZH[category],
    glyph: group[0].categoryGlyph,
    count: group.length,
  }))
  .sort((a, b) => b.count - a.count);

const summary = {
  sourceFile: INPUT,
  generatedAt: new Date().toISOString(),
  totalEntries: entries.length,
  sections: sectionStats,
  categories: categoryStats,
  openSource: entries.filter((e) => e.openSource).length,
  closedSource: entries.filter((e) => !e.openSource).length,
  uniqueDomains: new Set(entries.filter((e) => e.url).map((e) => safeHost(e.url))).size,
  anomalyCount: anomalies.length,
};

function safeHost(u) {
  try { return new URL(u).host; } catch { return ''; }
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

mkdirSync(OUTDIR, { recursive: true });

// 覆盖前先把上一版留成快照，`smhl diff` 靠它对比上游改了什么
const entriesPath = resolve(OUTDIR, 'entries.json');
const prevPath = resolve(OUTDIR, 'entries.prev.json');
let prevTakenAt = null;
if (existsSync(entriesPath)) {
  try {
    prevTakenAt = JSON.parse(readFileSync(entriesPath, 'utf8')).meta?.generatedAt ?? null;
  } catch {
    prevTakenAt = null; // 旧文件损坏也不该挡住重新解析
  }
  copyFileSync(entriesPath, prevPath);
}

const payload = {
  meta: {
    title: 'social-media-hacker-list',
    upstream: 'https://github.com/MobileFirstLLC/social-media-hacker-list',
    sourceFile: INPUT,
    sourceFileName: basename(INPUT),
    generatedAt: summary.generatedAt,
    totalEntries: entries.length,
    prevSnapshotAt: prevTakenAt,
  },
  entries,
};

writeFileSync(entriesPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

const CSV_COLUMNS = [
  'id', 'section', 'index', 'category', 'categoryZh', 'openSource',
  'sourceUrl', 'name', 'url', 'platformNames', 'description',
];
const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = [
  CSV_COLUMNS.join(','),
  ...entries.map((e) => CSV_COLUMNS.map((c) => {
    const v = e[c];
    return csvEscape(Array.isArray(v) ? v.join('; ') : v);
  }).join(',')),
].join('\r\n') + '\r\n';
writeFileSync(resolve(OUTDIR, 'entries.csv'), '\ufeff' + csv, 'utf8');

writeFileSync(resolve(OUTDIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
writeFileSync(resolve(OUTDIR, 'anomalies.json'), JSON.stringify({ count: anomalies.length, anomalies }, null, 2) + '\n', 'utf8');

const md = [];
md.push('# social-media-hacker-list · 结构化汇总', '');
md.push(`- 源文件: \`${INPUT}\``);
md.push(`- 生成时间: ${summary.generatedAt}`);
md.push(`- 条目总数: **${summary.totalEntries}**`);
md.push(`- 开源: ${summary.openSource} / 闭源: ${summary.closedSource}`);
md.push(`- 不重复域名: ${summary.uniqueDomains}`);
md.push(`- 解析异常: ${summary.anomalyCount}`, '');
md.push('## 按平台', '', '| 平台 | 条目数 | 其中开源 |', '| --- | ---: | ---: |');
for (const s of sectionStats) md.push(`| ${s.section} | ${s.count} | ${s.openSource} |`);
md.push('', '## 按类别', '', '| 类别 | 中文 | 条目数 |', '| --- | --- | ---: |');
for (const c of categoryStats) md.push(`| ${c.category} | ${c.categoryZh} | ${c.count} |`);
if (anomalies.length) {
  md.push('', '## 解析异常', '');
  for (const a of anomalies.slice(0, 50)) md.push(`- \`${a.type}\` @ line ${a.line ?? '-'}: ${a.raw ?? a.url ?? a.id ?? ''}`);
}
md.push('');
writeFileSync(resolve(OUTDIR, 'summary.md'), md.join('\n'), 'utf8');

/* ------------------------------------------------------------------ */
/* 终端输出                                                            */
/* ------------------------------------------------------------------ */

if (!argv.quiet) {
  console.log(`输入: ${INPUT}`);
  console.log(`输出: ${OUTDIR}/{entries.json, entries.csv, summary.json, summary.md, anomalies.json}`);
  console.log('');
  console.log(`条目总数: ${summary.totalEntries}  (开源 ${summary.openSource} / 闭源 ${summary.closedSource})`);
  console.log('');
  console.log('按平台:');
  for (const s of sectionStats) {
    console.log(`  ${s.section.padEnd(16)} ${String(s.count).padStart(3)}  (开源 ${s.openSource})`);
  }
  console.log('');
  console.log('按类别:');
  for (const c of categoryStats) {
    console.log(`  ${c.category.padEnd(20)} ${String(c.count).padStart(3)}  ${c.categoryZh}`);
  }
  console.log('');
  if (anomalies.length) {
    console.log(`解析异常 ${anomalies.length} 条（详见 data/anomalies.json）:`);
    for (const a of anomalies.slice(0, 20)) {
      console.log(`  - ${a.type} @ line ${a.line ?? '-'}${a.section ? ` [${a.section}]` : ''}`);
    }
    if (anomalies.length > 20) console.log(`  ... 其余 ${anomalies.length - 20} 条见 anomalies.json`);
  } else {
    console.log('解析异常: 0');
  }
}

process.exit(0);
