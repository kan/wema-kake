// ヘッダーのボタンに使うアイコン。付箋の操作のアイコンは、wema のスタンドアロン版
// （standalone/template.html）と同じ絵柄にしてある（同じ操作が同じ絵になる）。
// ここにある文字列は固定で、外から来た値は入らない。
import { el } from './dom';

const stroke = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const thin = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${body}</svg>`;
const dots = (points: [number, number][]) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">${points
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.5"/>`)
    .join('')}</svg>`;

const GRID = [3, 8, 13];
const STAR = '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2';

const ICONS = {
  undo: stroke('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  redo: stroke('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/>'),
  add: stroke('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  layout: dots(GRID.flatMap((y) => GRID.map((x): [number, number] => [x, y]))),
  alignLeft: thin(
    '<line x1="2" y1="2" x2="2" y2="14"/><rect x="4" y="3" width="10" height="3" rx="0.5"/><rect x="4" y="8" width="6" height="3" rx="0.5"/>',
  ),
  alignCenter: thin(
    '<line x1="8" y1="1" x2="8" y2="15"/><rect x="3" y="3" width="10" height="3" rx="0.5"/><rect x="5" y="8" width="6" height="3" rx="0.5"/>',
  ),
  alignRight: thin(
    '<line x1="14" y1="2" x2="14" y2="14"/><rect x="2" y="3" width="10" height="3" rx="0.5"/><rect x="6" y="8" width="6" height="3" rx="0.5"/>',
  ),
  alignTop: thin(
    '<line x1="2" y1="2" x2="14" y2="2"/><rect x="3" y="4" width="3" height="10" rx="0.5"/><rect x="8" y="4" width="3" height="6" rx="0.5"/>',
  ),
  alignMiddle: thin(
    '<line x1="1" y1="8" x2="15" y2="8"/><rect x="3" y="3" width="3" height="10" rx="0.5"/><rect x="8" y="5" width="3" height="6" rx="0.5"/>',
  ),
  alignBottom: thin(
    '<line x1="2" y1="14" x2="14" y2="14"/><rect x="3" y="2" width="3" height="10" rx="0.5"/><rect x="8" y="6" width="3" height="6" rx="0.5"/>',
  ),
  distributeH: thin(
    '<rect x="1" y="4" width="3" height="8" rx="0.5"/><rect x="6.5" y="4" width="3" height="8" rx="0.5"/><rect x="12" y="4" width="3" height="8" rx="0.5"/>',
  ),
  distributeV: thin(
    '<rect x="4" y="1" width="8" height="3" rx="0.5"/><rect x="4" y="6.5" width="8" height="3" rx="0.5"/><rect x="4" y="12" width="8" height="3" rx="0.5"/>',
  ),
  autoLayout: stroke(
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="8.5" y="14" width="7" height="7" rx="1"/><line x1="6.5" y1="10" x2="6.5" y2="14"/><line x1="6.5" y1="14" x2="12" y2="14"/><line x1="17.5" y1="10" x2="17.5" y2="14"/><line x1="17.5" y1="14" x2="12" y2="14"/>',
  ),
  zoomOut: stroke(
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
  ),
  zoomIn: stroke(
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
  ),
  zoomFit: stroke(
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  ),
  // ここから下は wema-kake だけにある操作
  center: stroke(
    '<circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>',
  ),
  // 子ページ（ボードの中のボード）
  childPage: stroke(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="6" height="5" rx="1"/><line x1="16" y1="14" x2="16" y2="18"/><line x1="14" y1="16" x2="18" y2="16"/>',
  ),
  edit: stroke('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: stroke(
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  ),
  history: stroke('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>'),
  // ブックマークの印（付いていない / 付いている）と、ブックマークの一覧
  star: stroke(`<polygon points="${STAR}"/>`),
  starFilled: stroke(`<polygon points="${STAR}" fill="currentColor"/>`),
  bookmarks: stroke(
    '<path d="M17 21l-6-4.5L5 21V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M9 1.5h9a2 2 0 0 1 2 2V17"/>',
  ),
  menu: dots([
    [3, 8],
    [8, 8],
    [13, 8],
  ]),
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): HTMLSpanElement {
  return el('span', { className: 'icon', innerHTML: ICONS[name] });
}
