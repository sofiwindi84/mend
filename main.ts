// mend: one command-line tool that applies the edits AI models write, in four
// formats, to a tree of text files. It implements SPEC.md version 1 in full:
// the command line, the output and exit codes, safe paths, format detection,
// three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches
// and JSON edits, applied in order and all-or-nothing. Node 22, standard
// library only, run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseErr {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}

class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function rstrip(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(model: FileModel): string {
  if (model.lines.length === 0) return '';
  return model.lines.join(model.br) + (model.final ? model.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
    return this.orig.get(p) as string | null;
  }
  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------- matching

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(
  lines: string[],
  pat: string[],
  tier: number,
  from: number,
  endAtEnd: boolean,
): number[] {
  const out: number[] = [];
  const k = pat.length;
  if (k === 0) return out;
  for (let i = from; i + k <= lines.length; i++) {
    if (endAtEnd && i + k !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(lines[i + j] as string, pat[j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  pos: number[];
}

function firstTier(
  lines: string[],
  pat: string[],
  strict: boolean,
  from: number,
  endAtEnd: boolean,
): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, pat, t, from, endAtEnd);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface NItem {
  t: string;
  ctx: boolean;
  oi: number;
}

function renderN(
  fileLines: string[],
  at: number,
  pat: string[],
  items: NItem[],
  tier: number,
): string[] {
  const out: string[] = [];
  if (pat.length === 0) {
    for (const it of items) out.push(it.t);
    return out;
  }
  const fLead = leadingWS(fileLines[at] as string);
  const pLead = leadingWS(pat[0] as string);
  for (const it of items) {
    if (it.ctx) {
      out.push((fileLines[at + it.oi] as string) ?? it.t);
      continue;
    }
    if (tier === 2 && it.t !== '' && it.t.trim() !== '' && it.t.startsWith(pLead)) {
      out.push(fLead + it.t.slice(pLead.length));
    } else {
      out.push(it.t);
    }
  }
  return out;
}

interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  blank: boolean;
}

function splitON(body: BodyLine[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ t: b.text, ctx: true, oi });
      oi += 1;
    } else if (b.kind === 'del') {
      o.push(b.text);
      oi += 1;
    } else if (b.kind === 'add') {
      n.push({ t: b.text, ctx: false, oi: -1 });
    }
  }
  return { o, n };
}

// ---------------------------------------------------------------- detection

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- JSON edits

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const path = p;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree: Tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', path);
      if (count > 1) throw new Fail('ambiguous', path);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree: Tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const model = splitText(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', path);
      model.lines.splice(line, 0, ...add);
      tree.now.set(path, joinText(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
  } else {
    lines.forEach((l, i) => {
      if (blank(l)) return;
      let e: Edit | null = null;
      try {
        e = jsonEdit(JSON.parse(l));
      } catch {
        e = null;
      }
      if (e === null) throw new ParseErr(i + 1);
      edits.push(e);
    });
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------- unified

function unifiedPath(line: string): string | null {
  let text = line.slice(4);
  const tab = text.indexOf('\t');
  if (tab >= 0) text = text.slice(0, tab);
  text = text.trim();
  if (text === '/dev/null') return null;
  if (text.startsWith('a/') || text.startsWith('b/')) text = text.slice(2);
  return text;
}

function parseGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  const parts = rest.split(' ');
  if (parts.length !== 2) return null;
  if (!parts[0]?.startsWith('a/') || !parts[1]?.startsWith('b/')) return null;
  return [parts[0].slice(2), parts[1].slice(2)];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@( .*)?$/;

interface HunkRec {
  a: number;
  body: BodyLine[];
  noEol: boolean;
}

interface SecRec {
  gitOld: string;
  gitNew: string;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: HunkRec[];
}

function hunkNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]?.kind === 'ctx' || body[j]?.kind === 'add') last = j;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1]?.kind === 'bs';
}

function applyHunks(model: FileModel, hunks: HunkRec[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitON(h.body);
    const oldLen = model.lines.length;
    if (o.length > 0) {
      const found = firstTier(model.lines, o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0] as number;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEnd = best + o.length === oldLen;
      const rendered = renderN(model.lines, best, o, n, found.tier);
      model.lines.splice(best, o.length, ...rendered);
      if (touchesEnd) model.final = !h.noEol;
    } else {
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      const touchesEnd = at === oldLen;
      const rendered = renderN(model.lines, at, o, n, 0);
      model.lines.splice(at, 0, ...rendered);
      if (touchesEnd) model.final = !h.noEol;
    }
    d += n.length - o.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: SecRec[] = [];
  let cur: SecRec | null = null;
  let inHeader = false;
  let pairSeen = false;
  const startSection = (
    gitOld: string,
    gitNew: string,
    pairOld?: string | null,
    pairNew?: string | null,
  ): void => {
    cur = {
      gitOld,
      gitNew,
      pairOld,
      pairNew,
      renFrom: undefined,
      renTo: undefined,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(cur);
    inHeader = true;
    pairSeen = pairOld !== undefined;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const g = parseGit(line);
      if (g === null) throw new ParseErr(i + 1);
      startSection(g[0], g[1]);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = unifiedPath(line);
      const np = unifiedPath(lines[i + 1] as string);
      if (cur !== null && inHeader && !pairSeen) {
        cur.pairOld = op;
        cur.pairNew = np;
        pairSeen = true;
      } else {
        startSection('', '', op, np);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (cur === null || m === null) throw new ParseErr(i + 1);
      const a = Number(m[1]);
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          body.push({ kind: 'ctx', text: '', blank: true });
          i += 1;
          continue;
        }
        const c = l[0] as string;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: l.slice(1), blank: false });
          i += 1;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'del', text: l.slice(1), blank: false });
          i += 1;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'add', text: l.slice(1), blank: false });
          i += 1;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'bs', text: l.slice(1), blank: false });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1] as BodyLine;
        if (last.kind === 'ctx' && last.blank) body.pop();
        else break;
      }
      cur.hunks.push({ a, body, noEol: hunkNoEol(body) });
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      throw new ParseErr(i + 2);
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      else if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseErr(1);

  return sections.map((sec) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : (sec.renFrom ?? sec.gitOld);
    const newP = sec.pairNew !== undefined ? sec.pairNew : (sec.renTo ?? sec.gitNew);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.delFile);
    if (isCreate) {
      const newPath = newP as string | null;
      return (tree: Tree) => {
        if (newPath === null || !safePath(newPath)) throw new Fail('unsafe', newPath ?? '');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        for (const h of sec.hunks) {
          for (const b of h.body) if (b.kind === 'add') plus.push(b.text);
        }
        let noEol = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const body = sec.hunks[hi]?.body as BodyLine[];
          for (let j = body.length - 1; j >= 0; j--) {
            if (body[j]?.kind === 'add') {
              noEol = j + 1 < body.length && body[j + 1]?.kind === 'bs';
              break outer;
            }
          }
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (isDelete) {
      const oldPath = oldP as string;
      return (tree: Tree) => {
        if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }
    if (oldP !== newP) {
      const oldPath = oldP as string;
      const newPath = newP as string;
      return (tree: Tree) => {
        if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safePath(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const model = splitText(before);
        applyHunks(model, sec.hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, joinText(model));
        tree.moves.push([oldPath, newPath]);
      };
    }
    const path = oldP as string;
    return (tree: Tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const model = splitText(before);
      applyHunks(model, sec.hunks, strict, path);
      tree.now.set(path, joinText(model));
    };
  });
}

// ---------------------------------------------------------------- SEARCH/REPLACE

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = (lines[j] as string).trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new ParseErr(searchAt + 1);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseErr(searchAt + 1);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = (lines[j] as string).trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(searchAt + 1);
      path = prevPath;
    }
    prevPath = path;
    blocks.push({
      path,
      oldLines: lines.slice(i + 1, sep),
      newLines: lines.slice(sep + 1, end),
    });
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new ParseErr(1);
  return blocks.map((b) => {
    const path = b.path;
    const oldLines = b.oldLines;
    const newLines = b.newLines;
    return (tree: Tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const model = splitText(before);
      const found = firstTier(model.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      if (found.pos.length > 1) throw new Fail('ambiguous', path);
      const at = found.pos[0] as number;
      const items: NItem[] = newLines.map((t) => ({ t, ctx: false, oi: -1 }));
      const rendered = renderN(model.lines, at, oldLines, items, found.tier);
      model.lines.splice(at, oldLines.length, ...rendered);
      tree.now.set(path, joinText(model));
    };
  });
}

// ---------------------------------------------------------------- V4A

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  body: string[];
  chunks: VChunk[];
}

const V4A_SEC = (l: string): boolean =>
  l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      const body: Array<{ t: string; blank: boolean }> = [];
      while (i < last) {
        const l = lines[i] as string;
        if (V4A_SEC(l)) break;
        if (l.startsWith('+')) {
          body.push({ t: l.slice(1), blank: false });
          i += 1;
          continue;
        }
        if (l === '') {
          body.push({ t: '', blank: true });
          i += 1;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      while (body.length > 0 && (body[body.length - 1] as { blank: boolean }).blank) body.pop();
      sections.push({ kind: 'add', path, moveTo: null, body: body.map((b) => b.t), chunks: [] });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i += 1;
      sections.push({ kind: 'delete', path, moveTo: null, body: [], chunks: [] });
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && (lines[i] as string).startsWith('*** Move to:')) {
        moveTo = (lines[i] as string).slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i] as string;
        if (V4A_SEC(l)) break;
        if (l === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.eof = true;
          closeChunk();
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          i += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          if (l === '') cur.body.push({ kind: 'ctx', text: '', blank: true });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), blank: false });
          else if (l[0] === '-') cur.body.push({ kind: 'del', text: l.slice(1), blank: false });
          else cur.body.push({ kind: 'add', text: l.slice(1), blank: false });
          i += 1;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      closeChunk();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1] as VChunk;
        if (!lastChunk.eof) {
          while (lastChunk.body.length > 0) {
            const b = lastChunk.body[lastChunk.body.length - 1] as BodyLine;
            if (b.kind === 'ctx' && b.text.trim() === '') lastChunk.body.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateLine + 1);
      sections.push({ kind: 'update', path, moveTo, body: [], chunks });
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (sections.length === 0) throw new ParseErr(1);

  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const path = sec.path;
      const body = sec.body;
      return (tree: Tree) => {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, body.length === 0 ? '' : body.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      const path = sec.path;
      return (tree: Tree) => {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    const path = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const model = splitText(before);
      let cursor = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let foundAt = -1;
          for (const t of tiers) {
            for (let j = cursor; j < model.lines.length; j++) {
              if (lineEq(model.lines[j] as string, ch.anchor, t)) {
                foundAt = j;
                break;
              }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) throw new Fail('no-match', path);
          cursor = foundAt + 1;
        }
        const { o, n } = splitON(ch.body);
        if (o.length > 0) {
          const found = firstTier(model.lines, o, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', path);
          const at = found.pos[0] as number;
          const rendered = renderN(model.lines, at, o, n, found.tier);
          model.lines.splice(at, o.length, ...rendered);
          cursor = at + rendered.length;
        } else {
          const at = ch.eof ? model.lines.length : cursor;
          const rendered = renderN(model.lines, at, o, n, 0);
          model.lines.splice(at, 0, ...rendered);
          cursor = at + rendered.length;
        }
      }
      const out = joinText(model);
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, out);
        tree.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, out);
      }
    };
  });
}

// ---------------------------------------------------------------- driver

function runCli(args: string[]): { code: number; out: string[] } {
  const usage = (): { code: number; out: string[] } => ({ code: 2, out: ['error: usage'] });
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage();
  const file = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.n}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const dPaths = new Set<string>();
  const aPaths = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    if (was === null) aPaths.add(p);
    else if (now === null) dPaths.add(p);
  }
  for (const [oldP, newP] of tree.moves) {
    if (dPaths.has(oldP) && aPaths.has(newP)) {
      dPaths.delete(oldP);
      aPaths.delete(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of dPaths) rows.push({ key: p, text: `D ${p}` });
  for (const p of aPaths) rows.push({ key: p, text: `A ${p}` });
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was !== null && now !== null && was !== now) rows.push({ key: p, text: `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outLines = [
    ...rows.map((r) => r.text),
    `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`,
  ];
  if (!check) {
    const dels: string[] = [];
    const writes: string[] = [];
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) dels.push(p);
      else writes.push(p);
    }
    dels.sort();
    writes.sort();
    for (const p of dels) rmSync(p, { force: true });
    for (const p of writes) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p) as string);
    }
  }
  return { code: 0, out: outLines };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file
  // on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
