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
  const options: Array<{ key: string; label: string }> = [];
  for (let i = tail.length - 1; i >= 0 && options.length < 6; i -= 1) {
    const m = /^\s*❯?\s*([1-9])\.\s*(.{2,60})/.exec(tail[i] ?? '');
    if (m) {
      const key = m[1] as string;
      if (!options.some((o) => o.key === key)) {
        options.unshift({ key, label: (m[2] as string).trim() });
      }
    } else if (options.length > 0 && !/^\s*❯?\s*[1-9]/.test(tail[i] ?? '')) {
      // 菜单块上方出现非选项行即停止——避免把旧输出里的菜单拼进来。
      if (options.length >= 2) break;
      options.length = 0;
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
