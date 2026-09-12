import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import { useLive } from '../../store/live.ts';
import { TerminalPane } from '../../components/TerminalPane.tsx';
import { QuickReplies } from '../../components/QuickReplies.tsx';

/**
 * 桌面会话查看（补上的功能缺口）：手机上启动的会话，人在电脑前也能实时
 * 看到它的终端、直接敲键盘、用快捷应答推进。与手机端共用同一套实时通道
 * （WebSocket + seq 重放），两个屏幕看到的是同一个虚拟终端。
 */
export function LocalSession(): React.ReactNode {
  const { id = '' } = useParams();
  const { subscribe, unsubscribe, events, sendInput, interrupt, resize, connection, sessions } = useLive();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const session = sessions.find((s) => s.id === id);

  useEffect(() => {
    if (!id) return;
    subscribe(id);
    return () => unsubscribe(id);
  }, [id, subscribe, unsubscribe]);

  const list = events[id] ?? [];

  return (
    <>
      <p style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 10px' }}>
        <Link to="/local">← 会话列表</Link>
        <strong>{session ? `${session.agent}` : id.slice(0, 8)}</strong>
        {session?.title && <span className="muted">{session.title}</span>}
        <span className="badge" style={session?.live ? { color: 'var(--state-running)', borderColor: 'var(--state-running)' } : undefined}>
          {session ? (session.live ? '运行中' : session.status) : connection === 'open' ? '已连接' : '连接中…'}
        </span>
        <span style={{ flex: 1 }} />
        <span>{connection === 'open' ? '🟢 实时' : '🟡 重连中'}</span>
      </p>

      <div className="card" style={{ padding: 6, background: '#0d1320' }}>
        <TerminalPane sessionId={id} events={list} onResized={(cols, rows) => resize(id, cols, rows)} />
      </div>

      <QuickReplies onSend={(data) => sendInput(id, data)} onInterrupt={() => interrupt(id)} />

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft) {
              sendInput(id, `${draft}\r`);
              setDraft('');
            }
          }}
          enterKeyHint="send"
          placeholder="发消息给 Agent…（也可以直接在终端里敲）"
          style={{
            flex: 1,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            padding: '10px 12px',
            fontSize: 14,
          }}
        />
        <button
          className="btn primary"
          onClick={() => {
            if (draft) {
              sendInput(id, `${draft}\r`);
              setDraft('');
              inputRef.current?.focus();
            }
          }}
        >
          发送
        </button>
      </div>
    </>
  );
}
