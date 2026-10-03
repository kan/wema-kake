// リンクの行き先の判定。DOM には依存しない（テストから動かせる）。

/**
 * `url` がこのサイト（`origin`）の中を指していれば、移動先の絶対 URL を返す。違えば null。
 *
 * 移動先には、検査した絶対 URL をそのまま使う。パスだけを取り出して移動してはいけない。
 * `https://このサイト//other.example/x` のパスは `//other.example/x` で、これを相対 URL として
 * 解釈すると、サイト外（other.example）を指す
 */
export function internalUrl(url: string, origin: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  return target.origin === origin ? target.href : null;
}
