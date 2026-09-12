import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentTransport } from './agents/catalog.ts';
import { surveyEnvironment } from './agents/survey.ts';
import { createLogger } from './logger.ts';

const log = createLogger('config');

export interface AgentSetting {
  enabled: boolean;
  mode: AgentTransport;
  /** Overrides the catalog adapter command. */
  command?: string;
  args?: string[];
  /** Working directory for this agent; falls back to the workspace path. */
  cwd?: string;
  label?: string;
}

export interface WorkspaceSetting {
  id: string;
  name: string;
  path: string;
}

export type TransportMode = 'lan' | 'cloudflare' | 'easytier' | 'ipv6' | 'frp' | 'manual';

export interface ServerConfig {
  host: string;
  port: number;
  name: string;
  dataDir: string;
}

export interface UniConfig {
  server: ServerConfig;
  transport: {
    mode: TransportMode;
    /** Set when mode is `manual`; any URL the phone should dial. */
    publicUrl?: string;
  };
  agents: Record<string, AgentSetting>;
  workspaces: WorkspaceSetting[];
  security: {
    pairingTtlMs: number;
    pairingRotateMs: number;
    deviceTtlMs: number;
    maxPendingPairingsGlobal: number;
    maxPendingPairingsPerIp: number;
    maxPairingAttempts: number;
    cookieName: string;
    /** Forces the `Secure` cookie flag on. Auto-detected from TLS otherwise. */
    forceSecureCookie?: boolean;
  };
}

export const DEFAULT_COOKIE_NAME = 'ut_device';

function defaultDataDir(): string {
  // Override hatch for tests and the launcher; production default is fixed.
  const override = process.env.UNI_TERMINAL_DATA_DIR;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), '.uni-terminal');
}

/**
 * Hard constraint (实施文档 01 §2.4, E6): the server must never refuse to start
 * because of a bad config — that produces the deadlock where the only tool
 * able to fix the config is the admin UI, which lives on the server that just
 * exited. So instead of throwing, every load ends in a usable config plus a
 * list of issues the UI must surface.
 */
export type ConfigIssueCode = 'parse_error' | 'fresh' | 'survey_note' | 'port_in_use';

export interface ConfigIssue {
  code: ConfigIssueCode;
  /** Human-readable, safe to render in the admin UI. */
  message: string;
  path?: string;
  /** Where the broken file was moved before degrading to defaults. */
  backupPath?: string;
}

export interface ConfigLoadResult {
  config: UniConfig;
  issues: ConfigIssue[];
  /** The config file in force — undefined only if it could not be written. */
  path?: string;
}

/**
 * The default workspace must never be `process.cwd()`: launched from a Start
 * Menu shortcut it can be `C:\Windows\System32`. Priority: a directory handed
 * to the launcher (`UNI_TERMINAL_CWD`), then the user's home.
 */
function defaultWorkspacePath(): string {
  const fromLauncher = process.env.UNI_TERMINAL_CWD;
  if (fromLauncher && fromLauncher.trim().length > 0) return fromLauncher.trim();
  return homedir();
}

export function defaultConfig(): UniConfig {
  return {
    server: {
      host: '0.0.0.0',
      port: 8787,
      name: 'Uni-terminal',
      dataDir: defaultDataDir(),
    },
    transport: {
      mode: 'lan',
    },
    agents: {
      // `pty` launches the agent's own interactive CLI and streams its terminal
      // bytes: this is the v1 path, because it works for every agent today.
      // `acp` is reserved for the structured-event back-end (tool calls, plans,
      // diffs, permission prompts) driven through the acpx runtime SDK.
      claude: { enabled: true, mode: 'pty' },
    },
    workspaces: [
      { id: 'default', name: '默认工作区', path: defaultWorkspacePath() },
    ],
    security: {
      pairingTtlMs: 5 * 60_000,
      pairingRotateMs: 30_000,
      deviceTtlMs: 180 * 24 * 60 * 60_000,
      maxPendingPairingsGlobal: 100,
      maxPendingPairingsPerIp: 3,
      maxPairingAttempts: 3,
      cookieName: DEFAULT_COOKIE_NAME,
    },
  };
}

/**
 * First boot: probe the machine, enable everything found (E5), and materialise
 * a config file so the user has something concrete instead of a blank page.
 */
function surveyedConfig(): { config: UniConfig; issues: ConfigIssue[] } {
  const config = defaultConfig();
  const issues: ConfigIssue[] = [];
  config.workspaces = [
    { id: 'default', name: '默认工作区', path: defaultWorkspacePath() },
  ];

  try {
    const survey = surveyEnvironment();
    const agents: UniConfig['agents'] = {};
    for (const detected of survey.agents) {
      if (detected.installed) {
        agents[detected.id] = { enabled: true, mode: 'pty' };
      }
    }
    if (Object.keys(agents).length > 0) {
      config.agents = agents;
      issues.push({
        code: 'survey_note',
        message: `首次启动环境普查：发现 ${Object.keys(agents).length} 个 Agent，已全部启用`,
      });
    } else {
      issues.push({
        code: 'survey_note',
        message: '首次启动环境普查：未发现任何已安装的 AI 编程工具，已保留 claude 占位配置',
      });
    }
  } catch (err) {
    issues.push({
      code: 'survey_note',
      message: `环境普查未完成（不影响启动）：${(err as Error).message}`,
    });
  }

  return { config, issues };
}

export function configPathCandidates(): string[] {
  return [
    process.env.UNI_TERMINAL_CONFIG,
    resolve(process.cwd(), 'uni-terminal.json'),
    join(defaultDataDir(), 'config.json'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * Config resolution order (first hit wins):
 *   1. $UNI_TERMINAL_CONFIG
 *   2. ./uni-terminal.json
 *   3. ~/.uni-terminal/config.json
 *
 * All three outcomes — missing, broken, healthy — produce a runnable config.
 */
export function loadConfig(): ConfigLoadResult {
  const candidates = configPathCandidates();

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    const target = join(defaultDataDir(), 'config.json');
    const { config, issues } = surveyedConfig();
    const written = tryWrite(config, target);
    if (written) {
      issues.push({
        code: 'fresh',
        message: '未找到配置文件，已按环境普查结果生成默认配置',
        path: target,
      });
      log.info(`未找到配置文件，已生成默认配置`, { path: target });
      return { config, issues, path: target };
    }
    // Data dir unwritable: run with defaults, no file — recovery mode in the
    // entry point will use the issue list to explain what happened.
    issues.push({
      code: 'fresh',
      message: '未找到配置文件，且默认位置不可写；本次以默认配置运行（只读诊断模式）',
      path: target,
    });
    return { config, issues };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(found, 'utf8'));
  } catch (err) {
    const backupPath = `${found}.bak-${Date.now()}`;
    let backupNote = '';
    try {
      copyFileSync(found, backupPath);
      backupNote = `原文件已备份为 ${backupPath}`;
    } catch {
      backupNote = '（备份失败：目录不可写）';
    }
    log.warn('配置文件无法解析，已降级为默认配置', { path: found, backupPath });
    return {
      config: defaultConfig(),
      issues: [
        {
          code: 'parse_error',
          message: `配置文件 ${found} 无法解析：${(err as Error).message}。${backupNote} 已使用默认配置启动，可在管理台中修复。`,
          path: found,
          backupPath,
        },
      ],
      path: found,
    };
  }

  const merged = mergeConfig(defaultConfig(), parsed as Partial<UniConfig>);
  log.info(`配置已加载`, { path: found, agents: Object.keys(merged.agents).length });
  return { config: merged, issues: [], path: found };
}

/** writeConfig that reports failure instead of taking the process down. */
export function tryWrite(config: UniConfig, path: string): boolean {
  try {
    writeConfig(config, path);
    return true;
  } catch (err) {
    log.warn('配置文件写入失败', { path, reason: (err as Error).message });
    return false;
  }
}

export function writeConfig(config: UniConfig, path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Finds the newest `*.bak-<timestamp>` next to the config file, for the
 * admin-UI "restore backup" button.
 */
export function latestConfigBackup(path: string): string | undefined {
  try {
    const file = path.split(/[\\/]/).pop() ?? '';
    const dir = join(path, '..');
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(`${file}.bak-`))
      .sort();
    return backups.length > 0 ? join(dir, backups[backups.length - 1] ?? '') : undefined;
  } catch {
    return undefined;
  }
}

/** Clamps and repairs a user-supplied config against the defaults. */
export function mergeConfig(base: UniConfig, patch: Partial<UniConfig>): UniConfig {
  const security = { ...base.security, ...(patch.security ?? {}) };

  // Never let a hand-edited config turn the pairing window into a permanent one.
  security.pairingTtlMs = clamp(security.pairingTtlMs, 30_000, 15 * 60_000);
  security.pairingRotateMs = clamp(security.pairingRotateMs, 5_000, security.pairingTtlMs);
  security.deviceTtlMs = clamp(security.deviceTtlMs, 60_000, 400 * 24 * 60 * 60_000);

  const agents: Record<string, AgentSetting> = {};
  for (const [id, raw] of Object.entries(patch.agents ?? base.agents)) {
    agents[id] = {
      enabled: raw.enabled ?? true,
      mode: raw.mode === 'pty' ? 'pty' : 'acp',
      ...(raw.command ? { command: raw.command } : {}),
      ...(raw.args ? { args: raw.args } : {}),
      ...(raw.cwd ? { cwd: raw.cwd } : {}),
      ...(raw.label ? { label: raw.label } : {}),
    };
  }

  const server = { ...base.server, ...(patch.server ?? {}) };
  server.port = Math.round(clamp(Number(server.port), 1, 65_535));
  if (!Number.isFinite(server.port)) server.port = base.server.port;
  server.name = String(server.name ?? base.server.name).slice(0, 100) || base.server.name;
  server.host = String(server.host ?? base.server.host).slice(0, 100) || base.server.host;
  server.dataDir = String(server.dataDir ?? base.server.dataDir);

  return {
    server,
    transport: { ...base.transport, ...(patch.transport ?? {}) },
    agents,
    workspaces:
      patch.workspaces && patch.workspaces.length > 0 ? patch.workspaces : base.workspaces,
    security,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
