import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { createLogger } from '../logger.ts';

const log = createLogger('claude-json');

/**
 * Claude Code 结构化驱动（stream-json 双向通道）。
 *
 * 与 PTY 的本质区别：PTY 给的是"人看的屏幕字节"，这里是"机器读的事件流"——
 * 助手文本 / 工具调用（含完整命令）/ 工具结果 / 权限请求 天然分离，
 * 手机端因此可以渲染成真正的卡片，而不是剥 ANSI 的猜谜。
 *
 * 通道协议（官方 CLI）：`claude -p --input-format stream-json
 * --output-format stream-json --verbose`；stdin 写 NDJSON 用户消息与
 * control_response（权限应答），stdout 收 NDJSON 事件。
 *
 * 事件 schema 官方文档不全（claude-code#24594），解析层对未知事件保持
 * 容错：一律以 agent.raw 透传，不丢弃。
 */

/** Claude Code 以"权限可用的头less模式"启动所需的默认参数。 */
export const CLAUDE_JSON_ARGS = [
  '--print',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--replay-user-messages',
  '--permission-mode', 'acceptEdits',
];

export interface StructuredEvent {
  type: string;
  payload: unknown;
}

export interface StructuredHandle {
  readonly pid: number | undefined;
  writeRaw(line: string): void;
  /** 纯文本 → 包装成 user 消息；JSON 行 → 原样透传（权限应答等）。 */
  sendUserText(text: string): void;
  interrupt(): void;
  kill(): void;
  onEvent(cb: (event: StructuredEvent) => void): void;
  onExit(cb: (exitCode: number | null) => void): void;
}

export function startClaudeJson(opts: {
  command: string;
  args: string[];
  cwd: string;
}): StructuredHandle {
  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env },
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const eventCbs: Array<(e: StructuredEvent) => void> = [];
  const exitCbs: Array<(code: number | null) => void> = [];

  const emit = (event: StructuredEvent): void => {
    for (const cb of eventCbs) cb(event);
  };

  // ---- stdout：NDJSON 事件流 → 归一化事件 ----
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      emit(parseLine(line));
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // stderr 诊断信息不属于事件流；攒着，进程退出时随 exit 事件带出。
    stderrTail += chunk;
  });
  let stderrTail = '';

  child.on('exit', (code) => {
    if (stderrTail.trim()) {
      emit({ type: 'agent.stderr', payload: { text: stderrTail.slice(-2000) } });
    }
    for (const cb of exitCbs) cb(code);
  });
  child.on('error', (err) => {
    emit({ type: 'agent.stderr', payload: { text: err.message } });
    for (const cb of exitCbs) cb(null);
  });

  const writeLine = (line: string): void => {
    if (child.stdin.writable) child.stdin.write(`${line}\n`);
  };

  /** 把 Claude Code 的 NDJSON 事件归一化成会话事件。 */
  function parseLine(line: string): StructuredEvent {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { type: 'agent.raw', payload: { line: line.slice(0, 500) } };
    }
    const type = msg.type as string;

    if (type === 'assistant' && typeof msg.message === 'object' && msg.message !== null) {
      const content = (msg.message as { content?: Array<Record<string, unknown>> }).content ?? [];
      // 一条 assistant 消息可能含多个内容块——作为多个事件发出。
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          emit({ type: 'agent.text', payload: { text: block.text } });
        } else if (block.type === 'tool_use') {
          emit({ type: 'agent.tool', payload: { name: block.name, input: block.input } });
        }
        // thinking 块对手机端是噪音，跳过。
      }
      return { type: 'agent.ignored', payload: { line: line.slice(0, 200) } };
    }

    if (type === 'user' && typeof msg.message === 'object' && msg.message !== null) {
      const content = (msg.message as { content?: unknown }).content;
      // tool_result 内容可能是字符串或块数组。
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content
          .map((b) => {
            if (typeof b === 'string') return b;
            if (b.type === 'tool_result') {
              // tool_result 块：content 可能是字符串或嵌套文本块
              const inner = b.content;
              if (typeof inner === 'string') return inner;
              if (Array.isArray(inner)) return inner.map((x) => (x as { text?: string }).text ?? '').join('\n');
            }
            return (b as { text?: string }).text ?? '';
          })
          .join('\n');
      }
      if (text.trim()) emit({ type: 'agent.tool_result', payload: { text: text.slice(0, 4000) } });
      return { type: 'agent.ignored', payload: { line: line.slice(0, 200) } };
    }

    if (type === 'result') {
      emit({
        type: 'agent.result',
        payload: {
          subtype: msg.subtype,
          result: typeof msg.result === 'string' ? msg.result.slice(0, 4000) : undefined,
          isError: msg.is_error === true,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
        },
      });
      return { type: 'agent.ignored', payload: { line: line.slice(0, 200) } };
    }

    if (type === 'control_request') {
      const request = msg.request as { subtype?: string; tool_name?: string; input?: unknown } | undefined;
      emit({
        type: 'agent.permission',
        payload: {
          requestId: msg.request_id,
          toolName: request?.tool_name ?? 'unknown',
          input: request?.input,
        },
      });
      return { type: 'agent.ignored', payload: { line: line.slice(0, 200) } };
    }

    // system/init 等已知但不渲染的事件 → 忽略；其余全部透传保底。
    if (type === 'system') return { type: 'agent.ignored', payload: { subtype: msg.subtype } };
    return { type: 'agent.raw', payload: { line: line.slice(0, 500) } };
  }

  return {
    pid: child.pid,
    writeRaw: writeLine,
    sendUserText(text) {
      writeLine(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        }),
      );
    },
    interrupt() {
      writeLine(
        JSON.stringify({
          type: 'control_request',
          request_id: `intr-${Date.now()}`,
          request: { subtype: 'interrupt' },
        }),
      );
    },
    kill() {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
    onEvent(cb) {
      eventCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
