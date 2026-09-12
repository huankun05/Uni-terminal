import { detectUa } from '../lib/ua.ts';

/** 安装引导页（M4 精细化）。iOS 无 beforeinstallprompt，只能图文引导。 */
export function InstallGuide(): React.ReactNode {
  const ua = detectUa();

  return (
    <div className="layout" style={{ maxWidth: 460, paddingTop: '12vh' }}>
      <div className="card">
        <h1>添加到主屏幕</h1>
        {ua.isIOS ? (
          <ol className="muted" style={{ fontSize: 14, paddingLeft: 20 }}>
            <li>用 Safari 打开本页面</li>
            <li>点底部中间的「分享」按钮</li>
            <li>下滑找到「添加到主屏幕」</li>
            <li>确认添加——之后像 App 一样从图标进入</li>
          </ol>
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>
            在 Chrome 等浏览器中打开本页面，地址栏右侧会出现「安装」图标；
            点击即可把 Uni-terminal 装到桌面。
          </p>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          安装后每次打开直达控制台，且 iOS 上登录状态更稳。
        </p>
      </div>
    </div>
  );
}
