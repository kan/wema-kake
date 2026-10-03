// 一覧のボードのデータを作る。ページ 1 つを付箋 1 枚、ページ間のリンクを接続線にする。
// DOM には依存しない（配置は wema のレイアウト関数で計算する）。
import { computeAutoLayout, type WemaBoardData, type WemaEdge, type WemaNote } from '@kanf/wema';
import type { IndexLink, IndexPage } from '../shared/api';

export interface IndexBoard {
  data: WemaBoardData;
  /** 付箋の id（= スラッグ）→ 絞り込みで照合する文字列（小文字にした表示名とスラッグ） */
  searchText: Map<string, string>;
}

const NOTE_WIDTH = 220;
const NOTE_HEIGHT = 130;
const GAP = 40;
const MARGIN = 40;
const PAGE_COLOR = '#FFF9C4';
/** まだ作られていないページ（リンクだけがある） */
const MISSING_COLOR = '#E0E0E0';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const META_STYLE = 'font-size: 11px; color: #666';

function pageHtml(page: IndexPage, formatDate: (ms: number) => string): string {
  const title = escapeHtml(page.title ?? page.name);
  const meta = `${formatDate(page.updated_at)}・付箋 ${page.note_count} 枚`;
  return (
    `<a href="/p/${page.name}"><b>${title}</b></a>` +
    `<div>${escapeHtml(page.excerpt)}</div>` +
    `<div><span style="${META_STYLE}">${escapeHtml(meta)}</span></div>`
  );
}

function missingHtml(slug: string): string {
  return `<a href="/p/${slug}">${slug}</a><div><span style="${META_STYLE}">未作成</span></div>`;
}

/**
 * ページとリンクから、一覧のボードを作る。
 *
 * - リンクでつながったページは、wema の自動レイアウトで階層に並べる
 * - つながりのないページは、その下に、渡された順（更新の新しい順）で `viewportWidth` に収まる列数で並べる
 * - リンク先が未作成のページは、色を変えた付箋として出す
 * - リンク先が一覧に含まれない既存のページ（件数の上限で外れたもの）への線は引かない
 */
export function buildIndexBoard(
  pages: IndexPage[],
  links: IndexLink[],
  viewportWidth: number,
  formatDate: (ms: number) => string,
): IndexBoard {
  const notes = new Map<string, WemaNote>();
  const searchText = new Map<string, string>();
  const addNote = (id: string, text: string, color: string, search: string) => {
    notes.set(id, { id, x: 0, y: 0, width: NOTE_WIDTH, height: NOTE_HEIGHT, text, color, zIndex: 1 });
    searchText.set(id, search.toLowerCase());
  };
  for (const page of pages) {
    addNote(page.name, pageHtml(page, formatDate), PAGE_COLOR, `${page.title ?? ''}\n${page.name}`);
  }

  const edges: WemaEdge[] = [];
  const connected = new Set<string>();
  for (const { from_page: from, to_page: to, missing } of links) {
    if (from === to || !notes.has(from)) continue;
    if (!notes.has(to)) {
      if (!missing) continue;
      addNote(to, missingHtml(to), MISSING_COLOR, to);
    }
    edges.push({ id: `${from}>${to}`, from, to, fromAnchor: 'auto', toAnchor: 'auto', style: 'arrow' });
    connected.add(from).add(to);
  }

  // つながったページを階層に並べる
  let bottom = MARGIN;
  const place = (id: string, x: number, y: number) => {
    const note = notes.get(id)!;
    note.x = x;
    note.y = y;
    bottom = Math.max(bottom, y + NOTE_HEIGHT);
  };
  const placed = new Set<string>();
  if (edges.length > 0) {
    const positions = computeAutoLayout([...notes.values()], edges, { noteIds: [...connected] });
    for (const { id, x, y } of positions) {
      place(id, x, y);
      placed.add(id);
    }
    bottom += GAP;
  }

  // 残りのページ（つながりのないページ）を、その下に並べる。自動レイアウトが位置を
  // 返さなかったページがあっても、ここで置くので重ならない
  const columns = Math.max(1, Math.floor((viewportWidth - MARGIN * 2 + GAP) / (NOTE_WIDTH + GAP)));
  const top = bottom;
  let index = 0;
  for (const id of notes.keys()) {
    if (placed.has(id)) continue;
    const column = index % columns;
    const row = Math.floor(index / columns);
    place(id, MARGIN + column * (NOTE_WIDTH + GAP), top + row * (NOTE_HEIGHT + GAP));
    index++;
  }

  return { data: { version: 1, notes: [...notes.values()], edges }, searchText };
}
