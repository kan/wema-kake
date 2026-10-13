// リモート MCP サーバー。ツールの定義と実装は src/shared/tools.ts にあり、ここでは MCP の
// サーバーに登録して、結果を MCP の形にするだけ。
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { type BoardAccess, TOOLS, ToolError } from '../../shared/tools';
import { ServerBoardAccess } from './board-access';

export function createMcpServer(access: BoardAccess): McpServer {
  const server = new McpServer({ name: 'wema-kake', version: '0.1.0' });
  for (const tool of TOOLS) {
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
 * `/mcp` のハンドラ。認証は呼び出し側（`src/worker/index.ts`）が済ませていて、
 * そこで決めた変更の主体（`agent:<client>`）を受け取る
 */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, actor: string): Promise<Response> {
  const access = new ServerBoardAccess(env, actor);
  // リクエストごとにサーバーを作る（MCP のサーバーは、同時に走るリクエストで共有できない）
  return createMcpHandler(() => createMcpServer(access))(request, env, ctx);
}
