import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../package.json' with { type: 'json' };
import { loadAccounts, noAccountsMessage } from './accounts.js';
import { ImapConnections } from './imap.js';
import { runSetup } from './setup.js';
import { registerTools } from './tools.js';

const MIN_NODE_MAJOR = 22;

function nodeVersionError(): string | undefined {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) return undefined;
  return `Node.js ${MIN_NODE_MAJOR} 이상이 필요합니다(지금 ${process.versions.node}). nodejs.org에서 LTS 버전으로 업데이트한 뒤 Claude Code를 다시 시작해 주세요.`;
}

async function startServer(): Promise<void> {
  const { accounts, warnings } = loadAccounts(process.env);
  // stdout은 MCP 통신 통로라서 안내는 stderr로만 쓴다.
  for (const warning of warnings) console.error(warning);
  if (accounts.length === 0) console.error(noAccountsMessage());

  const server = new McpServer({ name: 'korean-mail-mcp', version: packageJson.version });
  registerTools(server, { accounts, connections: new ImapConnections(), environmentError: nodeVersionError() });
  await server.connect(new StdioServerTransport());
}

async function setup(): Promise<void> {
  const versionError = nodeVersionError();
  if (versionError) {
    console.error(versionError);
    process.exit(1);
  }
  try {
    await runSetup();
  } catch (error) {
    // Ctrl+C로 질문을 빠져나가면 inquirer가 ExitPromptError를 던진다.
    if (error instanceof Error && error.name === 'ExitPromptError') process.exit(1);
    console.error(`\n설정을 완료하지 못했습니다:${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  // 브라우저를 여는 하위 프로세스 등이 남아 있어도 설정은 끝났으므로 바로 나간다.
  process.exit(0);
}

if (process.argv[2] === 'setup') {
  void setup();
} else {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
