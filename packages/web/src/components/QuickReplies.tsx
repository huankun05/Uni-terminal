import { useState } from 'react';

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

/**
 * 快捷应答栏：Agent 抛 y/n 时点一下就走；按键面板给 TUI 兜底。
 * 手机端与桌面端共用。
 */
export function QuickReplies(props: {
  onSend: (data: string) => void;
  onInterrupt: () => void;
}): React.ReactNode {
  const [showKeys, setShowKeys] = useState(false);

  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 4 }}>
        {QUICK_REPLIES.map((q) => (
          <button key={q.label} className="btn sm" style={{ padding: '8px 14px', flexShrink: 0 }} onClick={() => props.onSend(q.data)}>
            {q.label}
          </button>
        ))}
        <button className="btn sm" style={{ padding: '8px 14px', flexShrink: 0, color: 'var(--text-secondary)' }} onClick={() => setShowKeys((v) => !v)}>
          {showKeys ? '收起按键' : '按键'}
        </button>
        <button className="btn sm danger" style={{ padding: '8px 14px', flexShrink: 0 }} onClick={props.onInterrupt}>
          中断
        </button>
      </div>
      {showKeys && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {KEY_PANEL.map((k) => (
            <button key={k.label} className="btn sm mono" onClick={() => props.onSend(k.data)}>
              {k.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
