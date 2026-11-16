import { spawn, spawnSync } from 'node:child_process';
import { checkbox, confirm, input, password } from '@inquirer/prompts';
import { ACCOUNT_IDS, envKeys, makeAccount, serviceOf, type AccountId } from './accounts.js';
import { checkLogin, MailError } from './imap.js';

const SERVER_NAME = 'korean-mail';
const PACKAGE_NAME = '@cpal1828/korean-mail-mcp';
const NPX_CACHE_MARKER = '_npx';
// .cmd로 설치된 claude는 셸을 거쳐야 실행된다. 셸이 해석할 글자가 값에 있으면 등록을 맡기지 않는다.
const SHELL_SAFE_VALUE = /^[A-Za-z0-9@._+-]+$/;

type Env = Record<string, string>;
type Scope = 'user' | 'local';

interface Existing {
  scope: Scope;
  env: Env;
}

interface ClaudeCli {
  command: string;
  viaShell: boolean;
}

/** PRD §3-1. 계정을 묻고, 접속을 확인하고, Claude Code에 등록한다. */
export async function runSetup(): Promise<void> {
  console.log('\nkorean-mail-mcp 설정\n');
  const cli = findClaudeCli();
  const existing = cli ? readExisting(cli) : undefined;
  printRegistered(existing);

  const ids = await checkbox<AccountId>({
    message: '연결(추가·변경)할 메일을 고르세요 (스페이스로 선택, Enter로 진행)',
    choices: ACCOUNT_IDS.map((id) => ({ name: serviceOf(id).label, value: id })),
    required: true,
  });

  const env: Env = { ...existing?.env };
  let changed = false;
  for (const id of ids) {
    const credentials = await askAccount(id);
    if (!credentials) continue;
    const keys = envKeys(id);
    env[keys.email] = credentials.email;
    env[keys.password] = credentials.password;
    changed = true;
  }
  if (!changed) {
    console.log('\n바뀐 계정이 없어 등록을 그대로 둡니다.');
    return;
  }
  register(cli, existing, env);
}

function printRegistered(existing: Existing | undefined): void {
  if (!existing) return;
  for (const id of ACCOUNT_IDS) {
    const email = existing.env[envKeys(id).email];
    if (email) console.log(`등록됨: ${serviceOf(id).label} ${email}`);
  }
  console.log('');
}

async function askAccount(id: AccountId): Promise<{ email: string; password: string } | undefined> {
  const service = serviceOf(id);
  console.log(`\n[${service.label} 연결 준비]`);
  for (const step of service.setupSteps) console.log(` ${step}`);
  console.log(` 자세한 안내: ${service.guideUrl}\n`);
  if (await confirm({ message: '자세한 안내 페이지를 브라우저로 열까요?', default: true })) openBrowser(service.guideUrl);

  for (;;) {
    const email = (
      await input({ message: `${service.label} 메일 주소`, validate: (v) => v.includes('@') || '메일 주소 전체를 넣어 주세요' })
    ).trim();
    const appPassword = (await password({ message: '앱 비밀번호', mask: '*' })).trim();
    console.log('접속 확인 중...');
    try {
      const count = await checkLogin(makeAccount(id, email, appPassword));
      console.log(`✅ 연결 성공 (받은편지함 ${count.toLocaleString()}통)`);
      return { email, password: appPassword };
    } catch (error) {
      if (!(error instanceof MailError)) throw error;
      console.log(`❌ ${error.message}`);
      console.log(`   ${service.authHint}`);
      if (!(await confirm({ message: '다시 입력할까요?', default: true }))) return undefined;
    }
  }
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  // 브라우저를 못 열어도 주소는 이미 화면에 있으므로 설정은 계속한다.
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

function findClaudeCli(): ClaudeCli | undefined {
  if (process.platform !== 'win32') return { command: 'claude', viaShell: false };
  const found = spawnSync('where', ['claude'], { encoding: 'utf8' });
  const paths = found.status === 0 ? found.stdout.split(/\r?\n/).filter(Boolean) : [];
  const exe = paths.find((p) => p.toLowerCase().endsWith('.exe'));
  if (exe) return { command: exe, viaShell: false };
  const cmd = paths.find((p) => p.toLowerCase().endsWith('.cmd'));
  return cmd ? { command: cmd, viaShell: true } : undefined;
}

function runClaude(cli: ClaudeCli, args: string[]) {
  // shell을 쓰면 Node가 인자를 공백으로 그냥 이어 붙이므로, 공백이 든 경로(예: C:\Program Files\...)는 따옴표로 감싼다.
  const finalArgs = cli.viaShell ? args.map((a) => (a.includes(' ') ? `"${a}"` : a)) : args;
  return spawnSync(cli.command, finalArgs, { encoding: 'utf8', shell: cli.viaShell });
}

/** `claude mcp get`의 Environment 줄에서 이미 등록된 계정 값을 읽는다. */
function readExisting(cli: ClaudeCli): Existing | undefined {
  const result = runClaude(cli, ['mcp', 'get', SERVER_NAME]);
  if (result.status !== 0) return undefined;
  const output = result.stdout;
  const scopeLine = output.match(/Scope:\s*(\w+)/)?.[1]?.toLowerCase();
  if (scopeLine !== 'user' && scopeLine !== 'local') {
    throw new Error(`이미 등록된 ${SERVER_NAME}의 범위(${scopeLine ?? '알 수 없음'})를 이 설정이 다룰 수 없습니다. 기존 등록을 지우고 다시 실행해 주세요.`);
  }
  const env = parseEnvironment(output);
  if (!env) {
    // 기존 값을 못 읽고 다시 등록하면 다른 계정이 사라진다 (PRD §3-1).
    throw new Error(`이미 등록된 ${SERVER_NAME}의 계정 정보를 읽지 못했습니다. 기존 등록을 지우지 않고 멈춥니다.`);
  }
  return { scope: scopeLine, env };
}

export function parseEnvironment(output: string): Env | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Environment:');
  if (start < 0) return undefined;
  const env: Env = {};
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) break;
    env[match[1]] = match[2];
  }
  return env;
}

function register(cli: ClaudeCli | undefined, existing: Existing | undefined, env: Env): void {
  const server = serverCommand();
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const unsafe = cli?.viaShell && Object.values(env).some((v) => !SHELL_SAFE_VALUE.test(v));
  if (!cli || unsafe) {
    printManualCommand(env, server, cli ? '비밀번호에 셸이 해석할 수 있는 글자가 있어' : 'claude 명령을 찾지 못해');
    return;
  }
  if (existing) runClaude(cli, ['mcp', 'remove', SERVER_NAME, '-s', existing.scope]);
  const added = runClaude(cli, ['mcp', 'add', '--scope', 'user', SERVER_NAME, ...envArgs, '--', ...server]);
  if (added.status !== 0) {
    console.log(`\n등록에 실패했습니다: ${added.stderr.trim()}`);
    printManualCommand(env, server, '자동 등록이 실패해');
    return;
  }
  console.log('\n✅ Claude Code에 등록했습니다. Claude Code를 다시 시작하면 메일 도구를 쓸 수 있습니다.');
}

/** npx로 실행됐으면 npx 형태로, 아니면 지금 실행 중인 파일을 등록한다 (PRD §3-1). */
function serverCommand(): string[] {
  const script = process.argv[1];
  if (!script.includes(NPX_CACHE_MARKER)) return [process.execPath, script];
  return process.platform === 'win32' ? ['cmd', '/c', 'npx', '-y', PACKAGE_NAME] : ['npx', '-y', PACKAGE_NAME];
}

function printManualCommand(env: Env, server: string[], reason: string): void {
  const envArgs = Object.keys(env)
    .map((key) => (key.endsWith('_APP_PASSWORD') ? `-e ${key}=<앱 비밀번호>` : `-e ${key}=${env[key]}`))
    .join(' ');
  console.log(`\n${reason} 자동으로 등록하지 못했습니다. 아래 명령의 <앱 비밀번호>를 바꿔 직접 실행해 주세요.`);
  console.log(`claude mcp add --scope user ${SERVER_NAME} ${envArgs} -- ${server.join(' ')}`);
}
