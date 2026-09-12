import { useEffect, useState } from 'react';

import { api } from '../../api/client.ts';
import type { RuntimeIssue } from '../../components/DegradedBanner.tsx';

interface ConfigResponse {
  path?: string;
  config: {
    server: { name: string; port: number };
    agents: Record<string, { enabled: boolean; mode: string }>;
    workspaces: Array<{ id: string; name: string; path: string }>;
  };
  issues: RuntimeIssue[];
}

/**
 * M2 将把这页做全（Agent 开关/测试/改路径、工作区、服务、自启）。
 * M1 先用最小读写打通配置接口：改名 + Agent 开关热生效。
 */
export function LocalSettings(): React.ReactNode {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api.get<ConfigResponse>('/api/local/config').then(setConfig).catch(() => setConfig(null));
  }, []);

  const patch = async (body: Record<string, unknown>): Promise<void> => {
    try {
      const res = await api.patch<{ requiresRestart: boolean; restartKeys: string[] }>(
        '/api/local/config',
        body,
      );
      setMessage(
        res.requiresRestart
          ? `已保存，需重启后生效：${res.restartKeys.join(', ')}`
          : '已保存并即时生效',
      );
      setConfig(await api.get<ConfigResponse>('/api/local/config'));
    } catch (err) {
      setMessage(String(err));
    }
  };

  return (
    <>
      <h1>设置</h1>
      {config?.issues.some((i) => i.code === 'parse_error') && (
        <div className="banner-danger">
          配置文件有误，正在以默认配置运行。
          <button
            className="btn"
            style={{ marginLeft: 10 }}
            onClick={() => void api.post('/api/local/config/restore-backup')}
          >
            恢复备份
          </button>
        </div>
      )}
      {message && <p className="muted">{message}</p>}

      {config ? (
        <>
          <h2>服务</h2>
          <div className="card">
            <p style={{ margin: 0 }} className="mono">
              名称 {config.config.server.name} · 端口 {config.config.server.port}
              {config.path ? ` · ${config.path}` : ''}
            </p>
          </div>

          <h2>Agent 开关</h2>
          <div className="card">
            {Object.entries(config.config.agents).map(([id, setting]) => (
              <label key={id} style={{ display: 'block', fontSize: 14, padding: '2px 0' }}>
                <input
                  type="checkbox"
                  checked={setting.enabled}
                  onChange={(e) => void patch({ agents: { [id]: { ...setting, enabled: e.target.checked } } })}
                />{' '}
                <span className="mono">{id}</span>
                <span className="muted"> · {setting.mode}</span>
              </label>
            ))}
          </div>

          <h2>工作区</h2>
          <div className="card">
            {config.config.workspaces.map((w) => (
              <div key={w.id} className="mono" style={{ fontSize: 13 }}>
                {w.name} → {w.path}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">加载配置中…</p>
      )}
    </>
  );
}
