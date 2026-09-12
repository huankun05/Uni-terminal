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

/** 设备管理（M2）：列表 / 改名 / 吊销即断连。 */
export function LocalDevices(): React.ReactNode {
  const [devices, setDevices] = useState<Device[]>([]);
  const [message, setMessage] = useState('');

  const reload = (): void => {
    void api
      .get<{ devices: Device[] }>('/api/local/devices')
      .then((res) => setDevices(res.devices))
      .catch(() => setMessage('无法加载设备列表'));
  };

  useEffect(reload, []);

  const rename = async (d: Device): Promise<void> => {
    const name = window.prompt('新的设备名', d.name);
    if (!name || name === d.name) return;
    await api.patch(`/api/local/devices/${d.id}`, { name });
    reload();
  };

  const revoke = async (d: Device): Promise<void> => {
    if (!window.confirm(`吊销「${d.name}」？该设备的在线连接会立即断开，且无法再访问。`)) return;
    const res = await api.post<{ connectionsClosed: number }>(`/api/local/devices/${d.id}/revoke`);
    setMessage(`已吊销 ${d.name}，断开 ${res.connectionsClosed} 条在线连接`);
    reload();
  };

  return (
    <>
      <h1>已配对设备（{devices.length}）</h1>
      {message && <p className="muted">{message}</p>}
      {devices.map((d) => (
        <div key={d.id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <strong style={{ flex: 1 }}>{d.name}</strong>
            <button className="btn" onClick={() => void rename(d)}>改名</button>
            <button className="btn danger" onClick={() => void revoke(d)}>吊销</button>
          </div>
          <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
            指纹 {d.fingerprint} · 最近活跃 {formatTime(d.lastSeenAt)} · 凭据至 {formatTime(d.expiresAt)}
            {d.userAgent ? ` · ${d.userAgent}` : ''}
          </div>
        </div>
      ))}
      {devices.length === 0 && <p className="muted">还没有设备。到「配对」页生成二维码。</p>}
    </>
  );
}
