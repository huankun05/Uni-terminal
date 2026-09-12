import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';

import { api } from '../../api/client.ts';
import { useLive } from '../../store/live.ts';
import { formatTime } from '../../lib/format.ts';

/**
 * 三段式底部导航（实施01 §3.2）。
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
      <nav
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          borderTop: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {[
          ['/', '现在'],
          ['/settings', '设置'],
        ].map(([to, label]) => (
          <Link
            key={to}
            to={`/m${to}`}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '14px 0',
              color: 'var(--text-secondary)',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

/**
 * 首屏 = 状态卡（E1：不自动跳进会话；活跃卡整块可点）。
 * 待处理（权限请求）永远置顶——这是唯一"不处理就一直卡着"的事件类型（M3 精化）。
 */
export function MNow(): React.ReactNode {
  const navigate = useNavigate();
  const { connect, disconnect, connection, sessions, refreshSessions } = useLive();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (connection === 'open') refreshSessions();
  }, [connection, refreshSessions]);

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
        active.map((s) => (
          <div
            key={s.id}
            className="card"
            onClick={() => void navigate(`/m/s/${s.id}`)}
            style={{ cursor: 'pointer', marginBottom: 10, borderColor: 'var(--state-running)' }}
          >
            <div>
              <span className="status-dot" style={{ background: 'var(--state-running)' }} />
              <strong>{s.agent}</strong> 正在运行
            </div>
            {s.title && <div className="muted" style={{ fontSize: 14 }}>{s.title}</div>}
          </div>
        ))
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

      <p className="muted" style={{ fontSize: 13, marginTop: 20 }}>
        还没有会话？M2 完成配对、M3 提供新建任务页后即可从这里启动 Agent。
      </p>
    </div>
  );
}
