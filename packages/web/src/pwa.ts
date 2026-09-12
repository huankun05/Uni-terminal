/**
 * Service Worker 注册 + 安装提示捕获。
 *
 * prompt() 只有一次机会（拒绝后约 3 个月冷却，实施01 §3.7），
 * 所以捕获后不在启动时弹——存起来，由「设置」页的安装按钮显式触发。
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(available: boolean) => void>();

export function onInstallAvailability(cb: (available: boolean) => void): () => void {
  listeners.add(cb);
  cb(deferredPrompt !== null);
  return () => listeners.delete(cb);
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  if (choice.outcome === 'accepted') {
    deferredPrompt = null;
    listeners.forEach((cb) => cb(false));
  }
  return choice.outcome;
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
  listeners.forEach((cb) => cb(true));
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  listeners.forEach((cb) => cb(false));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('[pwa] service worker registration failed:', err);
    });
  });
}
