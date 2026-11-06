# smhl-kit · 社媒工具清单工具箱

把 [MobileFirstLLC/social-media-hacker-list](https://github.com/MobileFirstLLC/social-media-hacker-list)
的 `README.md` 变成**能用的东西**：结构化数据 + 命令行工具 + 离线可视化面板 + 链接体检 + 上游变更对比。

上游仓库本身只有一个数据文件（`README.md`，174 行 Markdown 表格），外加一个 Rust 链接检查器和两个
GitHub Actions workflow。本工具箱不改上游，只把它变成可查询、可筛、可导出、可体检的数据。

**零依赖**：只用 Node 标准库（Node 18+，本机 v24.19.0），不需要 `npm install`。

---

## 三种用法

### 1. 双击菜单（最省事）

双击 `工具箱.bat`，进入中文菜单：

```
 1) 打开可视化面板（筛选 / 搜索 / 收藏 / 复制）
 2) 统计概览（平台 / 类别 / 运行环境分布）
 3) 搜索工具（关键词）
 4) 浏览某个平台
 5) 随机推荐几个（选择困难时用）
 6) 同步上游最新快照并重新解析
 7) 看看上游改了什么（对比上一版快照）
 8) 链接体检（检查失效 / 归档 / 停更）
 9) 导出 Markdown / CSV
```

### 2. 命令行

```powershell
cd C:\Users\LZY20\Desktop\harness\smhl-kit
node smhl.mjs <命令> [选项]
```

### 3. 可视化面板

```powershell
node smhl.mjs export html     # 生成 dashboard.html（单文件，离线可用）
node smhl.mjs open dashboard  # 在浏览器打开
```

面板能力：实时搜索（名称/描述/平台/域名，多词 AND，命中高亮）、平台/类别/运行环境三级下拉、
只看开源、**收藏**（存 localStorage）、一键复制链接、把当前筛选结果复制成 Markdown、URL hash
同步（筛选后的链接可直接收藏/分享）。整个面板是单文件、无外链、无 CDN，断网也能用。

---

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `list` | 列出条目（表格 / `--json` / `--csv` / `--ids` / `--urls`） |
| `search <词...>` | 等价于 `list -q`，多个词是 AND |
| `show <id\|名称>` | 单条详情，含 README 行号与原始 Markdown 行 |
| `stats` | 平台/类别/运行环境分布（带条形图，`--json`） |
| `domains` | 域名聚合（`--top N`） |
| `rand -k N` | 随机抽几条 |
| `open <id\|名称\|dashboard>` | 浏览器打开某条或打开面板 |
| `export <json\|csv\|md\|html\|urls\|ids>` | 导出，`-o 文件` 落地 |
| `check` | 链接体检（失效/归档/停更） |
| `diff` | 对比上一版快照，看上游增删改 |
| `sync` / `update` | 同步上游快照 / 同步并重新解析 |
| `help` | 完整帮助 |

**通用筛选选项**（`list` / `search` / `stats` / `domains` / `rand` / `export` / `check` 都支持）：

| 选项 | 含义 |
| --- | --- |
| `-p, --platform <名>` | 平台章节，可重复，子串匹配（YouTube / X / Reddit / TikTok ...） |
| `-c, --category <名>` | 类别，可重复，中英文都认（`for-developers` / `面向开发者`） |
| `--on <名>` | 运行环境（Android / iOS / Extension / Web / Python ...） |
| `-q, --search <词>` | 关键词，可重复（名称/描述/平台/域名） |
| `--domain <域名>` | 按链接域名过滤（github.com ...） |
| `--oss` / `--closed` | 只看开源 / 只看闭源 |

### 常用例子

```powershell
# 安卓上的第三方客户端
node smhl.mjs list --on Android -c alternative-client

# GitHub 上的 Python 抓取库
node smhl.mjs search scraper --domain github.com --on Python

# 看看全貌
node smhl.mjs stats

# 挑一个今天要玩的
node smhl.mjs rand -c for-developers -k 3

# 导出成 Markdown 给朋友
node smhl.mjs export md -o 工具清单.md

# 导出某平台的 CSV
node smhl.mjs export csv -p Reddit -o reddit.csv

# 体检所有 GitHub 仓库（是否有归档 / 停更超一年）
node smhl.mjs check --only github

# 看上游这周加了什么
node smhl.mjs update --commit   # 同步 + 重新解析
node smhl.mjs diff
```

---

## 链接体检（`check`）

复刻了上游 Rust 检查器的判定逻辑，但更细：

- **GitHub 链接**走 `api.github.com`，检查仓库是否存在、是否 archived、`pushed_at` 是否超过 365 天没提交；
  同时列出 star 数。这样即使 `github.com` 网页端不可达也能判定。
- **其他链接**先 `HEAD` 再退回 `GET`；接受 `200 / 403 / 406`，并按上游的既有规则放行
  `reddit.com` 的 502 与 `apps.apple.com` 的 429。
- 并发可调（`--concurrency`，默认 8），单链接超时（`--timeout`，默认 15 秒），`--json` 便于接管道。
- **有失败项时退出码为 1**，可以直接用在 CI / 计划任务里。

```powershell
node smhl.mjs check                      # 全部 174 条主链接
node smhl.mjs check --only github        # 只查 GitHub 仓库（快，34 个）
node smhl.mjs check --all                # 连 ❋ 源码链接一起查
node smhl.mjs check -p YouTube --json
```

> GitHub API 未认证时限流 60 次/小时。超过 55 个 GitHub 链接时脚本会提示；
> 设环境变量 `GITHUB_TOKEN` 或 `--token` 可将上限提到 5000 次/小时。

---

## 同步上游（`sync.ps1` / `smhl.mjs sync`）

**本机 `github.com:443` 不可达**（`git clone` / `git fetch` 会超时），但 `codeload.github.com`、
`api.github.com`、`raw.githubusercontent.com` 都通。所以走官方 zip 端点：

```powershell
node smhl.mjs update --commit     # 等价于 sync.ps1 -Commit -Parse
```

脚本会：查询上游默认分支与最新 commit → 下载 zip → `robocopy /MIR /XD .git` 镜像覆盖本地快照
（保留本地 git 历史）→ 写入 `data/upstream.json` → `-Commit` 时固化成 `snapshot upstream <sha>` 提交
→ `-Parse` 时重新解析。这样即使不能 `git pull`，也能用
`git -C ..\social-media-hacker-list log -p` 看出上游每次改了什么。

> `sync.ps1` 刻意只写 ASCII：Windows PowerShell 5.1 按系统 ANSI 代码页（本机 cp936）解码 `.ps1`，
> 源码里的中文会被拆坏导致语法错误。中文说明一律放 `.md`。同理 `工具箱.bat` 里也没有中文，
> 它先 `chcp 65001` 再把交互菜单交给 `menu.mjs`。

---

## 自检（`verify.mjs`）

```powershell
node verify.mjs
```

四组检查：**数据完整性**（id 唯一、字段齐全、类别全部识别、无硬性解析异常）、
**与上游 README 一致**（表格行数 == 解析条目数）、**面板静态检查**（占位符已替换、内嵌 JSON 可解析、
`</script>` 已转义）、**浏览器真实渲染**（调本机 Edge/Chrome 无头模式 dump DOM，断言卡片数、
下拉填充、统计行）。

---

## 目录结构

```
harness/
├── social-media-hacker-list/      # 上游快照（含本地 .git 历史）
│   ├── README.md                  # 唯一的数据源
│   ├── checker/                   # 上游 Rust URL 检查器（未改动）
│   └── .github/workflows/         # check.yaml（链接周检）/ publish.yaml
└── smhl-kit/                      # 本工具箱
    ├── 工具箱.bat                  # 双击入口（ASCII，转交 menu.mjs）
    ├── menu.mjs                   # 交互菜单
    ├── smhl.mjs                   # 统一 CLI（list/show/stats/domains/rand/open/export/check/diff/sync）
    ├── parse.mjs                  # README.md -> 结构化数据
    ├── sync.ps1                   # 拉上游最新快照
    ├── verify.mjs                 # 自检
    ├── dashboard.template.html    # 面板模板（__SMHL_DATA__ 占位符）
    ├── dashboard.html             # 生成的面板（单文件离线）
    ├── package.json               # npm run <脚本>
    └── data/
        ├── entries.json           # 174 条完整记录（主产物）
        ├── entries.prev.json      # 上一版快照，diff 用
        ├── entries.csv            # Excel 友好（带 BOM）
        ├── summary.json / .md     # 统计汇总
        ├── anomalies.json         # 解析异常
        └── upstream.json          # 上游 repo / branch / commit / 抓取时间
```

> 早期版本的 `query.mjs` 已被 `smhl.mjs` 完全吸收（`node smhl.mjs list ...` 就是原来的用法），已移除。

---

## 数据字典（`entries.json` 的每条记录）

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定主键，`<平台 slug>-<表内序号>`，如 `youtube-24` |
| `index` | README 该平台表格里的序号 |
| `section` | 平台章节：Facebook / Instagram / LinkedIn / Mastodon / Multi-platform / Reddit / Snapchat / Threads / TikTok / X / YouTube |
| `category` / `categoryZh` / `categoryGlyph` | 类别键（由色块映射）/ 中文名 / 原始色块 |
| `openSource` | 是否带 ❋ 开源标记 |
| `sourceUrl` | ❋ 指向的源码地址（闭源为 `null`） |
| `name` / `url` | 条目名 / 主链接 |
| `platforms` / `platformNames` | 运行环境数组 `[{name,url}]` / 名字数组 |
| `description` | 描述 |
| `line` / `raw` | README 行号 / 原始 Markdown 行（便于回溯核对） |

类别映射（与 README 的 Legend 一节一致）：

| 色块 | `category` | 中文 | 色块 | `category` | 中文 |
| --- | --- | --- | --- | --- | --- |
| 🟪 | `alternative-client` | 替代客户端 | 🟫 | `for-developers` | 面向开发者 |
| 🟧 | `analytics-data` | 分析与数据 | 🟩 | `image` | 图片 |
| ⬛ | `bots` | 机器人 | 🟨 | `productivity-tools` | 效率与工具 |
| 🟦 | `content-creation` | 内容创作 | 🟥 | `video` | 视频 |

---

## 数据真相与已知瑕疵（都在上游数据本身）

- **条目总数 174**，与 README 表格行数交叉核对一致（`verify.mjs` 每次都验）。
  README 顶部的 badge 写的是 **entries-236**，与实际不符——那是手写静态值，已过期或口径不同。
- **`instagram-13`（Unfold）没有主链接**：链接在「平台」列（指向 App Store / Google Play），
  所以它的 `url` 和 `sourceUrl` 都是 `null`。面板对这类条目只显示名称，不显示「打开」。
- **运行环境标签不规范**：上游混用了 `Javascript`/`JavaScript`、`GH Action`/`GH Actions`、
  `bot`/`Bot`、`Web`/`Web/Bot`。本工具箱**不做静默合并**（那会篡改原始数据），
  所以 `stats` 里它们分开计数。
- 解析器不假设列数恰好为 6：列数异常、序号非数字、类别色块未知、主链接缺失、ID/序号重复、
  链接完全重复等都会写进 `data/anomalies.json`，不会静默丢数据。当前只有 1 条软性提示（上面的 Unfold）。
- 实测 `check` 发现 `threadsdownloader.com` 连接超时（本机网络下不可达），上游周检若在别的网络
  可能判定为正常——这类差异取决于出口网络，不代表上游清单失职。

## 统计快照（上游 commit `d02eb8b`）

| 平台 | 条目 | 开源 | | 类别 | 条目 |
| --- | ---: | ---: | --- | --- | ---: |
| Facebook | 8 | 2 | | productivity-tools | 41 |
| Instagram | 14 | 3 | | for-developers | 35 |
| LinkedIn | 13 | 4 | | video | 32 |
| Mastodon | 10 | 4 | | alternative-client | 19 |
| Multi-platform | 35 | 6 | | analytics-data | 16 |
| Reddit | 13 | 4 | | image | 14 |
| Snapchat | 2 | 1 | | content-creation | 12 |
| Threads | 3 | 0 | | bots | 5 |
| TikTok | 17 | 7 | | **合计** | **174** |
| X | 35 | 4 | | | |
| YouTube | 24 | 17 | | | |
| **合计** | **174** | **52** | | | |

GitHub 仓库体检（34 个）：全部通过，无归档、无停更超一年。
