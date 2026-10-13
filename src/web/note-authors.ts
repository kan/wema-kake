// 付箋の作成者と更新日時の表示。付箋の枠のすぐ下の領域（wema の renderNoteAccessory）に描く。
//
// AI（MCP のクライアント）が作った付箋には、印を常に出す。作成者と日時は、付箋にホバーするか、
// 付箋を選ぶか、印を押したときに出す（切り替えは style.css。押して出した状態は、ここで持つ）。
// 値は、サーバーから届く付加情報（src/shared/note-info.ts）で、付箋のデータには入っていない。
//
// この領域には、付箋への反応など、ほかの要素も並べられる。足すときは `render` に足す。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import { isAgentActor, type NoteInfo } from '../shared/note-info';
import { el, formatDate } from './dom';
import { t } from './i18n';
import { onViewEnd } from './navigation';

/** 主体（'user:<email>' / 'agent:<client>'）の、画面に出す名前。email は `@` より前だけを出す */
function actorLabel(actor: string): string {
  const name = actor.slice(actor.indexOf(':') + 1);
  return actor.startsWith('user:') ? name.split('@')[0] || name : name;
}

export class NoteAuthors {
  private board: WemaBoard | undefined;
  private lookup: (noteId: string) => NoteInfo | undefined = () => undefined;
  /** 印を押して、作成者と日時を出したままにしている付箋 */
  private readonly opened = new Set<string>();

  /**
   * wema の `renderNoteAccessory` に渡す。`container` は横並びの入れ物で、ポインタを受けるのは
   * 直接入れた要素だけなので、行で包まずに要素を直接入れる（包むと、その行が下の付箋の操作を妨げる）
   */
  readonly render = (note: WemaNote, container: HTMLElement): boolean => {
    const info = this.lookup(note.id);
    // 自分が作って、まだ確定していない付箋。確定したときに描き直す
    if (!info) return false;

    const { createdBy } = info;
    const date = formatDate(info.updatedAt);
    const detail = el('span', {
      className: 'note-author',
      textContent: createdBy === null ? date : t('author.detail', actorLabel(createdBy), date),
      // 名前は短くしてあるので、主体の全体（email のドメインなど）は、ここで確かめられるようにする
      title: createdBy ?? '',
    });
    if (createdBy === null || !isAgentActor(createdBy)) {
      container.append(detail);
      return true;
    }

    const opened = this.opened.has(note.id);
    detail.classList.toggle('note-author-open', opened);
    const badge = el('button', {
      type: 'button',
      className: 'note-agent',
      textContent: t('author.agent'),
      title: t('author.agentTitle', actorLabel(createdBy)),
      ariaExpanded: String(opened),
    });
    // 描き直した後も、フォーカスを印に残す（wema が、同じ値の要素へ戻す）
    badge.dataset.wemaFocusKey = 'agent';
    badge.addEventListener('click', () => {
      if (!this.opened.delete(note.id)) this.opened.add(note.id);
      this.board?.refreshNoteAccessory(note.id);
    });
    container.append(detail, badge);
    return true;
  };

  /** @param lookup 付箋の付加情報を返す。サーバーからまだ届いていなければ undefined */
  attach(board: WemaBoard, lookup: (noteId: string) => NoteInfo | undefined): void {
    this.board = board;
    this.lookup = lookup;
    onViewEnd(() => {
      this.board = undefined;
    });
  }

  /** 付加情報が変わった付箋を描き直す。もうない付箋の id が入っていてもよい */
  readonly refresh = (noteIds: Iterable<string>): void => {
    for (const id of noteIds) {
      if (this.lookup(id) === undefined) this.opened.delete(id);
      this.board?.refreshNoteAccessory(id);
    }
  };
}
