/**
 * Built-in agent catalog.
 *
 * Mirrors the registry that `acpx` ships (22 entries at the time of writing),
 * so a name typed here resolves to exactly the same adapter command acpx would
 * pick. Keeping our own copy means:
 *   1. we can show a "not installed yet" list without shelling out to acpx;
 *   2. we never have to guess a binary name at runtime.
 *
 * Source of truth: https://github.com/openclaw/acpx/blob/main/docs/agents.md
 *
 * `probe` is the executable we look for on PATH to decide whether the agent is
 * usable on this machine. Adapters launched through `npx -y` have no local
 * binary, so they probe as the package manager instead.
 */

export type AgentTransport = 'acp' | 'pty' | 'claude-json';

export interface CatalogEntry {
  /** acpx-friendly name, also the id users write in config. */
  id: string;
  /** Human label shown in the UI. */
  label: string;
  /** Upstream project, for the "what is this" tooltip. */
  upstream: string;
  /** Default acpx adapter command (informational; acpx owns the real value). */
  adapter: string;
  /** Executable(s) checked on PATH to decide installed / not installed. */
  probe: string[];
  /** Adapter runs through npx, so a local binary is not expected. */
  viaNpx: boolean;
}

export const AGENT_CATALOG: CatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', upstream: 'claude.ai/code', adapter: 'npx -y @agentclientprotocol/claude-agent-acp', probe: ['claude'], viaNpx: true },
  { id: 'codex', label: 'OpenAI Codex', upstream: 'codex.openai.com', adapter: 'npx -y @agentclientprotocol/codex-acp', probe: ['codex'], viaNpx: true },
  { id: 'gemini', label: 'Gemini CLI', upstream: 'github.com/google/gemini-cli', adapter: 'gemini --acp', probe: ['gemini'], viaNpx: false },
  { id: 'cursor', label: 'Cursor CLI', upstream: 'cursor.com/docs/cli', adapter: 'cursor-agent acp', probe: ['cursor-agent'], viaNpx: false },
  { id: 'copilot', label: 'GitHub Copilot CLI', upstream: 'docs.github.com/copilot', adapter: 'copilot --acp --stdio', probe: ['copilot'], viaNpx: false },
  { id: 'droid', label: 'Factory Droid', upstream: 'factory.ai', adapter: 'droid exec --output-format acp', probe: ['droid'], viaNpx: false },
  { id: 'iflow', label: 'iFlow CLI', upstream: 'github.com/iflow-ai/iflow-cli', adapter: 'iflow --experimental-acp', probe: ['iflow'], viaNpx: false },
  { id: 'kilocode', label: 'Kilocode', upstream: 'kilocode.ai', adapter: 'npx -y @kilocode/cli acp', probe: ['npx'], viaNpx: true },
  { id: 'kimi', label: 'Kimi CLI', upstream: 'github.com/MoonshotAI/kimi-cli', adapter: 'kimi acp', probe: ['kimi'], viaNpx: false },
  { id: 'kiro', label: 'Kiro CLI', upstream: 'kiro.dev', adapter: 'kiro-cli-chat acp', probe: ['kiro-cli-chat'], viaNpx: false },
  { id: 'mcode', label: 'MiniMax Code', upstream: 'npmjs.com/package/@minimax-ai/code', adapter: 'mcode acp', probe: ['mcode'], viaNpx: false },
  { id: 'mux', label: 'Mux', upstream: 'mux.coder.com', adapter: 'mux acp', probe: ['mux'], viaNpx: false },
  { id: 'opencode', label: 'OpenCode', upstream: 'opencode.ai', adapter: 'npx -y opencode-ai acp', probe: ['npx'], viaNpx: true },
  { id: 'pool', label: 'Poolside', upstream: 'poolside.ai', adapter: 'pool acp', probe: ['pool'], viaNpx: false },
  { id: 'qoder', label: 'Qoder CLI', upstream: 'docs.qoder.com/cli', adapter: 'qodercli --acp', probe: ['qodercli'], viaNpx: false },
  { id: 'qwen', label: 'Qwen Code', upstream: 'github.com/QwenLM/qwen-code', adapter: 'qwen --acp', probe: ['qwen'], viaNpx: false },
  { id: 'trae', label: 'Trae CLI', upstream: 'docs.trae.cn/cli', adapter: 'traecli acp serve', probe: ['traecli'], viaNpx: false },
  { id: 'zeroclaw', label: 'ZeroClaw', upstream: 'github.com/zeroclaw-labs/zeroclaw', adapter: 'zeroclaw acp', probe: ['zeroclaw'], viaNpx: false },
  { id: 'pi', label: 'Pi Coding Agent', upstream: 'github.com/mariozechner/pi', adapter: 'npx pi-acp', probe: ['npx'], viaNpx: true },
  { id: 'openclaw', label: 'OpenClaw', upstream: 'github.com/openclaw/openclaw', adapter: 'openclaw acp', probe: ['openclaw'], viaNpx: false },
  { id: 'fast-agent', label: 'fast-agent', upstream: 'fast-agent.ai/acp', adapter: 'uvx fast-agent-mcp acp', probe: ['uvx'], viaNpx: false },
  { id: 'grok-build', label: 'Grok Build', upstream: 'docs.x.ai/build', adapter: 'grok agent stdio', probe: ['grok'], viaNpx: false },
];

const BY_ID = new Map(AGENT_CATALOG.map((entry) => [entry.id, entry]));

/** Aliases acpx also accepts. */
const ALIASES: Record<string, string> = {
  'factory-droid': 'droid',
  factorydroid: 'droid',
};

export function lookupAgent(id: string): CatalogEntry | undefined {
  const canonical = ALIASES[id] ?? id;
  return BY_ID.get(canonical);
}

export function catalogEntryIds(): string[] {
  return AGENT_CATALOG.map((entry) => entry.id);
}
