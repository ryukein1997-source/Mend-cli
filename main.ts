// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves recorded by move edits: new path -> old path, for section 2's `R` lines. */
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

/** A file as section 3 sees it: its lines, its own line break, and whether it ends with one. */
interface FileParts {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** Section 5's matching tiers: 0 exact, 1 trailing blanks ignored, 2 leading blanks ignored too. */
type Tier = 0 | 1 | 2;

const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailWs(a) === stripTrailWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Occurrences of O in fileLines at one tier, at or after `from`; occurrences may overlap. */
function occurrencesAt(fileLines: string[], O: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!lineEq(fileLines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences there (section 5). */
function findTier(fileLines: string[], O: string[], strict: boolean, from = 0, eofOnly = false): { tier: Tier; occ: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrencesAt(fileLines, O, t, from);
    if (eofOnly) occ = occ.filter((i) => i + O.length === fileLines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a hunk, block or chunk body: context (in O and N), old only, or new only. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line followed this body line (unified diffs, section 6). */
  noEol?: boolean;
  /** This entry came from a raw empty patch line (a unified body trims those at its end). */
  rawEmpty?: boolean;
}

/** Splice a body's new side over the matched lines at `pos`, per section 5's writing rules. */
function applyMatch(fileLines: string[], pos: number, body: BodyLine[], tier: Tier, O: string[]): string[] {
  const written: string[] = [];
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'del') {
      oi += 1;
      continue;
    }
    if (b.kind === 'ctx') {
      written.push(fileLines[pos + oi]!);
      oi += 1;
      continue;
    }
    let t = b.text;
    if (tier === 2 && t !== '' && stripBothWs(t) !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    written.push(t);
  }
  return [...fileLines.slice(0, pos), ...written, ...fileLines.slice(pos + O.length)];
}

/** Whether a `\` line follows the body's last context or `+` line (section 6's final-break rule). */
function lastCtxOrAddNoEol(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind !== 'del') return body[i]!.noEol === true;
  }
  return false;
}

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

/** A `--- `/`+++ ` header path (section 6): up to the first tab, spaces removed, prefix removed; null for /dev/null. */
function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0]!.replace(/^ +| +$/g, '');
  if (rest === '/dev/null') return null;
  return rest.startsWith('a/') || rest.startsWith('b/') ? rest.slice(2) : rest;
}

/** Apply a section's hunks in order to a file's text (section 6), tracking the running delta and final break. */
function applyUnified(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let finalBreak = f.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: string[] = [];
    for (const b of h.body) {
      if (b.kind !== 'add') O.push(b.text);
      if (b.kind !== 'del') N.push(b.text);
    }
    if (O.length > 0) {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const o of found.occ) {
        const dd = Math.abs(o - target);
        if (dd < best) {
          best = dd;
          pos = o;
        }
      }
      const touches = pos + O.length === lines.length;
      lines = applyMatch(lines, pos, h.body, found.tier, O);
      if (touches) finalBreak = !lastCtxOrAddNoEol(h.body);
    } else {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      const adds = h.body.filter((b) => b.kind === 'add').map((b) => b.text);
      lines = [...lines.slice(0, at), ...adds, ...lines.slice(at)];
      if (atEnd) finalBreak = !lastCtxOrAddNoEol(h.body);
    }
    d += N.length - O.length;
  }
  return joinFile({ lines, br: f.br, finalBreak });
}

/** One unified section as an edit (section 6). */
function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : (sec.renameFrom ?? sec.gitOld);
  const newPath = sec.pairNew !== undefined ? sec.pairNew : (sec.renameTo ?? sec.gitNew);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if ((oldPath === null || sec.newFile) && newPath !== null) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const texts: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'add') {
            texts.push(b.text);
            noEol = b.noEol === true;
          }
        }
      }
      tree.now.set(newPath, joinFile({ lines: texts, br: '\n', finalBreak: !noEol }));
      return;
    }
    if (newPath === null || sec.deletedFile) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null) return;
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyUnified(text, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.set(newPath, oldPath);
      return;
    }
    tree.now.set(oldPath, applyUnified(text, sec.hunks, strict, oldPath));
  };
}

/** Read a unified diff (section 6) into one edit a section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => ({
    gitOld: null,
    gitNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const finish = (): void => {
    if (cur !== null) {
      sections.push(cur);
      cur = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pairOld !== undefined) {
        finish();
        cur = fresh();
      }
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          body.push({ kind: 'ctx', text: '', rawEmpty: true });
          j += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') body.push({ kind: 'ctx', text: l.slice(1) });
        else if (c === '-') body.push({ kind: 'del', text: l.slice(1) });
        else if (c === '+') body.push({ kind: 'add', text: l.slice(1) });
        else if (c === '\\') {
          const prev = body[body.length - 1];
          if (prev !== undefined) prev.noEol = true;
          j += 1;
          continue;
        } else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.rawEmpty === true && body[body.length - 1]!.noEol !== true) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  finish();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | undefined;
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

/** One V4A section as an edit (section 8). */
function v4aEdit(sec: VSection, strict: boolean): Edit {
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ lines: sec.addLines, br: '\n', finalBreak: true }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(text);
    let lines = f.lines;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      const anchor = chunk.anchor;
      if (anchor !== null) {
        const tiers: Tier[] = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineEq(lines[k]!, anchor, t)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: string[] = [];
      for (const b of chunk.body) {
        if (b.kind !== 'add') O.push(b.text);
        if (b.kind !== 'del') N.push(b.text);
      }
      if (O.length > 0) {
        const found = findTier(lines, O, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.occ[0]!;
        lines = applyMatch(lines, pos, chunk.body, found.tier, O);
        cursor = pos + N.length;
      } else {
        const at = chunk.eof ? lines.length : Math.min(cursor, lines.length);
        const adds = chunk.body.filter((b) => b.kind === 'add').map((b) => b.text);
        lines = [...lines.slice(0, at), ...adds, ...lines.slice(at)];
        cursor = at + adds.length;
      }
    }
    const out = joinFile({ lines, br: f.br, finalBreak: f.finalBreak });
    if (sec.moveTo !== undefined) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.set(sec.moveTo, p);
    } else {
      tree.now.set(p, out);
    }
  };
}

/** Read a V4A patch (section 8) into one edit a section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = line.startsWith(V_ADD) ? 'add' : line.startsWith(V_DEL) ? 'del' : line.startsWith(V_UPD) ? 'upd' : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? V_ADD : kind === 'del' ? V_DEL : V_UPD;
    const path = line.slice(prefix.length).trim();
    const raw: { n: number; text: string }[] = [];
    let j = i + 1;
    while (j < last && !isHeader(lines[j]!)) {
      raw.push({ n: j + 1, text: lines[j]! });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: VSection = { kind, path, line: i + 1, addLines: [], moveTo: undefined, chunks: [] };
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.n}`);
      }
    } else if (kind === 'del') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.n}`);
      }
    } else {
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(V_MOVE)) {
        sec.moveTo = raw[0]!.text.slice(V_MOVE.length).trim();
        k = 1;
      }
      let chunk: VChunk | null = null;
      const startChunk = (anchor: string | null): VChunk => {
        const c: VChunk = { anchor, eof: false, body: [] };
        sec.chunks.push(c);
        return c;
      };
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const a = t.slice(2).trim();
          chunk = startChunk(a === '' ? null : a);
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) chunk = startChunk(null);
          chunk.eof = true;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null || chunk.eof) chunk = startChunk(null);
          chunk.body.push({ kind: t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'del' : 'add', text: t === '' ? '' : t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.n}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.line}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

/** Read SEARCH/REPLACE blocks (section 7) into one edit a block. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let gt = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${at + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(at + 1, eq);
    const newLines = lines.slice(eq + 1, gt);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile({ lines: newLines, br: '\n', finalBreak: true }));
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const f = splitFile(text);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const body: BodyLine[] = [
        ...oldLines.map((t) => ({ kind: 'del' as const, text: t })),
        ...newLines.map((t) => ({ kind: 'add' as const, text: t })),
      ];
      const out = applyMatch(f.lines, found.occ[0]!, body, found.tier, oldLines);
      tree.now.set(p, joinFile({ lines: out, br: f.br, finalBreak: f.finalBreak }));
    });
    prevPath = path;
    prevEnd = gt;
    i = gt + 1;
  }
  return edits;
}

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
    edits = kind === 'json'
      ? jsonEdits(text, lines)
      : kind === 'unified'
        ? unifiedEdits(lines, strict)
        : kind === 'search-replace'
          ? srEdits(lines, strict)
          : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [newP, oldP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : wasOld;
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
