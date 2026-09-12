import { networkInterfaces } from 'node:os';
import type { ServerConfig, TransportMode, UniConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { CloudflareTransport } from './cloudflare.ts';
import { TailscaleTransport } from './tailscale.ts';
import type { AdvertisedEndpoint, TransportAdapter, TransportStatus } from './types.ts';

const log = createLogger('transport');

export interface LanAddress {
  iface: string;
  address: string;
  /** Sort key: lower is a more likely "this is my real LAN" candidate. */
  rank: number;
}

/**
 * Enumerates private IPv4 addresses, best candidate first.
 *
 * Ranking matters more than it looks: a Windows box routinely has half a dozen
 * addresses (Hyper-V switches, WSL, Docker, VPN, VirtualBox), and putting a
 * `172.x` virtual adapter in the QR code produces a pairing flow that silently
 * fails for reasons the user cannot see. So the ranking encodes what actually
 * correlates with "the WiFi the phone is also on".
 */
export function lanAddresses(): LanAddress[] {
  const found: LanAddress[] = [];
  const ifaces = networkInterfaces();

  for (const [name, entries] of Object.entries(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const rank = rankAddress(name, entry.address);
      if (rank === null) continue;
      found.push({ iface: name, address: entry.address, rank });
    }
  }

  return found.sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address));
}

/** Exported for the smoke test — the QR code depends on this classification. */
export function rankAddress(iface: string, address: string): number | null {
  // Never advertise a loopback or link-local (169.254/16, i.e. no DHCP lease).
  if (address.startsWith('127.') || address.startsWith('169.254.')) return null;

  // 198.18.0.0/15 is the benchmark range fake-IP TUN adapters (Mihomo / Clash,
  // sing-box) bind on the host itself. It shows up as a normal-looking private
  // address but a phone can never route to it — advertising it produces a QR
  // code that silently fails, so it must be dropped, not merely ranked low.
  if (/^198\.1[89]\./.test(address)) return null;

  const lower = iface.toLowerCase();
  const virtualHint = /(vethernet|wsl|docker|hyper-v|vmware|virtualbox|loopback|tap|tun|utun|zerotier|tailscale|radmin|mihomo|clash|sing-box)/.test(lower)
    ? 40
    : 0;

  if (address.startsWith('192.168.')) return 10 + virtualHint;
  if (address.startsWith('10.')) return 20 + virtualHint;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 30 + virtualHint;
  // Public or unusual address space: still usable, but least preferred.
  return 50 + virtualHint;
}

export class LanTransport implements TransportAdapter {
  readonly mode: TransportMode = 'lan';
  readonly autoDetected = true;
  private readonly server: ServerConfig;
  private readonly config: UniConfig;

  constructor(server: ServerConfig, config: UniConfig) {
    this.server = server;
    this.config = config;
  }

  status(): TransportStatus {
    const endpoints = this.endpoints();
    return {
      mode: 'lan',
      ready: endpoints.length > 0,
      hint: endpoints.length === 0 ? '没有找到可用的局域网地址，请确认电脑已连接 WiFi 或有线网络。' : undefined,
      endpoints,
    };
  }

  /** Ordered list; the QR code uses the first entry. */
  endpoints(): AdvertisedEndpoint[] {
    if (this.config.transport.mode === 'manual' && this.config.transport.publicUrl) {
      return [
        {
          url: this.config.transport.publicUrl,
          mode: 'manual',
          label: '手动指定地址',
          priority: 0,
        },
      ];
    }

    return lanAddresses().map((entry) => ({
      url: `http://${formatHost(entry.address)}:${this.server.port}`,
      mode: 'lan' as const,
      label: `局域网 · ${entry.iface}`,
      priority: entry.rank,
    }));
  }

  primaryUrl(): string | undefined {
    const first = this.endpoints()[0];
    return first?.url;
  }
}

function formatHost(address: string): string {
  // IPv6 needs brackets in a URL; we only advertise IPv4 today but keep this
  // correct so an ipv6 adapter can reuse it.
  return address.includes(':') ? `[${address}]` : address;
}

/**
 * Placeholder adapters.
 *
 * Each returns a status the UI can render honestly: what this mode needs, and
 * why it is not ready. Implementing one is a matter of adding a file — no
 * changes to routing, auth or the UI shell are required.
 */
export class UnconfiguredTransport implements TransportAdapter {
  readonly autoDetected = false;
  readonly mode: TransportMode;
  private readonly requirement: string;

  constructor(mode: TransportMode, requirement: string) {
    this.mode = mode;
    this.requirement = requirement;
  }

  status(): TransportStatus {
    return { mode: this.mode, ready: false, hint: this.requirement, endpoints: [] };
  }
}

export interface TransportRegistry {
  active: TransportAdapter;
  all: TransportStatus[];
  /** 直接引用，供管理台启停隧道（状态查询走 /api/local/transport）。 */
  cloudflare: CloudflareTransport;
  /** 直接引用，供管理台检测/启停 ts.net 发布。 */
  tailscale: TailscaleTransport;
}

export function createTransportRegistry(config: UniConfig): TransportRegistry {
  const lanAddressesFn = (): LanAddress[] => lanAddresses();
  const lan = new LanTransport(config.server, config);
  const cloudflare = new CloudflareTransport(config.server, config, lanAddressesFn);
  const tailscale = new TailscaleTransport(config.server, config, lanAddressesFn);

  const others: TransportAdapter[] = [
    cloudflare,
    new UnconfiguredTransport('easytier', '需要安装 EasyTier 并加入同一网络（国内延迟 20-60ms）。'),
    new UnconfiguredTransport('ipv6', '需要家宽分配公网 IPv6 且路由器放行。'),
    new UnconfiguredTransport('frp', '需要一台有公网 IP 的服务器。'),
  ];

  const active = config.transport.mode === 'cloudflare'
    ? cloudflare
    : (others.find((t) => t.mode === config.transport.mode && t !== cloudflare) ?? lan);

  const all = [lan, ...others].map((t) => t.status());
  log.info('传输层就绪', {
    active: active.mode,
    lanCandidates: lan.endpoints().length,
  });

  return {
    active,
    all: () => [lan, ...others].map((t) => t.status()),
    cloudflare,
    tailscale,
  };
}
