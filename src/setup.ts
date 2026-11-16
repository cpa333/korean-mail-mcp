import { spawn, spawnSync } from 'node:child_process';
import { confirm, input, password, select } from '@inquirer/prompts';
import {
  SERVICE_IDS,
  envKeys,
  loadAccounts,
  makeAccount,
  nextFreeSlot,
  sameEmail,
  serviceOf,
  type Account,
  type ServiceId,
} from './accounts.js';
import { checkLogin, MailError } from './imap.js';

const SERVER_NAME = 'korean-mail';
const PACKAGE_NAME = '@cpal1828/korean-mail-mcp';
const NPX_CACHE_MARKER = '_npx';
// .cmd로 설치된 claude는 셸을 거쳐야 실행된다. 셸이 해석할 글자가 값에 있으면 등록을 맡기지 않는다.
const SHELL_SAFE_VALUE = /^[A-Za-z0-9@._+-]+$/;

export type Env = Record<string, string>;
type Scope = 'user' | 'local';
type Action = 'add' | 'password' | 'remove' | 'done';

interface Existing {
  scope: Scope;
  env: Env;
}

interface ClaudeCli {
  command: string;
  viaShell: boolean;
}

interface Credentials {
  email: string;
  password: string;
}

/** PRD §3-1. 계정을 더하거나 바꾸거나 빼고, 접속을 확인하고, Claude Code에 등록한다. */
export async function runSetup(): Promise<void> {
  console.log('\nkorean-mail-mcp 설정\n');
  const cli = findClaudeCli();
  const existing = cli ? readExisting(cli) : undefined;
  let env: Env = { ...existing?.env };
  let changed = false;

  for (;;) {
    const accounts = loadAccounts(env).accounts;
    printAccounts(accounts);
    const action = await chooseAction(accounts);
    if (action === 'done') break;
    const next = await applyAction(action, env, accounts);
    if (next) {
      env = next;
      changed = true;
    }
  }

  if (!changed) {
    console.log('\n바뀐 것이 없어 등록을 그대로 둡니다.');
    return;
  }
  register(cli, existing, env);
}

function printAccounts(accounts: Account[]): void {
  console.log('');
  if (!accounts.length) console.log('등록된 계정이 없습니다.');
  for (const account of accounts) console.log(`등록됨: ${account.label}`);
  console.log('');
}

async function chooseAction(accounts: Account[]): Promise<Action> {
  const choices: { name: string; value: Action }[] = [{ name: '계정 추가', value: 'add' }];
  if (accounts.length) {
    choices.push({ name: '비밀번호 바꾸기', value: 'password' }, { name: '계정 빼기', value: 'remove' });
  }
  choices.push({ name: '끝내기 (바뀐 내용 등록)', value: 'done' });
  return select({ message: '무엇을 할까요?', choices });
}

async function applyAction(action: Exclude<Action, 'done'>, env: Env, accounts: Account[]): Promise<Env | undefined> {
  if (action === 'add') {
    const service = await select<ServiceId>({
      message: '어떤 메일인가요?',
      choices: SERVICE_IDS.map((id) => ({ name: serviceOf(id).label, value: id })),
    });
    const credentials = await askCredentials(service);
    if (!credentials) return undefined;
    if (accounts.some((a) => sameEmail(a.email, credentials.email))) console.log('이미 등록된 주소라 비밀번호를 바꿉니다.');
    return withAccount(env, accounts, service, credentials);
  }

  const account = await chooseAccount(accounts, action === 'password' ? '비밀번호를 바꿀 계정' : '뺄 계정');
  if (action === 'password') {
    const credentials = await askCredentials(account.service, account.email);
    return credentials ? withAccount(env, accounts, account.service, credentials) : undefined;
  }
  if (!(await confirm({ message: `${account.label} 계정을 뺄까요?`, default: false }))) return undefined;
  return withoutAccount(env, account);
}

async function chooseAccount(accounts: Account[], message: string): Promise<Account> {
  return select({ message, choices: accounts.map((a) => ({ name: a.label, value: a })) });
}

/** 같은 주소가 있으면 그 자리의 값을 바꾸고, 없으면 서비스의 빈 번호에 더한다 (PRD §4). */
export function withAccount(env: Env, accounts: Account[], service: ServiceId, credentials: Credentials): Env {
  const same = accounts.find((a) => sameEmail(a.email, credentials.email));
  const keys = same ? envKeys(same.service, same.slot) : envKeys(service, nextFreeSlot(accounts, service));
  return { ...env, [keys.email]: credentials.email, [keys.password]: credentials.password };
}

export function withoutAccount(env: Env, account: Account): Env {
  const keys = envKeys(account.service, account.slot);
  const next = { ...env };
  delete next[keys.email];
  delete next[keys.password];
  return next;
}

async function askCredentials(service: ServiceId, fixedEmail?: string): Promise<Credentials | undefined> {
  const info = serviceOf(service);
  console.log(`\n[${info.label} 연결 준비]`);
  for (const step of info.setupSteps) console.log(` ${step}`);
  console.log(` 자세한 안내: ${info.guideUrl}\n`);
  if (await confirm({ message: '자세한 안내 페이지를 브라우저로 열까요?', default: true })) openBrowser(info.guideUrl);

  for (;;) {
    const email =
      fixedEmail ??
      (await input({ message: `${info.label} 메일 주소`, validate: (v) => v.includes('@') || '메일 주소 전체를 넣어 주세요' })).trim();
    const appPassword = (await password({ message: `${email} 앱 비밀번호`, mask: '*' })).trim();
    console.log('접속 확인 중...');
    try {
      const count = await checkLogin(makeAccount(service, email, appPassword));
      console.log(`✅ 연결 성공 (받은편지함 ${count.toLocaleString()}통)`);
      return { email, password: appPassword };
    } catch (error) {
      if (!(error instanceof MailError)) throw error;
      console.log(`❌ ${error.message}`);
      console.log(`   ${info.authHint}`);
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
  const scope = output.match(/Scope:\s*(\w+)/)?.[1]?.toLowerCase();
  if (scope !== 'user' && scope !== 'local') {
    throw new Error(`이미 등록된 ${SERVER_NAME}의 범위(${scope ?? '알 수 없음'})를 이 설정이 다룰 수 없습니다. 기존 등록을 지우고 다시 실행해 주세요.`);
  }
  const env = parseEnvironment(output);
  if (!env) {
    // 기존 값을 못 읽고 다시 등록하면 다른 계정이 사라진다 (PRD §3-1).
    throw new Error(`이미 등록된 ${SERVER_NAME}의 계정 정보를 읽지 못했습니다. 기존 등록을 지우지 않고 멈춥니다.`);
  }
  return { scope, env };
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
  if (!loadAccounts(env).accounts.length) {
    if (cli && existing) runClaude(cli, ['mcp', 'remove', SERVER_NAME, '-s', existing.scope]);
    console.log(`\n계정을 모두 빼서 ${SERVER_NAME} 등록을 지웠습니다. Claude Code를 다시 시작하면 반영됩니다.`);
    return;
  }
  const server = serverCommand();
  const unsafe = cli?.viaShell && Object.values(env).some((v) => !SHELL_SAFE_VALUE.test(v));
  if (!cli || unsafe) {
    printManualCommand(env, server, cli ? '비밀번호에 셸이 해석할 수 있는 글자가 있어' : 'claude 명령을 찾지 못해');
    return;
  }
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
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
