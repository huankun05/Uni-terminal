/**
 * PTY 输出意图识别（ACP 到来前的结构化替代）。
 *
 * Claude Code 的 TUI 虽然只输出终端字节，但它的交互元素有稳定文本特征：
 *   权限菜单：  ❯ 1. Yes   2. Yes, and don't ask again   3. No
 *   确认提问：  Do you want to …? (y/n)
 *   模式状态行：⏵⏵ accept edits on (shift+tab to cycle)
 *
 * 从输出尾部解析这些特征，转成手机上的按钮——识别不到就退回静态快捷键，
 * 识别错了用户直接点静态键兜底，永远不会比纯终端更差。
 */

export type PtyIntentKind = 'menu' | 'yn' | 'none';

export interface PtyIntent {
  kind: PtyIntentKind;
  /** 菜单选项：key 是要发送的字符（如 '1'），label 是选项文本。 */
  options: Array<{ key: string; label: string }>;
  /** Claude Code 当前权限模式（从状态行读取）。 */
  mode?: string;
}

/** Claude Code 权限模式状态行特征 → 展示名。 */
const MODE_PATTERNS: Array<[RegExp, string]> = [
  [/bypass permissions (?:on|enabled)/i, '绕过权限'],
  [/accept edits on/i, '自动接受编辑'],
  [/plan mode on/i, '计划模式'],
];

/** 输入提示行（当前输入框），不参与意图判断。 */
const NOISE = [/(?:esc|ctrl\+c|tab) to (?:cancel|amend|interrupt|cycle)/i, /accept edits on/i, /shift\+tab/i];

export function analyzeTail(stripped: string): PtyIntent {
  const lines = stripped
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-14);
  const tailText = tail.join('\n');

  // 模式：从状态行读当前模式（供徽章展示）。
  let mode: string | undefined;
  for (const [pattern, label] of MODE_PATTERNS) {
    if (pattern.test(tailText)) {
      mode = label;
      break;
    }
  }

  // 菜单：尾部出现 ≥2 条编号选项（1. xxx / ❯ 1. xxx）。
  // TUI 重绘会把多个选项挤进同一行（"1. Yes  2. Yes, don't ask…"），
  // 所以用全局匹配而不是按行匹配：标签止于下一个 "N. "、换行或行尾；
  // 以最后一次出现 ❯ / 提问的位置为锚，避免把历史里的旧菜单拼进来。
  const options: Array<{ key: string; label: string }> = [];
  const anchor = Math.max(
    tailText.lastIndexOf('❯'),
    tailText.lastIndexOf('Do you want'),
    tailText.lastIndexOf('proceed?'),
    tailText.lastIndexOf('(y/n)'),
  );
  if (anchor >= 0) {
    const body = tailText.slice(Math.max(0, anchor - 200));
    const seen = new Set<string>();
    for (const m of body.matchAll(/(?:^|\n|\s)❯?\s*([1-9])\.\s*([^\n]*?)(?=\s{1,}[1-9]\.\s|\n|$)/g)) {
      const key = m[1] as string;
      if (seen.has(key)) continue; // 重绘产生的重复——保留首次（菜单顺序）
      seen.add(key);
      const label = (m[2] as string).replace(/\s+/g, ' ').trim().slice(0, 48);
      if (label.length >= 2) options.push({ key, label });
    }
  }

  if (options.length >= 2) {
    return { kind: 'menu', options, mode };
  }

  // y/n 确认提问。
  const cleanTail = tail.filter((l) => !NOISE.some((n) => n.test(l))).join('\n');
  if (/do you want[^?]*\?|continue\?|\(y\/n\)|yes\/no/i.test(cleanTail)) {
    return { kind: 'yn', options: [], mode };
  }

  return { kind: 'none', options: [], mode };
}

/**
 * 历史视图净化：把 alt-buffer TUI 重绘污染的字节流尽力还原成可读文本。
 *
 * 这是启发式的"尽力可读"，不是忠实还原（忠实还原只有 xterm 终端视图能做）。
 * 处理：TUI 居中导致的怪异缩进 → 去掉；旋转动画残骸（thinking*8thinking…）
 * → 剔除令牌；状态栏提示行（esc to… / Cooked for… / shift+tab…）→ 整行丢弃；
 * 重绘造成的连续重复行 → 去重。
 */
const NOISE_LINE: RegExp[] = [
  /esc to (?:cancel|interrupt|amend|explain)/i,
  /tab to amend/i,
  /ctrl\+[a-z] to /i,
  /\? for shortcuts/i,
  /⏵⏵|accept edits on|plan mode on|bypass permissions/i,
  /cooked for \d+/i,
  /^↳/,
];

export function humanizeTranscript(stripped: string, maxChars = 80_000): string {
  const out: string[] = [];
  let prev = '';
  for (const raw of stripped.split('\n')) {
    // TUI 居中产生的 ≥3 空格缩进直接去掉（保留 1-2 空格的列表缩进）。
    let line = raw.replace(/^\s{3,}/, '');
    // 旋转动画残骸：thinking*8thinking… 之类。
    if (/thinking[\d*…]/.test(line)) {
      line = line.replace(/(?:…)?\s*thinking[\d*…]*\s*/gi, '').trim();
    }
    if (!line.trim()) continue;
    if (NOISE_LINE.some((n) => n.test(line))) continue;
    if (line === prev) continue; // 重绘去重
    prev = line;
    out.push(line);
  }
  const text = out.join('\n');
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}
