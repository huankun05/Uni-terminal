import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';

import { useLive, type LiveEvent } from '../../store/live.ts';
import { ansiTail, stripAnsi } from '../../lib/ansi.ts';
import { speechSupported, startVoice } from '../../lib/speech.ts';

/**
 * 会话详情（实施01 §3.4/§3.6）：
 *  - 默认视图 = ANSI 剥离后的输出摘要（PTY 模式的可读形态）；
 *  - 快捷应答按钮：Agent 抛 y/n 时点一下就走，不打字；
 *  - 按键面板：给 TUI 兜底（Esc / Tab / 方向键 / Ctrl+C）；
 *  - 新建任务页带来的 prompt 在会话就绪后自动送入。
 */

const QUICK_REPLIES: Array<{ label: string; data: string }> = [
  { label: '继续', data: '继续\r' },
  { label: '是', data: 'y\r' },
  { label: '否', data: 'n\r' },
  { label: '同意并记住', data: '2\r' },
  { label: '停止', data: '\u0003' },
];

const KEY_PANEL: Array<{ label: string; data: string }> = [
  { label: 'Esc', data: '\u001b' },
  { label: 'Tab', data: '\t' },
  { label: '↑', data: '\u001b[A' },
  { label: '↓', data: '\u001b[B' },
  { label: 'Enter', data: '\r' },
  { label: 'y', data: 'y' },
  { label: 'n', data: 'n' },
  { label: 'Ctrl+C', data: '\u0003' },
];

export function MSession(): React.ReactNode {
  const { id = '' } = useParams();
  const location = useLocation();
  const { subscribe, unsubscribe, events, sendInput, interrupt, resize, connection, sessions } = useLive();
  const [draft, setDraft] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [voiceHint, setVoiceHint] = useState('');
  const [listening, setListening] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const promptSent = useRef(false);
  const voiceRef = useRef<{ stop: () => void } | null>(null);

  const session = sessions.find((s) => s.id === id);

  useEffect(() => {
    if (!id) return;
    subscribe(id);
    return () => unsubscribe(id);
  }, [id, subscribe, unsubscribe]);

  /**
   * 自适应终端宽度：TUI（Claude Code 等）按列数绘制，固定 100 列塞进手机
   * 屏就是截图里那种碎掉的样子。按流式面板的实际像素宽度反推列数并下发
   * resize，Agent 会以手机宽度重绘。挂载/旋转/首次就绪时各校一次。
   */
  useEffect(() => {
    if (!id || connection !== 'open') return;
    const apply = (): void => {
      const el = streamRef.current;
      if (!el) return;
      const style = window.getComputedStyle(el);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.font = `${style.fontSize} ${style.fontFamily}`;
      const charWidth = ctx.measureText('M').width || 7.5;
      const cols = Math.max(40, Math.floor((el.clientWidth - 20) / charWidth));
      const rows = Math.max(12, Math.floor(el.clientHeight / parseFloat(style.lineHeight || '19')));
      resize(id, cols, rows);
    };
    const timer = setTimeout(apply, 500); // 等订阅与首次输出稳定
    const onWindowResize = (): void => {
      clearTimeout(timer);
      apply();
    };
    window.addEventListener('resize', onWindowResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onWindowResize);
    };
  }, [id, connection, resize]);

  const list: LiveEvent[] = events[id] ?? [];

  // New-task prompt: deliver once, after the agent shell is actually up.
  const prompt = (location.state as { prompt?: string } | null)?.prompt;
  useEffect(() => {
    if (!prompt || promptSent.current) return;
    if (list.some((e) => e.type === 'session.ready')) {
      // 给 TUI 一点完成绘制的时间，否则首屏提示还没出就把输入打进了。
      const timer = setTimeout(() => {
        sendInput(id, `${prompt}\r`);
        promptSent.current = true;
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [prompt, list, id, sendInput]);

  // 输出增长时贴底，除非用户手动上翻（保留位置感）。
  const outputText = useMemo(
    () => list.filter((e) => e.type === 'session.output').map((e) => (e.payload as { chunk?: string })?.chunk ?? '').join(''),
    [list],
  );
  useEffect(() => {
    if (autoScroll && streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [outputText, autoScroll]);

  return (
    <div className="layout" style={{ maxWidth: 560 }}>
      <p className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Link to="/m" style={{ color: 'inherit' }}>← 返回</Link>
        <span>{session ? `${session.agent} · ${session.status}` : `会话 ${id.slice(0, 8)}`}</span>
        <span style={{ flex: 1 }} />
        <span>{connection === 'open' ? '🟢' : '🟡'}</span>
      </p>

      {/* 输出流：ANSI 剥离摘要 */}
      <div
        ref={streamRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="card mono"
        style={{ maxHeight: '52vh', overflowY: 'auto', fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      >
        {outputText ? ansiTail(outputText, 200, 20000) : <span className="muted">等待 Agent 输出…</span>}
      </div>

      {/* 快捷应答：不打字推进任务 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {QUICK_REPLIES.map((q) => (
          <button key={q.label} className="btn" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => sendInput(id, q.data)}>
            {q.label}
          </button>
        ))}
        <button className="btn" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setShowKeys((v) => !v)}>
          {showKeys ? '收起按键' : '按键'}
        </button>
        <button className="btn danger" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => interrupt(id)}>
          中断
        </button>
      </div>

      {showKeys && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {KEY_PANEL.map((k) => (
            <button key={k.label} className="btn mono" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => sendInput(id, k.data)}>
              {k.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
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
          placeholder="发消息给 Agent…（可用输入法语音键）"
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
          className="btn"
          style={listening ? { borderColor: 'var(--diff-del)', color: 'var(--diff-del)' } : undefined}
          title={speechSupported() ? '语音输入' : '当前环境（HTTP）不支持网页语音识别，可用输入法自带的语音键'}
          onClick={() => {
            if (listening) {
              voiceRef.current?.stop();
              voiceRef.current = null;
              setListening(false);
              return;
            }
            if (!speechSupported()) {
              setVoiceHint('网页语音识别需要 HTTPS 环境；你手机输入法自带的语音键在这里同样可用（它在系统层工作）。');
              setTimeout(() => setVoiceHint(''), 5000);
              return;
            }
            const v = startVoice(
              (text) => setDraft((prev) => (prev ? `${prev} ${text}` : text)),
              () => setListening(false),
            );
            if (v) {
              voiceRef.current = v;
              setListening(true);
            }
          }}
        >
          {listening ? '■ 听写中' : '🎤'}
        </button>
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
      {voiceHint && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>{voiceHint}</p>}
      {!autoScroll && (
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
  return ansiTail(text, 3, 200);
}

export { stripAnsi };
