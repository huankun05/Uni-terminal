/**
 * Tiny structured logger.
 *
 * Security rule (see docs: "self-written auth fails by omission, not by
 * miscalculation"): this logger must never receive credential material.
 * `redact()` exists so call sites can dump whole objects safely.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

const SECRET_KEYS = [
  'token',
  'tokenhash',
  'token_hash',
  'secret',
  'password',
  'devicecode',
  'device_code',
  'devicecodehash',
  'privatekey',
  'private_key',
  'cookie',
  'authorization',
  'pairingsecret',
];

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.includes(key.toLowerCase())) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactValue(val, depth + 1);
    }
  }
  return out;
}

const MIN_LEVEL: LogLevel = (process.env.UNI_LOG_LEVEL as LogLevel) ?? 'info';

function enabled(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(MIN_LEVEL);
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (!enabled(level)) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) {
    sink(line);
  } else {
    sink(line, JSON.stringify(redactValue(extra)));
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

export { redactValue as redact };
