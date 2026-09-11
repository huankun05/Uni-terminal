# 统一 AI Coding Agent 终端控制台 — 可行性调研报告

> 调研时间：2026-09-11
> 调研方式：GitHub API 实测仓库元数据（星数 / License / 活跃度）+ 官方文档核对
> 说明：报告中标注「✅ 实测」的数据来自 GitHub API 直接查询；标注「📄 文档」的来自官方或第三方文档，未经代码级验证。

---

## 一、结论先行

**你要做的东西，地基已经现成，但「统一」和「扫码远程」这两块恰恰是整个生态的空白区 —— 这正是机会所在。**

三句话总结：

1. **`ACP 协议`已经把「统一控制」这件事标准化了。** Claude Code、Codex、Gemini CLI、Cursor、OpenCode、小米 MiMo Code 等十几家工具都实现了或正在实现 ACP。只要写一个 ACP 客户端，理论上就能统一驱动它们 —— 不需要为每家写适配器。
2. **但 ACP 是为「编辑器 ↔ Agent」设计的，远程/多端场景官方自认「work in progress」。** 官方原文：*"Full support for remote agents is a work in progress."* 这就是 ZCode 能靠"扫码遥控"当卖点的原因 —— 不是技术难，是没人把它做成通用层。
3. **`herdr`（37.6K★，Apache-2.0）已经解决了最难的那块 —— 终端持久化 + Agent 状态感知 + Agent 可编程驱动终端。** 它缺的恰好是 Web 界面和扫码配对。**这是最值得复用的项目，没有之一。**

**推荐路线：以 herdr 为运行时底座，以 ACP/acpx 为统一接入层，自研「Web 控制台 + 扫码配对」这一层薄壳。** 不建议从零造 PTY 复用器和 Agent 状态机。

---

## 二、你的需求拆解

把原始诉求拆成 5 个可独立验证的能力，后面逐条对照市面方案：

| # | 能力 | 说明 | 实现难度 |
|---|------|------|---------|
| C1 | **统一接入** | 一个界面控制 Claude Code / Codex / ZCode / MiMo Code / Cursor… | 中（ACP 已标准化） |
| C2 | **多会话并存** | 同时跑多个 Agent，一眼看清谁卡住了 | 中（状态检测难） |
| C3 | **远程/扫码控制** | 手机扫码即接管，无需装 App、无需 SSH | 低-中（工程问题） |
| C4 | **创建/操作新终端** | 开新 shell、开新 pane、连新机器 | 中 |
| C5 | **任务编排** | 给目标让多个 Agent 分工执行 | 高（生态已有方案） |

---

## 三、现状盘点：各家产品的远程控制能力

### 3.1 ZCode（智谱 Z.ai）— 你提到的那个 📄 文档

| 维度 | 情况 |
|------|------|
| 形态 | **桌面 GUI 应用**（不是 CLI），zcode.z.ai |
| 远程方式 | ① 左下角手机图标 → 生成二维码 + 连接地址，手机扫码/浏览器打开<br>② Bot Channel：微信 / 飞书 / Lark / Telegram（Discord、Slack 计划中）<br>③ SSH / WSL / Docker 远程工作区 |
| 关键设计 | **手机只是控制面**：不同步代码、不新建运行环境。指令由桌面端工作区原本连着的机器执行（本地 / SSH 主机 / WSL / Docker 容器） |
| 限制 | 同一时间只允许**一个**手机页面连接；链接本身即授权（拿到即能操作）；关闭弹窗**不会**停止远控，必须手动点 Stop；手机只能触达桌面端已打开/已注册的工作区，**不能浏览任意目录、不能新建连接** |
| 其他 | 3.2.0 起支持自定义 subagents（Markdown 定义的角色 + 独立模型 + 读写权限） |

**评价**：体验做得很完整，但**它的控制面是私有闭环，只管自己**。这既是它的护城河，也是你可以打的软肋 —— 你有 5 个 Agent，就得开 5 个窗口扫码。

### 3.2 小米 MiMo Code ✅ 实测 13,060★ / MIT / TypeScript / 今日仍活跃

| 维度 | 情况 |
|------|------|
| 形态 | **终端 TUI**，fork 自 OpenCode（opencode 现已迁至 `anomalyco/opencode`，206.6K★） |
| 远程方式 | **Client/Server 分离**：远端 `mimo serve --port 4096`，本地 `mimo attach http://127.0.0.1:4096` |
| 亮点 | SQLite FTS5 跨会话记忆 + checkpoint 上下文重建；三 Agent（build/plan/compose）；`/dream` `/distill` 知识固化；**一键导入 Claude Code 的 MCP / skills / 认证配置** |
| 局限 | 需要自己搞定端口转发，**没有扫码、没有手机 UI** |

**评价**：它是"可远程"，不是"易远程"。`serve/attach` 架构对做统一控制台反而是**好消息** —— 意味着它的 Agent 能力可以被网络化调用。

### 3.3 其他主流 CLI 的远程能力

| 产品 | 星数 ✅ | 远程方案 | 备注 |
|------|--------|---------|------|
| **Claude Code** | 144,719 | 📄 官方有 remote-control 文档（据称限 Pro 以上） | 生态适配最全 |
| **OpenAI Codex** | 123,291 (Rust) | 无原生远程 UI | 通过 ACP 可被统一接入 |
| **Gemini CLI** | 106,911 | **原生支持 `gemini --acp`** | ACP 支持最好 |
| **opencode** | 206,630 (MIT) | `serve` 模式 | MiMo Code 的上游 |
| **Cursor CLI** | — | `cursor-agent acp` | 需 ACP 适配 |

**共同结论：几乎每一家都是"要么没有远程，要么各做各的私有实现"。**

---

## 四、可复用的开源项目清单（按架构分层）

### 第 1 层：统一协议层 —— 这是"统一"的技术地基

| 项目 | 星数 ✅ | License | 能复用哪一块 |
|------|--------|---------|-------------|
| **[agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)** | 4,209 | Apache-2.0 | **协议规范本身**（Rust 参考实现）。本地 Agent 走 JSON-RPC over stdio，远程走 HTTP/WebSocket（WIP），复用 MCP 的 JSON 表示 |
| **[openclaw/acpx](https://github.com/openclaw/acpx)** | 3,239 | **MIT** | **headless CLI 客户端**。`acpx codex / claude / pi / openclaw`，持久会话存在 `~/.acpx/`，`--format json` 输出 NDJSON 事件流，有权限模式。<br>🔑 **还导出 `acpx/runtime` 和 `acpx/flows` 供应用直接嵌入** —— 可以直接当你的 Agent 调用 SDK 用 |

> **这是本报告最关键的发现。** `acpx` 已经把"统一驱动多种 Agent + 机器可读事件流 + 可嵌入 SDK"三件事做完了，MIT 许可可商用。你的控制台不需要自己实现 Agent 适配层。

### 第 2 层：终端运行时层 —— 这是最难自己造的部分

| 项目 | 星数 ✅ | License | 能复用哪一块 |
|------|--------|---------|-------------|
| **[herdrdev/herdr](https://github.com/herdrdev/herdr)** | **37,627** | **Apache-2.0** | **强烈推荐复用。** Rust 单二进制，无 Electron。见下方详述 |

**herdr 的能力清单（官方 README 原文提炼）：**

- **后台 server 常驻**：关客户端 / SSH 断了，终端进程不死；必须 detach 而非 kill
- **多机一窗**：本地 + 保存的 SSH 机器统一在一个窗口，独立重连
- **Agent 状态感知**：每个 pane 标记 `working` / `blocked` / `idle`，**无需写 hook，零配置**（进程名匹配 + 终端输出启发式）
- **Agent-native（关键）**：Agent 可以通过 **CLI 和 socket API 驱动 herdr 本身** —— spawn 新 pane、互相 prompt、等待另一个 Agent 真正阻塞。**这就是你要的"让它操作或创建新的电脑终端"**
- **不包装、不替换 Agent**：它只"拥有它们的终端"，claude code / codex / cursor / opencode / grok 原样跑
- **键盘 + 鼠标双一等公民**、插件市场、Windows 支持（含 endpoint-protected Windows 场景）
- 架构纪律值得抄：**State 与 Runtime 完全分离**（AppState 无 PTY、无 async），13.5K 行集成测试跑在 mock PTY 字节流上

> ⚠️ **关于 herdr 你需要知道的两件事**：
> 1. 它本质是 **TUI**，不是 Web。手机侧靠 SSH attach（响应式 TUI），**没有二维码、没有浏览器 UI**。这正是你自研层的价值。
> 2. 它是单人主导的 side project（作者 Oğulcan Çelik，3 个月 974 commits，日更 ~10 commit），且 vendor 了 `libghostty-vt`（有 1,446 次 vendor 目录修改的维护负担）。**API 稳定性需要自己兜底**，建议 pin 版本。

### 第 3 层：Web 控制台层 —— 现成的"统一控制台"参考/竞品

| 项目 | 星数 ✅ | License | 能复用哪一块 |
|------|--------|---------|-------------|
| **[OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)** | **87,364** | **MIT** | **Agent Canvas**：自托管 Web UI，统一管理 Codex / Claude Code / Gemini CLI / **任意 stdio ACP server**（Custom 模式填启动命令即可）。含 Agent Server（REST + WebSocket）、Automation Server（GitHub/Slack 触发）、Sandbox 层。Canvas 与 Server **解耦**，可混部本地/Docker/云后端 |
| **[oxgeneral/ORCH](https://github.com/oxgeneral/ORCH)** | 161 | MIT | 多 Agent 团队编排 TUI：CTO/Backend/QA/Reviewer 角色分工，**每个 Agent 跑在独立 git worktree**，状态机强制人工 review 才能合并。有 `/orch` Claude Code skill |
| **[hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor)** | 989 | — | Agent 监控面板，可参考 UI 信息架构 |
| **[smallnest/imclaw](https://github.com/smallnest/imclaw)** | 50 | MIT | **思路最对但基本停更**（最后推送 2026-04-18）。ACP 网关：Go 单二进制 + WebSocket + Token 认证，把 acpx 能力网络化，让微信/飞书/QQ/Telegram 远程操控沙箱里的 Agent。**值得读设计，不建议依赖** |
| **[ax128/CodeCLI](https://github.com/ax128/CodeCLI)** | 0 | MIT | 多通道编排（本地 CLI / Telegram / 微信扫码 / HTTP / LangChain），包装 Claude Code + Cursor + Codex + OpenCode + Bash。**需求和你的重合度接近 100%，但 0 star、单人项目，只能当架构参考** |

### 第 4 层：Web 终端与远程接入基础设施（成熟件，直接拿来用）

| 项目 | 星数 ✅ | License | 用途 |
|------|--------|---------|------|
| **[Eugeny/tabby](https://github.com/Eugeny/tabby)** | 74,435 | MIT | 跨平台终端模拟器（含 SSH），可参考其连接管理/多标签架构 |
| **[xtermjs/xterm.js](https://github.com/xtermjs/xterm.js)** | 21,162 | MIT | **浏览器端终端渲染的事实标准**，Web 控制台必备 |
| **[Ylianst/MeshCentral](https://github.com/Ylianst/MeshCentral)** | 7,209 | Apache-2.0 | 远程设备管理平台（远程桌面/终端/文件），**"创建新机器终端"这条需求的成熟参照** |
| ttyd / gotty / wetty | — | MIT | 命令行工具一键暴露为 Web 终端，做 MVP 最快 |
| node-pty / portable-pty | — | MIT | PTY 分配，若不用 herdr 就得自己接这层 |

### 第 5 层：桌面 GUI 应用的桥接 —— 生态空白

ZCode 这类**桌面 GUI 产品没有 CLI / ACP 接口**，目前**没有任何开源项目能统一控制它们**。如果需要纳管，只有两条路：
- （a）**降级替代**：用同厂 CLI 版（如 z.ai 的 CLI）代替 GUI 版
- （b）**UI 自动化桥接**：操作系统级窗口/输入自动化（最脆弱，不推荐做主干）

> 建议：**一期先不碰 GUI 应用**，把 CLI/ACP 生态做透。GUI 桥接作为远期插件位。

---

## 五、推荐架构

```
┌──────────────────────────────────────────────────────────────┐
│  控制端 (你自研的差异化层)                                     │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Web 控制台      │  │ 扫码配对服务  │  │ IM Bot 网关       │  │
│  │ (xterm.js 多格) │  │ (短链+Token)  │  │ (微信/飞书/TG)    │  │
│  └────────────────┘  └──────────────┘  └──────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │ WebSocket (wss) + REST
┌───────────────────────────▼──────────────────────────────────┐
│  网关层 (自研, 薄)                                            │
│  · 会话路由 / 鉴权 / 多端同步  · ACP 事件流归一化              │
└──────┬───────────────────────────────┬───────────────────────┘
       │                               │
┌──────▼──────────────┐   ┌────────────▼──────────────────────┐
│ 统一接入层           │   │ 终端运行时层                       │
│ (复用 acpx, MIT)     │   │ (复用 herdr, Apache-2.0)          │
│ · ACP 客户端池       │   │ · PTY 复用 / detach-reattach      │
│ · 持久 session       │   │ · Agent 状态检测 (blocked/idle)   │
│ · NDJSON 事件流      │   │ · socket API: spawn pane          │
│ · 权限策略           │   │ · 多机统一 (本地 + SSH)           │
└──────┬──────────────┘   └────────────┬──────────────────────┘
       │                               │
┌──────▼───────────────────────────────▼───────────────────────┐
│  被纳管的 Agent                                              │
│  Claude Code · Codex · Gemini CLI · Cursor · opencode        │
│  · MiMo Code · ZCode CLI · 任意 stdio ACP server             │
│  （PTY 兜底：任何没有 ACP 的 TUI 工具也能纳管）                │
└──────────────────────────────────────────────────────────────┘
```

**三条设计原则：**

1. **协议优先，PTY 兜底。** 有 ACP 的走 ACP（拿到结构化事件：工具调用、diff、思考过程），没有的走 herdr 的 PTY 通道（拿到原始终端画面）。**两条腿都要有** —— 只走 ACP 会漏掉 ZCode 这类没有 ACP 的；只走 PTY 会丢掉结构化能力。
2. **薄网关，不重写运行时。** 你的代码只负责"路由 + 鉴权 + UI"，PTY 复用和状态机交给 herdr，Agent 适配交给 acpx。**自研部分的体量应该控制在 20% 以内。**
3. **扫码即授权，但要能吊销。** 学 ZCode 的短链 + Token 模式，但要加上 ZCode 明确没有的东西：**有效期 + 一次性 + 可主动吊销 + 权限范围限定**（ZCode 的链接一旦泄露就是完整授权，这是它的设计债，也是你的加分项）。

---

## 六、三条可选路线

| | **路线 A：薄壳复用（推荐）** | **路线 B：基于 OpenHands** | **路线 C：全自研** |
|---|---|---|---|
| **做法** | herdr（运行时）+ acpx（接入）+ 自研 Web/扫码层 | 直接用 OpenHands Agent Canvas，补扫码/移动端 | 从 PTY 开始自己写 |
| **自研量** | ~20% | ~10% | 100% |
| **周期** | 短 | 最短 | 长 |
| **控制力** | 高 | 中（受上游架构约束，Rust 代码库定制成本高） | 最高 |
| **风险** | herdr 是 side project，API 可能变 | 定位是"自己的 Agent runtime"，你要的"纳管已有 Agent"是它的边缘用法 | 容易在 PTY/状态检测上耗死 |
| **适合** | 想做成自己的产品 | 想快速验证 | 想深挖技术 |

**我建议路线 A**，理由：herdr 恰好补上了最难自研的两块（PTY 持久化 + Agent 状态启发式检测），而 acpx 补上了 Agent 适配，两者都是宽松许可（Apache-2.0 / MIT）。你自研的部分正好是**这个生态没人做好的部分** —— 跨产品的统一控制面 + 真正安全的扫码远程。

**如果只是想先跑通验证**，可以先做路线 C 的极简版：`ttyd + 二维码短链 + 多 tab`，一个周末就能验证"扫码遥控终端"的核心体验，再决定要不要上 herdr。

---

## 七、差异化机会点（你的产品凭什么存在）

现有方案的三个共同缺口，就是你的三个卖点：

1. **跨产品统一** — ZCode 只管 ZCode，herdr 只认它认识的 CLI，OpenHands 偏自己的 runtime。**"一个二维码管住我所有的 AI 编程工具"目前没有解。**
2. **可吊销的扫码授权** — ZCode 明确写了"链接本身带远控授权，拿到就能操作你的窗口"、"关闭弹窗不会停止远控"。这是明显的安全设计债。**做短时效 Token + 权限域限定 + 一键全端下线。**
3. **GUI 应用纳管** — 所有开源方案都只碰 CLI/TUI。**谁能把 ZCode 这类桌面 GUI 也纳入同一控制面，谁就有别人抄不走的位置。**（技术上最难，但价值最高）

进阶机会：**让 Agent 互相编排** —— herdr 的 socket API 已经支持"Agent 等待另一个 Agent 真正阻塞"，ORCH 展示了角色分工模式。把这两者接起来，"你睡觉时 5 个 Agent 协作交付"这件事的组件其实齐了。

---

## 八、建议的下一步

**立刻可做的验证（按成本排序）：**

1. **装 herdr 跑一遍**：`curl -fsSL https://herdr.dev/install.sh | sh`（Windows: `irm https://herdr.dev/install.ps1 | iex`），在 Windows 上开两个 pane 跑 Claude Code + 任意另一个 Agent，实测状态检测准不准、socket API 能不能 spawn pane。**这一步决定路线 A 是否成立。**
2. **装 acpx 打通两个 Agent**：`npm install -g acpx@latest`，跑 `acpx claude "..."` 和 `acpx codex "..."`，看 `--format json` 的事件流够不够做 UI。
3. **验证扫码链路**：`ttyd -p 8080 bash` + 一个生成带 Token 短链的小服务，手机扫码打开，确认 WebSocket 路径通。

**需要你决策的点：**

- 目标用户是**你自己用**还是**做成产品**？（决定要不要在意多租户、权限隔离）
- 一期纳管范围：**只做 CLI/ACP** 还是**必须包含 ZCode 这类 GUI**？（GUI 会显著拉长周期）
- 技术栈偏好：网关层用 **TypeScript**（贴合 acpx/xterm.js 生态）还是 **Rust**（贴合 herdr）？

---

## 附录：数据来源

- GitHub API 实测（2026-09-11）：`OpenHands/OpenHands`、`herdrdev/herdr`、`openclaw/acpx`、`agentclientprotocol/agent-client-protocol`、`XiaomiMiMo/MiMo-Code`、`anomalyco/opencode`、`openclaw/openclaw`、`oxgeneral/ORCH`、`smallnest/imclaw`、`ax128/CodeCLI`、`xtermjs/xterm.js`、`Eugeny/tabby`、`Ylianst/MeshCentral`、`anthropics/claude-code`、`openai/codex`、`google-gemini/gemini-cli`
- ACP 官方文档：https://agentclientprotocol.com/get-started/introduction
- ZCode 官方文档：https://zcode.z.ai/newdocs/remote-control
- herdr 官方站点：https://herdr.dev/docs/
- MiMo Code 官方：https://mimo.xiaomi.com/mimocode

> **重要提醒**：herdr、ORCH 等项目的第三方介绍文章在星数上互相矛盾（8.9K / 12.4K / 21.8K / 36K 都出现过）。本报告统一采用 **GitHub API 实测值**。涉及具体实现细节（如 Windows 支持完整度、socket API 稳定性）建议在选型前实际跑一遍验证。
