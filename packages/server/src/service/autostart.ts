import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Windows log-on autostart via Task Scheduler (设计02 定案).
 *
 * Not a Windows *service* on purpose: Session 0 services get the system's
 * PATH and credentials, not the user's — and every agent we drive needs the
 * user's. A log-on task stays inside the user session. The task runs the L2
 * launcher (not the server directly) so a log-on start never flashes a
 * console window.
 */

export const AUTOSTART_TASK = 'Uni-terminal';

export interface AutostartStatus {
  registered: boolean;
  task: string;
}

function run(cmd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (err) => {
      output += err.message;
      resolvePromise({ code: -1, output });
    });
    child.on('exit', (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

export async function autostartStatus(): Promise<AutostartStatus | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('schtasks', ['/query', '/tn', AUTOSTART_TASK], { windowsHide: true });
    return { registered: true, task: AUTOSTART_TASK };
  } catch {
    return { registered: false, task: AUTOSTART_TASK };
  }
}

export async function registerAutostart(): Promise<{ ok: boolean; output: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, output: '目前仅支持 Windows（任务计划程序）' };
  }
  const cliPath = resolve(fileURLToPath(import.meta.url), '../../cli.ts');
  // Quoting: schtasks' own CRT parsing turns \" back into " inside /TR, which
  // is what the task action needs for the space-containing node path.
  const tr = `"${process.execPath}" "${cliPath}" start --background`;
  const result = await run('schtasks', [
    '/Create', '/TN', AUTOSTART_TASK, '/TR', tr,
    '/SC', 'ONLOGON', '/F',
  ]);
  return { ok: result.code === 0, output: result.output };
}

export async function unregisterAutostart(): Promise<{ ok: boolean; output: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, output: '目前仅支持 Windows（任务计划程序）' };
  }
  const result = await run('schtasks', ['/Delete', '/TN', AUTOSTART_TASK, '/F']);
  return { ok: result.code === 0, output: result.output };
}
