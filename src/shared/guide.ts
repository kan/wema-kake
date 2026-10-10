// 使い方の付箋。最初のページ（サーバーが 1 回だけ作る。src/worker/first-page.ts）と、
// 使い方のボード（保存しない。src/web/help-view.ts）で使う。wema のスタンドアロン版の、
// 最初に出る付箋にならっている。
//
// 文面は、言語ごとに持つ（docs/plan.md のフェーズ 9）。画面の文言（src/web/i18n/）とは別に、
// ここに置く。サーバーも使うのと、付箋の本文（HTML）で、行の長さが配置に関わるため。
import type { BoardContent, WemaEdge, WemaNote } from './delta';
import type { Lang } from './i18n';

/** 最初のページのスラッグ */
export const FIRST_PAGE_SLUG = 'first-page';

/** 付箋の名前。接続線が指す名前で、付箋の id にもなる */
type Key = 'sample' | 'intro' | 'notes' | 'text' | 'edges' | 'view' | 'pages' | 'llm';

/** 1 つの言語の文面 */
interface GuideText {
  /** 最初のページの表示名 */
  firstPageTitle: string;
  /** 案内の付箋。最初のページ用と、使い方のボード用 */
  intro: { first: string; help: string };
  /** 本文の装飾の見本 */
  sample: string;
  /** 見出しと、項目の並び */
  sections: Record<Exclude<Key, 'sample' | 'intro'>, [heading: string, items: string[]]>;
  /**
   * 列の間隔。付箋は autoSize なので、幅は最も長い行で決まる。**長い行を足すと、隣の付箋と重なる。**
   * 1 行を短く保つか、ここを広げる
   */
  column: number;
}

const paragraphs = (heading: string, lines: string[]) =>
  `<b>${heading}</b>${lines.map((line) => `<div>${line}</div>`).join('')}`;

/** 装飾の見本。HTML は、wema が画面の操作で作るものと同じ形にする */
const sample = (text: {
  heading: string;
  bold: string;
  strike: string;
  color: string;
  link: string;
  separator: string;
  bullet: string;
  nested: string;
  numbered: [string, string];
  todo: string;
  done: string;
}) =>
  `<b>${text.heading}</b>` +
  `<div><b>${text.bold}</b>${text.separator}<s>${text.strike}</s>${text.separator}` +
  `<span style="color: #d32f2f">${text.color}</span>${text.separator}` +
  `<a href="https://github.com/kan/wema-kake" target="_blank" rel="noopener">${text.link}</a></div>` +
  `<ul><li>${text.bullet}<ul><li>${text.nested}</li></ul></li></ul>` +
  `<ol><li>${text.numbered[0]}</li><li>${text.numbered[1]}</li></ol>` +
  '<ul class="wema-checklist">' +
  `<li><input type="checkbox">${text.todo}</li>` +
  `<li class="wema-checked"><input type="checkbox" checked>${text.done}</li>` +
  '</ul>';

const TEXTS: Record<Lang, GuideText> = {
  ja: {
    firstPageTitle: '最初のページ',
    intro: {
      first: paragraphs('wema-kake へようこそ', [
        '付箋を並べて書く Wiki です。',
        '1 ページが、1 枚のボードになります。',
        'このページの付箋は、消してかまいません。',
      ]),
      help: paragraphs('使い方', [
        '試すためのボードです。',
        '付箋を動かしたり、書き換えたりできます。',
        'ここでの変更は、保存されません。',
      ]),
    },
    sample: sample({
      heading: '装飾の見本',
      bold: '太字',
      strike: '取り消し線',
      color: '文字の色',
      link: 'リンク',
      separator: '、',
      bullet: '箇条書き',
      nested: '段を下げた項目',
      numbered: ['番号付きのリスト', '2 つ目'],
      todo: 'チェックリスト',
      done: '済んだ項目',
    }),
    sections: {
      notes: [
        '付箋',
        [
          '空いている場所をダブルクリック → 作る',
          '上端をドラッグ → 動かす',
          '右下をドラッグ → 大きさを変える',
          '右下をダブルクリック → 内容に合わせる',
          '選択して Delete → 削除する',
          'Shift + クリック → 複数を選ぶ',
          'Ctrl + ドラッグ → 囲んで選ぶ',
        ],
      ],
      text: [
        '本文',
        [
          '文字を選択 → 太字、取り消し線、色、リンク',
          '付箋を選択 → 色、リスト、画像',
          'リストの中で Tab → 段を下げる',
          '長い本文は、畳んで表示できる',
        ],
      ],
      edges: [
        '接続線',
        [
          '縁の ● をドラッグ → 他の付箋とつなぐ',
          '空いている場所で離す → 先に付箋を作る',
          '線をクリック → 種類やラベルを変える',
        ],
      ],
      view: [
        '表示',
        [
          'ホイール、空いた場所をドラッグ → 動かす',
          'Ctrl + ホイール、ピンチ → 拡大と縮小',
          'Ctrl + Z → 元に戻す（自分の操作だけ）',
          'メニューの「参照モード」 → 読むだけにする',
        ],
      ],
      pages: [
        'ページ',
        [
          '「子ページを置く」 → 中にページを作る',
          '子ページの表示名をクリック → 中へ入る',
          '付箋を子ページへドラッグ → 中へ移動（Ctrl でコピー）',
          '/p/ページ名 へのリンク → 他のページへ移る',
          '左上の表示名をクリック → 名前を変える',
        ],
      ],
      llm: [
        'LLM',
        [
          'MCP でつなぐと、Claude などが読み書きできる',
          'LLM の操作は、メニューの「操作の履歴」に残る',
          '履歴から、操作ごとに取り消せる',
        ],
      ],
    },
    column: 460,
  },
  en: {
    firstPageTitle: 'First page',
    intro: {
      first: paragraphs('Welcome to wema-kake', [
        'A wiki you write with sticky notes.',
        'Each page is one board.',
        'Feel free to delete the notes on this page.',
      ]),
      help: paragraphs('Help', [
        'A board for trying things out.',
        'Move the notes around or rewrite them.',
        'Nothing you change here is saved.',
      ]),
    },
    sample: sample({
      heading: 'Formatting sample',
      bold: 'Bold',
      strike: 'strikethrough',
      color: 'text color',
      link: 'link',
      separator: ', ',
      bullet: 'Bulleted list',
      nested: 'Indented item',
      numbered: ['Numbered list', 'Second item'],
      todo: 'Checklist',
      done: 'Finished item',
    }),
    sections: {
      notes: [
        'Notes',
        [
          'Double-click an empty spot → create',
          'Drag the top edge → move',
          'Drag the bottom-right corner → resize',
          'Double-click that corner → fit the content',
          'Select and press Delete → delete',
          'Shift + click → select several',
          'Ctrl + drag → select an area',
        ],
      ],
      text: [
        'Text',
        [
          'Select text → bold, strikethrough, color, link',
          'Select a note → color, lists, image',
          'Tab inside a list → indent',
          'A long text can be shown folded',
        ],
      ],
      edges: [
        'Connections',
        [
          'Drag a ● on the edge → connect to a note',
          'Drop on an empty spot → create a note there',
          'Click a line → change its style or label',
        ],
      ],
      view: [
        'View',
        [
          'Wheel, or drag an empty spot → pan',
          'Ctrl + wheel, or pinch → zoom',
          'Ctrl + Z → undo (your own changes only)',
          '“View-only mode” in the menu → read only',
        ],
      ],
      pages: [
        'Pages',
        [
          '“Place a child page” → a page inside this one',
          'Click a child page’s title → go inside',
          'Drag a note onto a child page → move it inside (Ctrl: copy)',
          'A link to /p/page-name → go to that page',
          'Click the title at the top left → rename',
        ],
      ],
      llm: [
        'LLM',
        [
          'Over MCP, Claude and others can read and write',
          'Their operations are kept in “Operation history”',
          'Revert them there, one operation at a time',
        ],
      ],
    },
    column: 480,
  },
};

/** 最初のページの表示名 */
export const firstPageTitle = (lang: Lang): string => TEXTS[lang].firstPageTitle;

/** 段の位置 */
const ROWS = [60, 370, 680];

/**
 * 付箋の色、位置（列、段）、高さの目安。autoSize にするので、実際の大きさは、ボードが読み込んだ
 * ときに wema が計測して決める（wema 0.10.0 以降）。高さは、計測されるまでの値
 */
const LAYOUT: Record<Key, { color: string; column: number; row: number; height: number }> = {
  sample: { color: '#F5F5F5', column: 0, row: 0, height: 250 },
  intro: { color: '#FFF9C4', column: 1, row: 0, height: 120 },
  notes: { color: '#BBDEFB', column: 0, row: 1, height: 220 },
  text: { color: '#FFE0B2', column: 1, row: 1, height: 170 },
  edges: { color: '#C8E6C9', column: 2, row: 1, height: 150 },
  view: { color: '#FFCDD2', column: 0, row: 2, height: 170 },
  pages: { color: '#E1BEE7', column: 1, row: 2, height: 170 },
  llm: { color: '#B2DFDB', column: 2, row: 2, height: 150 },
};

/** 接続線。案内の付箋から 2 段目へ、2 段目から 3 段目へ。装飾の見本は、どれともつながない */
const EDGES: [from: Key, to: Key][] = [
  ['intro', 'notes'],
  ['intro', 'text'],
  ['intro', 'edges'],
  ['notes', 'view'],
  ['text', 'pages'],
  ['edges', 'llm'],
];

const noteId = (key: Key) => `guide-${key}`;

/** 使い方の付箋と接続線。`intro` で、案内の付箋の文面を選ぶ */
export function guideBoard(intro: keyof GuideText['intro'], lang: Lang): BoardContent {
  const text = TEXTS[lang];
  const bodyOf = (key: Key): string => {
    if (key === 'sample') return text.sample;
    if (key === 'intro') return text.intro[intro];
    const [heading, items] = text.sections[key];
    return `<b>${heading}</b><ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  };
  const notes = (Object.keys(LAYOUT) as Key[]).map((key, index): WemaNote => {
    const { color, column, row, height } = LAYOUT[key];
    return {
      id: noteId(key),
      x: 60 + column * text.column,
      y: ROWS[row],
      width: 380,
      height,
      text: bodyOf(key),
      color,
      zIndex: index + 1,
      autoSize: true,
    };
  });
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
