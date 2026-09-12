import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';

import { useLive, type LiveEvent } from '../../store/live.ts';
import { stripAnsi } from '../../lib/ansi.ts';
import { analyzeTail, humanizeTranscript } from '../../lib/pty.ts';
import { TerminalPane } from '../../components/TerminalPane.tsx';
import { QuickReplies } from '../../components/QuickReplies.tsx';

/**
 * 会话详情（实施01 §3.4/§3.6，视图按 E3 定案）：
 *  - 「终端」默认视图：xterm 渲染的 TUI，颜色与排版忠实，可键盘交互；
 *  - 「文本」视图：ANSI 剥离的完整历史，可滚动通读（终端视图受 TUI
 *    备用缓冲区限制没有回滚，这里就是完整历史记录）；
 *  - PTY 智能应答：识别 Claude Code 的选择菜单 / y/n 确认 → 转成按钮；
 *    读取当前权限模式 → 一键切换（shift+tab）；
 *  - 快捷应答兜底 + 新建任务 prompt 自动送入。
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

  const outputText = useMemo(
    () => list.filter((e) => e.type === 'session.output').map((e) => (e.payload as { chunk?: string })?.chunk ?? '').join(''),
    [list],
  );

  // PTY 智能应答：从输出尾部识别选择菜单 / y/n 确认 / 当前权限模式。
  const intent = useMemo(() => analyzeTail(stripAnsi(outputText).slice(-3000)), [outputText]);

  // 文本视图：贴底滚动，手动上翻即暂停。
  useEffect(() => {
    if (view === 'text' && autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [outputText, autoScroll, view]);

  // 终端视图兜底宽度，避免会话以 100 列启动撑碎首屏。
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
        {intent.mode && (
          <span className="badge running" title="从输出状态行识别；点右侧「切换模式」改变">模式：{intent.mode}</span>
        )}
        <span style={{ flex: 1 }} />
        <span>{connection === 'open' ? '🟢' : '🟡'}</span>
      </p>

      {/* 视图切换：终端视图受 TUI 备用缓冲区限制没有回滚——看历史切「文本」 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div className="seg">
          {([['term', '终端'], ['text', '历史']] as const).map(([v, label]) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
        {view === 'term' && (
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>看完整历史 → 切「历史」</span>
        )}
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
          style={{ maxHeight: '56vh', overflowY: 'auto', fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        >
          {outputText ? humanizeTranscript(stripAnsi(outputText)) : <span className="muted">等待 Agent 输出…</span>}
        </div>
      )}

      {/* PTY 智能应答：识别到选择菜单 → 选项变按钮 */}
      {intent.kind === 'menu' && (
        <div className="card" style={{ marginTop: 10, borderColor: 'var(--state-waiting)', padding: '10px 12px' }}>
          <p style={{ margin: '0 0 8px', fontSize: 13 }}>
            <span className="status-dot" style={{ background: 'var(--state-waiting)' }} />
            检测到选择请求 —— 点选项直接应答：
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {intent.options.map((o) => (
              <button
                key={o.key}
                className="btn"
                style={{ textAlign: 'left', fontSize: 13.5, padding: '8px 12px' }}
                onClick={() => sendInput(id, `${o.key}\r`)}
              >
                <span className="mono" style={{ color: 'var(--accent)', marginRight: 8 }}>{o.key}</span>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {intent.kind === 'yn' && (
        <div className="card" style={{ marginTop: 10, borderColor: 'var(--state-waiting)', padding: '10px 12px' }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            <span className="status-dot" style={{ background: 'var(--state-waiting)' }} />
            检测到确认请求 —— 用下面的「是 / 否」应答
          </p>
        </div>
      )}

      {/* 模式切换（Claude Code：shift+tab 循环权限模式） */}
      {intent.mode && (
        <div style={{ marginTop: 8 }}>
          <button
            className="btn sm"
            style={{ fontSize: 12.5 }}
            title="发送 shift+tab 循环切换权限模式，切换结果以状态行徽章为准"
            onClick={() => sendInput(id, '\u001b[Z')}
          >
            切换模式（当前：{intent.mode}）
          </button>
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
