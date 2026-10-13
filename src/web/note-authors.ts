// 付箋の作成者と更新日時の表示。付箋の枠のすぐ下の領域（wema の renderNoteAccessory）に描く。
//
// 出すのは、付箋にホバーしたときと、付箋を選んだときだけ（切り替えは style.css）。AI（MCP の
// クライアント）が作った付箋には、作成者と日時の右に、その AI のアイコンを並べる。
// 値は、サーバーから届く付加情報（src/shared/note-info.ts）で、付箋のデータには入っていない。
//
// この領域には、付箋への反応など、ほかの要素も並べられる。足すときは `render` に足す。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import { isAgentActor, type NoteInfo } from '../shared/note-info';
import { el, formatDate } from './dom';
import { type IconName, icon } from './icons';
import { t } from './i18n';
import { onViewEnd } from './navigation';

/** 主体（'user:<email>' / 'agent:<client>'）の、画面に出す名前。email は `@` より前だけを出す */
function actorLabel(actor: string): string {
  const name = actor.slice(actor.indexOf(':') + 1);
  return actor.startsWith('user:') ? name.split('@')[0] || name : name;
}

/**
 * agent の名前（OAuth のリダイレクト先のホスト名）から、アイコンを選ぶ。知らないクライアントと、
 * 手元のクライアント（`localhost`。どの AI かは分からない）は、共通のアイコンにする
 */
function agentIcon(name: string): IconName {
  if (name.startsWith('claude')) return 'claude';
  if (name.startsWith('chatgpt') || name.startsWith('openai')) return 'openai';
  return 'agent';
}

export class NoteAuthors {
  private board: WemaBoard | undefined;
  private lookup: (noteId: string) => NoteInfo | undefined = () => undefined;

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
    container.append(
      el('span', {
        className: 'note-author',
        textContent: createdBy === null ? date : t('author.detail', actorLabel(createdBy), date),
        // 名前は短くしてあるので、主体の全体（email のドメインなど）は、ここで確かめられるようにする
        title: createdBy ?? '',
      }),
    );
    if (createdBy !== null && isAgentActor(createdBy)) {
      const name = actorLabel(createdBy);
      const badge = icon(agentIcon(name));
      badge.classList.add('note-agent', `note-agent-${agentIcon(name)}`);
      badge.role = 'img';
      badge.title = badge.ariaLabel = t('author.agentTitle', name);
      container.append(badge);
    }
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
    for (const id of noteIds) this.board?.refreshNoteAccessory(id);
  };
}
