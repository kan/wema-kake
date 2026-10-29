// リモート MCP サーバー。ツールの定義と実装は src/shared/tools.ts にあり、ここでは MCP の
// サーバーに登録して、結果を MCP の形にするだけ。
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { type BoardAccess, TOOLS, ToolError } from '../../shared/tools';
import type { WemaKakeEnv } from '../config';
import { ServerBoardAccess } from './board-access';

/**
 * `write` が false なら、読み取りのツールだけを登録する。ツールの一覧に出ないので、LLM は呼ぼうと
 * しない。名前を指定して呼ばれても、MCP のサーバーが「ツールがない」というエラーを返す
 */
export function createMcpServer(access: BoardAccess, write: boolean): McpServer {
  const server = new McpServer({ name: 'wema-kake', version: '0.1.0' });
  for (const tool of TOOLS) {
    if (!write && !tool.readOnly) continue;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly },
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
export function handleMcp(
  request: Request,
  env: WemaKakeEnv,
  ctx: ExecutionContext,
  actor: string,
  write: boolean,
): Promise<Response> {
  const server = new ServerBoardAccess(env, actor);
  const access = write ? server : readOnlyAccess(server);
  // リクエストごとにサーバーを作る（MCP のサーバーは、同時に走るリクエストで共有できない）
  //
  // `Origin` は、呼び出し側（`src/worker/index.ts`）が自分のオリジンとの完全一致で確かめている。
  // ハンドラの検査はホスト名だけを比べ、既定の許可リストは localhost と workers.dev しか知らない。
  // そのままだと独自ドメインで自分のオリジンを断るので、許すホスト名を自分のものに絞って残す。
  // 他のオリジンから呼ばせないので、CORS のヘッダー（既定は `*`）も付けない
  return createMcpHandler(() => createMcpServer(access, write), {
    allowedOriginHostnames: [new URL(request.url).hostname],
    corsOptions: false,
  })(request, env, ctx);
}
