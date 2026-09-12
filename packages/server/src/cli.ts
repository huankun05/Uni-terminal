/**
 * L2 launcher (实施文档 01 §1.4).
 *
 * The core service (L0) is headless and long-lived; this CLI exists only to
 * remove the two Windows papercuts around it: the black console window and
 * "closing the window kills the service". `start --background` detaches the
 * server from this console (detached + stdio ignore + windowsHide — all three
 * are required, missing one resurrects the console window) and exits
 * immediately, so the process the user double-clicked is gone while the
 * service lives on.
 *
 * Commands:
 *   start              run the server in the foreground (first run, debugging)
 *   start --background start detached, print the URL, exit
 *   open               make sure the server runs, then open the admin UI
 *   status             config path, discovered agents, server reachability
 *   install-service    register log-on autostart (Task Scheduler)
 *   uninstall-service  remove the autostart task
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = resolve(import.meta.dirname, 'index.ts');
// node:sqlite is still flagged on the Node 22 line; keep in sync with the
// package.json `start` script.
const NODE_FLAGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];
const TASK_NAME = 'Uni-terminal';
const FIRST_PORT = 8787;
const PORT_SCAN = 11;

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'help';
  const background = command === 'start' && argv.includes('--background');

  switch (command) {
    case 'start':
      if (background) await startBackground();
      else await import('./index.ts');
      return;
    case 'open':
      await open();
      return;
    case 'status':
      await status();
      return;
    case 'install-service':
      await installService();
      return;
    case 'uninstall-service':
      await uninstallService();
      return;
    default:
      printHelp();
      return;
  }
}

async function startBackground(): Promise<void> {
  const existing = await findLivePort();
  if (existing !== undefined) {
    console.log(`  Uni-terminal 已在运行: http://127.0.0.1:${existing}`);
    return;
  }

  const child = spawn(
    process.execPath,
    [...NODE_FLAGS, SERVER_ENTRY],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();

  const port = await waitForAnyPort();
  if (port === undefined) {
    console.error('  服务已拉起但未能在预期端口上就绪，请用 `npm start` 前台启动排查。');
    process.exitCode = 1;
    return;
  }
  console.log(`  Uni-terminal 已在后台启动: http://127.0.0.1:${port}`);
}

async function open(): Promise<void> {
  let port = await findLivePort();
  if (port === undefined) {
    await startBackground();
    port = await findLivePort();
  }
  if (port === undefined) {
    console.error('  无法确认服务已就绪，未打开浏览器。');
    process.exitCode = 1;
    return;
  }
  const url = `http://127.0.0.1:${port}/local`;
  const opener =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('open', [url], { detached: true, stdio: 'ignore' });
  opener.unref();
  console.log(`  已打开管理台: ${url}`);
}

async function status(): Promise<void> {
  console.log('  Uni-terminal 状态');
  console.log('');

  const { configPathCandidates } = await import('./config.ts');
  const candidates = configPathCandidates();
  const found = candidates.find((p) => existsSync(p));
  console.log(`  配置文件    ${found ?? `${candidates[candidates.length - 1]}（尚未生成）`}`);

  const livePort = await findLivePort();
  console.log(`  服务状态    ${livePort ? `运行中 http://127.0.0.1:${livePort}` : '未运行'}`);
  console.log('');

  const { augmentSearchDirs } = await import('./agents/detect.ts');
  const { detectAllAgents } = await import('./agents/survey.ts');
  await augmentSearchDirs();
  const detected = detectAllAgents().filter((a) => a.installed);
  if (detected.length > 0) {
    console.log('  发现的 Agent:');
    for (const agent of detected) console.log(`    ${agent.id.padEnd(12)} ${agent.binary ?? ''}`);
  } else {
    console.log('  发现的 Agent: （无）');
  }
}

async function installService(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('  目前仅支持 Windows（任务计划程序）。');
    process.exitCode = 1;
    return;
  }
  const cliPath = fileURLToPath(import.meta.url);
  // Run through the launcher, not the server directly: the launcher detaches
  // with windowsHide so a log-on start never flashes a console window.
  const tr = `"${process.execPath}" "${cliPath}" start --background`;
  const result = await run('schtasks', [
    '/Create', '/TN', TASK_NAME, '/TR', tr,
    '/SC', 'ONLOGON', '/F',
  ]);
  if (result.code === 0) {
    console.log(`  已注册开机自启（任务计划程序「${TASK_NAME}」）。`);
  } else {
    console.error(`  注册失败（退出码 ${result.code}）：`);
    console.error(result.output.trimEnd());
    process.exitCode = 1;
  }
}

async function uninstallService(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('  目前仅支持 Windows（任务计划程序）。');
    process.exitCode = 1;
    return;
  }
  const result = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  if (result.code === 0) {
    console.log(`  已移除开机自启（任务计划程序「${TASK_NAME}」）。`);
  } else {
    console.error(`  移除失败（退出码 ${result.code}）：`);
    console.error(result.output.trimEnd());
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(
    [
      '',
      '  Uni-terminal 启动器',
      '',
      '  用法: node packages/server/src/cli.ts <命令>',
      '',
      '    start                前台启动服务（首次安装、排查问题）',
      '    start --background   后台静默启动（自启场景）',
      '    open                 确保服务已启动并打开管理台',
      '    status               配置路径 / 发现的 Agent / 服务状态',
      '    install-service      注册开机自启（Windows 任务计划程序）',
      '    uninstall-service    移除开机自启',
      '',
    ].join('\n'),
  );
}

// ------------------------------------------------------------------ helpers

function run(cmd: string, args: string[]): Promise<{ code: number; output: string }> {  return new Promise((resolvePromise) => {
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

async function probeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function findLivePort(): Promise<number | undefined> {
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_SCAN; port += 1) {
    if (await probeHealth(port)) return port;
  }
  return undefined;
}

async function waitForAnyPort(timeoutMs = 15_000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = await findLivePort();
    if (port !== undefined) return port;
    await new Promise((r) => setTimeout(r, 400));
  }
  return undefined;
}

void main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`启动器错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
