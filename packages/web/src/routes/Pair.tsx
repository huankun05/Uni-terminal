import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { api, ApiError } from '../api/client.ts';

/**
 * 扫码落地页。二维码里是 `?id=<pairId>&c=<challenge>`——只是请求，不是凭据。
 * 认领后轮询状态，桌面端批准的那一刻拿到 httpOnly Cookie。
 *
 * 没有参数进来（用户直接输地址）时给两条路：
 *  ① 输入电脑端显示的 8 位配对码（明文 HTTP 下始终可用）
 *  ② 页面内扫码（getUserMedia 需要安全上下文——HTTP 局域网上不可用，
 *     此时如实说明并引导走 ① 或系统相机）
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
  const urlId = params.get('id') ?? '';
  const urlChallenge = params.get('c') ?? '';

  const [view, setView] = useState<PairView | null>(null);
  const [phase, setPhase] = useState<'loading' | 'claiming' | 'polling' | 'done' | 'error' | 'entry'>('loading');
  const [error, setError] = useState('');
  const pollToken = useRef<string>('');

  // 手动配对码路径
  const [code, setCode] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<{ id: string; challenge: string } | null>(null);

  const id = urlId || resolved?.id || '';
  const challenge = urlId ? urlChallenge : (resolved?.challenge ?? '');

  const submitCode = async (): Promise<void> => {
    setResolving(true);
    setCodeError('');
    try {
      const res = await api.post<{ id: string; challenge: string }>('/api/pair/by-code', {
        code: code.trim().toUpperCase(),
      });
      setResolved(res);
    } catch (err) {
      setCodeError(err instanceof ApiError ? err.message : '兑换失败，请重试');
    } finally {
      setResolving(false);
    }
  };
  const [codeError, setCodeError] = useState('');

  useEffect(() => {
    if (!id) {
      setPhase('entry');
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

  if (phase === 'entry') {
    return (
      <Entry
        code={code}
        setCode={setCode}
        codeError={codeError}
        resolving={resolving}
        submitCode={() => void submitCode()}
      />
    );
  }

  const statusLine: Record<string, string> = {
    loading: '正在连接服务…',
    claiming: '正在登记本设备…',
    polling: '等待电脑端点击「允许」…',
    done: '已连接，正在进入控制台…',
  };

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
          <>
            <p style={{ color: 'var(--diff-del)' }}>{error}</p>
            <button className="btn" onClick={() => { setPhase('entry'); setResolved(null); setError(''); }}>
              返回重新输入
            </button>
          </>
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

function Entry(props: {
  code: string;
  setCode: (v: string) => void;
  codeError: string;
  resolving: boolean;
  submitCode: () => void;
}): React.ReactNode {
  const cameraAvailable = Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');

  const onScanResult = (payload: string): void => {
    try {
      const url = new URL(payload);
      const id = url.searchParams.get('id');
      const c = url.searchParams.get('c');
      if (!id || !c) throw new Error('bad payload');
      // 交给路由参数走同一条认领链路。
      window.location.assign(`/pair?id=${encodeURIComponent(id)}&c=${encodeURIComponent(c)}`);
    } catch {
      setScanError('识别到的不是本服务的配对码');
    }
  };

  return (
    <div className="layout" style={{ maxWidth: 420, paddingTop: '10vh' }}>
      <div className="card">
        <h1>连接到 Uni-terminal</h1>
        <p className="muted" style={{ fontSize: 13 }}>两种方式，任选其一：</p>

        <h2 style={{ marginTop: 14 }}>方式一 · 输入配对码</h2>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
          电脑端「配对」页二维码下方显示 8 位配对码。
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={props.code}
            onChange={(e) => props.setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8))}
            onKeyDown={(e) => { if (e.key === 'Enter') props.submitCode(); }}
            placeholder="8 位配对码"
            className="mono"
            style={{
              flex: 1,
              textAlign: 'center',
              fontSize: 20,
              letterSpacing: 6,
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              padding: '10px 8px',
            }}
          />
          <button className="btn primary" disabled={props.resolving || props.code.length !== 8} onClick={props.submitCode}>
            {props.resolving ? '…' : '连接'}
          </button>
        </div>
        {props.codeError && <p style={{ color: 'var(--diff-del)', fontSize: 13 }}>{props.codeError}</p>}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>方式二 · 扫描二维码</h2>
        {!scanning ? (
          <>
            <button
              className="btn"
              style={{ width: '100%' }}
              onClick={() => {
                if (!cameraAvailable) {
                  setScanError('当前页面通过明文 HTTP 打开，浏览器不允许调用摄像头。请改用「输入配对码」，或用系统相机扫描电脑屏幕上的二维码后打开链接。');
                  return;
                }
                setScanError('');
                setScanning(true);
              }}
            >
              打开摄像头扫描
            </button>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              也可以直接用手机的系统相机扫码打开本页。
            </p>
          </>
        ) : (
          <Scanner
            onResult={onScanResult}
            onClose={() => setScanning(false)}
          />
        )}
        {scanError && <p style={{ color: 'var(--state-waiting)', fontSize: 13 }}>{scanError}</p>}
      </div>
    </div>
  );
}

/** 页面内扫码：getUserMedia + jsQR 逐帧解码，识别到配对链接立即跳出。 */
function Scanner(props: { onResult: (payload: string) => void; onClose: () => void }): React.ReactNode {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | undefined;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const { default: jsQR } = await import('jsqr');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const loop = (): void => {
          if (cancelled || !video.videoWidth) {
            raf = requestAnimationFrame(loop);
            return;
          }
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx?.drawImage(video, 0, 0);
          const image = ctx?.getImageData(0, 0, canvas.width, canvas.height);
          const result = image ? jsQR(image.data, image.width, image.height) : null;
          if (result?.data) {
            props.onResult(result.data);
            return;
          }
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        console.warn('[pair] camera failed:', err);
        if (!cancelled) setError('无法访问摄像头（权限被拒或设备不可用）');
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <video
        ref={videoRef}
        muted
        playsInline
        style={{ width: '100%', borderRadius: 'var(--radius-sm)', background: '#000' }}
      />
      {error && <p style={{ color: 'var(--diff-del)', fontSize: 13 }}>{error}</p>}
      <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={props.onClose}>
        关闭摄像头
      </button>
    </div>
  );
}
