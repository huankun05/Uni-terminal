import { useEffect, useState } from 'react';

import { api } from '../api/client.ts';

interface FsEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

/**
 * 界面内的目录选择器（实施01 §2.3「改路径怎么选文件」）。
 *
 * 浏览器开不了原生文件对话框；服务端有文件系统权限，所以做一个能搜索的
 * 迷你浏览器——比原生对话框更好用，且只通过仅回环的 /api/local/fs/list。
 */
export function DirPicker(props: {
  title: string;
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}): React.ReactNode {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const browse = (path: string): void => {
    setError('');
    void api
      .post<FsListing>('/api/local/fs/list', { path })
      .then(setListing)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    browse(props.initialPath || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = (listing?.entries ?? []).filter((e) => e.type === 'dir' && e.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={props.onClose}
    >
      <div
        className="card"
        style={{ width: 520, maxWidth: '92vw', maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <strong>{props.title}</strong>
        <div className="mono muted" style={{ fontSize: 12, margin: '6px 0' }}>
          {listing?.path ?? '…'}
          {listing?.parent && (
            <>
              {' '}
              <button className="btn" style={{ padding: '2px 8px' }} onClick={() => browse(listing.parent!)}>
                上一级
              </button>
            </>
          )}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="输入名称过滤…"
          style={{
            background: 'var(--bg-base)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            padding: '6px 10px',
            marginBottom: 8,
          }}
        />
        {error && <p style={{ color: 'var(--diff-del)', fontSize: 13 }}>{error}</p>}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {visible.map((e) => (
            <div
              key={e.name}
              onClick={() => browse(listing!.parent === null ? `${listing!.path}\\${e.name}` : joinPath(listing!.path, e.name))}
              style={{ padding: '4px 6px', cursor: 'pointer', borderRadius: 4, fontSize: 14 }}
            >
              📁 {e.name}
            </div>
          ))}
          {visible.length === 0 && <p className="muted" style={{ fontSize: 13 }}>（无匹配的子目录）</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!listing}
            onClick={() => listing && props.onPick(listing.path)}
          >
            选择当前目录
          </button>
        </div>
      </div>
    </div>
  );
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}
