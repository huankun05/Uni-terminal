import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { CatalogEntry } from './catalog.ts';

/**
 * PATH lookup implemented in-process.
 *
 * We deliberately avoid spawning `where.exe` / `which`: this runs once per
 * configured agent on every boot, and spawning on Windows is both slow and a
 * source of console-window flashes when the parent is a console app.
 */

const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.JS', '.WSF', '.PS1'];

function extensions(): string[] {
  if (process.platform !== 'win32') return [''];
  const raw = process.env.PATHEXT;
  if (!raw) return DEFAULT_PATHEXT;
  const parsed = raw.split(';').filter((e) => e.trim().length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_PATHEXT;
}

export function findExecutable(name: string): string | undefined {
  if (isAbsolute(name)) {
    return existsSync(name) ? name : undefined;
  }

  const pathValue = process.env.PATH ?? '';
  const dirs = pathValue.split(delimiter).filter((d) => d.length > 0);
  const exts = extensions();

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // A PATH entry can contain stale network drives; ignore and continue.
      }
    }
  }
  return undefined;
}

export interface AgentAvailability {
  id: string;
  label: string;
  upstream: string;
  /** Resolved executable path, if any probe hit. */
  binary?: string;
  /** True when this agent can actually be launched here. */
  installed: boolean;
  /** Adapters distributed through npx need no local binary. */
  viaNpx: boolean;
  /** Extra note for the UI, e.g. why something is unavailable. */
  note?: string;
}

export function detectAgent(entry: CatalogEntry): AgentAvailability {
  for (const probe of entry.probe) {
    const binary = findExecutable(probe);
    if (binary) {
      return {
        id: entry.id,
        label: entry.label,
        upstream: entry.upstream,
        binary,
        installed: true,
        viaNpx: entry.viaNpx,
      };
    }
  }

  const note = entry.viaNpx
    ? `需要 ${entry.probe.join(' / ')} 才能通过 npx 拉起适配器`
    : `未在 PATH 中找到 ${entry.probe.join(' / ')}`;

  return {
    id: entry.id,
    label: entry.label,
    upstream: entry.upstream,
    installed: false,
    viaNpx: entry.viaNpx,
    note,
  };
}
