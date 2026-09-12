/**
 * Device/browser classification from the UA string plus display state.
 *
 * 国内第一道坎（设计02）：微信 / QQ / 微博的内置 WebView 不支持 添加到主屏幕、
 * Service Worker、WebAuthn —— 在那里整套方案是功能残废，必须拦截而不是降级。
 */

export type InAppBrowser = 'wechat' | 'qq' | 'weibo' | null;

export interface UaInfo {
  inApp: InAppBrowser;
  isIOS: boolean;
  isAndroid: boolean;
  isMobile: boolean;
  /** Running as an installed PWA rather than a browser tab. */
  standalone: boolean;
}

export function detectUa(ua = navigator.userAgent): UaInfo {
  let inApp: InAppBrowser = null;
  if (/MicroMessenger/i.test(ua)) inApp = 'wechat';
  else if (/QQ\//i.test(ua)) inApp = 'qq';
  else if (/Weibo/i.test(ua)) inApp = 'weibo';

  const isIOS = /iPhone|iPad|iPod/i.test(ua)
    || (navigator.platform === 'MacIntel' && (navigator as { maxTouchPoints?: number }).maxTouchPoints !== undefined
      && (navigator as { maxTouchPoints: number }).maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const standalone
    = window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as { standalone?: boolean }).standalone === true;

  return { inApp, isIOS, isAndroid, isMobile: isIOS || isAndroid, standalone };
}

export const INAPP_NAME: Record<Exclude<InAppBrowser, null>, string> = {
  wechat: '微信',
  qq: 'QQ',
  weibo: '微博',
};
