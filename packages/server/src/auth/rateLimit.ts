/**
 * In-memory sliding-window rate limiter.
 *
 * Scope is intentionally narrow: everything it guards (pairing creation,
 * pairing claim, polling cadence) is short-lived state that lives in memory
 * anyway, so a process restart clearing the counters is acceptable — an
 * attacker cannot restart our process.
 *
 * Three layers matter and all three are required (a single layer is the most
 * common way self-written auth gets broken):
 *   1. poll cadence   — stops a client from hammering the status endpoint
 *   2. claim attempts — three strikes invalidates the pairing outright
 *   3. global caps    — stops bulk creation from exhausting the server
 */

interface Bucket {
  /** Timestamps (ms) of hits inside the current window. */
  hits: number[];
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class SlidingWindow {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): RateLimitVerdict {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    const cutoff = now - this.windowMs;
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    this.buckets.set(key, bucket);

    if (bucket.hits.length >= this.limit) {
      const oldest = bucket.hits[0] as number;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      };
    }
    return { allowed: true, remaining: this.limit - bucket.hits.length, retryAfterMs: 0 };
  }

  /** Records a hit. Only call once you have decided to allow the request. */
  hit(key: string, now = Date.now()): void {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits.push(now);
    this.buckets.set(key, bucket);
  }

  /** Atomic check-and-record, the usual call site. */
  consume(key: string, now = Date.now()): RateLimitVerdict {
    const verdict = this.check(key, now);
    if (verdict.allowed) this.hit(key, now);
    return verdict;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drops buckets that have aged out so memory does not grow unbounded. */
  prune(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      const live = bucket.hits.filter((t) => t > now - this.windowMs);
      if (live.length === 0) {
        this.buckets.delete(key);
      } else {
        bucket.hits = live;
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

export function clientIp(headers: Headers, fallback: string): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0];
    if (first) return first.trim();
  }
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  return fallback;
}
