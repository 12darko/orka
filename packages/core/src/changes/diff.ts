/**
 * Line diffs (Myers) and unified-diff hunks, used for change statistics, the supervisor's view of
 * the agent's edits, and reverting a single hunk of an AI change.
 */
export interface DiffOp {
  type: 'equal' | 'insert' | 'delete';
  line: string;
}

export interface DiffLine {
  type: ' ' | '+' | '-';
  /** The line including its terminator ("\n" or "\r\n"; none on a last line without one). */
  text: string;
}

export interface DiffHunk {
  /** 0-based index of the hunk's first line in the old / new text. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Beyond this many edits the diff gives up on minimality and replaces the changed middle wholesale. */
const MAX_EDIT_DISTANCE = 1500;

/**
 * Lines with their terminators, so joining them gives back the exact text: "a\nb" -> ["a\n", "b"],
 * "" -> []. A changed line ending (or a missing final newline) is a real change.
 */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A line without its terminator, for display. */
export function lineText(line: string): string {
  return line.replace(/\r?\n$/, '');
}

export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB) ?? [...midA.map(del), ...midB.map(ins)];
  return [...a.slice(0, start).map(eq), ...middle, ...a.slice(endA).map(eq)];
}

const eq = (line: string): DiffOp => ({ type: 'equal', line });
const ins = (line: string): DiffOp => ({ type: 'insert', line });
const del = (line: string): DiffOp => ({ type: 'delete', line });

/** Myers' O((N+M)D) shortest edit script; undefined when the edit distance exceeds the cap. */
function myers(a: readonly string[], b: readonly string[]): DiffOp[] | undefined {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map(ins);
  if (!m) return a.map(del);
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for k in [-d, d] as it was before round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return undefined;
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[], dEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(eq(a[x - 1]));
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push(ins(b[y - 1]));
      y--;
    } else {
      ops.push(del(a[x - 1]));
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(eq(a[x - 1]));
    x--;
    y--;
  }
  return ops.reverse();
}

/** Group a diff into hunks with `context` unchanged lines around each change. */
export function buildHunks(ops: readonly DiffOp[], context = 3): DiffHunk[] {
  const positions: Array<{ ai: number; bi: number }> = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    positions.push({ ai, bi });
    if (op.type !== 'insert') ai++;
    if (op.type !== 'delete') bi++;
  }
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === 'equal') {
      index++;
      continue;
    }
    const start = Math.max(index - context, hunks.length ? hunkEndIndex(hunks, positions) : 0);
    let end = index;
    let scan = index;
    while (scan < ops.length) {
      if (ops[scan].type !== 'equal') {
        scan++;
        end = scan;
        continue;
      }
      let run = scan;
      while (run < ops.length && ops[run].type === 'equal') run++;
      if (run < ops.length && run - scan <= 2 * context) {
        scan = run;
        continue;
      }
      break;
    }
    let stop = end;
    while (stop < ops.length && stop < end + context && ops[stop].type === 'equal') stop++;
    const slice = ops.slice(start, stop);
    hunks.push({
      oldStart: positions[start].ai,
      newStart: positions[start].bi,
      oldLines: slice.filter((o) => o.type !== 'insert').length,
      newLines: slice.filter((o) => o.type !== 'delete').length,
      lines: slice.map((o) => ({ type: o.type === 'equal' ? ' ' : o.type === 'insert' ? '+' : '-', text: o.line })),
    });
    index = stop;
  }
  return hunks;
}

/** Op index right after the last hunk (hunks never overlap). */
function hunkEndIndex(hunks: DiffHunk[], positions: Array<{ ai: number; bi: number }>): number {
  const last = hunks[hunks.length - 1];
  const endA = last.oldStart + last.oldLines;
  const endB = last.newStart + last.newLines;
  const found = positions.findIndex((p) => p.ai >= endA && p.bi >= endB);
  return found === -1 ? positions.length : found;
}

export function hunkHeader(h: DiffHunk): string {
  const range = (start: number, count: number) => `${count ? start + 1 : start},${count}`;
  return `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`;
}

/** Undo one hunk: its new lines in `current` go back to the old ones. */
export function revertHunkIn(current: string, hunk: DiffHunk): string {
  const lines = splitLines(current);
  const old = hunk.lines.filter((l) => l.type !== '+').map((l) => l.text);
  lines.splice(hunk.newStart, hunk.newLines, ...old);
  return lines.join('');
}

/** Keep one hunk: the original takes over its new lines, so the hunk no longer counts as a change. */
export function acceptHunkIn(original: string, hunk: DiffHunk): string {
  const lines = splitLines(original);
  const next = hunk.lines.filter((l) => l.type !== '-').map((l) => l.text);
  lines.splice(hunk.oldStart, hunk.oldLines, ...next);
  return lines.join('');
}

export function hunksBetween(before: string | null, after: string | null, context = 3): DiffHunk[] {
  return buildHunks(diffLines(splitLines(before ?? ''), splitLines(after ?? '')), context);
}

/** A unified diff of one file ("a/" and "b/" prefixes, /dev/null for added or deleted files). */
export function unifiedDiff(relPath: string, before: string | null, after: string | null, context = 3): string {
  const hunks = hunksBetween(before, after, context);
  if (!hunks.length) return '';
  const head = `--- ${before === null ? '/dev/null' : `a/${relPath}`}\n+++ ${after === null ? '/dev/null' : `b/${relPath}`}`;
  const render = (l: DiffLine) => `${l.type}${lineText(l.text)}${/\n$/.test(l.text) ? '' : '\n\\ No newline at end of file'}`;
  const body = hunks.map((h) => `${hunkHeader(h)}\n${h.lines.map(render).join('\n')}`).join('\n');
  return `${head}\n${body}`;
}

/** Added and removed line counts. */
export function lineStats(before: string | null, after: string | null): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(splitLines(before ?? ''), splitLines(after ?? ''))) {
    if (op.type === 'insert') added++;
    else if (op.type === 'delete') removed++;
  }
  return { added, removed };
}
