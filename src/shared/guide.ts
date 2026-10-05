// 使い方の付箋。最初のページ（サーバーが 1 回だけ作る。src/worker/first-page.ts）と、
// 使い方のボード（保存しない。src/web/help-view.ts）で使う。wema のスタンドアロン版の、
// 最初に出る付箋にならっている。
import type { BoardContent, WemaEdge, WemaNote } from './delta';

/** 最初のページのスラッグと表示名 */
export const FIRST_PAGE = { slug: 'first-page', title: '最初のページ' };

const INTRO = {
  first:
    '<b>wema-kake へようこそ</b>' +
    '<div>付箋を並べて書く Wiki です。</div>' +
    '<div>1 ページが、1 枚のボードになります。</div>' +
    '<div>このページの付箋は、消してかまいません。</div>',
  help:
    '<b>使い方</b>' +
    '<div>試すためのボードです。</div>' +
    '<div>付箋を動かしたり、書き換えたりできます。</div>' +
    '<div>ここでの変更は、保存されません。</div>',
};

const section = (heading: string, items: string[]) =>
  `<b>${heading}</b><ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;

/** 本文の装飾の見本。HTML は、wema が作るものと同じ形にする */
const DECORATION =
  '<b>装飾の見本</b>' +
  '<div><b>太字</b>、<s>取り消し線</s>、<span style="color: #d32f2f">文字の色</span>、' +
  '<a href="https://github.com/kan/wema-kake" target="_blank" rel="noopener">リンク</a></div>' +
  '<ul><li>箇条書き<ul><li>段を下げた項目</li></ul></li></ul>' +
  '<ol><li>番号付きのリスト</li><li>2 つ目</li></ol>' +
  '<ul class="wema-checklist">' +
  '<li><input type="checkbox">チェックリスト</li>' +
  '<li class="wema-checked"><input type="checkbox" checked>済んだ項目</li>' +
  '</ul>';

/** 列の間隔と、段の位置。付箋は autoSize なので、幅は最も長い行で決まる（長い行を書くと、隣と重なる） */
const COLUMN = 460;
const ROWS = [60, 370, 680];

/**
 * 付箋 1 枚。`key` は、接続線が指す名前（付箋の id にもなる）。位置は、列と段で決める。
 * autoSize にするので、実際の大きさは、画面が出した後に計測して決める（src/web/toolbar.ts の
 * `measureAutoSizeNotes`）。`height` は、計測されるまでの目安
 */
interface GuideNote {
  key: string;
  text: string;
  color: string;
  column: number;
  row: number;
  height: number;
}

const guideNotes = (intro: string): GuideNote[] => [
  { key: 'sample', text: DECORATION, color: '#F5F5F5', column: 0, row: 0, height: 250 },
  { key: 'intro', text: intro, color: '#FFF9C4', column: 1, row: 0, height: 120 },
  {
    key: 'notes',
    text: section('付箋', [
      '空いている場所をダブルクリック → 作る',
      '上端をドラッグ → 動かす',
      '右下をドラッグ → 大きさを変える',
      '右下をダブルクリック → 内容に合わせる',
      '選択して Delete → 削除する',
      'Shift + クリック → 複数を選ぶ',
    ]),
    color: '#BBDEFB',
    column: 0,
    row: 1,
    height: 220,
  },
  {
    key: 'text',
    text: section('本文', [
      '文字を選択 → 太字、取り消し線、色、リンク',
      '付箋を選択 → 色、リスト、画像',
      'リストの中で Tab → 段を下げる',
      '長い本文は、畳んで表示できる',
    ]),
    color: '#FFE0B2',
    column: 1,
    row: 1,
    height: 170,
  },
  {
    key: 'edges',
    text: section('接続線', [
      '縁の ● をドラッグ → 他の付箋とつなぐ',
      '空いている場所で離す → 先に付箋を作る',
      '線をクリック → 種類やラベルを変える',
    ]),
    color: '#C8E6C9',
    column: 2,
    row: 1,
    height: 150,
  },
  {
    key: 'view',
    text: section('表示', [
      'ホイール、Space + ドラッグ → 動かす',
      'Ctrl + ホイール、ピンチ → 拡大と縮小',
      'Ctrl + Z → 元に戻す（自分の操作だけ）',
      'メニューの「参照モード」 → 読むだけにする',
    ]),
    color: '#FFCDD2',
    column: 0,
    row: 2,
    height: 170,
  },
  {
    key: 'pages',
    text: section('ページ', [
      '「子ページを置く」 → 中にページを作る',
      '子ページの表示名をクリック → 中へ入る',
      '/p/ページ名 へのリンク → 他のページへ移る',
      '左上の表示名をクリック → 名前を変える',
    ]),
    color: '#E1BEE7',
    column: 1,
    row: 2,
    height: 170,
  },
  {
    key: 'llm',
    text: section('LLM', [
      'MCP でつなぐと、Claude などが読み書きできる',
      'LLM の操作は「操作の履歴」に残る',
      '履歴から、操作ごとに取り消せる',
    ]),
    color: '#B2DFDB',
    column: 2,
    row: 2,
    height: 150,
  },
];

/** 接続線。案内の付箋から 2 段目へ、2 段目から 3 段目へ。装飾の見本は、どれともつながない */
const EDGES: [from: string, to: string][] = [
  ['intro', 'notes'],
  ['intro', 'text'],
  ['intro', 'edges'],
  ['notes', 'view'],
  ['text', 'pages'],
  ['edges', 'llm'],
];

const noteId = (key: string) => `guide-${key}`;

/** 使い方の付箋と接続線。`intro` で、案内の付箋の文面を選ぶ */
export function guideBoard(intro: keyof typeof INTRO): BoardContent {
  const notes = guideNotes(INTRO[intro]).map(
    ({ key, text, color, column, row, height }, index): WemaNote => ({
      id: noteId(key),
      x: 60 + column * COLUMN,
      y: ROWS[row],
      width: 380,
      height,
      text,
      color,
      zIndex: index + 1,
      autoSize: true,
    }),
  );
  const edges = EDGES.map(
    ([from, to]): WemaEdge => ({
      id: `guide-${from}-${to}`,
      from: noteId(from),
      to: noteId(to),
      fromAnchor: 'auto',
      toAnchor: 'auto',
      style: 'arrow',
    }),
  );
  return { notes, edges };
}
