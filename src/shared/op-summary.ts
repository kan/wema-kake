// サーバーが付ける、操作の要約（ops.summary）。文言ではなく符号で保存し、画面が、今の言語の文言に
// して出す（docs/plan.md のフェーズ 9）。LLM が MCP で付けた要約は、書かれた文のまま保存する。
//
// 符号を足す前に保存された要約（日本語の文）は、そのまま残っている。画面は、符号でない要約を、
// そのまま出す。

const PREFIX = 'system:';

/** 保存する符号 */
export const systemSummary = {
  /** ページを、付箋を置いた状態で作った（最初のページ） */
  pageCreated: () => `${PREFIX}page-created`,
  /** 子ページ `page` を削除したので、その付箋を消した */
  childRemoved: (page: string) => `${PREFIX}child-removed:${page}`,
  /** 操作 `seq` を取り消した（要約を付けずに取り消したとき） */
  revert: (seq: number) => `${PREFIX}revert:${seq}`,
};

export type SystemSummary =
  | { kind: 'pageCreated' }
  | { kind: 'childRemoved'; page: string }
  | { kind: 'revert'; seq: number };

/** 要約が、サーバーの付けた符号なら、その中身を返す。符号でなければ（知らない符号も）null */
export function parseSystemSummary(summary: string): SystemSummary | null {
  if (!summary.startsWith(PREFIX)) return null;
  const [kind, ...rest] = summary.slice(PREFIX.length).split(':');
  const value = rest.join(':');
  if (kind === 'page-created' && value === '') return { kind: 'pageCreated' };
  if (kind === 'child-removed' && value !== '') return { kind: 'childRemoved', page: value };
  if (kind === 'revert' && /^\d+$/.test(value)) return { kind: 'revert', seq: Number(value) };
  return null;
}
