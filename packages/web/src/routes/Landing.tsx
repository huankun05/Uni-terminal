import { useEffect } from 'react';
import { Navigate } from 'react-router';
import { detectUa } from '../lib/ua.ts';

/**
 * 着陆分流（实施01 §3.1）：极简页，判设备类型后跳转。内置浏览器不跳——
 * 拦截页在这里才是正确的目的地。
 */
export function Landing(): React.ReactNode {
  const ua = detectUa();

  useEffect(() => {
    if (ua.inApp) return;
    // 给跳转一个可感知的瞬间，也避免在静态外壳阶段抖动。
    const t = setTimeout(() => {
      window.location.assign(ua.isMobile ? '/m' : '/local');
    }, 150);
    return () => clearTimeout(t);
  }, [ua.inApp, ua.isMobile]);

  if (ua.inApp) return <Navigate to="/inapp" replace />;
  return <p className="muted" style={{ padding: 24 }}>正在进入…</p>;
}
