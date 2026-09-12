import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AGENT_CATALOG } from './catalog.ts';
import { detectAgent, type AgentAvailability } from './detect.ts';

/**
 * The first-boot environment survey.
 *
 * The design goal (实施文档 01 §2) is that "configuring a path" should be
 * replaced by "discovering it": a fresh install probes everything it can see,
 * enables what it finds (E5: detected agents default to *enabled*, not off),
 * writes the result to the config file and prints it in the banner. The user
 * who already uses Claude Code therefore never sees a settings screen.
 */

export interface EnvironmentSurvey {
  agents: AgentAvailability[];
  /** Git-workspace candidates for the first-run UI: `~/Projects/<repo>` & co. */
  workspaceCandidates: string[];
}

/** Home sub-directories that plausibly contain code checkouts. */
const WORKSPACE_PARENTS = ['Projects', 'Code', 'Work', 'Create', 'Desktop', 'Documents', 'repos'];

export function detectAllAgents(): AgentAvailability[] {
  return AGENT_CATALOG.map((entry) => detectAgent(entry));
}

/**
 * Scans well-known home locations one level deep for git repositories. Never
 * throws, never returns more than a handful of entries, and does not follow
 * symlinks — this runs on the boot path.
 */
export function workspaceCandidates(home = homedir()): string[] {
  const found: string[] = [];
  for (const parent of WORKSPACE_PARENTS) {
    const parentDir = join(home, parent);
    if (!existsSync(parentDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parentDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name.startsWith('$')) continue;
      const candidate = join(parentDir, name);
      try {
        if (statSync(candidate).isDirectory() && existsSync(join(candidate, '.git'))) {
          found.push(candidate);
        }
      } catch {
        // Unreadable entry — skip it.
      }
      if (found.length >= 12) return found;
    }
  }
  return found;
}

export function surveyEnvironment(): EnvironmentSurvey {
  return {
    agents: detectAllAgents(),
    workspaceCandidates: workspaceCandidates(),
  };
}
