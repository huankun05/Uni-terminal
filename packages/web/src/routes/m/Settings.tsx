import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { api, ApiError } from '../../api/client.ts';

/** 手机端设置（M3 精化）：连接信息 / 本设备 / 退出登录。 */
export function MSettings(): React.ReactNode {
  const [me, setMe] = useState<{ device?: { name?: string }; server?: { name?: string; fingerprint?: string } } | null>(
    null,
  );
  const [error, setError] = useState('');

  useEffect(() => {
    void api
      .get<{ device: { name: string }; server: { name: string; fingerprint: string } }>('/api/me')
      .then(setMe)
      .catch((err: unknown) => {
        // client.ts 已把 401 引去配对页；这里兜住其余错误。
        if (!(err instanceof ApiError && err.status === 401)) setError(String(err));
      });
  }, []);

  return (
    <div className="layout" style={{ maxWidth: 560 }}>
      <h1>设置</h1>
      {error && <p style={{ color: 'var(--diff-del)' }}>{error}</p>}
      <div className="card">
        <p style={{ margin: 0 }}>
          本机：<strong>{me?.server?.name ?? '…'}</strong>
        </p>
        <p className="muted mono" style={{ fontSize: 13, margin: '4px 0 0' }}>
          指纹 {me?.server?.fingerprint ?? '…'} · 本设备 {me?.device?.name ?? '…'}
        </p>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
        安装到主屏幕可获得更好的体验（<Link to="/install">安装引导</Link>）。
      </p>
      <button
        className="btn"
        onClick={() => {
          void api.post('/api/auth/logout').then(() => window.location.assign('/pair'));
        }}
      >
        退出登录（清除本设备凭据）
      </button>
    </div>
  );
}
