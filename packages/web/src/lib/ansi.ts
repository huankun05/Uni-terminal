/**
 * ANSI escape handling for the PTY summary view (实施01 §3.6).
 *
 * PTY mode has no structured events — the phone's readable view is the raw
 * byte stream with escapes stripped and control noise removed. It is a lossy
 * "what is it typing" view by design; the full-fidelity view is the terminal
 * pane (xterm, 懒加载, M4 接入).
 */

const ESC = '\u001b';

/** Strips CSI/OSC escapes, SGR colour codes and remaining control chars. */
export function stripAnsi(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === undefined) break;
    if (ch !== ESC) {
      // keep printable + newline/tab; drop the rest of the C0 range
      if (ch === '\n' || ch === '\t' || (ch >= ' ' && ch !== '\u007f')) out += ch;
      else if (ch === '\r') {
        // CR used for spinner/progress redraws — collapse, don't emit
      }
      continue;
    }

    const next = input[i + 1];
    if (next === '[') {
      // CSI: parameters then a final byte in @-~
      i += 2;
      while (i < input.length && !/[A-Za-z@~]/.test(input[i] ?? '')) i += 1;
    } else if (next === ']') {
      // OSC:terminated by BEL or ST
      i += 2;
      while (i < input.length) {
        if (input[i] === '\u0007') break;
        if (input[i] === ESC && input[i + 1] === '\\') { i += 1; break; }
        i += 1;
      }
    } else if (next !== undefined) {
      // two-byte escapes like ESC ( B, ESC } etc.
      i += 1;
    }
  }
  return out;
}

/** Tail summary: last non-empty lines, capped, for a "它现在在打什么" card. */
export function ansiTail(input: string, maxLines = 6, maxChars = 600): string {
  const lines = stripAnsi(input)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}
