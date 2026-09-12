import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api/client.ts';

/**
 * 配对台（M2 核心）。
 *
 * 安全模型再述：二维码只是 pairId + 30 秒轮换的 challenge，不是凭据；
 * 授权发生在本页的「允许」按钮上。被偷拍二维码的攻击者只会在你屏幕上
 * 触发一个陌生设备请求——UA/IP/指纹就摆在这张卡片上，点拒绝即可。
 */

interface PairingRequest {
  id: string;
  userCode: string;
  status: 'pending' | 'claimed' | 'approved' | 'denied';
  createdAt: number;
  expiresAt: number;
  requester?: {
    userAgent: string;
    ip: string;
    fingerprint: string;
    publicKey: string;
  };
}

const APPROVAL_POLL_MS = 2000;

function guessDeviceName(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Windows/i.test(ua)) return 'Windows 设备';
  if (/Macintosh/i.test(ua)) return 'Mac';
  return '新设备';
}

export function LocalPairing(): React.ReactNode {
  const [pairing, setPairing] = useState<PairingRequest | null>(null);
  const [qrUrl, setQrUrl] = useState<string>('');
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [rotateMs, setRotateMs] = useState(30_000);
  const [rotation, setRotation] = useState(0);
  const [message, setMessage] = useState('');
  const rotating = useRef(false);

  const loadQr = useCallback((id: string) => {
    // cache-buster: rotation reuses the same URL shape.
    setQrUrl(`/api/local/pairings/${encodeURIComponent(id)}/qr.svg?t=${Date.now()}`);
  }, []);

  const createPairing = useCallback(async (): Promise<void> => {
    const created = await api.post<{ id: string }>('/api/local/pairings');
    setPairing({ id: created.id, userCode: (created as unknown as { userCode?: string }).userCode ?? '', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 300_000 });
    setRotation((n) => n + 1);
    loadQr(created.id);
  }, [loadQr]);

  // 初次加载：读取配置中的轮换周期 + 复用尚未过期的配对码。
  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.get<{ config: { security: { pairingRotateMs: number } } }>('/api/local/config');
        setRotateMs(cfg.config.security.pairingRotateMs);
      } catch {
        // keep default
      }
      void api
        .get<{ pairings: PairingRequest[] }>('/api/local/pairings')
        .then(async (res) => {
          const usable = res.pairings.find((p) => p.status === 'pending' && p.expiresAt > Date.now());
          if (usable) {
            setPairing(usable);
            setRotation((n) => n + 1);
            loadQr(usable.id);
          } else {
            await createPairing();
          }
        })
        .catch(() => setMessage('无法创建配对码'));
    })();
  }, [createPairing, loadQr]);

  // 30 秒轮换：旧 challenge 立即作废，换上的才是有效的。
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      if (rotating.current) return;
      rotating.current = true;
      void api
        .post<{ challenge: string }>(`/api/local/pairings/${pairing.id}/rotate`)
        .then(() => {
          setRotation((n) => n + 1);
          loadQr(pairing.id);
        })
        .catch(() => setMessage('轮换失败，正在重试'))
        .finally(() => {
          rotating.current = false;
        });
    }, rotateMs);
    return () => clearInterval(timer);
  }, [pairing, rotateMs, loadQr]);

  // 待批准请求轮询：claimed 的才会出现在批准卡片里。
  useEffect(() => {
    const timer = setInterval(() => {
      void api
        .get<{ pairings: PairingRequest[] }>('/api/local/pairings')
        .then((res) => {
          setRequests(res.pairings.filter((p) => p.status === 'claimed'));
        })
        .catch(() => undefined);
    }, APPROVAL_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const approve = async (req: PairingRequest): Promise<void> => {
    await api.post(`/api/local/pairings/${req.id}/approve`, { name: guessDeviceName(req.requester?.userAgent ?? '') });
    setRequests((list) => list.filter((p) => p.id !== req.id));
    setMessage(`已允许 ${guessDeviceName(req.requester?.userAgent ?? '')} 接入`);
  };

  const deny = async (req: PairingRequest): Promise<void> => {
    await api.post(`/api/local/pairings/${req.id}/deny`);
    setRequests((list) => list.filter((p) => p.id !== req.id));
  };

  return (
    <>
      <h1>添加设备</h1>
      {message && <p className="muted">{message}</p>}

      {pairing && (
        <div className="card" style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', width: 180, height: 180, flexShrink: 0 }}>
            {qrUrl && (
              <img
                src={qrUrl}
                alt="配对二维码"
                width={180}
                height={180}
                style={{ borderRadius: 'var(--radius-sm)' }}
              />
            )}
            <CountdownRing rotateMs={rotateMs} rotation={rotation} size={188} />
          </div>
          <div style={{ minWidth: 200 }}>
            <p style={{ margin: '0 0 6px' }}>
              ① 用手机<b>相机</b>扫码（不要用微信扫）
            </p>
            <p className="muted" style={{ margin: '0 0 6px', fontSize: 13 }}>
              ② 手机打开页面登记自己 ③ 回到这里点「允许」
            </p>
            {pairing.userCode && (
              <p className="muted" style={{ fontSize: 13 }}>
                无法扫码？在手机浏览器打开 <code className="mono">{`${window.location.origin}/pair`}</code>，
                输入配对码 <strong className="mono" style={{ fontSize: 15, letterSpacing: 2 }}>{pairing.userCode}</strong>
              </p>
            )}
          </div>
        </div>
      )}

      <h2>待批准的接入请求（{requests.length}）</h2>
      {requests.length === 0 && <p className="muted" style={{ fontSize: 14 }}>手机扫码后，请求会出现在这里等你点「允许」。</p>}
      {requests.map((req) => (
        <div key={req.id} className="card" style={{ marginBottom: 10, borderColor: 'var(--state-waiting)' }}>
          <strong>{guessDeviceName(req.requester?.userAgent ?? '')}</strong>
          <span className="muted" style={{ fontSize: 13 }}> 来自 {req.requester?.ip}</span>
          <div className="mono muted" style={{ fontSize: 12, margin: '6px 0', wordBreak: 'break-all' }}>
            {req.requester?.userAgent} · 指纹 {req.requester?.fingerprint?.slice(0, 12)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void approve(req)}>允许</button>
            <button className="btn danger" onClick={() => void deny(req)}>拒绝</button>
          </div>
        </div>
      ))}
    </>
  );
}

/** 倒计时环：SVG 圆环随剩余时间收缩，rotation 变化时重置动画。 */
function CountdownRing({ rotateMs, rotation, size }: { rotateMs: number; rotation: number; size: number }): React.ReactNode {
  const r = 90;
  const c = 2 * Math.PI * r;
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setProgress(0);
    const start = Date.now();
    let raf = 0;
    const tick = (): void => {
      const p = Math.min(1, (Date.now() - start) / rotateMs);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rotateMs, rotation]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      style={{ position: 'absolute', inset: -4, pointerEvents: 'none' }}
    >
      <circle cx="100" cy="100" r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="3" />
      <circle
        cx="100"
        cy="100"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * progress}
        transform="rotate(-90 100 100)"
      />
    </svg>
  );
}
