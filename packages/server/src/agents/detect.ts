import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
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

/**
 * Directories beyond `process.env.PATH` that agent CLIs hide in.
 *
 * `process.env.PATH` alone is not enough: the service is frequently started by
 * the Task Scheduler or a detached launcher, where PATH differs from the
 * interactive shell's — and npm global installs (`claude`, `codex`, `qwen`…)
 * land in `%APPDATA%\npm` precisely when that entry is missing. Version
 * managers (volta / pnpm / bun / fnm) each own a shim directory too.
 */
function environmentSearchDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) dirs.push(join(appData, 'npm'));
    if (localAppData) {
      dirs.push(join(localAppData, 'pnpm'));
      dirs.push(join(localAppData, 'Volta', 'bin'));
      dirs.push(join(localAppData, 'Programs'));
    }
    dirs.push(join(home, '.bun', 'bin'));
    dirs.push(join(home, '.local', 'bin'));
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');
    dirs.push(join(home, '.local', 'bin'));
    dirs.push(join(home, '.bun', 'bin'));
    dirs.push(join(home, '.npm-global', 'bin'));
  }

  return dirs;
}

/** Extra directories contributed by slower sources (Windows registry PATH). */
let augmentedDirs: string[] = [];

/**
 * One-time async augmentation. The Windows registry holds the *original*
 * user/system PATH; a service process often inherits a trimmed one, so this is
 * the last reliable source. Cheap enough to run once at boot: a single
 * `reg query` per hive, hidden, best-effort.
 */
export async function augmentSearchDirs(): Promise<void> {
  if (process.platform !== 'win32') return;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const hives = [
    ['HKCU\\Environment', 'Path'],
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'],
  ] as const;

  const found: string[] = [];
  for (const [key, value] of hives) {
    try {
      const { stdout } = await run('reg', ['query', key, '/v', value], { windowsHide: true });
      // Output line looks like: `    Path    REG_EXPAND_SZ    C:\a;C:\b`
      const match = /REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(stdout);
      if (match?.[1]) {
        for (const dir of match[1].trim().split(';')) {
          const expanded = dir.trim().replace(/%([^%]+)%/g, (_, name: string) =>
            process.env[name.toUpperCase()] ?? '',
          );
          if (expanded.length > 0) found.push(expanded);
        }
      }
    } catch {
      // Missing key or reg unavailable — the other sources still stand.
    }
  }
  augmentedDirs = found;
}

function allSearchDirs(): string[] {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
  return [...pathDirs, ...environmentSearchDirs(), ...augmentedDirs];
}

export function findExecutable(name: string): string | undefined {
  if (isAbsolute(name)) {
    return existsSync(name) ? name : undefined;
  }

  const exts = extensions();

  for (const dir of allSearchDirs()) {
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
