// ツール（src/shared/tools.ts）が使う BoardAccess の、サーバー版。ページの DO と D1 を呼ぶ。
import type { OpSummary, RevertOutcome } from '../../shared/api';
import type { HistoryDelta } from '../../shared/delta';
import { type ApplyOutcome, type BoardAccess, type BoardState, ToolError } from '../../shared/tools';
import type { WemaKakeEnv } from '../config';
import { listPages, searchPages } from '../page-queries';
import { extractContent } from '../plain-text';
import { transferNotes } from '../transfer';

/** ops に記録する clientId。MCP にはブラウザのような接続ごとの id がない */
const MCP_CLIENT_ID = 'mcp';

export class ServerBoardAccess implements BoardAccess {
  /**
   * @param actor 変更の主体（'agent:<client>'）。認証結果から決めたものを渡す
   */
  constructor(
    private readonly env: WemaKakeEnv,
    private readonly actor: string,
  ) {}

  private page(slug: string) {
    return this.env.PAGE.getByName(slug);
  }

  listPages(options: { updatedAfter?: number; limit?: number }) {
    return listPages(this.env.DB, options);
  }

  async searchPages(query: string) {
    const hits = await searchPages(this.env.DB, query);
    if (hits === null) throw new ToolError('invalid query');
    return hits.map(({ name, title, parent, snippet }) => ({ name, title, parent, snippet }));
  }

  async readBoard(slug: string): Promise<BoardState | null> {
    return this.page(slug).getBoardState();
  }

  async parentOf(slug: string): Promise<string | null | undefined> {
    const ref = await this.page(slug).getPageRef();
    return ref === null ? undefined : ref.parent;
  }

  async clearParent(slug: string, parent: string): Promise<void> {
    await this.page(slug).clearParent(parent);
  }

  async createPage(slug: string, title: string): Promise<'created' | 'exists' | 'invalid title'> {
    const result = await this.page(slug).createPage(title);
    return result.ok ? 'created' : result.reason;
  }

  async plainText(html: string): Promise<string> {
    // ページへのリンクは、書くときと同じ書式（[[slug]]）で残す
    return (await extractContent(html, { siteOrigin: this.env.SITE_ORIGIN })).text;
  }

  async apply(slug: string, deltas: HistoryDelta[], summary: string): Promise<ApplyOutcome> {
    const result = await this.page(slug).applyOps({
      actor: this.actor,
      clientId: MCP_CLIENT_ID,
      opId: crypto.randomUUID(),
      deltas,
      summary,
      // 読んでから適用するまでの間にページが削除されていても、作り直さない
      mustExist: true,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    // すべてのデルタが捨てられた場合、seq は進んでいない（直前の別の操作の番号が入っている）
    return { ok: true, seq: result.deltas.length > 0 ? result.seq : null };
  }

  async moveNotes(from: string, to: string, ids: string[], summary: string) {
    const result = await transferNotes(this.env, {
      actor: this.actor,
      clientId: MCP_CLIENT_ID,
      opId: crypto.randomUUID(),
      from,
      to,
      noteIds: ids,
      copy: false,
      summary,
    });
    if (!result.ok) throw new ToolError(result.reason);
    const { ok: _, ...moved } = result;
    return moved;
  }

  async ownOps(slug: string): Promise<OpSummary[]> {
    return this.page(slug).listOps({ actor: this.actor });
  }

  async revert(slug: string, seq: number, summary: string): Promise<RevertOutcome> {
    const result = await this.page(slug).revert({
      seq,
      actor: this.actor,
      clientId: MCP_CLIENT_ID,
      opId: crypto.randomUUID(),
      // agent が取り消せるのは、自分の操作だけ
      ownOnly: true,
      summary,
    });
    if (!result.ok) throw new ToolError(result.reason);
    return { seq: result.seq, applied: result.applied, skipped: result.skipped };
  }
}
