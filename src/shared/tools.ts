// LLM に公開するツールの定義と実装。
//
// 実装は BoardAccess（ボードを読む、デルタを適用する、取り消す）越しに書いてある。リモート MCP では
// サーバー版（ページの DO と D1 を呼ぶ）を渡す。WebMCP を足すときは、ブラウザ版（wema の API を呼ぶ）を
// 渡せば、同じツールがそのまま使える。
import { computeAutoLayout } from '@kanf/wema';
import { z } from 'zod';
import { MAX_LIST_LIMIT, MAX_QUERY_LENGTH, MAX_TITLE_LENGTH, type OpSummary, type RevertOutcome } from './api';
import type { HistoryDelta, WemaEdge, WemaNote } from './delta';
import { CHILD_NOTE_SIZE, CHILD_PAGE_KEY, childPageOf, MAX_DEPTH } from './hierarchy';
import { textToHtml } from './note-text';
import { SLUG_RE } from './slug';

/** ツールが入力や状態の問題で実行できなかった。メッセージは LLM に返す */
export class ToolError extends Error {}

export interface PageInfo {
  name: string;
  title: string | null;
  note_count: number;
  updated_at: number;
  /** 親ページのスラッグ。ルートのページ（どのページの子でもない）なら null */
  parent: string | null;
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
  searchPages(
    query: string,
  ): Promise<{ name: string; title: string | null; parent: string | null; snippet?: string }[]>;
  /** ページがまだ作られていなければ null */
  readBoard(page: string): Promise<BoardState | null>;
  /** 親ページのスラッグ（ルートなら null）。ページがなければ undefined。索引ではなく、ページの今の値を返す */
  parentOf(page: string): Promise<string | null | undefined>;
  /** ページの親が `parent` なら、ルートへ戻す（親の記録が古く、親ページに子ページの付箋がないときに使う） */
  clearParent(page: string, parent: string): Promise<void>;
  /** ページを、付箋のない状態で作る。すでにあれば作らずに `exists` を返す */
  createPage(page: string, title: string): Promise<'created' | 'exists' | 'invalid title'>;
  /** 付箋の text（HTML）をプレーンテキストにする */
  plainText(html: string): Promise<string>;
  /**
   * デルタを 1 つの操作として適用する。`summary` は履歴に出る説明。
   * ページがなければ適用せず、`ok: false` を返すこと（ページを作るのは create_page だけ）
   */
  apply(page: string, deltas: HistoryDelta[], summary: string): Promise<ApplyOutcome>;
  /**
   * ページ `from` の付箋を、ページ `to` へ移す（作成者は引き継ぐ）。付箋の中身は、実装の側が
   * 元のページから読む。移せなければ ToolError を投げる。`noteIds` は移した後の付箋の id
   * （`ids` と同じ順）、`received` と `removed` は、それぞれのページで記録した操作の番号
   */
  moveNotes(
    from: string,
    to: string,
    ids: string[],
    summary: string,
  ): Promise<{ noteIds: string[]; received: number; removed: number | null }>;
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
    '付箋の本文（プレーンテキスト）。改行できる。"- " で始まる行は箇条書き、"- [ ] " / "- [x] " で始まる行はチェックリストになる。[[スラッグ]] と書くと、そのページへのリンクになる（read_board の本文にも、ページへのリンクは同じ書式で出る）。外部のページへは、URL（http:// か https://）をそのまま書くと、その URL を文字にしたリンクになる。リンクの文字は変えられないので、何のリンクかは URL の前後に文で書く。URL の直後の句読点（. , ; : ! ?）は、URL に含めない。HTML と Markdown のリンク（[文字](URL)）は書けない',
  );
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe('付箋の色（#RRGGBB）。分類に使う');

/** 付箋の幅と高さ */
const noteSize = z.number().min(40).max(2000);

type Rect = { x: number; y: number; width: number; height: number };

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + GAP / 2 &&
  b.x < a.x + a.width + GAP / 2 &&
  a.y < b.y + b.height + GAP / 2 &&
  b.y < a.y + a.height + GAP / 2;

/** 本文の量から、付箋の高さを見積もる（サーバーでは実際の描画の大きさを測れない） */
function estimateHeight(text: string, width: number): number {
  // 1 行に入る文字数は、幅に比例する（幅 200 で、全角 13 文字ほど）
  const perLine = Math.max(1, Math.floor((13 * width) / NOTE_WIDTH));
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
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
  // 書き込みのツールは、ページを作らない（作るのは create_page だけ）
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

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `page` が `ancestor` の子孫（`ancestor` 自身を含む）か。親をたどる（階層の深さの上限までで止まる） */
async function isDescendant(access: BoardAccess, page: string, ancestor: string): Promise<boolean> {
  let name: string | null | undefined = page;
  for (let depth = 0; name && depth <= MAX_DEPTH; depth++) {
    if (name === ancestor) return true;
    name = await access.parentOf(name);
  }
  return false;
}

/**
 * `parent` のボードに、`child` の子ページの付箋を置く（既存の付箋の下に、重ならないように）。
 * 置けるかどうか（親は 1 つだけ、輪にならない、深さ）は、ページの DO が確かめる。記録した操作の番号を返す
 */
async function placeChild(access: BoardAccess, parent: Board, parentSlug: string, child: string, summary: string) {
  const rect = placeNote(CHILD_NOTE_SIZE, undefined, parent.notes);
  const note: WemaNote = {
    id: crypto.randomUUID(),
    ...rect,
    text: '',
    color: NOTE_COLOR,
    zIndex: 1,
    meta: { [CHILD_PAGE_KEY]: child },
  };
  return applyOrThrow(access, parentSlug, [{ type: 'note:create', note }], summary);
}

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
    description:
      'ページの一覧（名前、表示名、付箋の数、更新日時、親ページ）を、更新の新しい順に返す。updated_at は ISO 8601（UTC）の日時。ページは階層になっていて、parent は親ページの名前（ルートのページなら null）。',
    readOnly: true,
    input: z.object({
      updated_after: z
        .union([z.iso.datetime({ offset: true }), z.iso.date()])
        .optional()
        .describe(
          'この日時より後に更新されたページだけを返す。ISO 8601 の日時（updated_at と同じ書式）か、日付だけ（その日の UTC の 0 時）',
        ),
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    }),
    async run(access, input) {
      const updatedAfter = input.updated_after === undefined ? undefined : Date.parse(input.updated_after);
      const pages = await access.listPages({ updatedAfter, limit: input.limit });
      // 日時は、数値（UNIX ミリ秒）のままだと読み違えやすいので、文字列にして返す
      return pages.map((p) => ({ ...p, updated_at: new Date(p.updated_at).toISOString() }));
    },
  }),

  tool({
    name: 'search_pages',
    description: 'ページを全文検索する（表示名と付箋の本文）。parent は親ページの名前（ルートのページなら null）。',
    readOnly: true,
    input: z.object({ query: z.string().min(1).max(MAX_QUERY_LENGTH) }),
    run: (access, input) => access.searchPages(input.query),
  }),

  tool({
    name: 'read_board',
    description:
      '1 ページの付箋（id、本文、座標、大きさ、色、作成者）と接続線（id、from、to、label）を返す。座標は左上が原点で、単位はピクセル。child_page のある付箋は、子ページを表す付箋で、値は子ページの名前（中身は、その名前で read_board を呼ぶと読める）。',
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
            // 子ページの付箋だけに付ける
            child_page: childPageOf(n),
          })),
        ),
        edges: board.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label })),
      };
    },
  }),

  tool({
    name: 'add_notes',
    description:
      `付箋を追加する。位置を省略すると、near で指定した付箋の右（なければ既存の付箋の下）に、重ならないように置く。大きさを省略すると、幅は ${NOTE_WIDTH}、高さは本文の量に合わせて自動で決まる（長い本文でも、ふつうは指定しなくてよい）。connect_from を指定すると、その付箋から新しい付箋へ接続線を引く。`,
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
            width: noteSize.optional().describe(`付箋の幅。省略すると ${NOTE_WIDTH}`),
            height: noteSize
              .optional()
              .describe('付箋の高さ。省略すると、本文の量と幅に合わせて自動で決まる'),
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
        const noteWidth = spec.width ?? NOTE_WIDTH;
        const size = { width: noteWidth, height: spec.height ?? estimateHeight(spec.text, noteWidth) };
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
            width: noteSize.optional(),
            height: noteSize.optional(),
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
    name: 'move_notes',
    description:
      '付箋を、別のページ（すでにあるページ）へ移す。付箋の作成者は変わらない（delete_notes と add_notes で移すと、作成者が自分に変わるので、移すときはこれを使う）。移す付箋どうしをつなぐ接続線も一緒に移り、残る付箋とつながっていた接続線は消える。移す先では、付箋どうしの位置関係を保ったまま、今ある付箋の下に置く。子ページを表す付箋は移せない（ページごと移すときは move_page を使う）。note_ids は移した後の付箋の id で、指定した順に並ぶ。operations は、変更したページと操作の番号の組で、それぞれのページで revert_operation に渡せる。',
    readOnly: false,
    input: z.object({
      page: page.describe('付箋が今あるページのスラッグ'),
      note_ids: z.array(z.string()).min(1).max(MAX_ITEMS),
      to: page.describe('移す先のページのスラッグ'),
      reason,
    }),
    async run(access, input) {
      if (input.to === input.page) throw new ToolError('the notes are already in this page');
      assertUnique(input.note_ids);
      const moved = await access.moveNotes(
        input.page, input.to, input.note_ids, summaryOf('move_notes', input.reason),
      );
      const operations = [{ page: input.to, operation: moved.received }];
      if (moved.removed !== null) operations.push({ page: input.page, operation: moved.removed });
      return { note_ids: moved.noteIds, operations };
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
    name: 'create_page',
    description:
      'ページを新しく作る。付箋のない空のページができる。parent を指定すると、そのページの中に子ページとして置く（parent のボードに、子ページを表す付箋が足される）。すでにある名前では作れない（既存のページを別のページの中へ移すときは move_page を使う）。ページの作成そのものは、revert_operation では取り消せない。子ページとして置いた操作は、parent のページで取り消せる（取り消すと、作ったページはルートのページとして残る）。',
    readOnly: false,
    input: z.object({
      name: z
        .string()
        .regex(SLUG_RE)
        .describe('新しいページのスラッグ（URL に使う名前。英小文字、数字、ハイフン。後から変えられない）'),
      title: z.string().max(MAX_TITLE_LENGTH).optional().describe('ページの表示名。省略すると、スラッグが表示される'),
      parent: page.optional().describe('子ページとして置く先のページのスラッグ。省略すると、ルートのページになる'),
      reason,
    }),
    async run(access, input) {
      const { name, parent } = input;
      if (parent === name) throw new ToolError(`a page cannot be placed in itself: ${name}`);
      // 置く先が無ければ、ページを作る前に断る
      const parentBoard = parent === undefined ? undefined : await existingBoard(access, parent);
      const created = await access.createPage(name, input.title ?? '');
      if (created === 'exists') {
        throw new ToolError(`page already exists: ${name} (use move_page to place an existing page)`);
      }
      if (created === 'invalid title') throw new ToolError('invalid title (control characters are not allowed)');
      if (parent === undefined || parentBoard === undefined) return { page: name, parent: null };
      try {
        const seq = await placeChild(access, parentBoard, parent, name, summaryOf('create_page', input.reason));
        return { page: name, parent, operation: seq };
      } catch (e) {
        // ページはできているので、どんな失敗でも、そのことを伝える（作り直そうとすると exists で断られる）
        throw new ToolError(`created ${name} as a root page, but could not place it in ${parent}: ${messageOf(e)}`);
      }
    },
  }),

  tool({
    name: 'move_page',
    description:
      '既存のページを、別のページの中へ子ページとして移す（今の親ページにある子ページの付箋を消し、移す先に置く）。parent に null を指定すると、親から外してルートのページにする。子ページを持つページは、子孫ごと移る。今の親ページで子ページの付箋につながっていた接続線は消える。移す先に置けなかった場合（輪になる、階層が深すぎるなど）は、元の親ページに戻してエラーを返す。operations は、変更したページと操作の番号の組で、それぞれのページで revert_operation に渡せる。',
    readOnly: false,
    input: z.object({
      name: page.describe('移すページのスラッグ'),
      parent: page
        .nullable()
        .describe('移す先の親ページのスラッグ。null なら、親から外してルートのページにする'),
      reason,
    }),
    async run(access, input) {
      const { name, parent: target } = input;
      const current = await access.parentOf(name);
      if (current === undefined) throw new ToolError(`page not found: ${name}`);
      if (target === name) throw new ToolError(`a page cannot be placed in itself: ${name}`);
      if (current === target) {
        throw new ToolError(target === null ? `already a root page: ${name}` : `already in ${target}: ${name}`);
      }
      const summary = summaryOf('move_page', input.reason);
      // 移す先が無いか、移す先が自分の子孫（輪になる）なら、今の親から外す前に断る。
      // 深さの上限は、置くときに DO が確かめる（断られたら、下で元に戻す）
      const targetBoard = target === null ? undefined : await existingBoard(access, target);
      if (target !== null && (await isDescendant(access, target, name))) {
        throw new ToolError(`could not place ${name} in ${target}: ${target} is inside ${name}`);
      }
      const operations: { page: string; operation: number }[] = [];

      let removed: number | undefined;
      if (current !== null) {
        const board = await access.readBoard(current);
        const notes = board?.notes.filter((n) => childPageOf(n) === name) ?? [];
        if (notes.length > 0) {
          removed = await applyOrThrow(
            access, current, notes.map((note): HistoryDelta => ({ type: 'note:delete', note })), summary,
          );
          operations.push({ page: current, operation: removed });
        } else {
          // 親の記録が古い（親ページに付箋がない、親ページがもうない）。記録だけを消す
          await access.clearParent(name, current);
        }
      }
      if (target === null || targetBoard === undefined) return { page: name, from: current, to: null, operations };

      try {
        const placed = await placeChild(access, targetBoard, target, name, summary);
        operations.push({ page: target, operation: placed });
        return { page: name, from: current, to: target, operations };
      } catch (e) {
        const why = `could not place ${name} in ${target}: ${messageOf(e)}`;
        if (current === null || removed === undefined) throw new ToolError(why);
        // 置けなかったので、外した操作を取り消して、元の親ページに戻す
        await access
          .revert(current, removed, summaryOf('move_page', `restore ${name} after a failed move`))
          .catch(() => undefined);
        // 戻せたかは、取り消しの結果ではなく、今の親で判断する（間に人が別のページへ置いたこともある）
        const now = await access.parentOf(name).catch(() => undefined);
        if (now === current) throw new ToolError(`${why} (left it in ${current})`);
        const where = now === null ? 'is now a root page' : now === undefined ? 'could not be checked' : `is now in ${now}`;
        throw new ToolError(
          `${why}. It was removed from ${current} and ${where}; operation ${removed} on ${current} is the removal`,
        );
      }
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
