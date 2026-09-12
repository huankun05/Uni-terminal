import { useEffect, useState } from 'react';

import { api } from '../../api/client.ts';
import { DegradedBanner, type RuntimeIssue } from '../../components/DegradedBanner.tsx';
import { formatDuration } from '../../lib/format.ts';

interface Bootstrap {
  server: { name: string; fingerprint: string };
  runtime: { port: number; configPath?: string; issues: RuntimeIssue[] };
  transport: {
    active: { mode: string; endpoints: Array<{ url: string; label: string }>; hint?: string };
    all: Array<{ mode: string; ready: boolean; hint?: string }>;
  };
  pty: { available?: boolean; error?: string };
  startedAt: number;
  secureCookies: boolean;
}

/** 诊断页（M2 §2.7）：与终端横幅同一数据源，两边必须一致。 */
export function LocalDiagnostics(): React.ReactNode {
  const [data, setData] = useState<Bootstrap | null>(null);

  useEffect(() => {
    void api.get<Bootstrap>('/api/local/bootstrap').then(setData).catch(() => setData(null));
  }, []);

  if (!data) return <p className="muted">加载中…</p>;

  return (
    <>
      <h1>诊断</h1>
      <DegradedBanner issues={data.runtime.issues} />

      <h2>服务</h2>
      <div className="card" style={{ fontSize: 14 }}>
        <p style={{ margin: 0 }}>
          名称 {data.server.name} · 指纹 <span className="mono">{data.server.fingerprint}</span>
        </p>
        <p className="muted" style={{ margin: 0 }}>
          实际端口 {data.runtime.port}
          {data.runtime.configPath ? ` · 配置 ${data.runtime.configPath}` : ''}
          {' '}· 运行 {formatDuration(Date.now() - data.startedAt)}
          {' '}· Cookie {data.secureCookies ? '强制 Secure' : '按连接判定（HTTP 下为明文）'}
        </p>
      </div>

      <h2>PTY 终端</h2>
      <div className="card" style={{ fontSize: 14 }}>
        {data.pty.available === false ? (
          <>
            <span style={{ color: 'var(--diff-del)' }}>不可用</span>
            <span className="muted"> —— {data.pty.error}，将以管道模式运行（无法交互输入）</span>
          </>
        ) : (
          <span>
            <span className="status-dot" style={{ background: 'var(--state-done)' }} />
            正常（交互式终端可用）
          </span>
        )}
      </div>

      <h2>传输 · {data.transport.active.mode}</h2>
      <div className="card" style={{ fontSize: 14 }}>
        {data.transport.active.endpoints.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>{data.transport.active.hint}</p>
        )}
        {data.transport.active.endpoints.map((e) => (
          <p key={e.url} className="mono" style={{ margin: 0, fontSize: 13 }}>
            {e.label}: {e.url}
          </p>
        ))}
      </div>

      <h2>其他传输方式</h2>
      <div className="card" style={{ fontSize: 13 }}>
        {data.transport.all
          .filter((t) => t.mode !== data.transport.active.mode)
          .map((t) => (
            <p key={t.mode} className="muted" style={{ margin: '2px 0' }}>
              <span className="mono">{t.mode}</span> — {t.ready ? '可用' : t.hint}
            </p>
          ))}
      </div>
    </>
  );
}
