import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStonekeepMcpServer } from './server.js';

export { TOOL_NAMES, createStonekeepMcpServer, type StonekeepMcpOptions } from './server.js';

/** Run the MCP server over stdio (stdout is reserved for the protocol). */
export async function startStdioServer(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const server = createStonekeepMcpServer({ cwd, env });
  await server.connect(new StdioServerTransport());
}
