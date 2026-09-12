import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';

import { api } from '../../api/client.ts';
import { DegradedBanner, type RuntimeIssue } from '../../components/DegradedBanner.tsx';
import { formatTime } from '../../lib/format.ts';

interface Bootstrap {
  server: { name: string; port: number; fingerprint: string };
  runtime: { port: number; configPath?: string; issues: RuntimeIssue[] };
  agents: Array<{ id: string; label: string; installed: boolean; binary?: string; note?: string }>;
  devices: Array<{ id: string; name: string; lastSeenAt: number }>;
  sessions: Array<{ id: string; agent: string; title: string | null; status: string; live: boolean; createdAt: number }>;
  pty: { available?: boolean; error?: string };
}

export function useBootstrap(): Bootstrap | undefined {
  const [data, setData] = useState<Bootstrap>();
  useEffect(() => {
    void api.get<Bootstrap>('/api/local/bootstrap').then(setData).catch(() => setData(undefined));
  }, []);
  return data;
}

const NAV: Array<{ to: string; label: string }> = [
  { to: '/local', label: '总览' },
  { to: '/local/pairing', label: '配对' },
  { to: '/local/devices', label: '设备' },
  { to: '/local/settings', label: '设置' },
  { to: '/local/diagnostics', label: '诊断' },
];

/** 桌面管理台壳：宽屏侧边栏，窄屏顶部横排。 */
export function LocalLayout(): React.ReactNode {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Uni<span>-</span>terminal
        </div>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/local'} className={({ isActive }) => (isActive ? 'active' : '')}>
            {item.label}
          </NavLink>
        ))}
        <div className="foot">
          仅本机可达 ·
          <br />
          管理接口不对外网开放
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

export function LocalDashboard(): React.ReactNode {
  const data = useBootstrap();

  if (!data) return <p className="muted">正在加载管理台…（若一直无响应，请确认从 127.0.0.1 访问）</p>;

  const installed = data.agents.filter((a) => a.installed);
  const liveSessions = data.sessions.filter((s) => s.live);

  return (
    <>
      <DegradedBanner issues={data.runtime.issues} />
      <h1>{data.server.name}</h1>
      <p className="page-sub mono">
        指纹 {data.server.fingerprint} · 实际端口 {data.runtime.port}
        {data.runtime.configPath ? ` · 配置 ${data.runtime.configPath}` : ''}
      </p>

      <div className="stats">
        <div className="stat">
          <div className="num">{liveSessions.length}</div>
          <div className="label">运行中的会话</div>
        </div>
        <div className="stat">
          <div className="num">{data.devices.length}</div>
          <div className="label">已配对设备</div>
        </div>
        <div className="stat">
          <div className="num">{installed.length}<span style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>/{data.agents.length}</span></div>
          <div className="label">可用 Agent</div>
        </div>
        <div className="stat">
          <div className="num" style={{ color: data.pty.available === false ? 'var(--diff-del)' : 'var(--state-done)' }}>
            {data.pty.available === false ? '✕' : '✓'}
          </div>
          <div className="label">PTY 终端</div>
        </div>
      </div>

      <h2>会话（{data.sessions.length}）— 点开可在本机实时查看</h2>
      <div className="card" style={{ padding: '6px 14px' }}>
        {data.sessions.length === 0 && <p className="muted" style={{ fontSize: 14 }}>还没有会话。手机扫码后在「新建」页发起，这里可以实时查看。</p>}
        {data.sessions.map((s) => (
          <Link key={s.id} to={`/local/sessions/${s.id}`} className="row" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="status-dot" style={{ background: s.live ? 'var(--state-running)' : 'var(--state-done)' }} />
            <span className="mono" style={{ flexShrink: 0 }}>{s.agent}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.title ?? s.id.slice(0, 8)}
            </span>
            <span className="badge" style={s.live ? { color: 'var(--state-running)', borderColor: 'var(--state-running)' } : undefined}>
              {s.live ? '运行中' : s.status}
            </span>
            <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>{formatTime(s.createdAt)}</span>
          </Link>
        ))}
      </div>

      <h2>Agent（{installed.length} 可用 / {data.agents.length} 目录）</h2>
      <div className="card" style={{ padding: '8px 14px' }}>
        {data.agents.map((a) => (
          <div key={a.id} className="row">
            <span className="status-dot" style={{ background: a.installed ? 'var(--state-done)' : 'var(--text-tertiary)' }} />
            <span style={{ width: 130, flexShrink: 0 }}>{a.label}</span>
            <span className="muted mono" style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {a.installed ? a.binary : a.note}
            </span>
          </div>
        ))}
        <p className="muted" style={{ fontSize: 13, margin: '8px 0 2px' }}>
          开关、测试、改路径在<Link to="/local/settings">设置页</Link>。
        </p>
      </div>
    </>
  );
}
