import { useEffect, useState } from 'react';

import { api } from '../../api/client.ts';
import { formatTime } from '../../lib/format.ts';

interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  fingerprint: string;
  userAgent?: string;
}

/**
 * 设备管理（M2）：列表 / 改名 / 吊销即断连。
 *
 * 故意不用 window.confirm / window.prompt：嵌入式浏览器（以及部分 App 内
 * WebView）会静默拦截它们——按钮看起来"点了没反应"。确认与改名都做成
 * 卡片内联状态，任何环境都可用。
 */
export function LocalDevices(): React.ReactNode {
  const [devices, setDevices] = useState<Device[]>([]);
  const [message, setMessage] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = (): void => {
    void api
      .get<{ devices: Device[] }>('/api/local/devices')
      .then((res) => setDevices(res.devices))
      .catch(() => setMessage('无法加载设备列表'));
  };

  useEffect(reload, []);

  const saveRename = async (): Promise<void> => {
    if (!renaming || !renaming.value.trim()) { setRenaming(null); return; }
    setBusyId(renaming.id);
    try {
      await api.patch(`/api/local/devices/${renaming.id}`, { name: renaming.value.trim() });
      setMessage('已改名');
      setRenaming(null);
      reload();
    } catch (err) {
      setMessage(`改名失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (d: Device): Promise<void> => {
    setBusyId(d.id);
    try {
      const res = await api.post<{ connectionsClosed: number }>(`/api/local/devices/${d.id}/revoke`);
      setMessage(`已吊销「${d.name}」，断开 ${res.connectionsClosed} 条在线连接，该设备需要重新配对才能访问`);
      setConfirmingId(null);
      reload();
    } catch (err) {
      setMessage(`吊销失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <h1>已配对设备（{devices.length}）</h1>
      {message && <p className="muted" style={{ color: 'var(--state-done)' }}>{message}</p>}
      {devices.map((d) => (
        <div key={d.id} className="card" style={{ marginBottom: 10, ...(confirmingId === d.id ? { borderColor: 'var(--diff-del)' } : {}) }}>
          {renaming?.id === d.id ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ id: d.id, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setRenaming(null); }}
                maxLength={64}
                style={{ flex: 1, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '6px 10px', fontSize: 14 }}
              />
              <button className="btn primary" disabled={busyId === d.id} onClick={() => void saveRename()}>保存</button>
              <button className="btn" onClick={() => setRenaming(null)}>取消</button>
            </div>
          ) : confirmingId === d.id ? (
            <div>
              <p style={{ margin: '0 0 8px', color: 'var(--diff-del)', fontSize: 14 }}>
                确认吊销「{d.name}」？它的在线连接会立即断开，且需要重新配对才能再访问。
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn danger" disabled={busyId === d.id} onClick={() => void revoke(d)}>
                  {busyId === d.id ? '吊销中…' : '确认吊销'}
                </button>
                <button className="btn" onClick={() => setConfirmingId(null)}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <strong style={{ flex: 1 }}>{d.name}</strong>
                <button className="btn" onClick={() => setRenaming({ id: d.id, value: d.name })}>改名</button>
                <button className="btn danger" onClick={() => setConfirmingId(d.id)}>吊销</button>
              </div>
              <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
                指纹 {d.fingerprint} · 最近活跃 {formatTime(d.lastSeenAt)} · 凭据至 {formatTime(d.expiresAt)}
                {d.userAgent ? ` · ${d.userAgent}` : ''}
              </div>
            </>
          )}
        </div>
      ))}
      {devices.length === 0 && <p className="muted">还没有设备。到「配对」页生成二维码。</p>}
    </>
  );
}
