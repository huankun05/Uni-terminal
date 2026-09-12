import { useEffect, useRef, useState } from 'react';

import { api } from '../api/client.ts';
import { useLive, type LiveEvent } from '../store/live.ts';

/**
 * 真终端面板（@xterm/xterm，懒加载）。
 *
 * 这是 TUI 工具（Claude Code 等）唯一忠实的视图：颜色、加粗、光标定位
 * 都按终端语义渲染——剥 ANSI 的文本流会把它碎成乱码，这里不会。回放
 * `/events?from=0` 的历史后接入实时事件，键盘输入与窗口尺寸变化双向
 * 同步（fit 反推列数 → resize 下发 → Agent 以此宽度重绘）。
 *
 * xterm 约 130KB（gzip ~48KB），只在首次打开终端视图时加载。
 */
export function TerminalPane(props: {
  sessionId: string;
  events: LiveEvent[];
  /** 终端视口变化时回调（父页面据此了解当前生效的 cols）。 */
  onResized?: (cols: number, rows: number) => void;
}): React.ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ write: (s: string) => void } | null>(null);
  const lastSeq = useRef(0);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  // 初始化：加载库 → 回放历史 → 接键盘 → 适配尺寸
  useEffect(() => {
    if (!props.sessionId) return;
    let disposed = false;
    let cleanup = (): void => undefined;

    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);
        await import('@xterm/xterm/css/xterm.css');
        if (disposed || !hostRef.current) return;

        const term = new Terminal({
          fontSize: 12,
          fontFamily: 'ui-monospace, Cascadia Code, Consolas, monospace',
          scrollback: 5000,
          convertEol: false,
          theme: {
            background: '#0d1320',
            foreground: '#e8edf5',
            cursor: '#4f8cff',
            selectionBackground: '#264f78',
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(hostRef.current);
        termRef.current = term;

        // 历史回放（新建会话此处为空，不影响）。
        try {
          const res = await api.get<{ events: Array<{ seq: number; type: string; payload: unknown }> }>(
            `/api/sessions/${encodeURIComponent(props.sessionId)}/events?from=0`,
          );
          for (const e of res.events) {
            if (e.type === 'session.output') {
              term.write((e.payload as { chunk?: string })?.chunk ?? '');
              lastSeq.current = e.seq;
            }
          }
        } catch {
          // 回放失败不致命——实时流照常。
        }

        // 键盘/粘贴 → 终端。
        term.onData((data) => {
          useLive.getState().sendInput(props.sessionId, data);
        });

        // 尺寸自适应：容器变化 → fit → 下发 resize。
        const doFit = (): void => {
          try {
            fit.fit();
            props.onResized?.(term.cols, term.rows);
          } catch {
            // 容器不可见时 fit 会抛——下次再试。
          }
        };
        term.onResize(({ cols, rows }) => props.onResized?.(cols, rows));
        doFit();
        const observer = new ResizeObserver(() => doFit());
        observer.observe(hostRef.current);
        setReady(true);

        cleanup = (): void => {
          observer.disconnect();
          term.dispose();
          termRef.current = null;
        };
      } catch (err) {
        console.warn('[terminal] init failed:', err);
        if (!disposed) setError('终端加载失败，请切换到文本视图');
      }
    })();

    return () => {
      disposed = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // 实时输出：只写比上次新的。
  useEffect(() => {
    const term = termRef.current;
    if (!term || !ready) return;
    for (const e of props.events) {
      if (e.seq <= lastSeq.current) continue;
      if (e.type === 'session.output') {
        term.write((e.payload as { chunk?: string })?.chunk ?? '');
        lastSeq.current = e.seq;
      }
    }
  }, [props.events, ready]);

  if (error) return <p className="muted" style={{ fontSize: 13 }}>{error}</p>;
  return (
    <div
      ref={hostRef}
      style={{ minHeight: 260, maxHeight: '52vh', overflow: 'hidden' }}
      // 点按终端弹出手机键盘（xterm 不自动聚焦）。
      onClick={() => hostRef.current?.querySelector('textarea')?.focus()}
    />
  );
}
