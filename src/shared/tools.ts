// LLM に公開するツールの定義と実装。
//
// 実装は BoardAccess（ボードを読む、デルタを適用する、取り消す）越しに書いてある。リモート MCP では
// サーバー版（ページの DO と D1 を呼ぶ）を渡す。WebMCP を足すときは、ブラウザ版（wema の API を呼ぶ）を
// 渡せば、同じツールがそのまま使える。
import { computeAutoLayout } from '@kanf/wema';
import { z } from 'zod';
import { MAX_LIST_LIMIT, MAX_QUERY_LENGTH, type OpSummary, type RevertOutcome } from './api';
import type { HistoryDelta, WemaEdge, WemaNote } from './delta';
import { textToHtml } from './note-text';
import { SLUG_RE } from './slug';

/** ツールが入力や状態の問題で実行できなかった。メッセージは LLM に返す */
export class ToolError extends Error {}

export interface PageInfo {
  name: string;
  title: string | null;
  note_count: number;
  updated_at: number;
}

type AuthoredNote = WemaNote & { createdBy: string | null };

export interface BoardState {
  title: string | null;
  notes: AuthoredNote[];
  edges: WemaEdge[];
}

export type ApplyOutcome =
  /** `seq` は記録した操作の番号。何も変わらなかった（値が同じ、対象がもうない）なら null */
  { ok: true; seq: number | null } | { ok: false; reason: string };

export interface BoardAccess {
  listPages(options: { updatedAfter?: number; limit?: number }): Promise<PageInfo[]>;
  searchPages(query: string): Promise<{ name: string; title: string | null; snippet?: string }[]>;
  /** ページがまだ作られていなければ null */
  readBoard(page: string): Promise<BoardState | null>;
  /** 付箋の text（HTML）をプレーンテキストにする */
  plainText(html: string): Promise<string>;
  /**
   * デルタを 1 つの操作として適用する。`summary` は履歴に出る説明。
   * ページがなければ適用せず、`ok: false` を返すこと（ツールはページを作らない）
   */
  apply(page: string, deltas: HistoryDelta[], summary: string): Promise<ApplyOutcome>;
  /** 自分（この agent）の最近の操作 */
  ownOps(page: string): Promise<OpSummary[]>;
  /** 自分の操作を取り消す */
  revert(page: string, seq: number, summary: string): Promise<RevertOutcome>;
}

const NOTE_WIDTH = 200;
const NOTE_HEIGHT = 150;
const NOTE_COLOR = '#FFF9C4';
const GAP = 40;
const MAX_ITEMS = 200;

const page = z
  .string()
  .regex(SLUG_RE)
  .describe('ページのスラッグ（list_pages の name）');
const reason = z
  .string()
  .max(200)
  .optional()
  .describe('この操作の説明。操作の履歴に表示され、人が取り消すかどうかの判断に使う');
const noteText = z
  .string()
  .max(20_000)
  .describe(
    '付箋の本文（プレーンテキスト）。改行できる。"- " で始まる行は箇条書き、"- [ ] " / "- [x] " で始まる行はチェックリストになる。HTML は書けない',
  );
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe('付箋の色（#RRGGBB）。分類に使う');

type Rect = { x: number; y: number; width: number; height: number };

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + GAP / 2 &&
  b.x < a.x + a.width + GAP / 2 &&
  a.y < b.y + b.height + GAP / 2 &&
  b.y < a.y + a.height + GAP / 2;

/** 本文の量から、付箋の高さを見積もる（サーバーでは実際の描画の大きさを測れない） */
function estimateHeight(text: string): number {
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 13)), 0);
  return Math.min(Math.max(NOTE_HEIGHT, 40 + lines * 22), 500);
}

/** 置き場所を決める。`near` があればその右、なければ既存の付箋の下。重なる間は下へずらす */
function placeNote(size: { width: number; height: number }, near: Rect | undefined, taken: Rect[]): Rect {
  const rect: Rect = near
    ? { ...size, x: near.x + near.width + GAP, y: near.y }
    : { ...size, x: GAP, y: taken.reduce((bottom, r) => Math.max(bottom, r.y + r.height), 0) + GAP };
  // 重なった付箋の下まで、一度にずらす
  for (let hit = taken.find((r) => overlaps(rect, r)); hit; hit = taken.find((r) => overlaps(rect, r))) {
    rect.y = hit.y + hit.height + GAP;
  }
  return rect;
}

/** 存在するページのボード。付箋は id で引けるようにしておく */
interface Board extends BoardState {
  notesById: Map<string, AuthoredNote>;
}

async function existingBoard(access: BoardAccess, slug: string): Promise<Board> {
  const board = await access.readBoard(slug);
  // ページの作成はツールでは行わない（人が画面から作る）
  if (!board) throw new ToolError(`page not found: ${slug}`);
  return { ...board, notesById: new Map(board.notes.map((n) => [n.id, n])) };
}

async function applyOrThrow(access: BoardAccess, slug: string, deltas: HistoryDelta[], summary: string) {
  if (deltas.length === 0) throw new ToolError('nothing to change');
  const result = await access.apply(slug, deltas, summary);
  if (!result.ok) throw new ToolError(result.reason);
  // 操作として記録されていないので、返せる番号がない（別の操作の番号を返すと、取り消しで事故になる）
  if (result.seq === null) {
    throw new ToolError('nothing changed: the board already has these values, or the targets no longer exist');
  }
  return result.seq;
}

/** 同じ id を 2 回指定していたら断る（2 件目が、1 件目の結果と食い違って拒否されるため） */
function assertUnique(ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ToolError(`duplicate id: ${id}`);
    seen.add(id);
  }
}

const summaryOf = (tool: string, why: string | undefined) => (why ? `${tool}: ${why}` : tool);

function findNote(board: Board, id: string) {
  const note = board.notesById.get(id);
  if (!note) throw new ToolError(`note not found: ${id}`);
  return note;
}

/** ツール 1 つ。`input` は入力のスキーマ、`run` は BoardAccess を使った実装 */
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** ボードを変更しないか */
  readOnly: boolean;
  run(access: BoardAccess, input: z.infer<S>): Promise<unknown>;
}

const tool = <S extends z.ZodType>(definition: Tool<S>): Tool<S> => definition;

const ARROW = { fromAnchor: 'auto', toAnchor: 'auto', style: 'arrow' } as const;

export const TOOLS: Tool[] = [
  tool({
    name: 'list_pages',
    description: 'ページの一覧（名前、表示名、付箋の数、更新日時）を、更新の新しい順に返す。',
    readOnly: true,
    input: z.object({
      updated_after: z
        .number()
        .optional()
        .describe('この時刻（UNIX ミリ秒）より後に更新されたページだけを返す'),
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    }),
    run: (access, input) => access.listPages({ updatedAfter: input.updated_after, limit: input.limit }),
  }),

  tool({
    name: 'search_pages',
    description: 'ページを全文検索する（表示名と付箋の本文）。',
    readOnly: true,
    input: z.object({ query: z.string().min(1).max(MAX_QUERY_LENGTH) }),
    run: (access, input) => access.searchPages(input.query),
  }),

  tool({
    name: 'read_board',
    description:
      '1 ページの付箋（id、本文、座標、大きさ、色、作成者）と接続線（id、from、to、label）を返す。座標は左上が原点で、単位はピクセル。',
    readOnly: true,
    input: z.object({ page }),
    async run(access, input) {
      const board = await existingBoard(access, input.page);
      return {
        title: board.title,
        notes: await Promise.all(
          board.notes.map(async (n) => ({
            id: n.id,
            text: await access.plainText(n.text),
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
            color: n.color,
            created_by: n.createdBy,
          })),
        ),
        edges: board.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label })),
      };
    },
  }),

  tool({
    name: 'add_notes',
    description:
      '付箋を追加する。位置を省略すると、near で指定した付箋の右（なければ既存の付箋の下）に、重ならないように置く。connect_from を指定すると、その付箋から新しい付箋へ接続線を引く。',
    readOnly: false,
    input: z.object({
      page,
      notes: z
        .array(
          z.object({
            text: noteText,
            x: z.number().optional(),
            y: z.number().optional(),
            color: color.optional(),
            near: z.string().optional().describe('この id の付箋の近くに置く'),
            connect_from: z.string().optional().describe('この id の付箋から、新しい付箋へ接続線を引く'),
          }),
        )
        .min(1)
        .max(MAX_ITEMS),
      reason,
    }),
    async run(access, input) {
      const board = await existingBoard(access, input.page);
      const taken: Rect[] = [...board.notes];
      const deltas: HistoryDelta[] = [];
      const ids: string[] = [];
      for (const spec of input.notes) {
        const anchor = spec.near ?? spec.connect_from;
        const near = anchor === undefined ? undefined : findNote(board, anchor);
        const size = { width: NOTE_WIDTH, height: estimateHeight(spec.text) };
        if ((spec.x === undefined) !== (spec.y === undefined)) {
          throw new ToolError('x and y must be given together (or both omitted for automatic placement)');
        }
        const rect =
          spec.x !== undefined && spec.y !== undefined
            ? { ...size, x: spec.x, y: spec.y }
            : placeNote(size, near, taken);
        taken.push(rect);
        const id = crypto.randomUUID();
        ids.push(id);
        deltas.push({
          type: 'note:create',
          note: { id, ...rect, text: textToHtml(spec.text), color: spec.color ?? NOTE_COLOR, zIndex: 1 },
        });
        if (spec.connect_from !== undefined) {
          findNote(board, spec.connect_from);
          deltas.push({
            type: 'edge:create',
            edge: { id: crypto.randomUUID(), from: spec.connect_from, to: id, ...ARROW },
          });
        }
      }
      const seq = await applyOrThrow(access, input.page, deltas, summaryOf('add_notes', input.reason));
      return { operation: seq, note_ids: ids };
    },
  }),

  tool({
    name: 'update_notes',
    description: '付箋の本文、色、位置、大きさを変更する。指定した項目だけが変わる。',
    readOnly: false,
    input: z.object({
      page,
      notes: z
        .array(
          z.object({
            id: z.string(),
            text: noteText.optional(),
            color: color.optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().min(40).max(2000).optional(),
            height: z.number().min(40).max(2000).optional(),
          }),
        )
        .min(1)
        .max(MAX_ITEMS),
      reason,
    }),
    async run(access, input) {
      const board = await existingBoard(access, input.page);
      assertUnique(input.notes.map((n) => n.id));
      const deltas = input.notes.map(({ id, text, ...rest }): HistoryDelta => {
        const note = findNote(board, id);
        const after: Partial<WemaNote> = { ...rest };
        // text の更新には、読んだ時点の text を添える（その後に誰かが編集していたら拒否される）
        const before: Partial<WemaNote> = {};
        if (text !== undefined) {
          before.text = note.text;
          after.text = textToHtml(text);
        }
        return { type: 'note:update', noteId: id, before, after };
      });
      const seq = await applyOrThrow(access, input.page, deltas, summaryOf('update_notes', input.reason));
      return { operation: seq };
    },
  }),

  tool({
    name: 'delete_notes',
    description: '付箋を削除する。その付箋につながる接続線も削除される。',
    readOnly: false,
    input: z.object({ page, note_ids: z.array(z.string()).min(1).max(MAX_ITEMS), reason }),
    async run(access, input) {
      const board = await existingBoard(access, input.page);
      assertUnique(input.note_ids);
      const deltas = input.note_ids.map(
        (id): HistoryDelta => ({ type: 'note:delete', note: findNote(board, id) }),
      );
      const seq = await applyOrThrow(access, input.page, deltas, summaryOf('delete_notes', input.reason));
      return { operation: seq };
    },
  }),

  tool({
    name: 'connect_notes',
    description: '付箋同士を接続線（矢印）でつなぐ。ラベルを付けられる。',
    readOnly: false,
    input: z.object({
      page,
      connections: z
        .array(z.object({ from: z.string(), to: z.string(), label: z.string().max(200).optional() }))
        .min(1)
        .max(MAX_ITEMS),
      reason,
    }),
    async run(access, input) {
      const board = await existingBoard(access, input.page);
      const ids: string[] = [];
      const deltas = input.connections.map(({ from, to, label }): HistoryDelta => {
        findNote(board, from);
        findNote(board, to);
        const id = crypto.randomUUID();
        ids.push(id);
        const edge: WemaEdge = { id, from, to, ...ARROW };
        if (label) edge.label = label;
        return { type: 'edge:create', edge };
      });
      const seq = await applyOrThrow(access, input.page, deltas, summaryOf('connect_notes', input.reason));
      return { operation: seq, edge_ids: ids };
    },
  }),

  tool({
    name: 'disconnect_notes',
    description: '接続線を削除する。',
    readOnly: false,
    input: z.object({ page, edge_ids: z.array(z.string()).min(1).max(MAX_ITEMS), reason }),
    async run(access, input) {
      const board = await existingBoard(access, input.page);
      const deltas = input.edge_ids.map((id): HistoryDelta => {
        const edge = board.edges.find((e) => e.id === id);
        if (!edge) throw new ToolError(`edge not found: ${id}`);
        return { type: 'edge:delete', edge };
      });
      const seq = await applyOrThrow(access, input.page, deltas, summaryOf('disconnect_notes', input.reason));
      return { operation: seq };
    },
  }),

  tool({
    name: 'auto_layout',
    description:
      '接続線のつながりに基づいて、付箋を階層に並べ直す。note_ids を省略すると、ページの全付箋が対象になる。1 回で動かせる付箋は 2000 枚まで（超える場合は note_ids で対象を絞る）。',
    readOnly: false,
    input: z.object({ page, note_ids: z.array(z.string()).max(2000).optional(), reason }),
    async run(access, input) {
      const board = await existingBoard(access, input.page);
      input.note_ids?.forEach((id) => findNote(board, id));
      const positions = computeAutoLayout(board.notes, board.edges, { noteIds: input.note_ids });
      const deltas: HistoryDelta[] = [];
      for (const { id, x, y } of positions) {
        const note = findNote(board, id);
        if (note.x === x && note.y === y) continue;
        deltas.push({ type: 'note:update', noteId: id, before: { x: note.x, y: note.y }, after: { x, y } });
      }
      const seq = await applyOrThrow(access, input.page, deltas, summaryOf('auto_layout', input.reason));
      return { operation: seq, moved: deltas.length };
    },
  }),

  tool({
    name: 'revert_operation',
    description:
      '自分が行った操作を取り消す。operation を省略すると、まだ取り消していない直前の操作が対象になる。その後に人が変更した付箋は戻さず、skipped で返す。何も戻せなかった場合（applied が 0）は、それより前の自分の操作の番号を earlier_operations で返すので、必要なら operation に指定して呼び直す。',
    readOnly: false,
    input: z.object({
      page,
      operation: z.number().int().optional().describe('取り消す操作の番号（各ツールが返す operation）'),
      reason,
    }),
    async run(access, input) {
      // ページの存在は確かめない（ページがなければ、操作の一覧が空で、取り消しも断られる）
      let seq = input.operation;
      let earlier: number[] = [];
      if (seq === undefined) {
        // 取り消しそのもの（reverts がある）と、取り消し済みのものは対象にしない
        const candidates = (await access.ownOps(input.page))
          .filter((op) => op.revertedBy === null && op.reverts === null)
          .map((op) => op.seq);
        if (candidates.length === 0) throw new ToolError('no operation to revert');
        [seq, ...earlier] = candidates;
      }
      const outcome = await access.revert(input.page, seq, summaryOf('revert_operation', input.reason));
      const result = { reverted: seq, operation: outcome.seq, applied: outcome.applied, skipped: outcome.skipped };
      // 何も戻せなかった操作は取り消し済みにならず、省略時にまた選ばれる。それより前の操作を
      // 取り消したいときに番号を指定できるよう、候補を返す
      return outcome.applied === 0 && earlier.length > 0 ? { ...result, earlier_operations: earlier } : result;
    },
  }),
];
