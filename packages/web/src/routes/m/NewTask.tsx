import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { api } from '../../api/client.ts';
import { DirPicker } from '../../components/DirPicker.tsx';

interface AgentInfo {
  id: string;
  label: string;
  installed: boolean;
  mode?: string;
}

interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
}

/**
 * 新建任务（实施01 §3.3/§3.4）：不做通用聊天框——
 * 选 Agent、选工作区、写任务描述，一键启动。
 * 任务描述在会话就绪后作为第一条输入送进 Agent。
 */
export function MNewTask(): React.ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [agentId, setAgentId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [task, setTask] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [customCwd, setCustomCwd] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  /** null = 使用配置的工作区；字符串 = 自定义目录 */
  const useCustom = customCwd !== '';

  useEffect(() => {
    const state = location.state as { task?: string } | null;
    if (state?.task) setTask(state.task);
    void api
      .get<{ agents: AgentInfo[] }>('/api/agents')
      .then((res) => {
        const usable = res.agents.filter((a) => a.installed);
        setAgents(usable);
        setAgentId((prev) => prev || usable.find((a) => a.id === 'claude')?.id || usable[0]?.id || '');
      })
      .catch((err: Error) => setError(err.message));
    void api
      .get<{ workspaces: WorkspaceInfo[] }>('/api/workspaces')
      .then((res) => {
        setWorkspaces(res.workspaces);
        setWorkspaceId((prev) => prev || res.workspaces[0]?.id || '');
      })
      .catch(() => undefined);
  }, [location.state]);

  const launch = async (): Promise<void> => {
    if (!agentId) { setError('请先选择一个 Agent'); return; }
    setBusy(true);
    setError('');
    try {
      const created = await api.post<{ session: { id: string; cwd?: string } }>('/api/sessions', {
        agent: agentId,
        workspaceId: useCustom ? undefined : (workspaceId || undefined),
        cwd: useCustom ? customCwd : undefined,
        title: title.trim() || task.trim().slice(0, 40) || undefined,
        cols: 100,
        rows: 30,
      });
      navigate(`/m/s/${created.session.id}`, { state: { prompt: task.trim() } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="layout" style={{ maxWidth: 560 }}>
      <h1>新建任务</h1>
      {error && <p style={{ color: 'var(--diff-del)', fontSize: 14 }}>{error}</p>}

      <h2>Agent</h2>
      <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {agents.length === 0 && <span className="muted">没有已安装的 Agent，请到电脑端设置页重新扫描。</span>}
        {agents.map((a) => (
          <button
            key={a.id}
            className="btn"
            style={a.id === agentId ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            onClick={() => setAgentId(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>

      <h2>工作目录</h2>
      <div className="card">
        {workspaces.map((w) => (
          <label key={w.id} style={{ display: 'block', fontSize: 14, padding: '2px 0' }}>
            <input
              type="radio"
              name="ws"
              checked={!useCustom && workspaceId === w.id}
              onChange={() => { setWorkspaceId(w.id); setCustomCwd(''); }}
            />{' '}
            {w.name} <span className="muted mono" style={{ fontSize: 12 }}>{w.path}</span>
          </label>
        ))}
        <label style={{ display: 'block', fontSize: 14, padding: '2px 0' }}>
          <input
            type="radio"
            name="ws"
            checked={useCustom}
            onChange={() => setPickerOpen(true)}
          />{' '}
          浏览服务器目录…
        </label>
        {useCustom && (
          <p className="mono muted" style={{ fontSize: 12, margin: '4px 0 0' }}>→ {customCwd}</p>
        )}
        {workspaces.length === 0 && !useCustom && <span className="muted">没有配置的工作区，请选「浏览服务器目录」。</span>}
      </div>

      <h2>任务描述</h2>
      <div className="card">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任务标题（可选，方便回看）"
          style={{ width: '100%', marginBottom: 8, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '8px 10px', fontSize: 14 }}
        />
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={5}
          placeholder="要做什么？例如：把 auth 模块的单测补齐，跑通后汇报结果"
          style={{ width: '100%', resize: 'vertical', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '8px 10px', fontSize: 14, fontFamily: 'inherit' }}
        />
      </div>

      <button className="btn primary" style={{ width: '100%', marginTop: 14, padding: 12 }} disabled={busy} onClick={() => void launch()}>
        {busy ? '启动中…' : '启动任务'}
      </button>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        启动后在会话里可随时用快捷按钮应答（继续 / 是 / 否 / 停止），不必打字。
      </p>

      {pickerOpen && (
        <DirPicker
          title="选择工作目录"
          endpoint="/api/fs/list"
          onPick={(path) => {
            setCustomCwd(path);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
