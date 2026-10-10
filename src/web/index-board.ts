// 一覧のボードのデータを作る。ページ 1 つを付箋 1 枚、ページ間のリンクを接続線にする。
// DOM には依存しない。配置はここで計算する（wema の自動レイアウトは、1 つの階層を横 1 列に
// 並べるので、リンクの多いページがあると横に長くなりすぎる）。
import type { WemaBoardData, WemaEdge, WemaNote } from '@kanf/wema';
import type { IndexLink, IndexPage } from '../shared/api';
import { t } from './i18n';

export interface IndexBoard {
  data: WemaBoardData;
  /** 付箋の id（= スラッグ）→ 絞り込みで照合する文字列（小文字にした表示名とスラッグ） */
  searchText: Map<string, string>;
  /** 付箋の id → 付箋の本文（絞り込みで一致の数を足す前の、元の本文） */
  texts: Map<string, string>;
}

const NOTE_WIDTH = 220;
/** 表示名、本文の冒頭（60 文字まで）、更新日時と付箋の数と子ページの数の行が、切れずに入る高さ */
const NOTE_HEIGHT = 160;
const GAP = 40;
const MARGIN = 40;
const PAGE_COLOR = '#FFF9C4';
/** まだ作られていないページ（リンクだけがある） */
const MISSING_COLOR = '#E0E0E0';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** リンクの線。本数が多くなるので、細く、矢印も小さくする（色は style.css の .index-canvas） */
const EDGE_STYLE: Omit<WemaEdge, 'id' | 'from' | 'to'> = {
  fromAnchor: 'auto',
  toAnchor: 'auto',
  style: 'arrow',
  strokeWidth: 1,
  arrowSize: 8,
};

const META_STYLE = 'font-size: 11px; color: #666';

function pageHtml(page: IndexPage, formatDate: (ms: number) => string): string {
  const title = escapeHtml(page.title ?? page.name);
  // 子ページは一覧に出ないので、中に何枚のボードがあるかを、ルートの付箋に出す
  const meta = t('index.meta', formatDate(page.updated_at), page.note_count, page.child_count);
  return (
    `<a href="/p/${page.name}"><b>${title}</b></a>` +
    `<div>${escapeHtml(page.excerpt)}</div>` +
    `<div><span style="${META_STYLE}">${escapeHtml(meta)}</span></div>`
  );
}

/**
 * 絞り込みで、子孫のページが一致したルートの付箋に足す表示。一致がなければ空文字
 * （付箋の本文の後ろに付ける。付箋の本文は index.texts）
 */
export function descendantHitsHtml(count: number): string {
  if (count === 0) return '';
  return `<div><span style="font-size: 11px; color: #1d4ed8"><b>${escapeHtml(t('index.descendantHits', count))}</b></span></div>`;
}

function missingHtml(slug: string): string {
  return `<a href="/p/${slug}">${slug}</a><div><span style="${META_STYLE}">${escapeHtml(t('index.missing'))}</span></div>`;
}

const CELL_WIDTH = NOTE_WIDTH + GAP;
const CELL_HEIGHT = NOTE_HEIGHT + GAP;
/** 階層と階層の間に足す間隔。線が通る場所を空ける */
const LAYER_GAP = 60;
/** まとまりの行と行の間（縦）に空ける間隔 */
const CLUSTER_GAP = 80;

/** リンクでつながったページのまとまり 1 つの配置。位置は、まとまりの左上からの相対 */
interface Cluster {
  width: number;
  height: number;
  positions: Map<string, { x: number; y: number }>;
}

/**
 * まとまり 1 つを、階層に並べる。リンク元を上、リンク先を下にする。
 *
 * 1 つの階層のページが多いときは、横 1 列に伸ばさずに複数の行へ折り返す
 * （1 ページへ 100 ページからリンクがあると、横 1 列では 100 枚ぶんの幅になり、線も長くなる）。
 */
function layoutCluster(ids: string[], edges: WemaEdge[], maxColumns: number): Cluster {
  const members = new Set(ids);
  const next = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const { from, to } of edges) {
    if (!members.has(from)) continue;
    const targets = next.get(from);
    if (targets) targets.push(to);
    else next.set(from, [to]);
    hasIncoming.add(to);
  }

  // 階層は、起点（どこからもリンクされていないページ）からの距離。起点から届かないページ
  // （相互リンクだけの輪）は、最初の 1 つを起点にして続ける
  const layerOf = new Map<string, number>();
  const visit = (roots: string[]) => {
    let frontier = roots.filter((id) => !layerOf.has(id));
    for (let layer = 0; frontier.length > 0; layer++) {
      for (const id of frontier) layerOf.set(id, layer);
      frontier = [...new Set(frontier.flatMap((id) => next.get(id) ?? []))].filter((id) => !layerOf.has(id));
    }
  };
  visit(ids.filter((id) => !hasIncoming.has(id)));
  for (const id of ids) visit([id]);

  const layers: string[][] = [];
  for (const id of ids) (layers[layerOf.get(id)!] ??= []).push(id);

  // 列の数は、最も多い階層がおよそ横長の長方形になる数にする
  const largest = Math.max(...layers.map((layer) => layer.length));
  const columns = Math.min(maxColumns, Math.max(2, Math.ceil(Math.sqrt(largest * 2))));
  const width = Math.min(columns, largest) * CELL_WIDTH - GAP;

  const positions = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const layer of layers) {
    for (let start = 0; start < layer.length; start += columns) {
      const row = layer.slice(start, start + columns);
      // 行は、まとまりの中央にそろえる
      const left = (width - (row.length * CELL_WIDTH - GAP)) / 2;
      row.forEach((id, i) => positions.set(id, { x: left + i * CELL_WIDTH, y }));
      y += CELL_HEIGHT;
    }
    y += LAYER_GAP;
  }
  return { width, height: y - GAP - LAYER_GAP, positions };
}

/** リンクでつながったページを、まとまりごとに分ける。順序は、付箋の並び（更新の新しい順）を保つ */
function connectedGroups(ids: string[], edges: WemaEdge[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const { from, to } of edges) parent.set(find(from), find(to));
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const group = groups.get(root);
    if (group) group.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()];
}

/**
 * ページとリンクから、一覧のボードを作る。
 *
 * - リンクでつながったページは、まとまりごとに階層に並べ、まとまりを左上から順に詰める
 * - つながりのないページは、その下に、渡された順（更新の新しい順）で格子に並べる
 * - 全体の幅は、ページが少なければ表示領域に収まる幅にする。多ければ、全体が表示領域と
 *   同じ縦横比になる幅まで広げる（全体を表示したときに、縦に細長くならないようにする）
 * - リンク先が未作成のページは、色を変えた付箋として出す
 * - リンク先が一覧に含まれない既存のページ（件数の上限で外れたもの）への線は引かない
 */
export function buildIndexBoard(
  pages: IndexPage[],
  links: IndexLink[],
  viewport: { width: number; height: number },
  formatDate: (ms: number) => string,
): IndexBoard {
  const notes = new Map<string, WemaNote>();
  const searchText = new Map<string, string>();
  const addNote = (id: string, text: string, color: string, search: string) => {
    notes.set(id, { id, x: 0, y: 0, width: NOTE_WIDTH, height: NOTE_HEIGHT, text, color, zIndex: 1 });
    searchText.set(id, search.toLowerCase());
  };
  for (const page of pages) {
    addNote(page.name, pageHtml(page, formatDate), page.color ?? PAGE_COLOR, `${page.title ?? ''}\n${page.name}`);
  }

  const edges: WemaEdge[] = [];
  const connected = new Set<string>();
  for (const { from_page: from, to_page: to, missing } of links) {
    if (from === to || !notes.has(from)) continue;
    if (!notes.has(to)) {
      if (!missing) continue;
      addNote(to, missingHtml(to), MISSING_COLOR, to);
    }
    edges.push({ id: `${from}>${to}`, from, to, ...EDGE_STYLE });
    connected.add(from).add(to);
  }

  // 列の数。表示領域に収まる数を下限にして、ページが多ければ、全体が表示領域と同じ縦横比になる数まで増やす
  const fitColumns = Math.max(1, Math.floor((viewport.width - MARGIN * 2 + GAP) / CELL_WIDTH));
  const aspect = viewport.width / Math.max(1, viewport.height);
  // 表示領域に収まる列数で並べても縦に収まるなら、列は増やさない（等倍で全体が見える）
  const fitsViewport = Math.ceil(notes.size / fitColumns) * CELL_HEIGHT + MARGIN <= viewport.height;
  const columns = fitsViewport
    ? fitColumns
    : Math.max(fitColumns, Math.ceil(Math.sqrt((notes.size * aspect * CELL_HEIGHT) / CELL_WIDTH)));
  const boardWidth = columns * CELL_WIDTH - GAP;

  const place = (id: string, x: number, y: number) => {
    const note = notes.get(id)!;
    note.x = MARGIN + x;
    note.y = MARGIN + y;
  };

  // つながったページのまとまりを、左上から順に詰める。行に入らなければ、次の行へ送る
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  const linkedIds = [...notes.keys()].filter((id) => connected.has(id));
  for (const group of connectedGroups(linkedIds, edges)) {
    const cluster = layoutCluster(group, edges, columns);
    if (x > 0 && x + cluster.width > boardWidth) {
      x = 0;
      y += rowHeight + CLUSTER_GAP;
      rowHeight = 0;
    }
    for (const [id, at] of cluster.positions) place(id, x + at.x, y + at.y);
    // 横の間隔は格子と同じにする（まとまりの位置が格子の列にそろい、列の数ちょうどに並ぶ）
    x += cluster.width + GAP;
    rowHeight = Math.max(rowHeight, cluster.height);
  }
  if (rowHeight > 0) y += rowHeight + CLUSTER_GAP;

  // つながりのないページを、その下に格子で並べる
  let index = 0;
  for (const id of notes.keys()) {
    if (connected.has(id)) continue;
    place(id, (index % columns) * CELL_WIDTH, y + Math.floor(index / columns) * CELL_HEIGHT);
    index++;
  }

  // 線は、上下の位置関係に合わせて、付箋の上端と下端につなぐ。'auto' のままだと、斜め下の
  // ページへの線が付箋の横から出て、隣の付箋の後ろを通る。同じ高さ同士だけ 'auto' に任せる。
  // 最初の配置で決めるので、参照モードで付箋を動かしても変わらない（動かした位置は保存されない）
  for (const edge of edges) {
    const dy = notes.get(edge.to)!.y - notes.get(edge.from)!.y;
    if (dy === 0) continue;
    edge.fromAnchor = dy > 0 ? 'bottom' : 'top';
    edge.toAnchor = dy > 0 ? 'top' : 'bottom';
  }

  const texts = new Map([...notes.values()].map((note) => [note.id, note.text]));
  return { data: { version: 1, notes: [...notes.values()], edges }, searchText, texts };
}
