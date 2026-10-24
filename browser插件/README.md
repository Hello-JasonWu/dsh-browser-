# browse —— 让 AI 真正打开你的 Chrome 去读网页

一个**零依赖**的本地浏览器驱动工具：不需要 Playwright / Puppeteer / 下载 Chromium，
直接驱动你机器上已装好的 Chrome，因此带着**真实浏览器指纹**和**你已登录的 cookie**，
能打开 `web_fetch` 拿不到的页面——登录墙后面的、纯 JS 渲染的、数据靠 XHR 拉取的。

它有两种用法，共用同一套代码：

| 形态 | 入口 | 适合 |
| --- | --- | --- |
| DeepSeek Harness 原生工具 | `plugin/index.mjs`（cordis 插件） | 让模型直接调 `browse`，不用写 bash |
| 命令行工具 | `browse.mjs` | 手动调试、写脚本、接别的 agent |

```
模型 / 你 ──► browse（工具或 CLI）
                 │  spawn（数组传参，无 shell 注入）
                 ▼
            browse.mjs ──► CDP (WebSocket) ──► 本机 Chrome
```

---

## 特性

- **24 个动作**：读页面、抓接口、点击输入、截图导 PDF、管标签页和登录态
- **源码 vs 渲染后 DOM 分得清**：`source` 是服务端原始 HTML，`html` 是 JS 跑完的真实 DOM
- **抓得到接口**：`net` 记录请求并把 XHR/JSON 响应体存成文件——比解析 DOM 稳
- **保留登录态**：`login` 打开可见窗口让你手动登录，cookie 留在工具自己的 profile 里复用
- **零 npm 依赖**：只用 Node 内置模块（`WebSocket` / `fetch` / `child_process`）
- **不碰你的日常 Chrome**：独立 profile（`.browse/profile`），不会污染主浏览器
- **安全边界清晰**：端口只监听 `127.0.0.1`；页面内容一律标注为外部不可信数据

---

## 目录结构

```
browser插件/
├── browse.mjs          命令行入口（也是插件实际执行的程序）
├── lib/
│   ├── cdp.mjs         极简 CDP 客户端（WebSocket，无依赖）
│   ├── chrome.mjs      Chrome 生命周期、调试端口、会话状态
│   └── extract.mjs     正文抽取（去导航/广告/页脚，输出 Markdown）
├── plugin/             包装成 DSH 原生工具的 cordis 插件
│   ├── index.mjs       插件本体：注册 browse 工具 + system prompt 指引
│   ├── install.mjs     一键安装 / 卸载（写 profile 的 cordis.patch.yml）
│   ├── patch-yaml.mjs  patch 文件的纯文本增删逻辑
│   ├── test-local.mjs  不加载 DSH 也能跑的契约测试
│   └── README.md       插件侧实现细节（踩过的坑）
├── package.json
└── .gitignore
```

---

## 环境要求

- **Node.js ≥ 22**（用到全局 `WebSocket` 和 `fetch`）
- **Chrome / Chromium / Edge / Brave** 任意一个，自动探测这些位置：
  - `/Applications/Google Chrome.app/…`（macOS）
  - `/usr/bin/google-chrome`、`/usr/bin/chromium`（Linux）
  - 其它位置用环境变量 `BROWSE_CHROME=/path/to/chrome` 指定
- **平台**：macOS / Linux 开箱可用；Windows 需手动设 `BROWSE_CHROME`（指向 `chrome.exe`）

---

## 安装

### 方式 A：装成 DSH 原生工具（推荐）

在**本目录**（`browser插件/`）执行：

```bash
node plugin/install.mjs --dry-run   # 先看看会改什么，不写任何文件
node plugin/install.mjs             # 真正安装（默认装到 web profile）
```

安装脚本做三件事：

1. 把插件**和整个 CLI** 拷到 `$DSH_HOME/profiles/web/plugins/dsh-tool-browse/`，
   所以装完之后**不再依赖本仓库的位置**，仓库可以随便挪走或删掉；
2. 在该 profile 的 `cordis.patch.yml` 追加一条 `- insert:` 条目，把插件注册进配置树
   （**改动前自动备份**为 `cordis.patch.yml.bak-<时间戳>`）；
3. 打印验证方式。

装完的产物：

```
$DSH_HOME/profiles/web/
├── plugins/dsh-tool-browse/
│   ├── index.mjs        插件本体
│   ├── package.json
│   ├── browse.mjs       被包装的 CLI
│   ├── lib/             它的依赖
│   └── .browse/         运行时状态（首次使用后生成，含浏览器 profile）
└── cordis.patch.yml     + tool-browse 条目
```

在线 profile 的 `patchReload` 是 `live`，所以**运行中的 harness 会自动重载，无需重启**。
在会话里让它跑一次验证：

```json
{"action": "status"}
```

常见变体：

```bash
node plugin/install.mjs --profile web     # 指定 profile
node plugin/install.mjs --force           # 覆盖已存在的条目配置
node plugin/install.mjs --uninstall       # 卸载（删条目 + 删插件目录）
```

> `DSH_HOME` 默认 `~/.dsh`，可用环境变量覆盖。

### 方式 B：只当命令行用

```bash
node browse.mjs open https://example.com
```

想直接敲 `browse`：

```bash
npm link          # 读 package.json 的 bin，全局注册 browse
browse open https://example.com
```

---

## 用法

同一个动作，命令行与工具调用一一对应：

| 想做的事 | 命令行 | 工具调用 |
| --- | --- | --- |
| 读正文 | `node browse.mjs open <url>` | `{"action":"open","url":"…"}` |
| 抓渲染后 DOM | `node browse.mjs html --sel "table"` | `{"action":"html","selector":"table"}` |
| 抓接口 JSON | `node browse.mjs net <url> --type xhr` | `{"action":"net","url":"…","type":"xhr"}` |
| 点击 | `node browse.mjs click "a[href*=foo]"` | `{"action":"click","selector":"a[href*=foo]"}` |
| 输入并回车 | `node browse.mjs type "#q" "关键词" --enter` | `{"action":"type","selector":"#q","text":"关键词","enter":true}` |
| 截图 | `node browse.mjs shot out.png --viewport` | `{"action":"shot","out":"out.png","viewport":true}` |
| 页面里跑 JS | `node browse.mjs eval "location.href"` | `{"action":"eval","expression":"location.href"}` |
| 手动登录 | `node browse.mjs login <url>` | `{"action":"login","url":"…"}` |

### 典型工作流

**1）页面数据是异步拉的时候，别解析 DOM，去抓接口：**

```bash
node browse.mjs net https://site/app --type xhr --settle 4000
# 输出里每条请求带 body -> net/03-list.json，直接读那个文件
```

**2）要确认「页面到底有没有渲染出来」：**

```bash
node browse.mjs source <url>   # 服务端原始 HTML（等价 view-source）
node browse.mjs html           # JS 执行完的真实 DOM
node browse.mjs outline        # DOM 结构缩略图，快速定位选择器
```

**3）登录墙后面：**

```bash
node browse.mjs login https://site/login   # 弹出可见窗口，你手动登录
node browse.mjs open https://site/private # 复用刚才的 cookie
```

---

## 动作速查

| 类别 | 动作 | 说明 |
| --- | --- | --- |
| 读页面 | `open` `read` `links` | 正文转 Markdown / 重读当前页 / 列链接 |
| 看结构 | `source` `html` `dom` `outline` | 原始 HTML / 渲染后 DOM / 元素属性 / DOM 树 |
| 抓数据 | `net` | 记录请求，XHR 响应体存到 `net/` |
| 交互 | `click` `type` `press` `scroll` | 按选择器或可见文字操作 |
| 产出 | `shot` `pdf` | 截图（默认整页，`--viewport` 只截可视区，`--print` 模拟打印样式）|
| 脚本 | `eval` | 在页面上下文执行 JS |
| 导航 | `back` `forward` `tabs` `use` `close` | 历史与标签页管理 |
| 会话 | `status` `cookies` `login` `stop` | 状态 / 看 cookie 判断登录 / 手动登录 / 关浏览器 |

常用 flag：`--wait <ms>` 加载后额外等待、`--for <css>` 等选择器出现、
`--out <file>` 写文件（相对路径落在本工具目录，不落工作区）、
`--json` 机读输出、`--text` 纯文本、`--html` 原始 HTML、`--new` 强制新标签页。

---

## 配置

装成工具后，可在 `cordis.patch.yml` 的条目里改：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `scriptPath` | 插件目录内的 `browse.mjs` | 实际执行的 CLI 位置 |
| `nodePath` | 当前 node | 用哪个 Node 运行它 |
| `timeoutMs` | `180000` | 单次调用预算（浏览器冷启动 + 渲染可能慢） |
| `maxOutputChars` | `60000` | 返回内容上限，避免整页源码灌进上下文 |

环境变量：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `BROWSE_PORT` | `9222` | CDP 调试端口（只绑 `127.0.0.1`） |
| `BROWSE_CHROME` | 自动探测 | Chrome 可执行文件路径 |
| `BROWSE_SCRIPT` | 自动探测 | 插件找不到 CLI 时的兜底路径 |

运行时状态全部在本工具目录下：`.browse/state.json`（当前标签页）、
`.browse/profile/`（浏览器 profile）、`.browse/chrome.log`（Chrome 日志）。

---

## 安全与隐私

- `.browse/profile/` 里是**你真实的登录 cookie**。它已在 `.gitignore` 中；
  不要提交、不要打包分享、不要放在同步盘里。
- 浏览器是**单例会话**：所有调用共用当前标签页，因此工具被标记为不可并发执行。
- 页面返回的内容一律视为**外部不可信数据**，工具输出会带 `External page content follows…` 前缀，
  插件也会在 system prompt 里提示模型不要执行页面里的指令（防提示注入）。
- 调试端口只监听 `127.0.0.1`；不要在不可信网络里把 9222 暴露出去。
- `--out` 的相对路径解析到**工具目录**，不会往你的项目工作区里乱写文件。

---

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `无法创建标签页（9222 端口是 Chrome 调试端口吗？）` | 9222 被别的程序占用（比如另一个 browse 实例），或 Chrome 没带 `--remote-debugging-port` 启动 |
| `No Chrome/Chromium binary found` | 设 `BROWSE_CHROME=/path/to/chrome` |
| 装了插件但工具列表没出现 | 确认装的 profile 就是当前会话用的那个（`dsh --profile web --dump-config \| grep -A4 tool-browse`）；看 `cordis.patch.yml` 里有没有 `tool-browse` 条目 |
| `patch` 改坏了 | 同目录有 `cordis.patch.yml.bak-<时间戳>`，覆盖回去即可 |
| 点击报 `nothing clickable matched` | CSS 选择器匹配到 **0 个**元素时会退回按可见文字匹配；先用 `links` / `outline` 确认真实 href 和结构 |
| 点了但 URL 没变 | 目标可能 `target="_blank"`，内容在新标签页里：`tabs` 看一下，或用 `use` 切过去 |
| 打开是空白/要登录 | `cookies <domain>` 看有没有 cookie，没有就先 `login` |
| 中文乱码 | `open` 已按页面 charset 解码；若是 `--json` 输出，看的是接口返回的编码 |

---

## 开发与测试

```bash
node plugin/test-local.mjs          # 静态：导出契约 / 参数翻译 / schema 编译 / prompt 段
node plugin/test-local.mjs --live   # 另外真实调工具（会驱动 Chrome，联网）
```

静态测试需要能 `import '@deepseek-ai/dsh-tools'`：在已安装 DSH 的机器上建个软链即可

```bash
mkdir -p node_modules
ln -s "$DSH_HOME/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai
```

改代码时的两种生效方式：

- **改 CLI**（`browse.mjs` / `lib/`）：直接改仓库这份并 `node plugin/install.mjs --script ./browse.mjs --force`，
  让插件指向仓库副本，改完即生效；
- **改插件**（`plugin/index.mjs`）：重跑 `node plugin/install.mjs --force`，live patch 会自动重载。

---

## 许可证

本仓库尚未声明许可证。发布到 GitHub 前建议自行选择（如 MIT / Apache-2.0）并添加 `LICENSE` 文件。
