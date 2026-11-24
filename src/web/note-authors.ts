// 付箋の作成者と更新日時の表示。付箋の枠のすぐ下の領域（wema の renderNoteAccessory）に描く。
//
// 出すのは、付箋にホバーしたときと、付箋を選んだときだけ（切り替えは style.css）。AI（MCP の
// クライアント）が作った付箋には、作成者と日時の右に、その AI のアイコンを並べる。
// 値は、サーバーから届く付加情報（src/shared/note-info.ts）で、付箋のデータには入っていない。
//
// この領域には、付箋への反応など、ほかの要素も並べられる。足すときは `render` に足す。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import { isAgentActor, type NoteInfo, type Reaction, type ReactionKind, sameReactor } from '../shared/note-info';
import { el, formatDate } from './dom';
import { type IconName, icon } from './icons';
import { t } from './i18n';
import { onViewEnd } from './navigation';
import { authorLabel, avatar, avatarStack, displayName, onProfilesChange, requestProfiles } from './profiles';

/**
 * agent の名前（OAuth のリダイレクト先のホスト名）から、アイコンを選ぶ。知らないクライアントと、
 * 手元のクライアント（`localhost`。どの AI かは分からない）は、共通のアイコンにする
 */
function agentIcon(name: string): IconName {
  if (name.startsWith('claude')) return 'claude';
  if (name.startsWith('chatgpt') || name.startsWith('openai')) return 'openai';
  return 'agent';
}

/** リアクションを付けた人の名前（ボタンの説明に並べる） */
const reactorLabel = (r: Reaction) => authorLabel(r.actor, r.delegate);

/** いいねのボタンに重ねて並べるアイコンの数。超えた分は「+n」で出す */
const MAX_REACTOR_AVATARS = 3;

/**
 * リアクションを付けた人のアイコンを、重ねて並べる（issue #122）。agent は、委任者のアイコンにする
 * （本人と、その代理の agent が両方付けていれば、1 つにまとめる。「+n」も、まとめた後の人数で数える）。
 * 名前はボタンの説明に並べるので、アイコンには説明を付けない（付けると、ボタンの説明を隠す）
 */
function reactorAvatars(reactions: Reaction[]): HTMLElement {
  const people = [...new Set(reactions.map((r) => (isAgentActor(r.actor) && r.delegate ? r.delegate : r.actor)))];
  return avatarStack(people, { max: MAX_REACTOR_AVATARS, className: 'note-reactors', decorative: true });
}

export interface ReactionHooks {
  /** ログインしている人の主体（'user:<email>'）。分かるまでは null で、ボタンは押せない */
  me(): string | null;
  /** リアクションを付ける（`on` が false なら外す）。押せないとき（同期の前など）は、渡さない */
  react?(noteId: string, kind: ReactionKind, on: boolean): void;
}

export class NoteAuthors {
  private board: WemaBoard | undefined;
  private lookup: (noteId: string) => NoteInfo | undefined = () => undefined;

  /** @param reactions リアクションのボタン。渡さなければ出さない */
  constructor(private readonly reactions?: ReactionHooks) {}

  /**
   * wema の `renderNoteAccessory` に渡す。`container` は横並びの入れ物で、ポインタを受けるのは
   * 直接入れた要素だけなので、行で包まずに要素を直接入れる（包むと、その行が下の付箋の操作を妨げる）
   */
  readonly render = (note: WemaNote, container: HTMLElement): boolean => {
    const info = this.lookup(note.id);
    // 自分が作って、まだ確定していない付箋。確定したときに描き直す
    if (!info) return false;

    const { createdBy } = info;
    // 表示名がまだ届いていなければ引く。届いたら `attach` で描き直す
    void requestProfiles(
      [createdBy, info.delegate, ...(info.reactions ?? []).flatMap((r) => [r.actor, r.delegate])].filter(
        (actor): actor is string => typeof actor === 'string',
      ),
    );
    const date = formatDate(info.updatedAt);
    // 人のアイコン（issue #122）。agent の付箋は、委任者（agent を認可した人）のアイコンを出す。
    // agent 自身のアイコンは、右に並べる
    const person = createdBy === null ? null : isAgentActor(createdBy) ? (info.delegate ?? null) : createdBy;
    container.append(
      el(
        'span',
        {
          className: 'note-author',
          // 名前は短くしてあるので、主体の全体（email のドメインなど）は、ここで確かめられるようにする
          title: createdBy === null ? '' : [createdBy, info.delegate].filter(Boolean).join(' / '),
        },
        // 名前は隣に書き、主体の全体は親の説明に出すので、アイコンには説明を付けない
        ...(person === null ? [] : [avatar(person, { decorative: true })]),
        el('span', {
          className: 'note-author-text',
          textContent: createdBy === null ? date : t('author.detail', authorLabel(createdBy, info.delegate), date),
        }),
      ),
    );
    if (createdBy !== null && isAgentActor(createdBy)) {
      const name = displayName(createdBy);
      const badge = icon(agentIcon(name));
      badge.classList.add('note-agent', `note-agent-${agentIcon(name)}`);
      badge.role = 'img';
      badge.title = badge.ariaLabel = t('author.agentTitle', name);
      container.append(badge);
    }
    if (this.reactions) container.append(this.reactionButton(note.id, info.reactions ?? []));
    return true;
  };

  /**
   * いいねのボタン。数と、自分が付けたかを出し、押すと付ける・外す。付いていれば、ホバーしていなくても出す
   * （style.css）。付けた人の名前は、ボタンの説明に並べる
   */
  private reactionButton(noteId: string, all: Reaction[]): HTMLButtonElement {
    const kind: ReactionKind = 'like';
    const likes = all.filter((r) => r.kind === kind);
    const me = this.reactions?.me() ?? null;
    const mine = me !== null && likes.some((r) => sameReactor(r, me));
    const button = el('button', {
      type: 'button',
      className: `note-reaction${likes.length > 0 ? ' has-reactions' : ''}${mine ? ' mine' : ''}`,
      title: likes.length > 0 ? t('reaction.by', likes.map(reactorLabel).join(', ')) : t('reaction.like'),
      disabled: me === null || !this.reactions?.react,
    });
    button.ariaPressed = String(mine);
    button.append(icon('like'));
    if (likes.length > 0) button.append(el('span', { textContent: String(likes.length) }), reactorAvatars(likes));
    button.addEventListener('click', (e) => {
      // 付箋の選択やドラッグにしない
      e.stopPropagation();
      this.reactions?.react?.(noteId, kind, !mine);
    });
    button.addEventListener('pointerdown', (e) => e.stopPropagation());
    return button;
  }

  /** @param lookup 付箋の付加情報を返す。サーバーからまだ届いていなければ undefined */
  attach(board: WemaBoard, lookup: (noteId: string) => NoteInfo | undefined): void {
    this.board = board;
    this.lookup = lookup;
    // 表示名が届いたら、すべての付箋の名前を描き直す（届くのは、画面を開いたときと、新しい人が来たとき）
    const off = onProfilesChange(() => this.refresh(board.getNotes().map((note) => note.id)));
    onViewEnd(() => {
      off();
      this.board = undefined;
    });
  }

  /** 付加情報が変わった付箋を描き直す。もうない付箋の id が入っていてもよい */
  readonly refresh = (noteIds: Iterable<string>): void => {
    for (const id of noteIds) this.board?.refreshNoteAccessory(id);
  };
}
