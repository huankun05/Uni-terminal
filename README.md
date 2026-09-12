# Uni-terminal

**扫码即用的自托管 AI 编程代理控制台。**

用手机浏览器打开一个网址，就能驱动你电脑上的 AI 编程 Agent —— 不装 App、不经第三方中继、Windows 优先。

> 状态：v0.0.1 · **手机可完整使用**：扫码配对 → 新建任务驱动 Agent → 看实时输出 → 快捷应答推进，全链路可跑（91 项端到端断言）。ACP 结构化事件面板、xterm 完整终端、PWA 化在后续里程碑。

---

## 文档

全部文档位于 [`docs/`](docs/)：

| 文档 | 内容 |
|---|---|
| [方案总纲](docs/方案总纲.md) | **目标定稿 · 实施路线 · 本轮调研结论（从这里读起）** |
| [实施 01](docs/实施01-桌面端与手机端形态方案.md) | 两端形态、工程结构、通信契约、任务清单与验收标准 |
| [设计 01](docs/设计01-长期凭据与传输架构.md) | 三层凭据模型、iOS ITP 约束、事件 → UI 映射 |
| [设计 02](docs/设计02-安装引导-配对码加固-常驻服务与传输定案.md) | PWA 安装引导、配对码加固、常驻服务形态、传输定案 |
| [调研 01](docs/调研01-统一AI编程代理终端控制台.md) | 需求拆解、各家产品远控能力盘点、可复用项目 |
| [调研 02](docs/调研02-竞品格局与技术选型修正.md) | 竞品实测数据、ACP 覆盖度、技术选型修正 |

---

## 为什么做这个

现在每个 AI 编程工具都在做自己的远程控制，而且是分散的：

- 各家各做一个，你管 5 个工具就要配 5 套远控；
- 现有方案要求你装专用 App，或者强依赖厂商中继服务器；
- 清一色 macOS / Linux 优先，Windows 是二等公民。

这个项目的前提是 **ACP（Agent Client Protocol）已经把"统一接入"标准化了**，所以不需要为每个工具写适配器。

## 核心设计

| 决策 | 选择 | 原因 |
|---|---|---|
| 统一接入 | ACP | 一次覆盖 22 个 Agent，新增 Agent 零成本 |
| 终端兜底 | PTY | 覆盖没有 ACP 的 TUI 工具（预编译发行版，`npm install` 即用） |
| 服务端 | Node 22 + `node:sqlite` | **零编译、零 native 依赖**，一个人能长期维护 |
| 前端 | PWA | 扫码即用，不上架商店 |
| 许可 | MIT | |

### 凭据模型：长寿命只给身份，绝不给会话

这是整个设计里最重要的一条。

| 层 | 名称 | 寿命 | 存放 | 泄露后果 |
|---|---|---|---|---|
| **L1** | 配对码 | 5 分钟 / 单次 | 服务端内存 | 几乎为零 |
| **L2** | 设备凭据 | 180 天滑动续期 | httpOnly Cookie | 可一键吊销、立即踢线 |
| **L3** | 会话凭据 | 15 分钟 | 浏览器内存 | 换不到 L2 |

长寿命凭据必须走 **服务端 `Set-Cookie`**，不能放 `localStorage` —— iOS 的 ITP 会清空一切脚本可写的存储（7 天无交互），只有 httpOnly Cookie 不受影响。放错地方的典型症状是「iOS 上每周要重新登录」。

### 配对：扫码只发起请求，授权必须人工点击

```
① 电脑上点「添加设备」→ 屏幕显示二维码
② 手机扫码 → 打开 PWA，带上一次性 pairId + 30 秒轮换的 challenge
③ 手机登记自己的公钥
④ 电脑弹出：「iPhone 15 · 来自 192.168.1.23 请求接入，是否允许？」
⑤ 你点「允许」   ← 授权发生在这一步
⑥ 手机拿到长期凭据，此后免扫码
```

**二维码不是凭据，只是 pairId。** 即使被偷拍，攻击者扫了也只会在你的电脑上弹出一个陌生设备的请求，你看到 UA/IP 不对就拒绝。这和「扫码即授权」的方案有本质区别。

配对码的限流分三层（照 RFC 8628）：

1. **轮询侧** —— 最小间隔 5 秒，违反则把该会话间隔 +5 秒；
2. **验证侧** —— 连续 3 次失败直接作废该码（而不是只拒绝请求，否则攻击者可以放慢速度绕过）；
3. **全局** —— 未消费码上限（全局 100 / 每 IP 3）。

### 传输：做成可插拔

| 场景 | 方案 | 手机装东西 | 成本 |
|---|---|---|---|
| **在家（同 WiFi）** | `lan` 局域网直连 | 否 | **零** |
| 在外 | `cloudflare` 隧道 | 否 | 一个域名 |
| 在外（进阶） | `easytier` 组网 | 是 | 域名 + 通用工具 |

v1 只实现 `lan`。适配器接口已经就位，新增一种传输方式是加一个文件，不需要重构。

## 快速开始

需要 **Node.js ≥ 22.18**（用到原生 TypeScript 直跑与内置 SQLite）。

```bash
git clone <this-repo>
cd uni-terminal
npm install

# 可选：复制示例配置并按需修改
cp uni-terminal.example.json uni-terminal.json

npm start
```

启动后终端会打印：

```
  Uni-terminal 已启动

  本机控制台    http://127.0.0.1:8787
  手机访问       http://192.168.1.23:8787   （同一 WiFi 下）
  服务指纹       A3F9-1C02-7B44
  可用 Agent     claude
  配置文件       C:\Users\you\.uni-terminal\config.json
```

**首次启动无需任何配置**：服务会普查环境（PATH、npm 全局目录、各版本管理器 shim 目录、Windows 注册表 PATH），发现哪些 Agent 就启用哪些，并把结果写进配置文件。预设端口被占用时自动顺延，横幅展示的永远是实际端口；配置文件损坏也不会拒绝启动——自动备份后用默认配置启动，管理台顶部给出修复入口。

`/api/local/*` 是本机管理接口，**只允许从本机访问**（同时校验回环地址、无转发头、Host 为回环名 —— 任一不满足即拒绝，所以隧道进来的请求进不来）。

## 配置

配置文件查找顺序（先命中者生效）：`$UNI_TERMINAL_CONFIG` → `./uni-terminal.json` → `~/.uni-terminal/config.json`。

```jsonc
{
  "server": { "port": 8787, "name": "我的工作站" },
  "transport": { "mode": "lan" },
  "agents": {
    // 内置 22 个 Agent，用 acpx 的名字即可
    "claude": { "enabled": true, "mode": "pty" },
    "codex":  { "enabled": false, "mode": "pty" },
    // 不在内置列表里的，显式写出 command
    "mimo":   { "enabled": true, "mode": "pty", "command": "mimo", "args": [] }
  },
  "workspaces": [{ "id": "default", "name": "默认", "path": "F:\\Work" }]
}
```

`mode` 的两种取值：

- `pty` —— 启动 Agent 自己的交互式 CLI，把终端字节流传给前端（v1 路径，对所有 Agent 都有效）；
- `acp` —— 走 ACP 拿结构化事件（工具调用 / diff / 计划 / 权限请求），前端渲染成对应面板，这是正在接入的目标形态。

## 内置 Agent（22 个）

`claude` · `codex` · `gemini` · `cursor` · `copilot` · `droid` · `iflow` · `kilocode` · `kimi` · `kiro` · `mcode`(MiniMax Code) · `mux` · `opencode` · `pool` · `qoder` · `qwen` · `trae` · `zeroclaw` · `pi` · `openclaw` · `fast-agent` · `grok-build`

启动时会探测哪些已安装，未安装的会告诉你缺什么。

## 架构

```
packages/server/src/
├── index.ts              入口：端口顺延 + 降级/恢复模式 + HTTP + WebSocket + 横幅
├── cli.ts                L2 启动器：start --background / open / status / install-service
├── config.ts             配置加载与校验（损坏降级、钳制、普查结果落地）
├── db.ts                 SQLite（node:sqlite，零编译）
├── logger.ts             结构化日志（自动脱敏凭据字段）
├── auth/
│   ├── secrets.ts        随机数 / 哈希 / 恒定时间比较 / 用户码
│   ├── identity.ts       Ed25519 服务端身份，防冒充（照 RustDesk 的做法）
│   ├── pairing.ts        配对状态机 + 三层限流
│   ├── devices.ts        L2 凭据签发 / 滑动续期 / 吊销
│   ├── cookies.ts        httpOnly Cookie 与 ITP 规避
│   └── rateLimit.ts      滑动窗口限流
├── transport/
│   ├── types.ts          传输适配器接口（可插拔）
│   └── lan.ts            局域网适配 + 待实现适配器的占位
├── agents/
│   ├── catalog.ts        22 个内置 Agent 目录
│   ├── detect.ts         可执行文件发现（PATH + npm 全局 + shim 目录 + 注册表 PATH）
│   ├── survey.ts         首次启动环境普查 + 工作区候选
│   └── driver.ts         PTY / 管道双后端，PTY 不可用时自动降级
├── session/
│   └── hub.ts            会话运行时 + 事件总线 + 断线重放
└── http/
    ├── app.ts            路由（含配置读写 / 环境普查 / 目录列举等服务面接口）
    └── local.ts          「是否本机请求」判定（安全关键）

packages/web/src/         （M1 起步，Vite 8 + React 19 + zustand）
├── api/client.ts         HTTP 封装，401 → 重新配对引导
├── api/socket.ts         ★ WebSocket 心跳 / 指数退避重连 / seq 重放
├── store/live.ts         ★ 事件流 store（追加 + seq 去重 + 重连自动补齐）
├── lib/ua.ts             微信 / QQ / 微博 / iOS / standalone 判定
├── components/DegradedBanner.tsx  降级运行可见化（E6）
└── routes/               / 分流 · /pair 配对 · /m 手机台 · /local 管理台 · /inapp 拦截
```

## 安全原则

自研认证最常见的失败不是**算错**，而是**漏了**。所以：

1. **密码学零自研。** 一切走 `node:crypto`。不用 `Math.random`，比较用恒定时间。
2. **流程照抄标准。** 设备授权参考 RFC 8628，会话轮转参考 OAuth 2.1，不为「代码简洁」砍掉安全步骤。
3. **安全清单写成断言。** 限流、吊销即断连、Cookie 标志、码不可重放 —— 每条都要有测试。

如果你发现某段认证代码「很巧妙」，那通常就是该重写它的信号。

## 路线图

### 服务端 — 已完成

- [x] 配置 / 存储 / 服务端身份（Ed25519）
- [x] 配对链路（三层限流 + 旋转 challenge + 单次消费）
- [x] L2 设备凭据（httpOnly Cookie + 滑动续期 + 吊销即断连）
- [x] PTY 驱动 + 双后端降级 + 事件持久化与重放（PTY 换用预编译发行版 `@lydell/node-pty`，安装零编译）
- [x] 传输适配器接口（`lan` 已实现，其余为占位）
- [x] **M0 配置层加固**：降级启动（配置损坏自动备份 + 默认值 + 界面内修复，绝不退出）· 端口占用自动顺延 · Agent 发现扩展（npm 全局 / 版本管理器 shim / 注册表 PATH）· 首次启动环境普查并自动生成配置 · 6 个配置读写接口 · L2 启动器（`start --background` / `open` / `status` / `install-service`）

### 前端 — 进行中

- [x] **M1 骨架与通信层**：`packages/web`（Vite + React 19 + TS + react-router）· HTTP 封装（401 → 配对引导）· WebSocket 心跳 + 指数退避重连 + `seq` 重放去重 · 事件流 store · 微信/iOS/standalone 判定 · 内置浏览器拦截页 · 降级横幅 · 路由级代码分割
- [x] **M2 桌面配对台 + 配置界面**：配对页（大二维码 + 30s 倒计时环 + 自动轮换 + 待批准请求卡片）· 设备管理（改名 / 吊销即断连）· 设置页（Agent 开关 / 真跑 `--version` 测试 / 环境重扫 / 工作区增删含界面内目录选择器 / 开机自启一键注册）· 诊断页
      ← **里程碑：最小闭环成立**
- [x] **M3 手机控制台**：三 Tab 首屏（现在 / 新建 / 设置）· 状态卡实时摘要（不进会话就知道它在干什么）· 新建任务页（选 Agent + 工作区 + 任务描述，prompt 自动送进会话）· 会话页（ANSI 剥离输出流 + 快捷应答按钮 继续/是/否/停止 + TUI 按键面板）
- [x] **M4 PWA 化**：manifest（standalone + maskable 图标）· Service Worker 离线外壳（**绝不缓存 `/api/*` 与 `/ws`**，sw.js 本体 no-cache 可更新）· Chromium 一键安装按钮（只在未安装时可用，尊重 prompt 一次机会）· iOS 图文引导 · **微信 / QQ / 微博内置浏览器拦截页** · xterm 终端面板（懒加载）
- [ ] **M5 真机验收**：iOS 后台保活、Android 一键安装、真跑一个 Claude Code 任务

### 后续

- [ ] ACP 驱动（`acpx/runtime`），把结构化事件映射为卡片面板
- [ ] Cloudflare Tunnel 传输（外网可达）
- [ ] Passkey（WebAuthn）作为恢复通道与高危二次验证
- [ ] 端到端载荷加密（配对时已登记手机公钥，加 E2E 无需重新配对）
- [ ] 跨平台托盘（一期仅提供 Windows 版，用 PowerShell `NotifyIcon` 零编译实现）

详见 [实施 01](docs/实施01-桌面端与手机端形态方案.md) 的任务清单与验收标准。

## 许可

MIT
