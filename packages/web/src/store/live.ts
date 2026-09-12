import { create } from 'zustand';

import { api } from '../api/client.ts';
import { LiveSocket, type ServerMessage } from '../api/socket.ts';

/**
 * The event-stream store: one global, append-only state fed by the WebSocket.
 *
 * Dedupe contract: an event is stored iff `seq > lastSeq[session]`. Combined
 * with re-subscribing at the stored `lastSeq` after every reconnect, this is
 * what makes "切后台 5 分钟回来，事件无缺失无重复" hold.
 */

export interface LiveEvent {
  seq: number;
  type: string;
  payload: unknown;
  at: number;
}

export interface SessionSummary {
  id: string;
  agent: string;
  title: string | null;
  status: string;
  live: boolean;
  createdAt: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'retrying';

interface LiveState {
  connection: ConnectionState;
  local: boolean;
  deviceId: string | null;
  sessions: SessionSummary[];
  events: Record<string, LiveEvent[]>;
  lastSeq: Record<string, number>;
  /** Sessions the UI wants live; re-subscribed on every reconnect. */
  desired: Record<string, true>;

  connect: () => void;
  disconnect: () => void;
  subscribe: (sessionId: string) => void;
  unsubscribe: (sessionId: string) => void;
  sendInput: (sessionId: string, data: string) => void;
  resize: (sessionId: string, cols: number, rows: number) => void;
  interrupt: (sessionId: string) => void;
  refreshSessions: () => void;
}

let socket: LiveSocket | null = null;
/**
 * Consecutive dials that never reached an open socket. A few in a row is a
 * sleeping server; many in a row with no `hello` (hence no deviceId) usually
 * means our credential died — probe once and get out of the retry loop instead
 * of hammering a door that answers 401.
 */
let failedDials = 0;

export const useLive = create<LiveState>((set, get) => {
  const dispatch = (msg: ServerMessage): void => {
    switch (msg.t) {
      case 'hello':
        failedDials = 0;
        set({ local: msg.local, deviceId: msg.deviceId });
        return;

      case 'event': {
        const { lastSeq, events } = get();
        if (msg.seq <= (lastSeq[msg.session] ?? 0)) return; // duplicate
        set({
          lastSeq: { ...lastSeq, [msg.session]: msg.seq },
          events: {
            ...events,
            [msg.session]: [...(events[msg.session] ?? []), {
              seq: msg.seq,
              type: msg.type,
              payload: msg.payload,
              at: msg.at,
            }],
          },
        });
        return;
      }

      case 'sessions':
        set({ sessions: msg.sessions });
        return;

      case 'revoked':
        // 吊销即清场：凭据已失效，回到配对引导。
        set({ deviceId: null, sessions: [] });
        window.location.assign('/pair');
        return;

      default:
        return;
    }
  };

  const flushSubscriptions = (): void => {
    const { desired, lastSeq } = get();
    for (const sessionId of Object.keys(desired)) {
      socket?.send({ t: 'sub', session: sessionId, from: lastSeq[sessionId] ?? 0 });
    }
    socket?.send({ t: 'sessions' });
  };

  const ensureSocket = (): LiveSocket => {
    if (socket) return socket;
    socket = new LiveSocket({
      onOpen: () => {
        failedDials = 0;
        set({ connection: 'open' });
        flushSubscriptions();
      },
      onClose: () => {
        failedDials += 1;
        if (failedDials >= 3 && !get().deviceId) {
          // api.get throws on 401 and navigates to /pair; a resolved probe
          // means auth is fine and the server is just unreachable — keep the
          // normal backoff running.
          void api.get('/api/me').catch(() => undefined);
        }
        if (get().connection !== 'retrying') set({ connection: 'retrying' });
      },
      onMessage: dispatch,
    });
    return socket;
  };

  return {
    connection: 'idle',
    local: false,
    deviceId: null,
    sessions: [],
    events: {},
    lastSeq: {},
    desired: {},

    connect: () => {
      set({ connection: 'connecting' });
      ensureSocket().start();
    },

    disconnect: () => {
      socket?.stop();
      socket = null;
      set({ connection: 'idle' });
    },

    subscribe: (sessionId) => {
      set((s) => ({ desired: { ...s.desired, [sessionId]: true } }));
      ensureSocket();
      if (!socket?.connected) {
        if (get().connection === 'idle' || get().connection === 'retrying') {
          set({ connection: 'connecting' });
          socket!.start();
        }
        return; // onOpen flushes the subscription
      }
      socket.send({ t: 'sub', session: sessionId, from: get().lastSeq[sessionId] ?? 0 });
    },

    unsubscribe: (sessionId) => {
      set((s) => {
        const desired = { ...s.desired };
        delete desired[sessionId];
        const events = { ...s.events };
        delete events[sessionId];
        return { desired, events };
      });
      socket?.send({ t: 'unsub', session: sessionId });
    },

    sendInput: (sessionId, data) => socket?.send({ t: 'input', session: sessionId, data }),
    resize: (sessionId, cols, rows) => socket?.send({ t: 'resize', session: sessionId, cols, rows }),
    interrupt: (sessionId) => socket?.send({ t: 'interrupt', session: sessionId }),
    refreshSessions: () => socket?.send({ t: 'sessions' }),
  };
});
