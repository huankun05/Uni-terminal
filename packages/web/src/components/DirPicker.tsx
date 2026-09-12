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
  drives?: string[];
}

/**
 * 界面内的目录选择器（实施01 §2.3「改路径怎么选文件」）。
 *
 * 浏览器开不了原生文件对话框；服务端有文件系统权限，所以做一个能搜索、
 * 能跳盘、能粘贴路径直达的迷你浏览器。endpoint 二选一：
 *   /api/local/fs/list —— 仅回环（桌面管理台）
 *   /api/fs/list       —— 已配对设备（手机的新建任务页）
 */
export function DirPicker(props: {
  title: string;
  initialPath?: string;
  endpoint?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}): React.ReactNode {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [filter, setFilter] = useState('');
  const [jumpPath, setJumpPath] = useState('');
  const [error, setError] = useState('');
  const endpoint = props.endpoint ?? '/api/local/fs/list';

  const browse = (path: string): void => {
    setError('');
    void api
      .post<FsListing>(endpoint, { path })
      .then((res) => {
        setListing(res);
        setJumpPath(res.path);
        setFilter('');
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    browse(props.initialPath || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirs = (listing?.entries ?? []).filter((e) => e.type === 'dir' && e.name.toLowerCase().includes(filter.toLowerCase()));

  /** 路径拆成可点击的面包屑段（兼容 \\ 与 /）。 */
  const crumbs = (listing?.path ?? '').split(/[\\/]+/).filter(Boolean);

  const jump = (): void => {
    if (jumpPath.trim()) browse(jumpPath.trim());
  };

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
        style={{ width: 560, maxWidth: '94vw', maxHeight: '76vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <strong>{props.title}</strong>

        {/* 路径跳转：粘贴 / 手输，回车直达 */}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            value={jumpPath}
            onChange={(e) => setJumpPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') jump(); }}
            placeholder="粘贴或输入路径后回车，如 D:\Work"
            className="mono"
            style={{ flex: 1, fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '5px 8px' }}
          />
          <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={jump}>跳转</button>
        </div>

        {/* 面包屑 + 上一级 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '8px 0 6px', flexWrap: 'wrap', fontSize: 12 }}>
          {listing?.parent && (
            <button className="btn" style={{ padding: '2px 8px' }} onClick={() => browse(listing.parent!)}>← 上一级</button>
          )}
          <span className="mono muted">/ {crumbs.join('  /  ')}</span>
        </div>

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="输入名称过滤当前目录…"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '6px 10px', marginBottom: 8 }}
        />

        {error && <p style={{ color: 'var(--diff-del)', fontSize: 13 }}>{error}</p>}

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 160 }}>
          {/* 盘符：只在根层级出现（Windows），从这里进其他盘 */}
          {(listing?.drives ?? []).map((drive) => (
            <div
              key={drive}
              onClick={() => browse(drive)}
              style={{ padding: '7px 6px', cursor: 'pointer', borderRadius: 4, fontSize: 14 }}
            >
              💽 磁盘 {drive}
            </div>
          ))}
          {dirs.map((e) => (
            <div
              key={e.name}
              onClick={() => browse(joinPath(listing!.path, e.name))}
              style={{ padding: '7px 6px', cursor: 'pointer', borderRadius: 4, fontSize: 14 }}
            >
              📁 {e.name}
            </div>
          ))}
          {!listing?.drives?.length && dirs.length === 0 && (
            <p className="muted" style={{ fontSize: 13 }}>（无子目录——可以直接选当前目录）</p>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" disabled={!listing} onClick={() => listing && props.onPick(listing.path)}>
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
