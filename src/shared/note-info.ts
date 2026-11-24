// 付箋ごとの付加情報。サーバーが認証結果と時刻から決める値で、付箋のデータ（WemaNote、meta）には
// 入れない（クライアントが書き換えられる値になるため）。画面は、表示にだけ使う。
//
// 項目を足すとき（付箋への反応など）も、付箋の id ごとのこの形に足し、スナップショットの `info` で
// 届ける。操作の履歴に積まない項目は seq を進めないので、変更は `ops` ではなく、別のメッセージで届ける
// （`meta` と同じく、再接続のときに現在値を送り直す）。
import type { HistoryDelta } from './delta';

/** 付箋に付けられるリアクションの種類。まず「いいね」だけ。種類を足すときは、末尾に足す */
export const REACTION_KINDS = ['like'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

export const isReactionKind = (value: unknown): value is ReactionKind =>
  (REACTION_KINDS as readonly unknown[]).includes(value);

/**
 * 付箋へのリアクション 1 つ。利用者ごとに、付箋 1 枚につき種類ごとに 1 つ。agent は、主体と委任者の
 * 組ごとに 1 つ（管理者が 2 人以上いると、どちらの agent も同じ主体になるため）。
 * **付箋の変更ではない**ので、付けても外しても、書き込み者と更新日時は変わらず、ops にも積まない
 */
export interface Reaction {
  kind: ReactionKind;
  /** 付けた主体（'user:<email>' / 'agent:<client>'） */
  actor: string;
  /** agent なら、その委任者（'user:<email>'） */
  delegate?: string;
  /** 付けた時刻（UNIX ミリ秒） */
  at: number;
}

/** 同じ人（主体と委任者）のリアクションか */
export const sameReactor = (r: Pick<Reaction, 'actor' | 'delegate'>, actor: string, delegate?: string | null) =>
  r.actor === actor && (r.delegate ?? null) === (delegate ?? null);

export interface NoteInfo {
  /**
   * 書き込み者（'user:<email>' / 'agent:<client>'）。分からなければ null。付箋を作った人で、その後に
   * 移動以外の変更（本文、色、大きさなど）をした人がいれば、最後にした人になる（`changesWriter`）
   */
  createdBy: string | null;
  /**
   * 作成者が agent なら、その委任者（agent を認可した人の 'user:<email>'）。分からなければ null。
   * 古い Worker のスナップショットには入っていない
   */
  delegate?: string | null;
  /** 最後に変更した時刻（UNIX ミリ秒）。移動や大きさの変更でも変わる */
  updatedAt: number;
  /**
   * リアクション（付けた順）。なければ省く。ops では届かず、`reactions` のメッセージで届く
   * （src/shared/protocol.ts）
   */
  reactions?: Reaction[];
}

/** 付箋の id ごとの付加情報（スナップショットに載せる形） */
export type NoteInfos = Record<string, NoteInfo>;

/** 付箋の大きさの決まり方。内容で決まる大きさの変更は、書き込み者を変えない */
export interface SizedBy {
  autoSize?: boolean;
  foldable?: boolean;
}

/** サーバーが自分で行う操作の主体（期限による削除、色の食い違いの修復など）。書き込み者にはしない */
export const SYSTEM_ACTOR = 'system';

/**
 * 付箋の更新で、書き込み者を操作の主体に変えるか。**サーバー（src/worker/apply-ops.ts の applyDeltas）と
 * 画面（applyOpToInfos）の両方が、これで決める。**
 *
 * 変えないのは、次のフィールドだけの変更。
 * - 位置（x、y）
 * - 内容で決まる大きさ。autoSize の付箋の幅と高さ、foldable の付箋の高さ。wema は、表示したブラウザで
 *   測った大きさを、そのブラウザでの次の更新（移動など）に載せて送る。付箋を見て動かしただけの人を、
 *   書き込み者にしないため
 *
 * サーバーが自分で行う操作（主体が `system`）では、変えない。
 *
 * @param changed 実際に変わったフィールド（サーバーが適用したデルタの `after` と `before` のキー）
 * @param sized 更新した後の付箋の、大きさの決まり方
 */
export function changesWriter(actor: string, changed: Iterable<string>, sized: SizedBy): boolean {
  if (actor === SYSTEM_ACTOR) return false;
  for (const key of changed) {
    if (key === 'x' || key === 'y') continue;
    if (key === 'width' && sized.autoSize) continue;
    if (key === 'height' && (sized.autoSize || sized.foldable)) continue;
    return true;
  }
  return false;
}

/** 作成者が agent（MCP のクライアント）か */
export const isAgentActor = (actor: string | null): boolean => actor?.startsWith('agent:') ?? false;

const USER_ACTOR_PREFIX = 'user:';

/** 人の主体（'user:<email>'）の email。人でなければ undefined */
export const emailOfActor = (actor: string): string | undefined =>
  actor.startsWith(USER_ACTOR_PREFIX) ? actor.slice(USER_ACTOR_PREFIX.length) : undefined;

/** email から、人の主体（'user:<email>'）を作る */
export const userActor = (email: string): string => `${USER_ACTOR_PREFIX}${email}`;

/**
 * 確定した操作を、付加情報に反映する。サーバーが付箋の行に書く値（`created_by`、`delegate`、`updated_at`）と
 * 同じ結果になる。変わった付箋の id を返す。
 *
 * @param actor 操作の主体
 * @param at 操作を記録した時刻
 * @param deltas サーバーが実際に適用したデルタ
 * @param delegate 操作の委任者（`OpsMsg.delegate`）
 * @param sizedBy 付箋の、適用する前の大きさの決まり方（手元のボードの値）。書き込み者を変えるかの判定に使う
 */
export function applyOpToInfos(
  infos: Map<string, NoteInfo>,
  actor: string,
  at: number,
  deltas: HistoryDelta[],
  delegate: string | null = null,
  sizedBy: (noteId: string) => SizedBy | undefined = () => undefined,
): Set<string> {
  const changed = new Set<string>();
  for (const d of deltas) {
    if (d.type === 'note:create') {
      infos.set(d.note.id, { createdBy: actor, delegate, updatedAt: at });
      changed.add(d.note.id);
    } else if (d.type === 'note:delete') {
      if (infos.delete(d.note.id)) changed.add(d.note.id);
    } else if (d.type === 'note:update') {
      // 手元にない付箋の更新は、作成者が分からないまま、時刻だけを持つ
      // リアクションなど、操作で変わらない項目は残す
      const cur = infos.get(d.noteId);
      const before = sizedBy(d.noteId) ?? {};
      const sized: SizedBy = {
        autoSize: 'autoSize' in d.after ? d.after.autoSize === true : 'autoSize' in d.before ? false : before.autoSize,
        foldable: 'foldable' in d.after ? d.after.foldable === true : 'foldable' in d.before ? false : before.foldable,
      };
      const keys = new Set([...Object.keys(d.before), ...Object.keys(d.after)]);
      const rewrite = changesWriter(actor, keys, sized);
      infos.set(d.noteId, {
        ...cur,
        createdBy: rewrite ? actor : (cur?.createdBy ?? null),
        delegate: rewrite ? delegate : (cur?.delegate ?? null),
        updatedAt: at,
      });
      changed.add(d.noteId);
    }
  }
  return changed;
}
