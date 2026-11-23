// mend: one patch tool for every AI edit format.
//
// Reads a patch (unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits),
// finds the lines each edit names at the first of three matching tiers,
// and writes every change or none. SPEC.md is the contract; this file is a
// fresh implementation of it. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** A file's lines under its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const idx = text.indexOf('\n');
  const br = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** Tier-2 re-indent of one new line: replace O's first line's leading whitespace by the file's. */
function reindent(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** One replacement: N's lines over O's lines at position pos. Context lines take the file's own lines. */
interface NewLine {
  text: string;
  ctx: number | null;
}

function replaceAt(lines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const p = o.length === 0 ? '' : leadingWs(o[0]);
  const f = o.length === 0 || pos >= lines.length ? '' : leadingWs(lines[pos]!);
  const out = lines.slice(0, pos);
  for (const e of n) {
    if (e.ctx !== null) out.push(lines[pos + e.ctx]!);
    else if (tier === 2) out.push(reindent(e.text, p, f));
    else out.push(e.text);
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

function occursAt(lines: string[], o: string[], at: number, tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) {
    if (!lineEq(lines[at + k]!, o[k]!, tier)) return false;
  }
  return true;
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at least once, at or after `from`, with every position. */
function findFirstTier(lines: string[], o: string[], from: number, maxTier = 2): TierHit | null {
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const positions: number[] = [];
    for (let p = from; p + o.length <= lines.length; p += 1) {
      if (occursAt(lines, o, p, tier)) positions.push(p);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  write(p: string, text: string): void {
    this.now.set(p, text);
  }

  remove(p: string): void {
    this.now.set(p, null);
    this.moves.delete(p);
  }

  move(oldP: string, newP: string, text: string): void {
    const src = this.moves.get(oldP) ?? oldP;
    this.moves.delete(oldP);
    this.moves.set(newP, src);
    this.now.set(oldP, null);
    this.now.set(newP, text);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.write(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.write(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const fl = splitFile(before);
      if (line < 0 || line > fl.lines.length) throw new Fail('no-match', p);
      const lines = fl.lines.slice();
      lines.splice(line, 0, ...add);
      tree.write(p, renderFile(lines, fl.br, fl.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

interface UHunk {
  a: number;
  body: UBodyLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  oldFromHeader: boolean;
  newFromHeader: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, spaces removed, a/ or b/ removed. */
function diffPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let phase: 'header' | 'hunks' = 'header';
  let hunk: UHunk | null = null;

  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === 'ctx' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      hunk = null;
    }
  };

  const startSection = (oldP: string | null, newP: string | null): void => {
    sec = { oldPath: oldP, newPath: newP, oldFromHeader: false, newFromHeader: false, isCreate: false, isDelete: false, hunks: [] };
    sections.push(sec);
    phase = 'header';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const kind = line === '' ? 'ctx' : line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'backslash';
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1) });
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (sec !== null && phase === 'header') {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.oldPath = diffPath(line);
        sec.oldFromHeader = true;
        i += 1;
        continue;
      }
      if (line.startsWith('+++ ')) {
        sec.newPath = diffPath(line);
        sec.newFromHeader = true;
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!sec.oldFromHeader) sec.oldPath = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!sec.newFromHeader) sec.newPath = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        hunk = { a, body: [] };
        sec.hunks.push(hunk);
        phase = 'hunks';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(null, null);
      sec!.oldPath = diffPath(line);
      sec!.oldFromHeader = true;
      i += 1;
      continue;
    }
    if (sec !== null && phase === 'hunks') {
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        hunk = { a, body: [] };
        sec.hunks.push(hunk);
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  endBody();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.oldPath ?? s.newPath;
    const newP = s.newPath ?? s.oldPath;
    if (oldP === null || newP === null) throw new Exit2('error: parse 1');
    edits.push(unifiedEdit(s, oldP, newP, strict));
  }
  return edits;
}

function hunkON(h: UHunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(h: UHunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j -= 1) {
    const b = h.body[j]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      const next = h.body[j + 1];
      return next !== undefined && next.kind === 'backslash';
    }
  }
  return false;
}

/** Whether a `\` line follows the hunk's last `+` line (create branch only: SPEC §6 counts only the last `+` line). */
function backslashAfterLastPlus(h: UHunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j -= 1) {
    if (h.body[j]!.kind === 'new') {
      const next = h.body[j + 1];
      return next !== undefined && next.kind === 'backslash';
    }
  }
  return false;
}

function unifiedEdit(s: USection, oldP: string, newP: string, strict: boolean): Edit {
  return (tree) => {
    if (oldP !== '/dev/null' && !safePath(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== '/dev/null' && newP !== oldP && !safePath(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === '/dev/null' || s.isCreate;
    const isDelete = newP === '/dev/null' || s.isDelete;
    if (isCreate) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      }
      let finalBreak = true;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        const h = s.hunks[k]!;
        if (h.body.some((b) => b.kind === 'new')) {
          finalBreak = !backslashAfterLastPlus(h);
          break;
        }
      }
      tree.write(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.remove(oldP);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let fl = splitFile(before);
    let lines = fl.lines;
    let final = fl.final;
    let d = 0;
    for (const h of s.hunks) {
      const { o, n } = hunkON(h);
      if (o.length === 0) {
        const idx = Math.max(0, Math.min(h.a + d, lines.length));
        const ins = n.map((e) => e.text);
        lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
        if (idx === lines.length - ins.length && ins.length > 0) final = !backslashAfterLast(h);
        else if (idx === lines.length && ins.length === 0) final = !backslashAfterLast(h);
        d += n.length;
        continue;
      }
      const found = findFirstTier(lines, o, 0, strict ? 0 : 2);
      if (found === null) throw new Fail('no-match', oldP);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + o.length === lines.length;
      lines = replaceAt(lines, best, o, n, found.tier);
      if (atEnd) final = !backslashAfterLast(h);
      d += n.length - o.length;
    }
    const out = renderFile(lines, fl.br, final);
    if (oldP !== newP) tree.move(oldP, newP, out);
    else tree.write(oldP, out);
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (;;) {
    let s = -1;
    for (let j = prevEnd; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (eq < 0 && t === '>>>>>>> REPLACE') break;
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.write(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = splitFile(before);
    const found = findFirstTier(fl.lines, oldLines, 0, strict ? 0 : 2);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const p = leadingWs(oldLines[0]!);
    const f = leadingWs(fl.lines[pos]!);
    const replacement = newLines.map((t) => (found.tier === 2 ? reindent(t, p, f) : t));
    const out = [...fl.lines.slice(0, pos), ...replacement, ...fl.lines.slice(pos + oldLines.length)];
    tree.write(path, renderFile(out, fl.br, fl.final));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  endOfFile: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const [marker, kind] of [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'delete'],
    ['*** Update File:', 'update'],
  ] as const) {
    if (line.startsWith(marker)) return { kind, path: line.slice(marker.length).trim() };
  }
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const start = v4aSectionStart(line);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    if (start.kind === 'add') {
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && v4aSectionStart(lines[j]!) === null) {
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const collected: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) collected.push(l.slice(1));
        else if (l === '') collected.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(start.path, collected));
      i = j;
      continue;
    }
    if (start.kind === 'delete') {
      edits.push(v4aDeleteEdit(start.path));
      i += 1;
      continue;
    }
    // update
    let j = i + 1;
    let moveTo: string | null = null;
    if (j < last && lines[j]!.startsWith('*** Move to:')) {
      moveTo = lines[j]!.slice('*** Move to:'.length).trim();
      j += 1;
    }
    const raw: string[] = [];
    const rawBase = j;
    while (j < last && v4aSectionStart(lines[j]!) === null) {
      raw.push(lines[j]!);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const chunks = parseV4aChunks(raw, rawBase);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(v4aUpdateEdit(start.path, moveTo, chunks, strict));
    i = j;
  }
  return edits;
}

function parseV4aChunks(raw: string[], rawBase: number): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let o: string[] = [];
  let n: NewLine[] = [];
  const flush = (endOfFile: boolean): void => {
    if (cur === null) return;
    cur.o = o;
    cur.n = n;
    cur.endOfFile = endOfFile;
    chunks.push(cur);
    cur = null;
    o = [];
    n = [];
  };
  for (let k = 0; k < raw.length; k += 1) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      flush(false);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], endOfFile: false };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${rawBase + k + 1}`);
      flush(true);
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length > 0) {
          if (l === '') continue;
          throw new Exit2(`error: parse ${rawBase + k + 1}`);
        }
        cur = { anchor: null, o: [], n: [], endOfFile: false };
      }
      if (l === '') {
        o.push('');
        n.push({ text: '', ctx: o.length - 1 });
      } else if (l[0] === ' ') {
        o.push(l.slice(1));
        n.push({ text: l.slice(1), ctx: o.length - 1 });
      } else if (l[0] === '-') {
        o.push(l.slice(1));
      } else {
        n.push({ text: l.slice(1), ctx: null });
      }
      continue;
    }
    throw new Exit2(`error: parse ${rawBase + k + 1}`);
  }
  flush(false);
  return chunks;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.write(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.remove(path);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fl = splitFile(before);
    let lines = fl.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let foundLine = -1;
        for (let tier = 0; tier <= (strict ? 0 : 2) && foundLine < 0; tier += 1) {
          for (let j = cursor; j < lines.length; j += 1) {
            if (lineEq(lines[j]!, chunk.anchor, tier)) {
              foundLine = j;
              break;
            }
          }
        }
        if (foundLine < 0) throw new Fail('no-match', path);
        cursor = foundLine + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.endOfFile ? lines.length : cursor;
        const ins = chunk.n.map((e) => e.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (let tier = 0; tier <= (strict ? 0 : 2) && found === null; tier += 1) {
        for (let p = cursor; p + chunk.o.length <= lines.length; p += 1) {
          if (!occursAt(lines, chunk.o, p, tier)) continue;
          if (chunk.endOfFile && p + chunk.o.length !== lines.length) continue;
          found = { tier, pos: p };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      lines = replaceAt(lines, found.pos, chunk.o, chunk.n, found.tier);
      cursor = found.pos + chunk.n.length;
    }
    const out = renderFile(lines, fl.br, fl.final);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.write(path, out);
  };
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapNow = new Map(tree.now);
    const snapMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapNow) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of snapMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [newP, oldP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    const deleted: string[] = [];
    const written: [string, string][] = [];
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.get(p)!;
      if (was === now) continue;
      if (now === null) deleted.push(p);
      else written.push([p, now]);
    }
    for (const p of deleted) rmSync(p, { force: true });
    for (const [p, content] of written) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
