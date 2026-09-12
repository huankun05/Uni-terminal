import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { api, ApiError } from '../api/client.ts';

/**
 * 扫码落地页。二维码里是 `?id=<pairId>&c=<challenge>`——只是请求，不是凭据。
 * 认领后轮询状态，桌面端批准的那一刻拿到 httpOnly Cookie。
 */

interface PairView {
  status: string;
  expiresAt: number;
  serverName: string;
  serverFingerprint: string;
}

function toB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The pairing public key is registered for a future E2E upgrade; nothing is
 * encrypted with it today (server stores it opaquely).
 *
 * WebCrypto only exists in a secure context — HTTPS or localhost. The primary
 * v1 scenario is plain-HTTP LAN, where `crypto.subtle` is undefined on the
 * phone, so degrade to a random identifier there. Consequence, recorded in
 * 实施01 §6: devices paired over HTTP will need to re-register a real key
 * through their (by then authenticated) credential channel before E2E turns
 * on — a rotation endpoint, not a re-pairing.
 */
async function generatePublicKey(): Promise<string> {
  if (crypto.subtle) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    return toB64Url(new Uint8Array(spki));
  }

  // Insecure context: 48 random bytes → 64 base64url chars, same shape.
  const random = new Uint8Array(48);
  crypto.getRandomValues(random);
  return toB64Url(random);
}

/** `crypto.randomUUID` is secure-context-only too; never use it here. */
function clientNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toB64Url(bytes);
}

export function Pair(): React.ReactNode {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const challenge = params.get('c') ?? '';

  const [view, setView] = useState<PairView | null>(null);
  const [phase, setPhase] = useState<'loading' | 'claiming' | 'polling' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const pollToken = useRef<string>('');

  useEffect(() => {
    if (!id) {
      setPhase('error');
      setError('缺少配对参数，请在电脑端重新生成二维码');
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const info = await api.get<PairView>(`/api/pair/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setView(info);

        if (challenge && info.status === 'pending') {
          setPhase('claiming');
          const claim = await api.post<{ pollToken: string }>(`/api/pair/${encodeURIComponent(id)}/claim`, {
            challenge,
            publicKey: await generatePublicKey(),
            clientNonce: clientNonce(),
          });
          if (cancelled) return;
          pollToken.current = claim.pollToken;
          setPhase('polling');
        } else {
          setPhase('polling');
        }
      } catch (err) {
        if (cancelled) return;
        // Raw detail lands in the console (remote-inspectable); the user gets
        // something actionable instead of a TypeError.
        console.warn('[pair] claim failed:', err);
        setPhase('error');
        setError(
          err instanceof ApiError
            ? err.message
            : '配对请求失败，请刷新重试；若持续失败，请更换系统浏览器（Chrome/Safari）再试',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, challenge]);

  // Polling loop: starts once we have a poll token, honours Retry-After.
  useEffect(() => {
    if (phase !== 'polling') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/pair/${encodeURIComponent(id)}/status`, {
          headers: pollToken.current ? { 'x-poll-token': pollToken.current } : {},
          credentials: 'same-origin',
        });
        if (res.status === 401) {
          // Pairing gone; the desktop side will re-issue a code.
          if (!cancelled) {
            setPhase('error');
            setError('配对请求已失效，请在电脑端重新生成二维码');
          }
          return;
        }
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        const body = (await res.json()) as { status?: string };
        if (cancelled) return;
        if (body.status === 'approved') {
          setPhase('done');
          window.location.assign('/m');
          return;
        }
        timer = setTimeout(tick, Math.max(2, retryAfter) * 1000);
      } catch {
        timer = setTimeout(tick, 5000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, id]);

  const statusLine: Record<string, string> = {
    loading: '正在连接服务…',
    claiming: '正在登记本设备…',
    polling: '等待电脑端点击「允许」…',
    done: '已连接，正在进入控制台…',
  };

  // 没有 id/c 参数 = 直接输地址进来的。这不是错误场景，给出正确入口。
  if (!id) {
    return (
      <div className="layout" style={{ maxWidth: 460, paddingTop: '14vh' }}>
        <div className="card">
          <h1>需要从二维码进入</h1>
          <p style={{ color: 'var(--diff-del)' }}>本页缺少配对参数。</p>
          <p style={{ fontSize: 14 }}>
            正确的配对方式：在<b>电脑</b>上打开管理台
            <code className="mono"> http://127.0.0.1:{window.location.port}/local/pairing </code>
            → 点「添加设备」生成二维码 → 用本机<b>相机</b>扫码（不要用微信扫）。
          </p>
          <p className="muted" style={{ fontSize: 13 }}>
            二维码只在电脑端出现，因为它只是发起请求；真正的授权发生在电脑屏幕上的「允许」按钮。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="layout" style={{ maxWidth: 420, paddingTop: '18vh' }}>
      <div className="card">
        <h1>连接到 {view?.serverName ?? 'Uni-terminal'}</h1>
        {view && (
          <p className="muted mono" style={{ fontSize: 13 }}>
            服务指纹 {view.serverFingerprint}
          </p>
        )}
        {phase === 'error' ? (
          <p style={{ color: 'var(--diff-del)' }}>{error}</p>
        ) : (
          <p>
            <span className="status-dot" style={{ background: 'var(--state-waiting)' }} />
            {statusLine[phase] ?? '…'}
          </p>
        )}
        {phase === 'polling' && (
          <p className="muted" style={{ fontSize: 13 }}>
            请看向电脑屏幕：那里会显示本设备的浏览器与地址，点「允许」完成配对。
          </p>
        )}
      </div>
    </div>
  );
}
