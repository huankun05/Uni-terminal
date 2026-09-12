import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router';

import { api } from '../../api/client.ts';
import { DegradedBanner, type RuntimeIssue } from '../../components/DegradedBanner.tsx';

interface Bootstrap {
  server: { name: string; port: number; fingerprint: string };
  runtime: { port: number; configPath?: string; issues: RuntimeIssue[] };
  agents: Array<{ id: string; label: string; installed: boolean; binary?: string; note?: string }>;
  devices: Array<{ id: string; name: string; lastSeenAt: number }>;
  sessions: Array<{ id: string; agent: string; status: string; live: boolean }>;
  pty: { available?: boolean; error?: string };
}

function useBootstrap(): Bootstrap | undefined {
  const [data, setData] = useState<Bootstrap>();
  useEffect(() => {
    void api.get<Bootstrap>('/api/local/bootstrap').then(setData).catch(() => setData(undefined));
  }, []);
  return data;
}

export function LocalLayout(): React.ReactNode {
  return (
    <div className="layout">
      <nav className="muted" style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 14 }}>
        <Link to="/local" style={{ color: 'inherit' }}>总览</Link>
        <Link to="/local/pairing" style={{ color: 'inherit' }}>配对</Link>
        <Link to="/local/devices" style={{ color: 'inherit' }}>设备</Link>
        <Link to="/local/settings" style={{ color: 'inherit' }}>设置</Link>
        <Link to="/local/diagnostics" style={{ color: 'inherit' }}>诊断</Link>
      </nav>
      <Outlet />
    </div>
  );
}

export function LocalDashboard(): React.ReactNode {
  const data = useBootstrap();

  if (!data) return <p className="muted">正在加载管理台…（若一直无响应，请确认从 127.0.0.1 访问）</p>;

  const installed = data.agents.filter((a) => a.installed);
  return (
    <>
      <DegradedBanner issues={data.runtime.issues} />
      <h1>{data.server.name}</h1>
      <p className="muted mono" style={{ fontSize: 13 }}>
        指纹 {data.server.fingerprint} · 实际端口 {data.runtime.port}
        {data.runtime.configPath ? ` · 配置 ${data.runtime.configPath}` : ''}
      </p>

      <h2>Agent（{installed.length} 可用 / {data.agents.length} 目录）</h2>
      <div className="card">
        {data.agents.map((a) => (
          <div key={a.id} style={{ padding: '2px 0', fontSize: 14 }}>
            <span
              className="status-dot"
              style={{ background: a.installed ? 'var(--state-done)' : 'var(--text-tertiary)' }}
            />
            {a.label}
            <span className="muted" style={{ marginLeft: 8 }}>
              {a.installed ? a.binary : a.note}
            </span>
          </div>
        ))}
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          开关、改路径、测试等完整配置在<Link to="/local/settings">设置页</Link>（M2 完善）。
        </p>
      </div>

      <h2>已配对设备（{data.devices.length}）</h2>
      <div className="card">
        {data.devices.length === 0 && <span className="muted">还没有设备配对。M2 将提供二维码配对界面。</span>}
        {data.devices.map((d) => (
          <div key={d.id} style={{ fontSize: 14 }}>
            {d.name} <span className="muted">最近活跃 {new Date(d.lastSeenAt).toLocaleString()}</span>
          </div>
        ))}
      </div>

      <h2>会话（{data.sessions.length}）</h2>
      <div className="card">
        {data.sessions.length === 0 && <span className="muted">暂无会话</span>}
        {data.sessions.map((s) => (
          <div key={s.id} style={{ fontSize: 14 }}>
            <span className="mono">{s.id.slice(0, 8)}</span> · {s.agent} · {s.status}
            {s.live && ' · 运行中'}
          </div>
        ))}
      </div>

      {data.pty.available === false && (
        <>
          <h2>PTY</h2>
          <div className="banner-danger">未加载 PTY，将以管道模式运行：{data.pty.error}</div>
        </>
      )}
    </>
  );
}
