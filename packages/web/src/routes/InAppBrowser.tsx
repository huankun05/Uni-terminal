import { detectUa, INAPP_NAME } from '../lib/ua.ts';

/**
 * 内置浏览器拦截（实施01 §3.8）：不给「继续访问」——放行了也是个不能用的页面。
 * 出路两条：分平台跳出步骤 + 复制链接兜底。
 */
export function InAppBrowser(): React.ReactNode {
  const ua = detectUa();
  const name = ua.inApp ? INAPP_NAME[ua.inApp] : '当前应用';

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      alert('链接已复制，请粘贴到系统浏览器打开');
    } catch {
      // 剪贴板被拒时让用户长按地址栏复制。
      alert('复制失败，请长按上方地址栏手动复制链接，用系统浏览器打开');
    }
  };

  return (
    <div className="layout" style={{ maxWidth: 460, paddingTop: '12vh' }}>
      <div className="card">
        <h1>请在系统浏览器中打开</h1>
        <p>
          {name}内置浏览器不支持「添加到主屏幕」与本方案需要的浏览器能力，
          在这里无法正常使用。
        </p>
        <h2>怎么出去</h2>
        <p className="muted" style={{ fontSize: 14 }}>
          点右上角「···」（iOS）或「⋮」（Android）→ 选择「在浏览器中打开」。
        </p>
        <button className="btn primary" onClick={() => void copyLink()}>
          复制链接，去浏览器打开
        </button>
      </div>
    </div>
  );
}
