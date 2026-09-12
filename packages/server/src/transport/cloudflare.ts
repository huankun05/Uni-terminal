import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerConfig, UniConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { findExecutable } from '../agents/detect.ts';
import { lanAddresses, type LanAddress } from './lan.ts';
import type { AdvertisedEndpoint, TransportAdapter, TransportStatus } from './types.ts';

const log = createLogger('cloudflare');

/**
 * Cloudflare Tunnel 传输（设计02 定案的外网方案）。
 *
 * 快速隧道（`cloudflared tunnel --url`）免登录、免域名、免配置：cloudflared
 * 向 CF 边缘建一条出站连接，手机拿到一个 HTTPS 地址——顺带解决明文 HTTP
 * 的一切安全上下文限制（摄像头、语音、WebCrypto、PWA 安装提示）。
 *
 * 代价与边界（如实呈现给用户）：
 *  - 快速隧道地址随机且每次重启会变（长期使用应注册命名隧道 + 自己的域名）；
 *  - 流量在 CF 边缘解密，CF 理论上可见明文 → 应用层 E2E 是后续项；
 *  - 依赖 cloudflared 二进制：PATH 找不到时提供自动下载（GitHub Releases），
 *    下载失败可手动粘贴路径。
 */
export class CloudflareTransport implements TransportAdapter {
  readonly mode = 'cloudflare' as const;
  readonly autoDetected = false;

  private readonly server: ServerConfig;
  private readonly config: UniConfig;
  private readonly lan: () => LanAddress[];

  private child: ChildProcess | undefined;
  private url: string | undefined;
  private state: 'idle' | 'starting' | 'running' | 'error' = 'idle';
  private detail = '';

  constructor(server: ServerConfig, config: UniConfig, lan: () => LanAddress[]) {
    this.server = server;
    this.config = config;
    this.lan = lan;
  }

  get running(): boolean {
    return this.state === 'running' && this.url !== undefined;
  }

  get binaryPath(): string | undefined {
    const configured = this.config.transport.binaryPath;
    if (configured && existsSync(configured)) return configured;
    const inDataDir = join(this.server.dataDir, 'cloudflared.exe');
    if (process.platform === 'win32' && existsSync(inDataDir)) return inDataDir;
    return findExecutable('cloudflared');
  }

  status(): TransportStatus {
    // ready 只看隧道本身——局域网地址是备用门牌，不代表隧道可用，
    // 否则「隧道运行中」会在根本没连上时也亮绿灯。
    const endpoints = this.running ? this.endpoints() : [];
    const hint =
      this.state === 'error'
        ? `隧道启动失败：${this.detail}`
        : this.state === 'starting'
          ? '正在建立隧道…'
          : running
            ? undefined
            : !this.binaryPath
              ? '未找到 cloudflared。可在设置页自动下载，或手动指定路径。'
              : undefined;
    return { mode: this.mode, ready: running, hint, endpoints };
  }

  endpoints(): AdvertisedEndpoint[] {
    const out: AdvertisedEndpoint[] = [];
    if (this.url) {
      out.push({
        url: this.url,
        mode: 'cloudflare',
        label: 'Cloudflare 隧道（HTTPS · 外网可达）',
        priority: 0,
        warning: '流量经 Cloudflare 边缘中转，地址随机且重启会变',
      });
    }
    // 隧道之外，局域网地址仍是备用入口（同一服务，两个门牌）。
    for (const entry of this.lan()) {
      out.push({
        url: `http://${entry.address}:${this.server.port}`,
        mode: 'cloudflare',
        label: `局域网 · ${entry.iface}`,
        priority: 10 + entry.rank,
      });
    }
    return out;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const binary = this.binaryPath;
    if (!binary) {
      this.state = 'error';
      this.detail = '未找到 cloudflared 可执行文件';
      throw new Error(this.detail);
    }

    this.state = 'starting';
    this.detail = '';
    const local = `http://127.0.0.1:${this.server.port}`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(binary, ['tunnel', '--url', local, '--no-autoupdate'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.state = 'error';
        this.detail = '60 秒内未从 cloudflared 输出中取得隧道地址';
        reject(new Error(this.detail));
      }, 60_000);

      const onData = (chunk: Buffer | string): void => {
        const text = String(chunk);
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
        if (match && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.url = match[0];
          this.state = 'running';
          log.info('隧道已建立', { url: this.url });
          resolve();
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData); // cloudflared 把状态打到 stderr

      child.on('exit', (code) => {
        this.child = undefined;
        if (this.state === 'running') {
          // 进程意外退出：回到的空闲态，下次 start 重新拉起。
          this.url = undefined;
          this.state = 'idle';
          log.warn('cloudflared 进程退出', { code });
          return;
        }
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.state = 'error';
          this.detail = `cloudflared 退出（code ${code}）`;
          reject(new Error(this.detail));
        }
      });
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.state = 'error';
          this.detail = err.message;
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    this.state = 'idle';
    if (child) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  }

  /** 下载 cloudflared（Windows amd64）到数据目录，供无 PATH 的机器使用。 */
  async downloadBinary(): Promise<string> {
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    const target = join(this.server.dataDir, 'cloudflared.exe');
    log.info('开始下载 cloudflared', { target });
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`下载失败（HTTP ${res.status}）。国内网络可能无法访问 GitHub，请手动下载后粘贴路径。`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(target, buf);
    // 记住位置，重启后自动拉起。
    this.config.transport.binaryPath = target;
    log.info('cloudflared 下载完成', { size: buf.length });
    return target;
  }
}
