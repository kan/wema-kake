// ツール（src/shared/tools.ts）が使う BoardAccess の、サーバー版。ページの DO と D1 を呼ぶ。
import type { OpSummary, RevertOutcome } from '../../shared/api';
import type { HistoryDelta } from '../../shared/delta';
import { type ApplyOutcome, type BoardAccess, type BoardState, ToolError } from '../../shared/tools';
import { listPages, searchPages } from '../page-queries';
import { extractContent } from '../plain-text';

/** ops に記録する clientId。MCP にはブラウザのような接続ごとの id がない */
const MCP_CLIENT_ID = 'mcp';

export class ServerBoardAccess implements BoardAccess {
  /**
   * @param actor 変更の主体（'agent:<client>'）。認証結果から決めたものを渡す
   */
  constructor(
    private readonly env: Env,
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
    return hits.map(({ name, title, snippet }) => ({ name, title: title ?? null, snippet }));
  }

  async readBoard(slug: string): Promise<BoardState | null> {
    return this.page(slug).getBoardState();
  }

  async plainText(html: string): Promise<string> {
    return (await extractContent(html)).text;
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
