import type { SessionRow, Store } from '../db.ts';
import type { AgentSetting, UniConfig } from '../config.ts';
import { lookupAgent } from '../agents/catalog.ts';
import { startProcess, type RunHandle } from '../agents/driver.ts';
import { randomId } from '../auth/secrets.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('session');

export type SessionStatus = 'starting' | 'running' | 'exited' | 'failed' | 'canceled';

export interface SessionEvent {
  seq: number;
  type: string;
  payload: unknown;
  at: number;
}

/**
 * Event vocabulary.
 *
 * `session.*` events come from the PTY back-end: raw bytes plus lifecycle.
 * `agent.*` is reserved for the ACP back-end, which reports structured
 * activity (tool calls, plans, diffs, permission prompts) instead of a stream
 * of terminal bytes. The phone renders `agent.*` as purpose-built panels and
 * keeps `session.output` behind a collapsed "raw terminal" toggle — a terminal
 * transcript is a poor fit for a 6-inch screen.
 */
export const EVENT_TYPES = {
  ready: 'session.ready',
  output: 'session.output',
  status: 'session.status',
  exit: 'session.exit',
  error: 'session.error',
} as const;

interface Runtime {
  id: string;
  agent: string;
  handle: RunHandle;
  seq: number;
  status: SessionStatus;
  outputBuffer: string;
  flushTimer: NodeJS.Timeout | undefined;
  meta: { command: string; args: string[]; cwd: string };
}

export interface StartParams {
  agent: string;
  workspaceId?: string;
  title?: string;
  cols?: number;
  rows?: number;
}

export class SessionError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function resolveAgentLaunch(
  config: UniConfig,
  agentId: string,
): { command: string; args: string[]; cwd: string; mode: 'acp' | 'pty' } {
  const setting: AgentSetting | undefined = config.agents[agentId];
  if (!setting) {
    throw new SessionError('agent_not_configured', `配置里没有 ${agentId}，请先在电脑端添加它`, 404);
  }
  if (!setting.enabled) {
    throw new SessionError('agent_disabled', `${agentId} 已被禁用`);
  }

  const workspace =
    config.workspaces.find((w) => w.id === (setting.cwd ?? '')) ?? config.workspaces[0];

  const cwd = setting.cwd && setting.cwd !== workspace?.id
    ? setting.cwd
    : (workspace?.path ?? process.cwd());

  if (setting.command) {
    return {
      command: setting.command,
      args: setting.args ?? [],
      cwd,
      mode: setting.mode,
    };
  }

  const entry = lookupAgent(agentId);
  if (!entry) {
    throw new SessionError(
      'agent_unknown',
      `未知的 Agent「${agentId}」。请在配置中显式写出 command，或使用内置名称。`,
      404,
    );
  }

  // For a PTY back-end we want the agent's own interactive CLI, and the catalog
  // probe is exactly "the executable that exists on this machine". Package
  // runners are excluded because `npx` alone is not a runnable agent.
  const probe = entry.probe[0];
  const isPackageRunner = probe === 'npx' || probe === 'uvx' || probe === 'pnpm' || probe === 'npm';
  if (!probe || isPackageRunner || entry.probe.length !== 1) {
    throw new SessionError(
      'agent_needs_command',
      `${entry.label} 的启动命令不唯一，请在配置里为它写上 command 和 args。`,
    );
  }

  return { command: probe, args: setting.args ?? [], cwd, mode: setting.mode };
}

/**
 * Owns running agent processes and fans their events out to subscribers.
 *
 * Two behaviours here matter more than they look:
 *   1. Output is coalesced (~40ms). A PTY emits many tiny chunks; one event
 *      per chunk would mean thousands of WebSocket frames and thousands of
 *      SQLite rows for a single screenful of text.
 *   2. Every event is persisted before it is broadcast, so a phone that lost
 *      signal mid-run can reconnect and replay from its last seen `seq`. On a
 *      mobile client this is a requirement, not a nicety.
 */
export class SessionHub {
  private readonly store: Store;
  private readonly config: UniConfig;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly watchers = new Map<string, Set<(event: SessionEvent) => void>>();

  constructor(store: Store, config: UniConfig) {
    this.store = store;
    this.config = config;
  }

  async start(params: StartParams): Promise<{ session: SessionRow; info: { usesPty: boolean; command: string } }> {
    const launch = resolveAgentLaunch(this.config, params.agent);
    const id = randomId(12);
    const now = Date.now();

    const session: SessionRow = {
      id,
      agent: params.agent,
      workspace: params.workspaceId ?? this.config.workspaces[0]?.id ?? null,
      cwd: launch.cwd,
      title: params.title ?? `${params.agent} · ${new Date(now).toLocaleTimeString('zh-CN')}`,
      status: 'starting',
      created_at: now,
      updated_at: now,
      last_seq: 0,
    };

    let handle: RunHandle;
    try {
      handle = await startProcess({
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        cols: params.cols ?? 100,
        rows: params.rows ?? 30,
      });
    } catch (err) {
      // Surface this as a typed error so the client gets an actionable message
      // ("that binary does not exist") instead of an opaque 500.
      throw new SessionError(
        'agent_start_failed',
        `无法启动 ${params.agent}（命令 ${launch.command}）：${(err as Error).message}`,
        502,
      );
    }

    this.store.insertSession(session);

    const runtime: Runtime = {
      id,
      agent: params.agent,
      handle,
      seq: 0,
      status: 'starting',
      outputBuffer: '',
      flushTimer: undefined,
      meta: { command: launch.command, args: launch.args, cwd: launch.cwd },
    };
    this.runtimes.set(id, runtime);

    handle.onData((chunk) => this.queueOutput(runtime, chunk));
    handle.onExit(({ exitCode }) => this.handleExit(runtime, exitCode));

    this.setStatus(runtime, 'running');
    this.emit(runtime, EVENT_TYPES.ready, {
      agent: params.agent,
      pid: handle.pid,
      usesPty: handle.usesPty,
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      mode: launch.mode,
    });

    log.info('会话已启动', {
      id,
      agent: params.agent,
      command: launch.command,
      usesPty: handle.usesPty,
    });

    return { session, info: { usesPty: handle.usesPty, command: launch.command } };
  }

  input(sessionId: string, data: string): void {
    const runtime = this.requireRuntime(sessionId);
    runtime.handle.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(sessionId);
    runtime?.handle.resize(cols, rows);
  }

  /** Cooperative interrupt: what the user means by "stop". */
  interrupt(sessionId: string): void {
    const runtime = this.requireRuntime(sessionId);
    runtime.handle.write('\u0003');
    log.info('会话已中断', { id: sessionId });
  }

  /** Hard stop, used when the session is deleted. */
  kill(sessionId: string, reason: SessionStatus = 'canceled'): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.status = reason;
    runtime.handle.kill();
  }

  history(sessionId: string, fromSeq = 0, limit = 2000): SessionEvent[] {
    return this.store.eventsSince(sessionId, fromSeq, limit).map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: safeParse(row.payload),
      at: row.created_at,
    }));
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    let set = this.watchers.get(sessionId);
    if (!set) {
      set = new Set();
      this.watchers.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.watchers.delete(sessionId);
    };
  }

  list(): SessionRow[] {
    return this.store.listSessions();
  }

  /** Live status, falling back to the persisted row for sessions from a previous run. */
  statusOf(sessionId: string): SessionStatus | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) return runtime.status;
    const row = this.store.getSession(sessionId);
    return row?.status as SessionStatus | undefined;
  }

  isLive(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  shutdown(): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
      runtime.handle.kill();
      this.store.setSessionStatus(id, 'exited', Date.now());
    }
    this.runtimes.clear();
    this.watchers.clear();
    log.info('全部会话已停止');
  }

  // ---- internals --------------------------------------------------------

  private handleExit(runtime: Runtime, exitCode: number | null): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = undefined;
    }
    if (runtime.outputBuffer.length > 0) {
      const rest = runtime.outputBuffer;
      runtime.outputBuffer = '';
      this.emit(runtime, EVENT_TYPES.output, { chunk: rest });
    }

    const status: SessionStatus =
      runtime.status === 'canceled' ? 'canceled' : exitCode === 0 ? 'exited' : 'failed';

    this.setStatus(runtime, status);
    this.emit(runtime, EVENT_TYPES.exit, { code: exitCode });
    this.runtimes.delete(runtime.id);
    log.info('会话已结束', { id: runtime.id, status, exitCode });
  }

  private setStatus(runtime: Runtime, status: SessionStatus): void {
    runtime.status = status;
    this.store.setSessionStatus(runtime.id, status, Date.now());
    this.emit(runtime, EVENT_TYPES.status, { status });
  }

  private queueOutput(runtime: Runtime, chunk: string): void {
    runtime.outputBuffer += chunk;
    if (runtime.flushTimer) return;
    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = undefined;
      const data = runtime.outputBuffer;
      runtime.outputBuffer = '';
      if (data.length > 0) this.emit(runtime, EVENT_TYPES.output, { chunk: data });
    }, 40);
  }

  private emit(runtime: Runtime, type: string, payload: unknown): void {
    runtime.seq += 1;
    const event: SessionEvent = { seq: runtime.seq, type, payload, at: Date.now() };

    this.store.appendEvent({
      session_id: runtime.id,
      seq: event.seq,
      type,
      payload: JSON.stringify(payload),
      created_at: event.at,
    });

    if (event.seq % 200 === 0) {
      this.store.pruneEvents(runtime.id, 3000);
    }

    for (const listener of this.watchers.get(runtime.id) ?? []) {
      try {
        listener(event);
      } catch (err) {
        log.warn('事件监听器抛出异常', { id: runtime.id, error: (err as Error).message });
      }
    }
  }

  private requireRuntime(sessionId: string): Runtime {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new SessionError('session_not_live', '该会话已结束，无法写入', 409);
    }
    return runtime;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
