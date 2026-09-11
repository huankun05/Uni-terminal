import type { TransportMode } from '../config.ts';

/**
 * Transport adapters.
 *
 * "How does the phone reach this machine" is a separate concern from "who is
 * allowed in", and it is the one part of the stack where the right answer
 * depends on the user's network rather than on our code. So it is an interface
 * with pluggable implementations, not a hard-coded assumption.
 *
 * Scope for v1 is deliberately just `lan`: the same-WiFi case covers the
 * overwhelming majority of real usage, needs no account, no domain and no
 * third party, and is therefore the only one that can be zero-config.
 *
 * Everything else is a stub that returns a usable URL or an honest
 * explanation of what the user must supply — the interface exists now so that
 * adding `cloudflare` / `easytier` later is a new file, not a refactor.
 */

export interface AdvertisedEndpoint {
  /** URL the phone should dial. */
  url: string;
  /** Which adapter produced it. */
  mode: TransportMode;
  /** Human label, e.g. "家庭 WiFi". */
  label: string;
  /** Lower sorts first in the UI. */
  priority: number;
  /** Caveats worth surfacing, e.g. "CF 可解密流量". */
  warning?: string;
}

export interface TransportStatus {
  mode: TransportMode;
  ready: boolean;
  /** What the user still has to do, if anything. */
  hint?: string;
  endpoints: AdvertisedEndpoint[];
}

export interface TransportAdapter {
  readonly mode: TransportMode;
  /** Whether this adapter can produce an endpoint on a plain boot. */
  readonly autoDetected: boolean;
  status(): TransportStatus;
  /** Called once at boot; may shell out to an external tunnel binary. */
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
