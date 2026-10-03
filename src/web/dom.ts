type Child = Node | string | null | undefined | false;

/** 要素を作る。`props` は要素のプロパティ（className、textContent、onclick など） */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
  return node;
}

/**
 * wema の `onLinkClick` に渡す。サイト内のリンクは同じタブで開き、true を返す（wema は何もしない）。
 * サイト外のリンクと、修飾キーや中ボタンでのクリックは、wema に任せる（新しいタブで開く）。
 *
 * `url` は、ブラウザが解決した絶対 URL。サイト内かどうかはオリジンで判定する
 * （属性の値の先頭が `/` かどうかで判定すると、`//other.example/` でサイト外へ飛ばせてしまう）
 */
export function openInternalLink(url: string, event: MouseEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return false;
  const target = new URL(url);
  if (target.origin !== location.origin) return false;
  location.assign(target.pathname + target.search + target.hash);
  return true;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
