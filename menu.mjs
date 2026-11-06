#!/usr/bin/env node
/**
 * menu.mjs — 双击 `工具箱.bat` 后进入的交互菜单。
 * 只做编排：真正的活儿都交给 smhl.mjs 子命令（stdio 继承，便于实时看输出）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRIES = join(HERE, 'data', 'entries.json');
const UPSTREAM = join(HERE, 'data', 'upstream.json');

if (!existsSync(ENTRIES)) {
  console.log('还没有解析数据，先跑一次解析…');
  run(['parse.mjs']);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const c = (code, s) => `\u001b[${code}m${s}\u001b[0m`;

function run(args) {
  const r = spawnSync(process.execPath, args.map((a, i) => (i === 0 ? join(HERE, a) : a)), { stdio: 'inherit' });
  return r.status ?? 1;
}

function headline() {
  let total = '?', when = '', commit = '';
  try {
    const d = JSON.parse(readFileSync(ENTRIES, 'utf8'));
    total = d.entries.length;
    when = d.meta?.generatedAt ? new Date(d.meta.generatedAt).toLocaleString() : '';
  } catch {}
  try {
    const u = JSON.parse(readFileSync(UPSTREAM, 'utf8'));
    commit = (u.commit ?? '').slice(0, 7);
  } catch {}
  console.log('');
  console.log(c(1, '  社媒工具清单 · 工具箱'));
  console.log(`  条目 ${total}${commit ? `　上游 ${commit}` : ''}${when ? `　解析于 ${when}` : ''}`);
  console.log('');
}

const MENU = [
  ['1', '打开可视化面板（筛选 / 搜索 / 收藏 / 复制）', async () => {
    run(['smhl.mjs', 'export', 'html']);
    run(['smhl.mjs', 'open', 'dashboard']);
  }],
  ['2', '统计概览（平台 / 类别 / 运行环境分布）', async () => run(['smhl.mjs', 'stats'])],
  ['3', '搜索工具（关键词）', async () => {
    const kw = (await rl.question('  关键词（空格分隔，多个词是 AND）: ')).trim();
    if (kw) run(['smhl.mjs', 'search', ...kw.split(/\s+/)]);
  }],
  ['4', '浏览某个平台', async () => {
    const p = (await rl.question('  平台（如 YouTube / X / Reddit / TikTok）: ')).trim();
    if (p) run(['smhl.mjs', 'list', '-p', p, '-n', '40']);
  }],
  ['5', '随机推荐几个（选择困难时用）', async () => run(['smhl.mjs', 'rand', '-k', '3'])],
  ['6', '同步上游最新快照并重新解析', async () => run(['smhl.mjs', 'update', '--commit'])],
  ['7', '看看上游改了什么（对比上一版快照）', async () => run(['smhl.mjs', 'diff'])],
  ['8', '链接体检（检查失效 / 归档 / 停更）', async () => {
    console.log('  1) 全部链接（较慢）　2) 只查 GitHub 仓库（快）');
    const choice = (await rl.question('  选择 [1/2，默认 2]: ')).trim();
    run(choice === '1' ? ['smhl.mjs', 'check'] : ['smhl.mjs', 'check', '--only', 'github']);
  }],
  ['9', '导出 Markdown / CSV', async () => {
    console.log('  1) Markdown  2) CSV');
    const choice = (await rl.question('  选择 [1/2，默认 1]: ')).trim();
    const fmt = choice === '2' ? 'csv' : 'md';
    const name = fmt === 'csv' ? '工具清单.csv' : '工具清单.md';
    run(['smhl.mjs', 'export', fmt, '-o', join(HERE, name)]);
    console.log(`  已导出：${join(HERE, name)}`);
  }],
  ['?', '查看完整命令行帮助', async () => run(['smhl.mjs', 'help'])],
];

async function main() {
  for (;;) {
    headline();
    for (const [k, label] of MENU) console.log(`  ${c(36, k.padStart(2))}) ${label}`);
    console.log(`   ${c(36, '0')}) 退出`);
    console.log('');

    const answer = (await rl.question('  请选择: ')).trim();
    if (answer === '0' || answer.toLowerCase() === 'q') break;

    const item = MENU.find(([k]) => k === answer);
    if (!item) { console.log(c(31, '  没有这个选项，重来。')); continue; }

    console.log('');
    try {
      await item[2]();
    } catch (err) {
      console.log(c(31, `  出错了: ${err?.message ?? err}`));
    }
    console.log('');
    await rl.question('  回车返回菜单…');
  }
}

try {
  await main();
} catch (err) {
  if (err?.name !== 'AbortError') console.error(err);
} finally {
  rl.close();
  console.log('  再见。');
}
