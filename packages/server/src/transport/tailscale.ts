import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { ServerConfig, UniConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { findExecutable } from '../agents/detect.ts';
import { lanAddresses, type LanAddress } from './lan.ts';
import type { AdvertisedEndpoint, TransportAdapter, TransportStatus } from './types.ts';

const log = createLogger('tailscale');
const run = promisify(execFile);

/**
 * Tailscale 组网传输。
 *
 * 手机装 Tailscale 并登录同一账号后，与电脑处于同一个加密虚拟局域网；
 * 再由 `tailscale serve` 把本服务以 **固定地址 + 正规 HTTPS 证书**
 * （<电脑名>.<网络名>.ts.net）发布出去——地址永不变，出门在家都一样，
 * 且浏览器视其为安全上下文（摄像头 / 语音 / PWA 全解锁）。
 *
 * 分工边界（如实）：
 *  - 我们能自动做的：检测安装与登录状态、代跑 serve、读出 ts.net 地址；
 *  - 我们不能代做的：手机上安装并登录 Tailscale App（首次登录需要
 *    外网账号授权——用户已确认有梯子）；管理台开启 MagicDNS 与
 *    HTTPS 证书（tailnet 全局，各一次点击，serve 失败时给出直链）。
 *
 * serve 配置持久化在 tailscaled 里，所以本适配器**没有进程要守护**：
 * 配过一次，重启电脑后依然生效。
 */
export class TailscaleTransport implements TransportAdapter {
  readonly mode = 'tailscale' as const;
  readonly autoDetected = false;

  private readonly server: ServerConfig;
  private readonly config: UniConfig;
  private readonly lan: () => LanAddress[];

  private cached: TransportStatus | undefined;
  private cachedAt = 0;
  private dnsName: string | undefined;

  constructor(server: ServerConfig, config: UniConfig, lan: () => LanAddress[]) {
    this.server = server;
    this.config = config;
    this.lan = lan;
  }

  private binary(): string | undefined {
    const typical = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : '/usr/bin/tailscale';
    if (existsSync(typical)) return typical;
    return findExecutable('tailscale');
  }

  status(): TransportStatus {
    // status() 是同步接口；检测是异步子进程调用，由 API 触发后缓存 here。
    return (
      this.cached ?? {
        mode: this.mode,
        ready: false,
        hint: '尚未检测。点「检测状态」读取本机 Tailscale 的安装与登录情况。',
        endpoints: [],
      }
    );
  }

  endpoints(): AdvertisedEndpoint[] {
    const out: AdvertisedEndpoint[] = [];
    if (this.dnsName) {
      out.push({
        url: `https://${this.dnsName}`,
        mode: 'tailscale',
        label: 'Tailscale（HTTPS · 固定地址 · 组网）',
        priority: 0,
        warning: '手机需登录同一 Tailscale 账号并开启连接',
      });
    }
    for (const entry of this.lan()) {
      out.push({
        url: `http://${entry.address}:${this.server.port}`,
        mode: 'tailscale',
        label: `局域网 · ${entry.iface}`,
        priority: 10 + entry.rank,
      });
    }
    return out;
  }

  /**
   * 全量检测：是否安装 → 是否登录 → 是否开启 serve → ts.net 名称。
   * 结果缓存 10 秒，供频繁的 bootstrap / status 查询。
   */
  async detect(): Promise<TransportStatus> {
    const bin = this.binary();
    if (!bin) {
      this.cached = {
        mode: this.mode,
        ready: false,
        hint: '本机未安装 Tailscale。下载：https://tailscale.com/download（安装后点「检测状态」）',
        endpoints: this.lanFallback(),
      };
      this.cachedAt = Date.now();
      return this.cached;
    }

    let stateJson: {
      BackendState?: string;
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    } = {};
    try {
      const { stdout } = await run(bin, ['status', '--json'], { windowsHide: true, timeout: 8_000 });
      stateJson = JSON.parse(stdout) as typeof stateJson;
    } catch (err) {
      this.cached = {
        mode: this.mode,
        ready: false,
        hint: `无法读取 Tailscale 状态：${(err as Error).message.slice(0, 120)}`,
        endpoints: this.lanFallback(),
      };
      this.cachedAt = Date.now();
      return this.cached;
    }

    const backend = stateJson.BackendState ?? 'Unknown';
    if (backend !== 'Running') {
      this.cached = {
        mode: this.mode,
        ready: false,
        hint:
          backend === 'NeedsLogin'
            ? 'Tailscale 已安装但未登录：打开系统托盘的 Tailscale 图标完成登录（需要外网账号授权，一次即可）。'
            : `Tailscale 状态异常：${backend}`,
        endpoints: this.lanFallback(),
      };
      this.cachedAt = Date.now();
      return this.cached;
    }

    this.dnsName = stateJson.Self?.DNSName?.replace(/\.$/, '');
    const serving = await this.isServing(bin);

    const hint = serving
      ? undefined
      : this.dnsName
        ? '已登录。点「启用 HTTPS 发布」即可获得固定地址（若失败，通常需要先在管理台开启 MagicDNS 与 HTTPS）。'
        : '已登录，但未读取到 MagicDNS 名称：请在 https://login.tailscale.com/admin/dns 开启 MagicDNS。';

    this.cached = {
      mode: this.mode,
      ready: serving && Boolean(this.dnsName),
      hint,
      endpoints: this.endpoints(),
    };
    this.cachedAt = Date.now();
    log.info('状态检测完成', { backend, dnsName: this.dnsName, serving });
    return this.cached;
  }

  /**
   * 开机自愈：已登录且有 MagicDNS 名、但 serve 未在位时自动补启。
   *
   * serve 配置理论上持久化在 tailscaled 里，但实际会因客户端更新/重登等
   * 情况丢失——用户在界面上点过一次「启用」，就应当永远生效，而不是每次
   * 重启都要重新点。幂等，安全。
   */
  async ensureReady(): Promise<TransportStatus> {
    const status = await this.detect();
    if (status.ready) return status;
    if (this.dnsName) {
      try {
        return await this.enableServe();
      } catch (err) {
        log.warn('开机自愈补启 serve 失败', { reason: (err as Error).message });
      }
    }
    return this.cached ?? status;
  }

  /** 代跑 `tailscale serve --bg`，把本服务发布为 ts.net HTTPS。 */
  async enableServe(): Promise<TransportStatus> {
    const bin = this.binary();
    if (!bin) throw new Error('本机未安装 Tailscale。下载：https://tailscale.com/download');

    const target = `http://127.0.0.1:${this.server.port}`;
    try {
      await run(bin, ['serve', '--bg', target], { windowsHide: true, timeout: 15_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/HTTPS|MagicDNS|cert/i.test(message)) {
        throw new Error(
          '需要在管理台开启 MagicDNS 与 HTTPS 证书（各一次点击）：https://login.tailscale.com/admin/dns 。开启后重试。',
        );
      }
      // 旧版本语法兜底：`tailscale serve --bg <port>`
      try {
        await run(bin, ['serve', '--bg', String(this.server.port)], { windowsHide: true, timeout: 15_000 });
      } catch (err2) {
        throw new Error(`serve 失败：${(err2 as Error).message.slice(0, 200)}`);
      }
    }

    log.info('tailscale serve 已启用', { target });
    this.cachedAt = 0;
    return this.detect();
  }

  async disableServe(): Promise<TransportStatus> {
    const bin = this.binary();
    if (!bin) throw new Error('本机未安装 Tailscale');
    try {
      await run(bin, ['serve', '--bg', 'off'], { windowsHide: true, timeout: 15_000 });
    } catch {
      try {
        await run(bin, ['serve', 'off'], { windowsHide: true, timeout: 15_000 });
      } catch {
        // 没配置过 serve 时 off 会报错——视为已关闭。
      }
    }
    this.cachedAt = 0;
    return this.detect();
  }

  private async isServing(bin: string): Promise<boolean> {
    try {
      const { stdout } = await run(bin, ['serve', 'status'], { windowsHide: true, timeout: 8_000 });
      return stdout.includes('https://');
    } catch {
      return false;
    }
  }

  private lanFallback(): AdvertisedEndpoint[] {
    return this.endpoints().filter((e) => e.mode === 'lan' || !this.dnsName);
  }
}
