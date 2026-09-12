import { useState } from 'react';

/**
 * 「安全上下文」解锁指引。
 *
 * 浏览器禁止网页修改自己的安全开关（否则任何页面都能把自己设为可信），
 * 所以真正的"一键自动"做不到。能做到的极限是：自动填好当前地址、
 * 一键复制、给出照着点的分步指引——把手动操作压到最短。
 *
 * 适用场景：在家局域网使用时，给 http://IP:端口 解锁摄像头/语音等
 * 安全上下文功能（Chrome / Edge 等 Chromium 浏览器）。
 */
export function SecureContextGuide(): React.ReactNode {
  const origin = window.location.origin;
  const [copied, setCopied] = useState<'flag' | 'origin' | null>(null);

  const copy = async (text: string, what: 'flag' | 'origin'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板在 HTTP 下可能被拒——退化为选中提示。
      window.prompt('请手动复制：', text);
    }
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="card" style={{ fontSize: 14 }}>
      <p style={{ margin: '0 0 8px' }}>
        <strong>在家使用时解锁摄像头 / 语音 / 安装提示</strong>
      </p>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
        手机 Chrome（或 Edge 等 Chromium 系浏览器）：
      </p>
      <ol className="muted" style={{ fontSize: 13, margin: '0 0 10px', paddingLeft: 20, lineHeight: 2 }}>
        <li>
          地址栏输入 <code className="mono">chrome://flags</code> 回车
        </li>
        <li>
          搜索 <code className="mono">insecure</code>，找到
          <strong>「Unsafely treat insecure origin as secure」</strong>
        </li>
        <li>
          把开关改为 <strong>Enabled</strong>，并在右侧文本框填入下面这个地址 →
        </li>
        <li>点底部「Relaunch」重启浏览器</li>
      </ol>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm primary" onClick={() => void copy(origin, 'origin')}>
          {copied === 'origin' ? '✓ 已复制' : `① 一键复制本服务地址`}
        </button>
        <button className="btn sm" onClick={() => void copy('chrome://flags/#unsafely-treat-insecure-origin-as-secure', 'flag')}>
          {copied === 'flag' ? '✓ 已复制' : '② 复制设置页地址'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
        原理：这台服务器就是你自己的电脑，白名单是 Chromium 官方提供的开关；
        浏览器禁止网页代你操作它，所以最后一步需要你亲手点。出门在外请用
        「外网访问（HTTPS）」隧道，无需此设置。
      </p>
    </div>
  );
}
