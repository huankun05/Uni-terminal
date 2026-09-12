import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../logger.ts';

const log = createLogger('driver');

/**
 * A running agent process, normalised across PTY and pipe back-ends.
 *
 * The reason both exist: a real PTY is what makes an interactive TUI work
 * (keystrokes echo, the app believes it owns a terminal, ANSI redraws are
 * correct). But `node-pty` is a native module — on Windows, if no prebuilt
 * binary matches the running Node ABI, npm falls back to compiling it and that
 * needs Visual Studio Build Tools. We ship `@lydell/node-pty` instead: it only
 * distributes prebuilt binaries and never invokes node-gyp, so "npm install
 * and it runs" holds. The pipe fallback below stays as the last resort for
 * platforms the prebuilds do not cover.
 *
 * So: prefer PTY, fall back to pipes, and tell the truth about which one is in
 * use through `usesPty`, because the UI behaves differently (a pipe-only run
 * cannot accept interactive keystrokes meaningfully).
 */
export interface RunHandle {
  readonly pid: number | undefined;
  readonly usesPty: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (info: { exitCode: number | null }) => void): void;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
}

interface PtyDisposable {
  dispose(): void;
}

interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): PtyDisposable;
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess;
}

let ptyModule: PtyModule | null | undefined;
let ptyLoadError: string | undefined;

/**
 * Resolves once. `undefined` means "not tried yet", `null` means "unavailable,
 * fall back to pipes" — the distinction keeps the failure message out of logs
 * on every single session start.
 */
export async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule !== undefined) return ptyModule;

  try {
    const mod = (await import('@lydell/node-pty')) as unknown as PtyModule;
    ptyModule = mod;
    log.info('@lydell/node-pty available, interactive terminals enabled');
  } catch (err) {
    ptyModule = null;
    ptyLoadError = (err as Error).message;
    log.warn('node-pty unavailable, falling back to piped mode', {
      reason: ptyLoadError,
      fix: 'check that a @lydell/node-pty prebuilt binary exists for this platform',
    });
  }
  return ptyModule;
}

export function ptyDiagnostics(): { available: boolean | undefined; error?: string } {
  return {
    available: ptyModule === undefined ? undefined : ptyModule !== null,
    ...(ptyLoadError ? { error: ptyLoadError } : {}),
  };
}

function mergedEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  // Agents need the *user's* context (PATH, API keys, git config). That is
  // also why this server must run inside the user's login session rather than
  // as a Windows service in Session 0 — there, PATH and credentials are the
  // system's, not the user's, and every agent fails to launch.
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  out.TERM = out.TERM || 'xterm-256color';
  out.FORCE_COLOR = '1';
  return out;
}

class PtyHandle implements RunHandle {
  readonly usesPty = true;
  private readonly proc: PtyProcess;

  constructor(proc: PtyProcess) {
    this.proc = proc;
  }

  get pid(): number {
    return this.proc.pid;
  }

  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc.resize(Math.max(20, cols), Math.max(5, rows));
    } catch {
      // Resizing a process that just exited is a harmless race.
    }
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }

  onData(cb: (chunk: string) => void): void {
    this.proc.onData(cb);
  }

  onExit(cb: (info: { exitCode: number | null }) => void): void {
    this.proc.onExit((info) => cb({ exitCode: info.exitCode }));
  }
}

class PipeHandle implements RunHandle {
  readonly usesPty = false;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
  }

  get pid(): number | undefined {
    return this.child.pid ?? undefined;
  }

  write(data: string): void {
    // Without a PTY there is no line discipline to echo input, so we echo it
    // ourselves. Otherwise the phone sees its own keystrokes vanish.
    this.child.stdin.write(data);
  }

  resize(): void {
    // Nothing to do: a pipe has no window size.
  }

  kill(): void {
    this.child.kill();
  }

  onData(cb: (chunk: string) => void): void {
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => cb(chunk));
    this.child.stderr.on('data', (chunk: string) => cb(chunk));
  }

  onExit(cb: (info: { exitCode: number | null }) => void): void {
    this.child.on('exit', (code) => cb({ exitCode: code }));
    this.child.on('error', () => cb({ exitCode: null }));
  }
}

export async function startProcess(options: RunOptions): Promise<RunHandle> {
  const pty = await loadPty();
  const env = mergedEnv(options.env);

  if (pty) {
    const proc = pty.spawn(options.command, options.args, {
      name: 'xterm-256color',
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env,
      // ConPTY on Windows 10+; the default is fine but being explicit avoids
      // surprises on older builds.
      useConpty: process.platform === 'win32' ? true : undefined,
    });
    return new PtyHandle(proc);
  }

  // Resolve through the shell on Windows so `.cmd`/`.ps1` shims installed by
  // npm are found — `claude`, for example, is `claude.ps1` on this machine.
  const isWindows = process.platform === 'win32';
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env,
    shell: isWindows,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  return new PipeHandle(child);
}
