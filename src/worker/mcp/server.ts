// リモート MCP サーバー。ツールの定義と実装は src/shared/tools.ts にあり、ここでは MCP の
// サーバーに登録して、結果を MCP の形にするだけ。
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { type BoardAccess, TOOLS, ToolError, toolAnnotations } from '../../shared/tools';
import type { WemaKakeEnv } from '../config';
import { ServerBoardAccess } from './board-access';

/**
 * `write` が false なら、読み取りのツールだけを登録する。ツールの一覧に出ないので、LLM は呼ぼうと
 * しない。名前を指定して呼ばれても、MCP のサーバーが「ツールがない」というエラーを返す
 */
export function createMcpServer(access: BoardAccess, write: boolean): McpServer {
  // ツールの一覧は、接続の間に変わらない（主体と設定で決まる）ので、変更の通知を出さないと宣言する。
  // 宣言しないと、`registerTool` が `listChanged: true` を付ける。そのままだと、2026-07-28 版の
  // クライアントが `subscriptions/listen` を開き、SDK は要求ごとに作って捨てるハンドラの bus に
  // 購読させる。通知は届かず、SSE がクライアントが切るまで開いたまま残る。`false` なら、クライアントは
  // 自分からは開かず、開かれても SDK が受け付けた通知なしで応答してすぐ閉じる
  const server = new McpServer(
    { name: 'wema-kake', version: '0.1.0' },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const tool of TOOLS) {
    if (!write && !tool.readOnly) continue;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: toolAnnotations(tool),
      },
      async (input: unknown) => {
        try {
          // 入力は、MCP のサーバーが tool.input で検証済み
          const result = await tool.run(access, input);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (e) {
          // 入力や状態の問題は、LLM が読んで直せるように結果として返す
          if (e instanceof ToolError) {
            return { isError: true, content: [{ type: 'text' as const, text: e.message }] };
          }
          throw e;
        }
      },
    );
  }
  return server;
}

/**
 * 書き込みのメソッドが断る `BoardAccess`。読み取りだけの主体に渡す。ツールを登録しないことに加えて、
 * ツールの `readOnly` の付け間違いがあっても書き込めないようにする。メソッドを足したら、型の検査で
 * ここに足すよう求められるので、読み取りか書き込みかをそのときに決める
 */
export function readOnlyAccess(access: BoardAccess): BoardAccess {
  const deny = () => Promise.reject(new ToolError('this client can only read'));
  return {
    listPages: (options) => access.listPages(options),
    searchPages: (query) => access.searchPages(query),
    readBoard: (page) => access.readBoard(page),
    parentOf: (page) => access.parentOf(page),
    plainText: (html) => access.plainText(html),
    ownOps: (page) => access.ownOps(page),
    clearParent: deny,
    createPage: deny,
    apply: deny,
    moveNotes: deny,
    revert: deny,
  };
}

/**
 * `/mcp` のハンドラ。認証は呼び出し側（`src/worker/index.ts`）が済ませていて、
 * そこで決めた変更の主体（`agent:<client>`）と、その主体が書き込みのツールを使えるかを受け取る
 */
export function handleMcp(request: Request, env: WemaKakeEnv, actor: string, write: boolean): Promise<Response> {
  const server = new ServerBoardAccess(env, actor);
  const access = write ? server : readOnlyAccess(server);
  // リクエストごとにハンドラとサーバーを作る（MCP のサーバーは、同時に走るリクエストで共有できない）。
  // 2026-07-28 版と、それより前の版（initialize あり）の両方を受ける。前の版はステートレスで受ける
  // （`legacy: 'stateless'` が既定）
  //
  // SDK のハンドラは `Origin` も `Host` も確かめず、CORS のヘッダーも付けない。`Origin` は、呼び出し側
  // （`src/worker/index.ts`）が自分のオリジンとの完全一致で確かめている。SDK の
  // `originValidationResponse` はホスト名しか比べないので使わない
  //
  // `responseMode: 'json'` は指定しない。指定すると、ハンドラを作るたびに SDK が `console.warn` を出す。
  // 既定（auto）でも、途中で通知を出さないツールの応答は JSON 1 本になる
  //
  // SDK は、内部で捕まえた例外を 500 にして返し、ログには出さない。原因を追えるように `onerror` で出す
  return createMcpHandler(() => createMcpServer(access, write), {
    onerror: (error) => console.error('MCP handler error:', error),
  }).fetch(request);
}
