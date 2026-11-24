// 同じページを開いているほかの人（issue #124）。ヘッダーにアイコンを並べ、その人が選んでいる付箋に
// その人の色の枠を付ける。本文を編集していれば「a が編集中」と出す。
//
// 自分（同じ主体）の別のタブは出さない（ヘッダーには自分のアイコンがすでにある）。同じ人の複数の
// タブは、ヘッダーでは 1 つにまとめる。agent（MCP）は WebSocket でつながらないので出ない。
import type { WemaNoteDecoration } from '@kanf/wema';
import type { PeerPresence } from '../shared/protocol';
import { el } from './dom';
import { t } from './i18n';
import { avatarStack, displayName, hueOf, onProfilesChange, requestProfiles } from './profiles';

/** ヘッダーに並べるアイコンの数。超えた分は「+n」で出す */
const MAX_PRESENCE_AVATARS = 5;

/** 付箋に付ける、ほかの人の印 */
interface NoteMark {
  actor: string;
  editing: boolean;
}

/** CSS の文字列（`content` に渡す）にする。表示名は制御文字を含まない（サーバーが断る） */
const cssString = (text: string) => `"${text.replace(/[\\"]/g, '\\$&')}"`;

export class PresenceView {
  /** ヘッダーに置く、開いている人のアイコンの並び。誰もいなければ隠す */
  readonly root = el('span', { className: 'presence-bar', title: t('presence.title'), hidden: true });
  private peers: ReadonlyMap<string, PeerPresence> = new Map();
  /** 自分を除いた、開いている人（同じ人は 1 つ。つながった順） */
  private actors: string[] = [];
  private marks = new Map<string, NoteMark>();
  private me: string | null = null;

  /** @param refreshNote 付箋の飾り（`decoration`）を描き直す */
  constructor(private readonly refreshNote: (noteId: string) => void) {}

  /**
   * 表示名かアイコンが変わったら描き直す。返す関数で止める。付箋の枠の色は email で決まるので、
   * 描き直すのは、名前を出している「編集中」の付箋だけ
   */
  attach(): () => void {
    return onProfilesChange(() => {
      this.renderBar();
      for (const [id, mark] of this.marks) if (mark.editing) this.refreshNote(id);
    });
  }

  /** 自分の主体。分かるまでは、自分の別のタブも出る */
  setMe(actor: string): void {
    this.me = actor;
    this.update(this.peers);
  }

  update(peers: ReadonlyMap<string, PeerPresence>): void {
    this.peers = peers;
    const others = [...peers.values()].filter((p) => p.actor !== this.me);
    const marks = new Map<string, NoteMark>();
    for (const peer of others) {
      // 同じ付箋を何人かが選んでいたら、編集している人を優先し、ほかは先の人
      if (peer.editing) marks.set(peer.editing, { actor: peer.actor, editing: true });
      for (const id of peer.selection) if (!marks.has(id)) marks.set(id, { actor: peer.actor, editing: false });
    }
    const changed = [...new Set([...this.marks.keys(), ...marks.keys()])].filter((id) => {
      const before = this.marks.get(id);
      const after = marks.get(id);
      return before?.actor !== after?.actor || before?.editing !== after?.editing;
    });
    this.marks = marks;
    for (const id of changed) this.refreshNote(id);

    const actors = [...new Set(others.map((p) => p.actor))];
    // 選択が変わっただけで、並ぶ人が同じなら、ヘッダーは作り直さない（画像を読み直さない）
    if (actors.join('\n') === this.actors.join('\n')) return;
    this.actors = actors;
    // 名前とアイコンを引いてから描く（届いたら onProfilesChange でもう一度描く）
    void requestProfiles(actors);
    this.renderBar();
  }

  /** 付箋の飾り。ほかの人が選んでいなければ undefined */
  decoration(noteId: string): WemaNoteDecoration | undefined {
    const mark = this.marks.get(noteId);
    if (!mark) return undefined;
    return {
      className: mark.editing ? 'note-peer note-peer-editing' : 'note-peer',
      style: {
        '--peer-hue': String(hueOf(mark.actor)),
        ...(mark.editing ? { '--peer-label': cssString(t('presence.editing', displayName(mark.actor))) } : {}),
      },
    };
  }

  private renderBar(): void {
    this.root.replaceChildren(avatarStack(this.actors, { max: MAX_PRESENCE_AVATARS, className: 'presence-avatars' }));
    this.root.hidden = this.actors.length === 0;
  }
}
