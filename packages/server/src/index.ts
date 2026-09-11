import { serve } from '@hono/node-server';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { loadPty, ptyDiagnostics } from './agents/driver.ts';
import { readDeviceToken } from './auth/cookies.ts';
import { DeviceService } from './auth/devices.ts';
import { ServerIdentity } from './auth/identity.ts';
import { PairingService } from './auth/pairing.ts';
import { loadConfig, type UniConfig } from './config.ts';
import { Store } from './db.ts';
import { createApp } from './http/app.ts';
import { isLocalConnection, peerAddress } from './http/local.ts';
import { createLogger } from './logger.ts';
import { SessionHub, type SessionEvent } from './session/hub.ts';
import { createTransportRegistry } from './transport/lan.ts';

const log = createLogger('main');

const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 60_000;

interface ClientState {
  ws: WebSocket;
  deviceId: string | null;
  local: boolean;
  alive: boolean;
  /** sessionId -> unsubscribe handle */
  subscriptions: Map<string, () => void>;
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const config = loadConfig();

  const store = new Store(resolve(config.server.dataDir, 'uni-terminal.db'));
  const identity = ServerIdentity.loadOrCreate(config.server.dataDir);
  const pairing = new PairingService(store, config);
  const devices = new DeviceService(store, config);
  const hub = new SessionHub(store, config);
  const transport = createTransportRegistry(config);

  // Probe node-pty once at boot so the startup banner can state plainly
  // whether interactive terminals will work, instead of failing later.
  await loadPty();

  const startedAt = Date.now();
  const webDistDir = resolve(import.meta.dirname, '../../web/dist');

  let wsHandle: ReturnType<typeof attachWebSocket> | undefined;

  const app = createApp({
    config,
    store,
    identity,
    pairing,
    devices,
    hub,
    transport,
    webDistDir,
    startedAt,
    onDeviceRevoked: (deviceId) => wsHandle?.kickDevice(deviceId) ?? 0,
  });

  const httpServer = serve(
    { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
    (info) => printBanner(config, info.port, transport, identity),
  ) as unknown as HttpServer;

  wsHandle = attachWebSocket(httpServer, { config, hub, devices });

  const sweepTimer = setInterval(() => {
    pairing.sweep();
    devices.sweep();
  }, SWEEP_MS);
  sweepTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    clearInterval(sweepTimer);
    wsHandle?.closeAll();
    hub.shutdown();
    httpServer.close(() => {
      store.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 3_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });
}

// ------------------------------------------------------------------ startup

function printBanner(
  config: UniConfig,
  port: number,
  transport: ReturnType<typeof createTransportRegistry>,
  identity: ServerIdentity,
): void {
  const endpoints = transport.active.status().endpoints;
  const lines: string[] = [];
  lines.push('');
  lines.push('  Uni-terminal 已启动');
  lines.push('');
  lines.push(`  本机控制台    http://127.0.0.1:${port}`);
  if (endpoints.length > 0) {
    lines.push(`  手机访问       ${endpoints[0]?.url}   （同一 WiFi 下）`);
    for (const extra of endpoints.slice(1, 4)) {
      lines.push(`                 ${extra.url}   （备选：${extra.label}）`);
    }
  } else {
    lines.push('  手机访问       未找到局域网地址，请确认已连接网络');
  }
  lines.push(`  服务指纹       ${identity.fingerprint}`);
  lines.push(`  可用 Agent     ${Object.keys(config.agents).join(', ') || '（未配置）'}`);

  const pty = ptyDiagnostics();
  if (pty.available === false) {
    lines.push('');
    lines.push('  ⚠ 未加载 node-pty，将以管道模式运行（无法交互式输入）');
    if (pty.error) lines.push(`    原因：${pty.error}`);
    lines.push('    修复：安装 Visual Studio Build Tools（C++ 工作负载）后重跑 npm install');
  }
  if (!config.security.forceSecureCookie) {
    lines.push('');
    lines.push('  ⚠ 当前为明文 HTTP（局域网）。同网段的设备可观察到流量，');
    lines.push('    建议仅在可信任的网络中使用，后续版本将提供 HTTPS 隧道。');
  }
  lines.push('');

  for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------- websocket

interface WsDeps {
  config: UniConfig;
  hub: SessionHub;
  devices: DeviceService;
}

/**
 * Real-time channel.
 *
 * Two details are load-bearing on a phone:
 *  - a 30s heartbeat, because idle TCP is reclaimed by carriers, routers and
 *    edge proxies, and our traffic pattern is "silent for minutes, then a
 *    burst" — without it the symptom is a mysterious "works, then stops";
 *  - replay by `seq`, because a mobile client loses its socket every time the
 *    user switches apps or networks, and re-rendering a whole transcript each
 *    time is both slow and visibly jarring.
 */
function attachWebSocket(server: HttpServer, deps: WsDeps) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientState>();

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const local = isLocalConnection(req);
    const device = deps.devices.authenticate(
      readDeviceToken(normaliseHeader(req.headers.cookie), deps.config.security.cookieName),
    );

    if (!local && !device) {
      log.warn('rejected websocket upgrade', { ip: peerAddress(req) });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const state: ClientState = {
        ws,
        deviceId: device?.id ?? null,
        local,
        alive: true,
        subscriptions: new Map(),
      };
      clients.add(state);
      bindClient(state, deps);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        dropClient(client, 'heartbeat timeout');
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        dropClient(client, 'ping failed');
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function dropClient(client: ClientState, reason: string): void {
    for (const unsub of client.subscriptions.values()) unsub();
    client.subscriptions.clear();
    clients.delete(client);
    try {
      client.ws.terminate();
    } catch {
      // Already closed.
    }
    log.debug('client dropped', { reason });
  }

  function bindClient(state: ClientState, deps2: WsDeps): void {
    const { ws } = state;

    ws.on('pong', () => {
      state.alive = true;
    });

    send(ws, {
      t: 'hello',
      local: state.local,
      deviceId: state.deviceId,
      heartbeatMs: HEARTBEAT_MS,
      agents: Object.keys(deps2.config.agents),
    });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        send(ws, { t: 'error', message: '消息不是合法 JSON' });
        return;
      }
      handleMessage(state, msg, deps2);
    });

    ws.on('close', () => dropClient(state, 'closed by peer'));
    ws.on('error', () => dropClient(state, 'socket error'));
  }

  function handleMessage(state: ClientState, msg: Record<string, unknown>, deps2: WsDeps): void {
    const type = msg.t;
    const sessionId = typeof msg.session === 'string' ? msg.session : undefined;

    switch (type) {
      case 'ping':
        send(state.ws, { t: 'pong', at: Date.now() });
        return;

      case 'sub': {
        if (!sessionId) return;
        if (state.subscriptions.has(sessionId)) return;
        subscribeSession(state, sessionId, toSeq(msg.from), deps2);
        return;
      }

      case 'unsub': {
        if (!sessionId) return;
        const unsub = state.subscriptions.get(sessionId);
        if (unsub) {
          unsub();
          state.subscriptions.delete(sessionId);
        }
        return;
      }

      case 'input': {
        if (!sessionId || typeof msg.data !== 'string') return;
        try {
          deps2.hub.input(sessionId, msg.data);
        } catch (err) {
          send(state.ws, { t: 'error', session: sessionId, message: (err as Error).message });
        }
        return;
      }

      case 'interrupt': {
        if (!sessionId) return;
        try {
          deps2.hub.interrupt(sessionId);
        } catch (err) {
          send(state.ws, { t: 'error', session: sessionId, message: (err as Error).message });
        }
        return;
      }

      case 'resize': {
        if (!sessionId) return;
        const cols = typeof msg.cols === 'number' ? msg.cols : 100;
        const rows = typeof msg.rows === 'number' ? msg.rows : 30;
        deps2.hub.resize(sessionId, cols, rows);
        return;
      }

      case 'sessions': {
        send(state.ws, {
          t: 'sessions',
          sessions: deps2.hub.list().map((s) => ({
            id: s.id,
            agent: s.agent,
            title: s.title,
            status: deps2.hub.statusOf(s.id) ?? s.status,
            live: deps2.hub.isLive(s.id),
            createdAt: s.created_at,
          })),
        });
        return;
      }

      default:
        send(state.ws, { t: 'error', message: `未知消息类型 ${String(type)}` });
    }
  }

  /**
   * Subscribe first, buffer, then backfill history.
   *
   * The naive orderings both have a hole: reading history before subscribing
   * drops any event that lands in between, and subscribing before reading
   * history can interleave a live event ahead of older ones. Buffering closes
   * both — history is sent in order, then anything that arrived meanwhile is
   * replayed on top, with `lastSent` suppressing duplicates.
   */
  function subscribeSession(
    state: ClientState,
    sessionId: string,
    fromSeq: number,
    deps2: WsDeps,
  ): void {
    let lastSent = fromSeq;
    let flushed = false;
    const buffered: SessionEvent[] = [];

    const deliver = (event: SessionEvent): void => {
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      send(state.ws, {
        t: 'event',
        session: sessionId,
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        at: event.at,
      });
    };

    const unsub = deps2.hub.subscribe(sessionId, (event) => {
      if (!flushed) {
        buffered.push(event);
        return;
      }
      deliver(event);
    });
    state.subscriptions.set(sessionId, unsub);

    for (const event of deps2.hub.history(sessionId, fromSeq)) {
      deliver(event);
    }

    flushed = true;
    for (const event of buffered) deliver(event);

    send(state.ws, { t: 'subscribed', session: sessionId, from: lastSent });
  }

  return {
    /** Closes every socket authenticated with a revoked credential. */
    kickDevice(deviceId: string): number {
      let closed = 0;
      for (const client of [...clients]) {
        if (client.deviceId === deviceId) {
          send(client.ws, { t: 'revoked' });
          try {
            client.ws.close(4001, 'credential revoked');
          } catch {
            // Ignore: we are terminating it anyway.
          }
          dropClient(client, 'credential revoked');
          closed += 1;
        }
      }
      if (closed > 0) log.warn('closed sockets for revoked device', { deviceId, closed });
      return closed;
    },

    closeAll(): void {
      clearInterval(heartbeat);
      for (const client of [...clients]) {
        try {
          client.ws.close(1001, 'server shutting down');
        } catch {
          // Ignore.
        }
        dropClient(client, 'server shutdown');
      }
    },
  };
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function toSeq(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return 0;
}

function normaliseHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

void (async () => {
  try {
    await main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('fatal startup error', { message });
    console.error(`\n启动失败：${message}\n`);
    process.exit(1);
  }
})();

export type { IncomingMessage };
