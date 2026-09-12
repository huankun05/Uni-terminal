import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { api, ApiError } from '../../api/client.ts';
import { onInstallAvailability, promptInstall } from '../../pwa.ts';
import { detectUa } from '../../lib/ua.ts';
import { SecureContextGuide } from '../../components/SecureContextGuide.tsx';

/** 手机端设置：安装到主屏 / 连接信息 / 本设备 / 退出登录。 */
export function MSettings(): React.ReactNode {
  const [me, setMe] = useState<{ device?: { name?: string }; server?: { name?: string; fingerprint?: string } } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [canInstall, setCanInstall] = useState(false);
  const ua = detectUa();

  useEffect(() => {
    void api
      .get<{ device: { name: string }; server: { name: string; fingerprint: string } }>('/api/me')
      .then(setMe)
      .catch((err: unknown) => {
        // client.ts 已把 401 引去配对页；这里兜住其余错误。
        if (!(err instanceof ApiError && err.status === 401)) setError(String(err));
      });
    return onInstallAvailability(setCanInstall);
  }, []);

  const standalone = ua.standalone;

  return (
    <div className="layout" style={{ maxWidth: 560 }}>
      <h1>设置</h1>
      {error && <p style={{ color: 'var(--diff-del)' }}>{error}</p>}

      <h2>安装</h2>
      <div className="card" style={{ fontSize: 14 }}>
        {standalone ? (
          <p style={{ margin: 0 }}>
            <span className="status-dot" style={{ background: 'var(--state-done)' }} />
            已作为应用安装
          </p>
        ) : canInstall ? (
          <button className="btn primary" onClick={() => void promptInstall()}>
            📲 安装到主屏幕
          </button>
        ) : ua.isIOS ? (
          <p style={{ margin: 0 }} className="muted">
            iPhone 上请用 Safari 的「分享 → 添加到主屏幕」
            （<Link to="/install">图文引导</Link>）。安装后离线也能打开外壳，且登录态更稳。
          </p>
        ) : (
          <p style={{ margin: 0 }} className="muted">
            用 Chrome 等浏览器打开本页地址栏会出现「安装」图标
            （<Link to="/install">说明</Link>）。
          </p>
        )}
      </div>

      {!standalone && !window.isSecureContext && (
        <>
          <h2>解锁更多功能（在家使用时）</h2>
          <SecureContextGuide />
        </>
      )}

      <h2>连接</h2>
      <div className="card">
        <p style={{ margin: 0 }}>
          本机：<strong>{me?.server?.name ?? '…'}</strong>
        </p>
        <p className="muted mono" style={{ fontSize: 13, margin: '4px 0 0' }}>
          指纹 {me?.server?.fingerprint ?? '…'} · 本设备 {me?.device?.name ?? '…'}
        </p>
      </div>

      <h2>设备</h2>
      <button
        className="btn danger"
        onClick={() => {
          void api.post('/api/auth/logout').then(() => window.location.assign('/pair'));
        }}
      >
        退出登录（清除本设备凭据，需重新配对）
      </button>
    </div>
  );
}
