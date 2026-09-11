import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentTransport } from './agents/catalog.ts';
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
  return join(homedir(), '.uni-terminal');
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
      { id: 'default', name: '默认工作区', path: process.cwd() },
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
 * Config resolution order (first hit wins):
 *   1. $UNI_TERMINAL_CONFIG
 *   2. ./uni-terminal.json
 *   3. ~/.uni-terminal/config.json
 *
 * A missing file is not an error: we materialise a default one so the user has
 * something concrete to edit instead of a blank page in the docs.
 */
export function loadConfig(): UniConfig {
  const candidates = [
    process.env.UNI_TERMINAL_CONFIG,
    resolve(process.cwd(), 'uni-terminal.json'),
    join(defaultDataDir(), 'config.json'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    const target = join(defaultDataDir(), 'config.json');
    const fresh = defaultConfig();
    writeConfig(fresh, target);
    log.info(`no config found, wrote a starter file`, { path: target });
    return fresh;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(found, 'utf8'));
  } catch (err) {
    throw new Error(`config at ${found} is not valid JSON: ${(err as Error).message}`);
  }

  const merged = mergeConfig(defaultConfig(), parsed as Partial<UniConfig>);
  log.info(`config loaded`, { path: found, agents: Object.keys(merged.agents).length });
  return merged;
}

export function writeConfig(config: UniConfig, path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function mergeConfig(base: UniConfig, patch: Partial<UniConfig>): UniConfig {
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

  return {
    server: { ...base.server, ...(patch.server ?? {}) },
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
