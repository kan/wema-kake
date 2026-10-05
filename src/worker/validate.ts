import type { Anchor, ArrowHead, EdgeRouting, EdgeStyle, LineStyle } from '@kanf/wema';
import type { BoardContent, HistoryDelta, WemaEdge, WemaNote } from '../shared/delta';
import { CHILD_PAGE_KEY } from '../shared/hierarchy';
import { isValidSlug } from '../shared/slug';

const MAX_DELTAS = 2000;
/**
 * text 1 つの上限（JSON 文字列にしたときのバイト数）。text の更新 1 回で ops の行に
 * before / after / fixup の 3 つが入っても MAX_OP_BYTES に収まる大きさにしている
 */
const MAX_TEXT_BYTES = 500_000;
/** ops の 1 行（body と fixups の合計）の上限。DO の SQLite は 1 行 2MB まで */
export const MAX_OP_BYTES = 1_800_000;

/** 変更を受け付けられないときに投げる。`current` は送信元が手元の状態を直すためのもの */
export class RejectError extends Error {
  constructor(
    reason: string,
    readonly current?: BoardContent,
  ) {
    super(reason);
  }
}

export type Obj = Record<string, unknown>;

const ID_RE = /^[\w-]{1,64}$/;
const COLOR_RE = /^[#\w(),.%\s-]{1,64}$/;

const ANCHORS = ['top', 'right', 'bottom', 'left', 'auto'] satisfies Anchor[];
const EDGE_STYLES = ['arrow', 'line', 'dashed'] satisfies EdgeStyle[];
const LINE_STYLES = ['solid', 'dashed', 'dotted'] satisfies LineStyle[];
const ARROW_HEADS = ['none', 'start', 'end', 'both'] satisfies ArrowHead[];
const ROUTINGS = ['curve', 'polyline'] satisfies EdgeRouting[];

/** 省略できない接続線のフィールド。未設定に戻す指定は無視する */
export const REQUIRED_EDGE_FIELDS: string[] = ['fromAnchor', 'toAnchor', 'style'];

/** 件数の指定を整数にして範囲に収める。数値でなければ `fallback` を使う */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  return Math.min(Math.max(Math.trunc(Number(value)) || fallback, 1), max);
}

const encoder = new TextEncoder();

/** `s` の UTF-8 でのバイト数が `max` を超えるか。長さだけで決まるときはエンコードしない */
export function exceedsBytes(s: string, max: number): boolean {
  if (s.length > max) return true;
  if (s.length * 3 <= max) return false;
  return encoder.encode(s).length > max;
}

function obj(v: unknown, what: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new RejectError(`${what} must be an object`);
  }
  return v as Obj;
}

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new RejectError(`invalid ${what}`);
  return v;
}

export { id as parseId };

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RejectError(`invalid ${what}`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new RejectError(`invalid ${what}`);
  return v;
}

function oneOf<T extends string>(v: unknown, values: string[], what: string): T {
  if (typeof v !== 'string' || !values.includes(v)) throw new RejectError(`invalid ${what}`);
  return v as T;
}

function text(v: unknown): string {
  if (typeof v !== 'string') throw new RejectError('invalid text');
  // JSON にすると 1 文字が最大 6 バイト（\uXXXX）になる。明らかに収まるときは計算を省く
  if (v.length * 6 + 2 > MAX_TEXT_BYTES && exceedsBytes(JSON.stringify(v), MAX_TEXT_BYTES)) {
    throw new RejectError('text too large');
  }
  return v;
}

function color(v: unknown): string {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) throw new RejectError('invalid color');
  return v;
}

function label(v: unknown): string {
  if (typeof v !== 'string' || v.length > 500) throw new RejectError('invalid label');
  return v;
}

const META_KEY_RE = /^[\w-]{1,32}$/;
const MAX_META_KEYS = 8;
const MAX_META_VALUE_LENGTH = 256;

/**
 * 付箋の meta（利用側のデータ。wema は中身を解釈しない）。値は文字列だけ。
 * wema は大きさと形を制限しないので、ここで制限する。キーは並べ替えて返す（保存した値を、
 * 文字列にして比べられるようにするため）。
 *
 * `page` は、子ページの付箋が指す子ページのスラッグ（src/shared/hierarchy.ts）
 */
function meta(v: unknown): Record<string, string> {
  const entries = Object.entries(obj(v, 'meta')).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length > MAX_META_KEYS) throw new RejectError('invalid meta');
  for (const [key, value] of entries) {
    if (!META_KEY_RE.test(key) || typeof value !== 'string' || value.length > MAX_META_VALUE_LENGTH) {
      throw new RejectError('invalid meta');
    }
  }
  const out = Object.fromEntries(entries) as Record<string, string>;
  if (CHILD_PAGE_KEY in out && !isValidSlug(out[CHILD_PAGE_KEY])) throw new RejectError('invalid meta');
  return out;
}

/** 付箋の、id と zIndex 以外のフィールド */
export type NoteField = Exclude<keyof WemaNote, 'id' | 'zIndex'>;
type EdgeField = Exclude<keyof WemaEdge, 'id' | 'from' | 'to'>;

/**
 * 付箋の、id と zIndex 以外のフィールド。zIndex は同期しないので更新では捨てる。
 * **wema が足したフィールドは、ここに足すまで型エラーになる**（`pick` は知らないフィールドを黙って
 * 捨てるので、足し忘れると、そのフィールドだけが保存されない）
 */
const NOTE_FIELDS = {
  x: (v: unknown) => num(v, 'x'),
  y: (v: unknown) => num(v, 'y'),
  width: (v: unknown) => num(v, 'width'),
  height: (v: unknown) => num(v, 'height'),
  text,
  color,
  autoSize: (v: unknown) => bool(v, 'autoSize'),
  foldable: (v: unknown) => bool(v, 'foldable'),
  meta,
} satisfies { [K in NoteField]: (v: unknown) => WemaNote[K] };

/** 接続線の、id / from / to 以外のフィールド。from / to は変更できないので更新では捨てる */
const EDGE_FIELDS = {
  fromAnchor: (v: unknown) => oneOf(v, ANCHORS, 'fromAnchor'),
  toAnchor: (v: unknown) => oneOf(v, ANCHORS, 'toAnchor'),
  style: (v: unknown) => oneOf(v, EDGE_STYLES, 'style'),
  label,
  lineStyle: (v: unknown) => oneOf(v, LINE_STYLES, 'lineStyle'),
  strokeWidth: (v: unknown) => num(v, 'strokeWidth'),
  arrowHead: (v: unknown) => oneOf(v, ARROW_HEADS, 'arrowHead'),
  arrowSize: (v: unknown) => num(v, 'arrowSize'),
  routing: (v: unknown) => oneOf(v, ROUTINGS, 'routing'),
  collapsed: (v: unknown) => bool(v, 'collapsed'),
} satisfies { [K in EdgeField]: (v: unknown) => WemaEdge[K] };

type Fields = Record<string, (v: unknown) => unknown>;

/** 既知のフィールドだけを検証して取り出す。値が null / undefined のキーは無いものとして扱う */
function pick(source: Obj, fields: Fields): Obj {
  const out: Obj = {};
  for (const [key, parse] of Object.entries(fields)) {
    if (source[key] != null) out[key] = parse(source[key]);
  }
  return out;
}

function requireKeys(o: Obj, keys: string[], what: string): void {
  for (const key of keys) {
    if (!(key in o)) throw new RejectError(`${what}.${key} is required`);
  }
}

function parseNote(v: unknown): WemaNote {
  const o = obj(v, 'note');
  const fields = pick(o, NOTE_FIELDS);
  requireKeys(fields, ['x', 'y', 'width', 'height', 'text', 'color'], 'note');
  const zIndex = o.zIndex == null ? 0 : num(o.zIndex, 'zIndex');
  return { ...fields, id: id(o.id, 'note id'), zIndex: Math.trunc(zIndex) } as WemaNote;
}

function parseEdge(v: unknown): WemaEdge {
  const o = obj(v, 'edge');
  const fields = pick(o, EDGE_FIELDS);
  requireKeys(fields, REQUIRED_EDGE_FIELDS, 'edge');
  return {
    ...fields,
    id: id(o.id, 'edge id'),
    from: id(o.from, 'edge from'),
    to: id(o.to, 'edge to'),
  } as WemaEdge;
}

function parseUpdate(d: Obj, fields: Fields): { before: Obj; after: Obj } {
  return {
    before: pick(obj(d.before ?? {}, 'before'), fields),
    after: pick(obj(d.after, 'after'), fields),
  };
}

function parseDelta(v: unknown): HistoryDelta {
  const d = obj(v, 'delta');
  switch (d.type) {
    case 'note:create':
    case 'note:delete':
      return { type: d.type, note: parseNote(d.note) };
    case 'note:update':
      return { type: d.type, noteId: id(d.noteId, 'noteId'), ...parseUpdate(d, NOTE_FIELDS) };
    case 'edge:create':
    case 'edge:delete':
      return { type: d.type, edge: parseEdge(d.edge) };
    case 'edge:update':
      return { type: d.type, edgeId: id(d.edgeId, 'edgeId'), ...parseUpdate(d, EDGE_FIELDS) };
    default:
      throw new RejectError('unknown delta type');
  }
}

/** 外から来たデルタの形を検証し、既知のフィールドだけを持つデルタにして返す */
export function parseDeltas(input: unknown): HistoryDelta[] {
  if (!Array.isArray(input) || input.length === 0) throw new RejectError('invalid deltas');
  if (input.length > MAX_DELTAS) {
    throw new RejectError(`too many deltas (${input.length}, limit ${MAX_DELTAS})`);
  }
  // サニタイズは text の量に比例して時間がかかる。記録できない大きさの入力は、
  // サニタイズに回す前にここで断る（記録時の MAX_OP_BYTES の検査より手前で止める）
  let textLength = 0;
  return input.map((v) => {
    const d = parseDelta(v);
    if (d.type === 'note:create') {
      textLength += d.note.text.length;
    } else if (d.type === 'note:update') {
      textLength += (d.before.text?.length ?? 0) + (d.after.text?.length ?? 0);
    }
    if (textLength > MAX_OP_BYTES) throw new RejectError('operation too large');
    return d;
  });
}
