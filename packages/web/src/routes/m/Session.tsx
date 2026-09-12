import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import { useLive, type LiveEvent } from '../../store/live.ts';

/**
 * 会话详情：事件流 + 最小输入区（M3 将换成「事件 → 面板映射」的卡片视图
 * 与快捷应答；此页先把双通道数据打通——文本流 + 原始终端兜底后续挂 xterm）。
 */
export function MSession(): React.ReactNode {
  const { id = '' } = useParams();
  const { subscribe, unsubscribe, events, sendInput, interrupt, connection } = useLive();
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!id) return;
    subscribe(id);
    return () => unsubscribe(id);
  }, [id, subscribe, unsubscribe]);

  const list: LiveEvent[] = events[id] ?? [];

  return (
    <div className="layout" style={{ maxWidth: 560 }}>
      <p className="muted" style={{ fontSize: 13 }}>
        <Link to="/m" style={{ color: 'inherit' }}>← 返回</Link> · 连接 {connection === 'open' ? '正常' : '恢复中…'} · 共 {list.length} 条事件
      </p>

      <div className="card" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
        {list.length === 0 && <span className="muted">等待事件…</span>}
        {list.map((e) => (
          <div key={e.seq} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '6px 0' }}>
            <span className="mono muted" style={{ fontSize: 11 }}>{e.type}</span>
            <div className="mono" style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {renderPayload(e)}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft) {
              sendInput(id, `${draft}\n`);
              setDraft('');
            }
          }}
          placeholder="发送到终端…"
          className="mono"
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
        <button className="btn danger" onClick={() => interrupt(id)}>中断</button>
      </div>
    </div>
  );
}

/** M1 的临时渲染：文本类事件直出，结构化事件先以类型标注占位（M3 换卡片）。 */
function renderPayload(e: LiveEvent): string {
  if (e.type === 'session.output' && typeof (e.payload as { chunk?: string })?.chunk === 'string') {
    return (e.payload as { chunk: string }).chunk;
  }
  return JSON.stringify(e.payload).slice(0, 300);
}
