// 画面の文言（日本語）。こちらを正とする。キーを足すときは、en.ts にも同じキーを足す
// （en.ts は、同じキーと同じ引数を持つことを型で確かめている）。
//
// 値を埋め込む文言は、関数で書く。日本語と英語で語順が違うので、使う側で文字列を足さない。
//
// 使い方の付箋（src/shared/guide.ts）は、ここの文言のうち `menu.viewOnly`、`child.place`、
// `ops.title` を、かぎかっこで引用している。これらを変えたら、付箋の文面も合わせる。

export const ja = {
  // --- どの画面でも使うもの ---
  loading: '読み込み中…',
  notFound: 'ページが見つかりません',
  list: '一覧',
  close: '閉じる',
  save: '保存',
  title: '表示名',
  help: '使い方',
  undo: '元に戻す (Ctrl+Z)',
  redo: 'やり直す (Ctrl+Shift+Z)',
  /** ブラウザのタブに出す名前。`name` は、ページの表示名や画面の名前 */
  documentTitle: (name: string) => `${name} - wema-kake`,
  /** 言語を切り替える項目。切り替え先の言語を、その言語で書く */
  'lang.switch': 'English',

  // 失敗の知らせ。`reason` は、サーバーやブラウザの返した理由（src/web/dom.ts の `failureMessage`）
  'failed.bookmark': (reason: string) => `ブックマークの変更に失敗しました（${reason}）`,
  'failed.ancestors': (reason: string) => `親ページの取得に失敗しました（${reason}）`,
  'failed.rename': (reason: string) => `表示名の変更に失敗しました（${reason}）`,
  'failed.backlinks': (reason: string) => `リンク元の取得に失敗しました（${reason}）`,
  'failed.history': (reason: string) => `履歴の取得に失敗しました（${reason}）`,
  'failed.revert': (reason: string) => `取り消しに失敗しました（${reason}）`,
  'failed.delete': (reason: string) => `削除に失敗しました（${reason}）`,
  'failed.create': (reason: string) => `作成に失敗しました（${reason}）`,
  'failed.transfer': (reason: string) => `子ページへ付箋を送れませんでした（${reason}）`,

  // --- ヘッダーの部品 ---
  'zoom.reset': '等倍に戻す',
  'zoom.out': '縮小',
  'zoom.in': '拡大',
  'zoom.fit': '全体が収まるように縮小',
  'zoom.center': '付箋全体の中央へ移動（倍率はそのまま）',

  // --- ページへの一覧（ブックマーク、最近の変更） ---
  'links.loadFailed': (reason: string) => `取得できませんでした（${reason}）`,
  'recent.title': '最近の変更',
  'recent.empty': 'ページはありません',
  'bookmarks.title': 'ブックマークしたページ',
  'bookmarks.empty': 'ブックマークはありません',
  'bookmark.add': 'このページをブックマークする',
  'bookmark.remove': 'ブックマークを外す',
  'bookmark.unwritten': 'まだ何も書かれていないページには、付けられません',

  // --- ページを作る入力欄 ---
  'form.optional': '省略できます',
  'form.slugHint': 'URL に使う名前。小文字の英数字とハイフン',
  'form.slugInvalid': 'スラッグは小文字の英数字とハイフンで、64 文字までです',
  'form.create': '作成',
  'form.slugTaken': 'そのスラッグのページはすでにあります。',
  'form.openIt': '開く',

  // --- ページの操作 ---
  'page.rename': '表示名を変える',
  'page.delete': 'ページを削除',
  'page.deleteConfirm': (name: string) =>
    `ページ「${name}」を削除します。付箋と履歴がすべて消え、取り消しはできません。`,
  'page.alreadyDeleted': 'このページは、すでに削除されています',
  'page.deletedAlert': 'このページは削除されました。一覧へ戻ります。',
  'page.titleHint': (slug: string) => `/p/${slug}（クリックして表示名を変える）`,

  // --- 一覧の画面 ---
  'index.filter': 'ページを絞り込む',
  'index.newPage': '＋ 新規ページ',
  'index.count': (total: number) => `${total} ページ`,
  /** `note` は、検索に失敗したときの `index.searchFailed`。なければ空文字 */
  'index.matched': (matched: number, total: number, note: string) => `${matched} / ${total} ページ${note}`,
  'index.searchFailed': (reason: string) => `（本文の検索に失敗しました: ${reason}）`,
  'index.empty': 'まだページがありません',
  'index.loadFailed': (reason: string) => `一覧を取得できませんでした（${reason}）`,
  /** 一覧の付箋の下の行。`date` は、書式を整えた更新日時 */
  'index.meta': (date: string, notes: number, children: number) =>
    `${date}・付箋 ${notes} 枚${children > 0 ? `・子ページ ${children}` : ''}`,
  'index.descendantHits': (count: number) => `子ページに ${count} 件の一致`,
  'index.missing': '未作成',

  // --- ページの画面: 付箋の操作 ---
  'note.add': '付箋を追加',
  'layout.title': '整列と配置',
  'align.left': '左端をそろえる',
  'align.center': '左右の中央をそろえる',
  'align.right': '右端をそろえる',
  'align.top': '上端をそろえる',
  'align.middle': '上下の中央をそろえる',
  'align.bottom': '下端をそろえる',
  'layout.distributeH': '左右に均等に並べる（3 枚以上を選択）',
  'layout.distributeV': '上下に均等に並べる（3 枚以上を選択）',
  'layout.auto': '接続線に沿って自動で配置（全体）',

  // --- ページの画面: 同期 ---
  'status.connecting': '接続中…',
  'status.offline': 'オフライン（再接続します）',
  'status.saving': '保存中…',
  'sync.conflict': '他の人が同じ付箋を編集していたため、変更を取り消しました',
  'sync.rejected': (reason: string) => `変更を保存できなかったため、取り消しました（${reason}）`,

  // --- ページの画面: リンク元、メニュー ---
  'backlinks.count': (count: number) => `リンク元 ${count}`,
  'backlinks.title': 'このページへリンクしているページ',
  'menu.title': 'メニュー',
  'menu.viewOnly': '参照モード（読むだけ）',
  'menu.viewOnlyExit': '参照モードを終える',
  'menu.themeCard': '付箋の見た目: カード',
  'menu.themeDefault': '付箋の見た目: 標準',
  'menu.history': '操作の履歴…',
  'menu.exportJson': 'JSON を書き出す',
  'menu.deletePage': 'ページを削除…',

  // --- 操作の履歴 ---
  'ops.title': '操作の履歴',
  'ops.agentOnly': 'agent の操作だけ',
  'ops.refresh': '更新',
  'ops.empty': '操作はありません',
  'ops.revert': '取り消す',
  'ops.noSummary': '（説明なし）',
  /** 取り消し済みの操作の要約の後ろに付ける */
  'ops.revertedMark': '（取り消し済み）',
  // サーバーが付けた要約（符号で保存されている。src/shared/op-summary.ts）
  'ops.summary.pageCreated': 'ページの作成',
  'ops.summary.childRemoved': (page: string) => `子ページ ${page} の削除`,
  'ops.summary.revert': (seq: number) => `#${seq} の取り消し`,
  'ops.summary.revertUnknown': '取り消し',
  'ops.summary.notesReceived': (page: string) => `ページ ${page} から付箋を受け取り`,

  // 取り消しの結果。`why` は、`revert.reasons` で作った理由（なければ空文字）
  'revert.done': '取り消しました',
  'revert.none': (why: string) => `取り消せる変更がありませんでした${why}`,
  'revert.partial': (skipped: number, why: string) => `一部を取り消しました。${skipped} 件は残しています${why}`,
  'revert.reasons': (reasons: string[]) => `（${reasons.join('、')}）`,
  // 取り消さなかった理由（SkipReason）
  'skip.modified': 'その後に変更された',
  'skip.connected': '他の接続線がつながっている',
  'skip.deleted': 'すでに削除されている',
  'skip.exists': '同じものがすでにある',
  'skip.endpoint-missing': '両端の付箋がない',

  // --- 子ページ ---
  'child.place': '子ページを置く',
  'child.newHeading': '新しいページを作って置く',
  'child.createAndPlace': '作成して置く',
  'child.existingHeading': '既存のページを置く',
  'child.rootPage': 'ルートのページ',
  'child.slugPlaceholder': 'ページの名前（スラッグ）',
  'child.placeExisting': '置く',
  'child.slugTaken': 'そのスラッグのページはすでにあります。既存のページとして置けます',
  /** 子ページの付箋の下の行 */
  'child.summary': (notes: number, slug: string) => `子ページ・付箋 ${notes} 枚（/p/${slug}）`,
  'child.elsewhere': (parent: string) => `「${parent}」に置かれています`,
  /** `why` は、下の `child.reject.*`。`kept` は、「作成して置く」で作ったページが残っているか */
  'child.rejected': (why: string, kept: boolean) =>
    `子ページとして置けませんでした（${why}）${kept ? '。作成したページは、ルートのページとして一覧に残っています' : ''}`,
  // 付箋を、子ページの付箋の上へドラッグして放したとき（src/web/note-drop.ts）
  'transfer.moved': (notes: number, page: string) => `付箋 ${notes} 枚を「${page}」へ移動しました`,
  'transfer.copied': (notes: number, page: string) => `付箋 ${notes} 枚を「${page}」へコピーしました`,
  // 子ページとして置けない理由（ChildRejectCode）
  'child.reject.not-found': 'ページが見つかりません',
  'child.reject.self': '自分自身は置けません',
  'child.reject.other-parent': 'すでに別のページの子になっています',
  'child.reject.duplicate': 'このページにすでに置いてあります',
  'child.reject.ancestor': 'このページの先祖なので、輪になります',
  'child.reject.too-deep': (max: number) => `階層は ${max} 段までです`,

  // --- 使い方の画面 ---
  'help.unsaved': 'このボードは保存されません',
};
