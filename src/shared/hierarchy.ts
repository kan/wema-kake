// ページの階層（docs/plan.md のフェーズ 6.6）。
//
// ページを、別のページのボードの上に「子ページの付箋」として置くと、そのページの子になる。
// 子ページの付箋は、meta に子ページのスラッグを持つ付箋。本文のリンクは、階層には関与しない。
// 親は 1 つだけで、階層は木になる。
import type { HistoryDelta, WemaNote } from './delta';

/** 子ページの付箋の meta のキー。値は、子ページのスラッグ */
export const CHILD_PAGE_KEY = 'page';

/** 階層の深さの上限。ルートを 1 段目と数える */
export const MAX_DEPTH = 5;

/**
 * 子ページとして置けなかった理由。
 * - not-found: ページがない
 * - self: 自分自身を置こうとした
 * - other-parent: すでに別のページの子になっている
 * - duplicate: このページに、すでに置いてある
 * - ancestor: このページの先祖なので、輪になる
 * - too-deep: 深さの上限を超える
 */
export type ChildRejectCode = 'not-found' | 'self' | 'other-parent' | 'duplicate' | 'ancestor' | 'too-deep';

/** 置けなかったときの `reject` の `reason` の先頭。続けて、理由と、置こうとしたページが入る */
const REJECT_PREFIX = 'child page: ';

/** 置けなかったことを表す `reason`。画面は `parseChildRejection` で読み、agent はそのまま読む */
export function childRejection(code: ChildRejectCode, page: string): string {
  return `${REJECT_PREFIX}${code}: ${page}`;
}

/** `reason` が、子ページとして置けなかったことを表していれば、理由とページを返す */
export function parseChildRejection(reason: string): { code: ChildRejectCode; page: string } | undefined {
  if (!reason.startsWith(REJECT_PREFIX)) return undefined;
  const [code, page] = reason.slice(REJECT_PREFIX.length).split(': ');
  return { code: code as ChildRejectCode, page: page ?? '' };
}

/** 子ページの付箋なら、子ページのスラッグを返す */
export function childPageOf(note: Pick<WemaNote, 'meta'>): string | undefined {
  return note.meta?.[CHILD_PAGE_KEY];
}

/**
 * デルタが、子ページの付箋の集合を変え得るか。変え得るのは、付箋の削除（消す付箋が子ページの
 * 付箋かどうかは、保存してある値で決まる）、子ページの付箋の作成、meta の更新
 */
export function touchesChildren(deltas: HistoryDelta[]): boolean {
  return deltas.some(
    (d) =>
      d.type === 'note:delete' ||
      (d.type === 'note:create' && childPageOf(d.note) !== undefined) ||
      (d.type === 'note:update' && ('meta' in d.before || 'meta' in d.after)),
  );
}

/** デルタを適用すると、新しく子として置かれることになるページ（重複は除く） */
export function placedPages(deltas: HistoryDelta[]): string[] {
  const pages = new Set<string>();
  for (const d of deltas) {
    const page =
      d.type === 'note:create' ? childPageOf(d.note) : d.type === 'note:update' ? childPageOf(d.after) : undefined;
    if (page !== undefined) pages.add(page);
  }
  return [...pages];
}
