/**
 * WebSocket channel for `/ws`.
 *
 * Two properties are load-bearing on a phone (实施01 §4.2):
 *  - a client-side heartbeat: the server pings at the protocol level and we
 *    answer automatically, but that proves nothing to *our* code — an
 *    application-level ping with a missed-pong detector is what turns "the
 *    socket looks open but is a zombie" into a visible reconnect;
 *  - replay by `seq`: on every (re)open the caller re-subscribes with the last
 *    sequence number it rendered, and the server backfills the gap. Events are
 *    therefore never lost across backgrounding or network switches, and the
 *    dedupe key (seq) means they are never rendered twice.
 */

export interface ServerHello {
  t: 'hello';
  local: boolean;
  deviceId: string | null;
  heartbeatMs: number;
  agents: string[];
}

export interface ServerEvent {
  t: 'event';
  session: string;
  seq: number;
  type: string;
  payload: unknown;
  at: number;
}

export interface ServerSessions {
  t: 'sessions';
  sessions: Array<{
    id: string;
    agent: string;
    title: string | null;
    status: string;
    live: boolean;
    createdAt: number;
  }>;
}

export type ServerMessage =
  | ServerHello
  | ServerEvent
  | ServerSessions
  | { t: 'subscribed'; session: string; from: number }
  | { t: 'revoked' }
  | { t: 'pong'; at: number }
  | { t: 'error'; message: string };

export interface SocketHandlers {
  onMessage: (msg: ServerMessage) => void;
  /** Connection state changes: 'open' after a successful (re)connect. */
  onOpen: () => void;
  onClose: () => void;
}

const PING_INTERVAL_MS = 15_000;
/** A healthy link answers pings and streams heartbeats well inside this. */
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class LiveSocket {
  private ws: WebSocket | null = null;
  private handlers: SocketHandlers;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt = 0;
  private stopped = true;

  constructor(handlers: SocketHandlers) {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, 'client stop');
    this.ws = null;
  }

  send(message: Record<string, unknown>): void {
    if (this.connected) this.ws?.send(JSON.stringify(message));
  }

  private open(): void {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.lastMessageAt = Date.now();
      this.pingTimer = setInterval(() => this.tick(), PING_INTERVAL_MS);
      this.handlers.onOpen();
    };

    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      try {
        this.handlers.onMessage(JSON.parse(ev.data as string) as ServerMessage);
      } catch {
        // A malformed frame must not kill the connection loop.
      }
    };

    ws.onclose = () => {
      this.clearTimers();
      this.handlers.onClose();
      if (!this.stopped) this.scheduleRetry();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // onclose will run.
      }
    };
  }

  private tick(): void {
    if (!this.connected) return;
    if (Date.now() - this.lastMessageAt > PONG_TIMEOUT_MS + PING_INTERVAL_MS) {
      // Zombie socket: close() triggers the normal retry path.
      this.ws?.close(4000, 'heartbeat timeout');
      return;
    }
    this.send({ t: 'ping' });
  }

  private scheduleRetry(): void {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retry);
    this.retry += 1;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = undefined;
    this.pingTimer = undefined;
  }
}
