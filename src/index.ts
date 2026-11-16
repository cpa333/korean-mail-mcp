import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../package.json' with { type: 'json' };
import { loadAccounts, noAccountsMessage } from './accounts.js';
import { ImapConnections } from './imap.js';
import { registerTools } from './tools.js';

const MIN_NODE_MAJOR = 22;

function nodeVersionError(): string | undefined {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) return undefined;
  return `Node.js ${MIN_NODE_MAJOR} 이상이 필요합니다(지금 ${process.versions.node}). nodejs.org에서 LTS 버전으로 업데이트한 뒤 Claude Code를 다시 시작해 주세요.`;
}

async function main(): Promise<void> {
  const { accounts, warnings } = loadAccounts(process.env);
  // stdout은 MCP 통신 통로라서 안내는 stderr로만 쓴다.
  for (const warning of warnings) console.error(warning);
  if (accounts.length === 0) console.error(noAccountsMessage());

  const server = new McpServer({ name: 'korean-mail-mcp', version: packageJson.version });
  registerTools(server, { accounts, connections: new ImapConnections(), environmentError: nodeVersionError() });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
