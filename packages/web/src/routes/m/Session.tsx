import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';

import { useLive, type LiveEvent } from '../../store/live.ts';
import { stripAnsi } from '../../lib/ansi.ts';
import { TerminalPane } from '../../components/TerminalPane.tsx';
import { QuickReplies } from '../../components/QuickReplies.tsx';

/**
 * 会话详情（实施01 §3.4/§3.6，视图按 E3 定案）：
 *  - 「终端」默认视图：xterm 渲染的 TUI，颜色与排版忠实，可键盘交互；
 *  - 「文本」视图：ANSI 剥离的纯文本流，用于通读与复制；
 *  - 快捷应答：Agent 抛 y/n 时点一下就走；按键面板给 TUI 兜底；
 *  - 新建任务带来的 prompt 在会话就绪后自动送入。
 */

export function MSession(): React.ReactNode {
  const { id = '' } = useParams();
  const location = useLocation();
  const { subscribe, unsubscribe, events, sendInput, interrupt, resize, connection, sessions } = useLive();
  const [view, setView] = useState<'term' | 'text'>('term');
  const [draft, setDraft] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const streamRef = useRef<HTMLDivElement>(null);
  const promptSent = useRef(false);

  const session = sessions.find((s) => s.id === id);

  useEffect(() => {
    if (!id) return;
    subscribe(id);
    return () => unsubscribe(id);
  }, [id, subscribe, unsubscribe]);

  const list: LiveEvent[] = events[id] ?? [];

  // 文本视图的输出缓存（终端视图自己消化事件）。
  const outputText = useMemo(
    () => list.filter((e) => e.type === 'session.output').map((e) => (e.payload as { chunk?: string })?.chunk ?? '').join(''),
    [list],
  );

  // 文本视图：贴底滚动，手动上翻即暂停。
  useEffect(() => {
    if (view === 'text' && autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [outputText, autoScroll, view]);

  // 终端视图没有测量面板时（未开终端前），先用估算宽度兜底一次，
  // 避免会话以 100 列启动把首屏撑碎。
  useEffect(() => {
    if (!id || connection !== 'open' || view !== 'term') return;
    const timer = setTimeout(() => resize(id, 44, 22), 400);
    return () => clearTimeout(timer);
  }, [id, connection, view, resize]);

  // New-task prompt：会话就绪后自动送入。
  const prompt = (location.state as { prompt?: string } | null)?.prompt;
  useEffect(() => {
    if (!prompt || promptSent.current) return;
    if (list.some((e) => e.type === 'session.ready')) {
      const timer = setTimeout(() => {
        sendInput(id, `${prompt}\r`);
        promptSent.current = true;
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [prompt, list, id, sendInput]);

  return (
    <div className="layout" style={{ maxWidth: 560, paddingBottom: 90 }}>
      <p className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Link to="/m" style={{ color: 'inherit' }}>← 返回</Link>
        <span>{session ? `${session.agent} · ${session.status}` : `会话 ${id.slice(0, 8)}`}</span>
        <span style={{ flex: 1 }} />
        <span>{connection === 'open' ? '🟢' : '🟡'}</span>
      </p>

      {/* 视图切换 + 输出区 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div className="seg">
          {([['term', '终端'], ['text', '文本']] as const).map(([v, label]) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'term' ? (
        <div className="card" style={{ padding: 6, background: '#0d1320' }}>
          <TerminalPane sessionId={id} events={list} onResized={(cols, rows) => resize(id, cols, rows)} />
        </div>
      ) : (
        <div
          ref={streamRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          className="card mono"
          style={{ maxHeight: '52vh', overflowY: 'auto', fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        >
          {outputText ? stripAnsi(outputText).slice(-20000) : <span className="muted">等待 Agent 输出…</span>}
        </div>
      )}

      {/* 快捷应答：单行横滑，不打字推进任务（与桌面端共用组件） */}
      <QuickReplies onSend={(data) => sendInput(id, data)} onInterrupt={() => interrupt(id)} />

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft) {
              sendInput(id, `${draft}\r`);
              setDraft('');
            }
          }}
          enterKeyHint="send"
          placeholder={view === 'term' ? '在下方终端直接输入，或在这里发消息…' : '发消息给 Agent…'}
          style={{
            flex: 1,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            padding: '10px 12px',
            fontSize: 14,
          }}
        />
        <button
          className="btn primary"
          onClick={() => {
            if (draft) {
              sendInput(id, `${draft}\r`);
              setDraft('');
            }
          }}
        >
          发送
        </button>
      </div>
      {view === 'text' && !autoScroll && (
        <button className="btn" style={{ marginTop: 6, fontSize: 12 }} onClick={() => setAutoScroll(true)}>
          ↓ 回到底部（已暂停自动滚动）
        </button>
      )}
    </div>
  );
}

/** 供「现在」页取最新动态摘要。 */
export function sessionSummary(list: LiveEvent[]): string {
  const text = list.filter((e) => e.type === 'session.output').map((e) => (e.payload as { chunk?: string })?.chunk ?? '').join('');
  return stripAnsi(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0).slice(-3).join('\n').slice(-200);
}

export { stripAnsi };
