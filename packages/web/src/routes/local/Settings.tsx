import { useEffect, useState } from 'react';

import { api } from '../../api/client.ts';
import type { RuntimeIssue } from '../../components/DegradedBanner.tsx';
import { DirPicker } from '../../components/DirPicker.tsx';

interface ConfigResponse {
  path?: string;
  config: {
    server: { name: string; port: number; host: string };
    agents: Record<string, { enabled: boolean; mode: string; command?: string }>;
    workspaces: Array<{ id: string; name: string; path: string }>;
    security: { pairingRotateMs: number };
  };
  issues: RuntimeIssue[];
}

interface AgentAvailability {
  id: string;
  label: string;
  installed: boolean;
  binary?: string;
  note?: string;
}

interface ServiceInfo {
  port: number;
  configuredPort: number;
  uptimeMs: number;
  platform: string;
  autostart: { registered: boolean; task: string } | null;
}

interface TransportInfo {
  mode: string;
  ready: boolean;
  hint?: string;
  endpoints: Array<{ url: string; label: string; warning?: string }>;
}

/**
 * 设置页（M2 验收：全程不打开 JSON 就能配好 Agent 与工作区）。
 * 热生效项保存即生效；改端口由服务端标记 requiresRestart。
 */
export function LocalSettings(): React.ReactNode {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [scan, setScan] = useState<AgentAvailability[] | null>(null);
  const [service, setService] = useState<ServiceInfo | null>(null);
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState<string>('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newWorkspacePath, setNewWorkspacePath] = useState('');
  const [tunnel, setTunnel] = useState<TransportInfo | null>(null);
  const [tsStatus, setTsStatus] = useState<TransportInfo | null>(null);
  const [tsDetail, setTsDetail] = useState('');
  const [tsBusy, setTsBusy] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [customBinary, setCustomBinary] = useState('');

  const reloadConfig = (): void => {
    void api.get<ConfigResponse>('/api/local/config').then(setConfig).catch(() => setConfig(null));
  };

  useEffect(() => {
    reloadConfig();
    void api.get<ServiceInfo>('/api/local/service').then(setService).catch(() => undefined);
    void refreshTunnel();
  }, []);

  const refreshTunnel = (): void => {
    void api
      .get<{ all: TransportInfo[] }>('/api/local/transport')
      .then((res) => {
        setTunnel(res.all.find((t) => t.mode === 'cloudflare') ?? null);
        setTsStatus(res.all.find((t) => t.mode === 'tailscale') ?? null);
      })
      .catch(() => undefined);
  };

  const tailscaleAction = async (action: 'detect' | 'serve' | 'off'): Promise<void> => {
    setTsBusy(true);
    setTsDetail('');
    try {
      const res = await api.post<{ tailscale: TransportInfo }>('/api/local/transport/tailscale', { action });
      setTsStatus(res.tailscale);
      if (action === 'serve') setMessage('Tailscale HTTPS 已启用，二维码指向 ts.net 固定地址');
      if (action === 'off') setMessage('Tailscale 发布已关闭，回到局域网模式');
    } catch (err) {
      setTsDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setTsBusy(false);
      refreshTunnel();
    }
  };

  const tunnelAction = async (action: 'start' | 'stop' | 'download', binaryPath?: string): Promise<void> => {
    setTunnelBusy(true);
    try {
      await api.post('/api/local/transport/cloudflare', { action, binaryPath });
      setMessage(
        action === 'start' ? '隧道已建立，二维码现在指向 HTTPS 外网地址'
          : action === 'stop' ? '隧道已停止，回到局域网模式'
            : 'cloudflared 下载完成，可以启动隧道了',
      );
    } catch (err) {
      setMessage(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTunnelBusy(false);
      refreshTunnel();
    }
  };

  const patch = async (body: Record<string, unknown>, note = '已保存'): Promise<void> => {
    try {
      const res = await api.patch<{ requiresRestart: boolean; restartKeys: string[] }>('/api/local/config', body);
      setMessage(res.requiresRestart ? `${note}；需重启后生效：${res.restartKeys.join(', ')}` : `${note}，已即时生效`);
      reloadConfig();
    } catch (err) {
      setMessage(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const testAgent = async (id: string): Promise<void> => {
    setTesting(id);
    try {
      const res = await api.post<{ ok: boolean; exitCode: number | null; output: string; binary: string }>(
        `/api/local/agents/${id}/test`,
      );
      setMessage(
        res.ok
          ? `${id} 可用（${res.binary}）：${res.output.trim().split('\n')[0]?.slice(0, 60)}`
          : `${id} 退出码 ${res.exitCode}，请检查命令或路径`,
      );
    } catch (err) {
      setMessage(`${id} 测试失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting('');
    }
  };

  const rescan = async (): Promise<void> => {
    const res = await api.post<{ agents: AgentAvailability[] }>('/api/local/agents/rescan');
    setScan(res.agents);
    setMessage(`扫描完成：发现 ${res.agents.filter((a) => a.installed).length} 个已安装的工具`);
  };

  const enableAgent = async (id: string): Promise<void> => {
    await patch({ agents: { [id]: { enabled: true, mode: 'pty' } } }, `已启用 ${id}`);
    setScan((s) => (s ? s.filter((a) => a.id !== id) : s));
  };

  const addWorkspace = async (): Promise<void> => {
    if (!newWorkspacePath.trim()) return;
    const path = newWorkspacePath.trim();
    let hasGit = false;
    try {
      const listing = await api.post<{ entries: Array<{ name: string }> }>('/api/local/fs/list', { path });
      hasGit = listing.entries.some((e) => e.name === '.git');
    } catch {
      setMessage('目录不可读，已按原样添加');
    }
    const ws = { id: `ws-${Date.now()}`, name: path.split(/[\\/]/).pop() || path, path };
    await patch({ workspaces: [...(config?.config.workspaces ?? []), ws] }, `已添加工作区${hasGit ? '（识别为 git 仓库）' : ''}`);
    setNewWorkspacePath('');
  };

  const removeWorkspace = async (id: string): Promise<void> => {
    await patch({ workspaces: (config?.config.workspaces ?? []).filter((w) => w.id !== id) }, '已移除工作区');
  };

  const toggleAutostart = async (): Promise<void> => {
    const enable = !(service?.autostart?.registered ?? false);
    const res = await api.post<{ ok: boolean; message?: string; autostart: ServiceInfo['autostart'] }>(
      '/api/local/service/autostart',
      { enable },
    );
    if (res.ok) {
      setService((s) => (s ? { ...s, autostart: res.autostart } : s));
      setMessage(enable ? '已注册开机自启' : '已移除开机自启');
    } else {
      setMessage(`操作失败：${res.message}`);
    }
  };

  const catalogIds = new Set(Object.keys(config?.config.agents ?? {}));

  return (
    <>
      <h1>设置</h1>
      {config?.issues.some((i) => i.code === 'parse_error') && (
        <div className="banner-danger">
          配置文件有误，正在以默认配置运行。
          <button
            className="btn"
            style={{ marginLeft: 10 }}
            onClick={() => {
              void api.post('/api/local/config/restore-backup').then(reloadConfig);
            }}
          >
            恢复备份
          </button>
        </div>
      )}
      {message && <p className="muted">{message}</p>}

      <h2>AI 编程工具</h2>
      <div className="card">
        <button className="btn" onClick={() => void rescan()}>重新扫描环境</button>
        {scan && scan.filter((a) => a.installed && !catalogIds.has(a.id)).length > 0 && (
          <p className="muted" style={{ fontSize: 13 }}>
            新发现：
            {scan
              .filter((a) => a.installed && !catalogIds.has(a.id))
              .map((a) => (
                <button key={a.id} className="btn" style={{ margin: '2px 4px' }} onClick={() => void enableAgent(a.id)}>
                  启用 {a.id}
                </button>
              ))}
          </p>
        )}
        {config &&
          Object.entries(config.config.agents).map(([id, setting]) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <label style={{ flex: 1, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={setting.enabled}
                  onChange={(e) => void patch({ agents: { [id]: { ...setting, enabled: e.target.checked } } }, `已${e.target.checked ? '启用' : '停用'} ${id}`)}
                />{' '}
                <span className="mono">{id}</span>
                <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>{setting.command ?? ''}</span>
              </label>
              <button className="btn" disabled={testing === id} onClick={() => void testAgent(id)}>
                {testing === id ? '测试中…' : '测试'}
              </button>
            </div>
          ))}
      </div>

      <h2>工作区</h2>
      <div className="card">
        {(config?.config.workspaces ?? []).map((w) => (
          <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
            <span style={{ flex: 1, fontSize: 13 }} className="mono">
              <strong>{w.name}</strong> → {w.path}
            </span>
            <button className="btn danger" onClick={() => void removeWorkspace(w.id)}>移除</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={newWorkspacePath}
            onChange={(e) => setNewWorkspacePath(e.target.value)}
            placeholder="粘贴目录路径，或点「浏览」…"
            className="mono"
            style={{ flex: 1, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13 }}
          />
          <button className="btn" onClick={() => setPickerOpen(true)}>浏览</button>
          <button className="btn primary" onClick={() => void addWorkspace()}>添加</button>
        </div>
      </div>

      <h2>组网访问（Tailscale · HTTPS · 固定地址）</h2>
      <div className="card" style={{ fontSize: 14 }}>
        {tsStatus?.ready ? (
          <>
            <p style={{ margin: '0 0 6px' }}>
              <span className="status-dot" style={{ background: 'var(--state-done)' }} />
              已发布 —— 手机（同一 Tailscale 账号）通过以下固定地址访问（HTTPS）：
            </p>
            {tsStatus.endpoints.filter((e) => e.url.startsWith('https://')).map((e) => (
              <p key={e.url} className="mono" style={{ margin: 0, fontSize: 13, color: 'var(--accent)' }}>{e.url}</p>
            ))}
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
              地址永久不变。手机需安装 Tailscale 并登录同一账号、开关打开。
            </p>
            <button className="btn danger" disabled={tsBusy} onClick={() => void tailscaleAction('off')}>
              关闭发布
            </button>
          </>
        ) : (
          <>
            <p style={{ margin: '0 0 8px' }}>
              <span className="status-dot" style={{ background: 'var(--state-waiting)' }} />
              {tsStatus?.hint ?? '点「检测状态」读取本机 Tailscale 的安装与登录情况'}
            </p>
            <ol className="muted" style={{ fontSize: 12.5, margin: '0 0 10px', paddingLeft: 18, lineHeight: 1.9 }}>
              <li>电脑安装并登录 Tailscale（<a href="https://tailscale.com/download" target="_blank" rel="noreferrer">下载</a>，登录需梯子，一次即可）</li>
              <li>管理员在 <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">login.tailscale.com/admin/dns</a> 开启 MagicDNS 与 HTTPS 证书（整个网络一次即可）</li>
              <li>手机安装 Tailscale、登录同一账号并打开开关（首次登录手机也需要梯子）</li>
              <li>回这里点「检测状态」→「启用 HTTPS 发布」，然后用显示的 ts.net 地址在手机打开本页</li>
            </ol>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={tsBusy} onClick={() => void tailscaleAction('detect')}>
                {tsBusy ? '处理中…' : '检测状态'}
              </button>
              <button className="btn" disabled={tsBusy} onClick={() => void tailscaleAction('serve')}>
                启用 HTTPS 发布
              </button>
            </div>
            {tsDetail && <p style={{ color: 'var(--state-waiting)', fontSize: 13, marginTop: 8 }}>{tsDetail}</p>}
          </>
        )}
      </div>

      <h2>外网访问（HTTPS）</h2>
      <div className="card" style={{ fontSize: 14 }}>
        {tunnel?.ready ? (
          <>
            <p style={{ margin: '0 0 6px' }}>
              <span className="status-dot" style={{ background: 'var(--state-done)' }} />
              隧道运行中 —— 手机可通过以下地址从任何网络访问（HTTPS）：
            </p>
            {tunnel.endpoints.filter((e) => e.url.startsWith('https://')).map((e) => (
              <p key={e.url} className="mono" style={{ margin: 0, fontSize: 13, color: 'var(--accent)' }}>{e.url}</p>
            ))}
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
              {tunnel.endpoints.find((e) => e.warning)?.warning}
            </p>
            <button className="btn danger" disabled={tunnelBusy} onClick={() => void tunnelAction('stop')}>
              停止隧道
            </button>
          </>
        ) : (
          <>
            <p style={{ margin: '0 0 6px' }}>
              <span className="status-dot" style={{ background: 'var(--state-waiting)' }} />
              未启用 —— {tunnel?.hint ?? '启动后获得一个 HTTPS 外网地址，二维码自动指向它'}
            </p>
            <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
              快速隧道免费、免域名、免配置；地址随机且重启会变（长期固定地址需注册命名隧道）。
              流量经 Cloudflare 中转。
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn primary" disabled={tunnelBusy} onClick={() => void tunnelAction('start')}>
                {tunnelBusy ? '处理中…' : '启动快速隧道'}
              </button>
              <button className="btn" disabled={tunnelBusy} onClick={() => void tunnelAction('download')}>
                下载 cloudflared
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input
                value={customBinary}
                onChange={(e) => setCustomBinary(e.target.value)}
                placeholder="cloudflared 路径（自动下载失败时手动粘贴，如 D:\\tools\\cloudflared.exe）"
                className="mono"
                style={{ flex: 1, fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '6px 8px' }}
              />
              <button className="btn" disabled={tunnelBusy || !customBinary.trim()} onClick={() => void tunnelAction('start', customBinary.trim())}>
                用此路径启动
              </button>
            </div>
          </>
        )}
      </div>

      <h2>服务</h2>
      <div className="card">
        {service ? (
          <>
            <p style={{ margin: 0, fontSize: 14 }}>
              实际端口 <strong className="mono">{service.port}</strong>
              {service.port !== service.configuredPort && (
                <span className="muted">（配置的 {service.configuredPort} 被占用，已顺延）</span>
              )}
              · 已运行 {Math.round(service.uptimeMs / 1000)}s · {service.platform}
            </p>
            {service.autostart ? (
              <p style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                开机自启：{service.autostart.registered ? '✅ 已注册' : '○ 未注册'}
                <button className="btn" onClick={() => void toggleAutostart()}>
                  {service.autostart.registered ? '移除自启' : '一键注册'}
                </button>
              </p>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>（当前平台不支持自启管理）</p>
            )}
          </>
        ) : (
          <p className="muted">加载中…</p>
        )}
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          改端口需重启服务；Agent 开关与工作区保存即生效。
        </p>
      </div>

      {pickerOpen && (
        <DirPicker
          title="选择工作区目录"
          initialPath={newWorkspacePath || undefined}
          onPick={(path) => {
            setNewWorkspacePath(path);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
