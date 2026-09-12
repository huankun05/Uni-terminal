import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';

import { api } from '../../api/client.ts';
import { useLive } from '../../store/live.ts';
import { formatTime } from '../../lib/format.ts';
import { stripAnsi } from '../../lib/ansi.ts';
import { sessionSummary } from './Session.tsx';
import { analyzeTail } from '../../lib/pty.ts';

/**
 * 三段式底部导航（实施01 §3.2）：现在 / 新建 / 设置。
 *
 * The auth gate matters more than it looks: without it an *unpaired* phone
 * lands here and the live store starts dialling /ws on a timer — every dial is
 * a rejected upgrade on the server and a pointless retry loop on the phone.
 * Asking /api/me first sends a credential-less phone to /pair before any
 * socket exists (401 inside api.get navigates there automatically).
 */
export function MLayout(): React.ReactNode {
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    void api
      .get('/api/me')
      .then(() => setAuthed(true))
      .catch(() => {
        // 401 已由 client.ts 引去 /pair；其余错误停在提示页。
      });
  }, []);

  if (!authed) {
    return (
      <div className="layout" style={{ maxWidth: 560 }}>
        <p className="muted">正在检查配对状态…</p>
      </div>
    );
  }

  return (
    <>
      <div style={{ minHeight: 'calc(100vh - 56px)' }}>
        <Outlet />
      </div>
      <nav className="tabbar">
        {[
          ['/now', '现在'],
          ['/new', '新建'],
          ['/settings', '设置'],
        ].map(([to, label]) => (
          <NavLink key={to} to={`/m${to}`} end={to === '/now'} className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

/**
 * 首屏 = 状态卡（E1：不自动跳进会话；活跃卡整块可点）。
 * 活跃会话在这里保持订阅，卡片上直接显示"它现在在打什么"——
 * 掏手机的第一问（跑完了吗/卡住了吗）不点进去就有答案。
 */
export function MNow(): React.ReactNode {
  const navigate = useNavigate();
  const { connect, disconnect, connection, sessions, events, subscribe, unsubscribe, refreshSessions } = useLive();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (connection === 'open') refreshSessions();
  }, [connection, refreshSessions]);

  // 状态卡动态：活跃会话全部订阅，离开首屏时退订。
  const liveIds = sessions.filter((s) => s.live).map((s) => s.id).sort().join(',');
  useEffect(() => {
    if (connection !== 'open' || !liveIds) return;
    for (const id of liveIds.split(',')) subscribe(id);
    return () => {
      for (const id of liveIds.split(',')) unsubscribe(id);
    };
  }, [connection, liveIds, subscribe, unsubscribe]);

  const active = sessions.filter((s) => s.live);
  const finished = sessions.filter((s) => !s.live);

  return (
    <div className="layout" style={{ maxWidth: 560 }}>
      <h1>现在</h1>
      <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
        连接：{
          connection === 'open' ? '正常' : connection === 'retrying' ? '重连中…' : connection === 'connecting' ? '连接中…' : '未连接'
        }
      </p>

      {active.length === 0 ? (
        <div className="card">
          <span className="status-dot" style={{ background: 'var(--text-tertiary)' }} />
          空闲中
          {sessions.length > 0 && (
            <span className="muted"> · 最近活动 {formatTime(Math.max(...sessions.map((s) => s.createdAt)))}</span>
          )}
        </div>
      ) : (
        active.map((s) => {
          const summary = sessionSummary(events[s.id] ?? []);
          const raw = (events[s.id] ?? [])
            .filter((e) => e.type === 'session.output')
            .map((e) => (e.payload as { chunk?: string })?.chunk ?? '')
            .join('');
          const needsReply = analyzeTail(stripAnsi(raw).slice(-3000)).kind !== 'none';
          return (
            <div
              key={s.id}
              className="card"
              onClick={() => void navigate(`/m/s/${s.id}`)}
              style={{ cursor: 'pointer', marginBottom: 10, borderColor: needsReply ? 'var(--state-waiting)' : 'var(--state-running)' }}
            >
              <div>
                <span className="status-dot" style={{ background: needsReply ? 'var(--state-waiting)' : 'var(--state-running)' }} />
                <strong>{s.agent}</strong> {needsReply ? '正在等你应答' : '正在运行'}
                {s.title && <span className="muted" style={{ fontSize: 13 }}> · {s.title}</span>}
              </div>
              {summary && (
                <div className="mono muted" style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap', maxHeight: 72, overflow: 'hidden' }}>
                  {summary}
                </div>
              )}
            </div>
          );
        })
      )}

      {finished.length > 0 && (
        <>
          <h2>已结束（{finished.length}）</h2>
          {finished.map((s) => (
            <div
              key={s.id}
              className="card"
              onClick={() => void navigate(`/m/s/${s.id}`)}
              style={{ cursor: 'pointer', marginBottom: 8, opacity: 0.75 }}
            >
              <span className="status-dot" style={{ background: 'var(--state-done)' }} />
              {s.agent} · {s.title ?? s.id.slice(0, 8)} · {s.status}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
