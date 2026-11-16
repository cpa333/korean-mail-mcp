import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { confirm, input, password, select } from '@inquirer/prompts';
// 버전만 가져와 package.json 전체가 번들에 들어가지 않게 한다.
import { version } from '../package.json';
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
// .cmd로 설치된 claude는 셸을 거쳐야 실행된다. 셸이 해석할 글자가 인자에 있으면 등록을 맡기지 않는다 (PRD §3-1).
const SHELL_SAFE_VALUE = /^[A-Za-z0-9@._+\-:\\/]+$/;
// 환경변수 인자 KEY=VALUE의 키. =는 구분자라 키와 값을 따로 검사한다 (PRD §3-1).
const SHELL_SAFE_KEY = /^[A-Z0-9_]+$/;
// cmd의 /c 같은 스위치는 win32에서 절대 경로로 판정되므로 수동 명령에서 따옴표로 감싸지 않게 따로 가린다.
const CMD_SWITCH = /^\/[A-Za-z]$/;
// 줄바꿈·NUL 같은 제어 문자가 든 값은 받지 않는다(명령 인자·오류 문구에 섞이지 않게).
const CONTROL_CHAR = /[\p{Cc}\u2028\u2029]/u;
const WHITESPACE = /\s/;
// claude mcp get이 값을 가릴 때 쓰는 글자. 가려진 값으로 다시 등록하면 비밀번호가 사라진다.
const MASKED_VALUE = /^\*+$/;
const PASSWORD_KEY_SUFFIX = '_APP_PASSWORD';
const PASSWORD_PLACEHOLDER = '<앱 비밀번호>';
const OTHER_VALUE_PLACEHOLDER = '<기존 값>';
const HIDDEN_TEXT = '***';
const CLAUDE_EXE = '.exe';
const CLAUDE_CMD = '.cmd';
// 이름만 쓰면 Windows가 현재 폴더의 where.exe·cmd.exe를 먼저 실행할 수 있어 시스템 폴더의 것을 직접 부른다.
const WHERE_EXE = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
const CMD_EXE = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');

export type Env = Record<string, string>;
type Scope = 'user' | 'local';
type Action = 'add' | 'password' | 'remove' | 'save' | 'cancel';

interface Existing {
  scope: Scope;
  env: Env;
  /** 등록된 서버 실행 명령(`Command` + `Args`). 읽지 못하면 없다. */
  server?: string;
}

export interface ClaudeCli {
  command: string;
  viaShell: boolean;
}

/** claude를 쓸 수 있으면 cli, 아니면 수동 등록을 안내할 때 앞에 붙일 이유 */
export type ClaudeLookup = { cli: ClaudeCli; problem?: undefined } | { cli?: undefined; problem: string };

interface Credentials {
  email: string;
  password: string;
}

export class EscPressed extends Error {}

/** 질문 하나를 묻는다. 그동안 Esc를 누르면 EscPressed를 던져 지금 작업을 취소하게 한다 (PRD §3-1). */
export async function ask<T>(prompt: (context: { signal: AbortSignal }) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onKey = (_text: string, key?: { name?: string }) => {
    if (key?.name === 'escape') controller.abort();
  };
  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKey);
  try {
    return await prompt({ signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new EscPressed();
    throw error;
  } finally {
    process.stdin.off('keypress', onKey);
  }
}

/** PRD §3-1. 계정을 추가·변경·삭제하고, 접속을 확인하고, Claude Code에 등록한다. */
export async function runSetup(): Promise<void> {
  console.log('\nkorean-mail-mcp 설정');
  console.log('입력 중 Esc를 누르면 진행 중인 작업을 취소하고 메뉴로 돌아갑니다. Ctrl+C를 누르면 저장하지 않고 종료합니다.');
  const lookup = findClaudeCli();
  if (lookup.problem) {
    console.log(`${lookup.problem} 기존 등록을 읽지 못합니다. 기존에 등록한 계정은 아래 목록에 나오지 않습니다.`);
    console.log('완료를 선택하면 직접 실행할 등록 명령을 안내합니다.');
  }
  const existing = lookup.cli ? readExisting(lookup.cli) : undefined;
  let env: Env = { ...existing?.env };
  // 버전을 고정해 등록하므로, 실행 명령만 바뀌어도 다시 등록해야 업데이트된다 (PRD §3-1).
  let changed = announceServerChange(existing?.server, serverCommand().join(' '));

  for (;;) {
    const accounts = loadAccounts(env).accounts;
    printAccounts(accounts);
    const action = await chooseAction(accounts).catch(escAs<Action>('cancel'));
    if (action === 'save') break;
    if (action === 'cancel') {
      if (!changed || (await confirmQuit())) {
        console.log('\n저장하지 않고 종료합니다. 기존 등록은 바뀌지 않습니다.');
        return;
      }
      continue;
    }
    const next = await applyAction(action, env, accounts).catch(escAs<Env | undefined>(undefined));
    if (next) {
      env = next;
      changed = true;
    }
  }

  if (!changed) {
    console.log('\n변경된 내용이 없어 기존 등록을 유지합니다.');
    return;
  }
  register(lookup, existing, env);
}

/** 기존 실행 명령과 새로 등록할 명령이 다르면 알리고 true. 기존 명령을 읽지 못했으면 비교하지 않는다. */
export function announceServerChange(registered: string | undefined, next: string): boolean {
  if (!registered || registered === next) return false;
  console.log(`\n실행 명령이 바뀝니다: ${registered} → ${next}`);
  console.log('완료 (저장)을 선택하면 계정은 그대로 두고 새 실행 명령으로 다시 등록합니다.');
  return true;
}

/** Esc로 멈춘 질문은 정해 둔 값으로 바꾸고, 그 밖의 오류는 그대로 던진다. */
function escAs<T>(value: T) {
  return (error: unknown): T => {
    if (!(error instanceof EscPressed)) throw error;
    console.log('\n진행 중인 작업을 취소했습니다.');
    return value;
  };
}

async function confirmQuit(): Promise<boolean> {
  const message = '변경 내용을 저장하지 않고 종료하시겠습니까?';
  return ask((context) => confirm({ message, default: false }, context)).catch(escAs(false));
}

function printAccounts(accounts: Account[]): void {
  console.log('');
  if (!accounts.length) console.log('등록된 계정이 없습니다.');
  for (const account of accounts) console.log(`등록된 계정: ${account.label}`);
  console.log('');
}

async function chooseAction(accounts: Account[]): Promise<Action> {
  const choices: { name: string; value: Action }[] = [{ name: '계정 추가', value: 'add' }];
  if (accounts.length) {
    choices.push({ name: '비밀번호 바꾸기', value: 'password' }, { name: '계정 삭제', value: 'remove' });
  }
  choices.push({ name: '완료 (저장)', value: 'save' }, { name: '취소 (저장 안 함)', value: 'cancel' });
  return ask((context) => select({ message: '원하는 작업을 선택해 주세요.', choices }, context));
}

async function applyAction(action: 'add' | 'password' | 'remove', env: Env, accounts: Account[]): Promise<Env | undefined> {
  if (action === 'add') {
    const choices = SERVICE_IDS.map((id) => ({ name: serviceOf(id).label, value: id }));
    const service = await ask((context) => select<ServiceId>({ message: '추가할 메일 서비스를 선택해 주세요.', choices }, context));
    const credentials = await askCredentials(service);
    if (!credentials) return undefined;
    if (accounts.some((a) => sameEmail(a.email, credentials.email))) console.log('이미 등록된 주소이므로 비밀번호를 변경합니다.');
    return withAccount(env, accounts, service, credentials);
  }

  const account = await chooseAccount(
    accounts,
    action === 'password' ? '비밀번호를 변경할 계정을 선택해 주세요.' : '삭제할 계정을 선택해 주세요.',
  );
  if (action === 'password') {
    const credentials = await askCredentials(account.service, account.email);
    return credentials ? withAccount(env, accounts, account.service, credentials) : undefined;
  }
  const serviceLabel = serviceOf(account.service).label;
  const message = `${account.email} 계정을 이 MCP에서 삭제하시겠습니까? (${serviceLabel} 계정과 메일은 그대로입니다)`;
  if (!(await ask((context) => confirm({ message, default: false }, context)))) return undefined;
  return withoutAccount(env, account);
}

async function chooseAccount(accounts: Account[], message: string): Promise<Account> {
  const choices = accounts.map((a) => ({ name: a.label, value: a }));
  return ask((context) => select({ message, choices }, context));
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
  const openGuide = await ask((context) =>
    confirm({ message: '자세한 안내 페이지를 브라우저로 여시겠습니까?', default: true }, context),
  );
  if (openGuide) openBrowser(info.guideUrl);

  for (;;) {
    const email = fixedEmail ?? (await askEmail(service));
    const message = `앱 비밀번호를 입력해 주세요(계정: ${email}).`;
    const appPassword = (
      await ask((context) => password({ message, mask: '*', validate: (v) => passwordProblem(v.trim()) ?? true }, context))
    ).trim();
    console.log('접속을 확인하고 있습니다...');
    try {
      const count = await checkLogin(makeAccount(service, email, appPassword));
      console.log(`✅ 연결에 성공했습니다. (받은편지함 ${count.toLocaleString()}통)`);
      return { email, password: appPassword };
    } catch (error) {
      if (!(error instanceof MailError)) throw error;
      console.log(`❌ ${error.message}`);
      console.log(`   ${info.authHint}`);
      if (!(await ask((context) => confirm({ message: '다시 입력하시겠습니까?', default: true }, context)))) return undefined;
    }
  }
}

async function askEmail(service: ServiceId): Promise<string> {
  const message = `${serviceOf(service).label} 메일 주소를 입력해 주세요.`;
  const answer = await ask((context) => input({ message, validate: (v) => emailProblem(service, v.trim()) ?? true }, context));
  return answer.trim();
}

/** setup에 입력한 메일 주소의 문제. 문제가 없으면 undefined (PRD §3-1) */
export function emailProblem(service: ServiceId, email: string): string | undefined {
  const { label, domains } = serviceOf(service);
  if (CONTROL_CHAR.test(email) || WHITESPACE.test(email)) return '메일 주소에는 공백이나 제어 문자를 넣을 수 없습니다.';
  const [localPart, domain, ...rest] = email.split('@');
  if (!localPart || !domain || rest.length) return `메일 주소 전체를 입력해 주세요(예: me@${domains[0]}).`;
  if (!domains.includes(domain.toLowerCase())) {
    return `${label} 계정에 사용할 수 있는 주소: ${domains.map((d) => `@${d}`).join(', ')}`;
  }
  return undefined;
}

/** 입력한 앱 비밀번호의 문제. 문제가 없으면 undefined */
export function passwordProblem(appPassword: string): string | undefined {
  return CONTROL_CHAR.test(appPassword) ? '앱 비밀번호에 제어 문자가 들어 있습니다. 다시 입력해 주세요.' : undefined;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? [CMD_EXE, ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  // 브라우저를 못 열어도 주소는 이미 화면에 있으므로 설정은 계속한다.
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

function findClaudeCli(): ClaudeLookup {
  if (process.platform !== 'win32') return { cli: { command: 'claude', viaShell: false } };
  const found = spawnSync(WHERE_EXE, ['claude'], { encoding: 'utf8' });
  const paths = found.status === 0 ? found.stdout.split(/\r?\n/) : [];
  const cli = pickClaudeCli(paths, process.cwd());
  if (!cli) return { problem: 'claude 명령을 찾을 수 없어' };
  console.log(`claude 실행 파일: ${cli.command}`);
  if (cli.viaShell && !isShellSafe(cli.command)) {
    return { problem: 'claude 실행 파일 경로에 자동 등록에서 다룰 수 없는 문자(한글·공백 등)가 있어' };
  }
  return { cli };
}

/**
 * `where claude` 결과에서 쓸 실행 파일을 고른다 (PRD §3-1).
 * where는 현재 폴더를 PATH보다 먼저 찾으므로 현재 폴더에 있는 것은 뺀다.
 * 하위 폴더는 빼지 않는다: 홈 폴더에서 실행하면 정상 설치 위치(~\.local\bin, AppData\Roaming\npm)도 그 아래에 있기 때문이다.
 */
export function pickClaudeCli(paths: string[], cwd: string): ClaudeCli | undefined {
  const here = normalizedDir(cwd);
  const candidates = paths
    .map((p) => p.trim())
    .filter((p) => [CLAUDE_EXE, CLAUDE_CMD].includes(extensionOf(p)) && normalizedDir(path.win32.dirname(p)) !== here);
  const first = candidates[0];
  if (!first) return undefined;
  const firstDir = normalizedDir(path.win32.dirname(first));
  const sameDirExe = candidates.find((p) => normalizedDir(path.win32.dirname(p)) === firstDir && extensionOf(p) === CLAUDE_EXE);
  const chosen = sameDirExe ?? first;
  return { command: chosen, viaShell: extensionOf(chosen) === CLAUDE_CMD };
}

function normalizedDir(dir: string): string {
  return path.win32.resolve(dir).toLowerCase();
}

function extensionOf(file: string): string {
  return path.win32.extname(file).toLowerCase();
}

export function isShellSafe(value: string): boolean {
  return SHELL_SAFE_VALUE.test(value);
}

function runClaude(cli: ClaudeCli, args: string[]): SpawnSyncReturns<string> {
  if (!cli.viaShell) return spawnSync(cli.command, args, { encoding: 'utf8' });
  // 셸로 넘기는 인자는 findClaudeCli·shellSafeArgs 검사를 통과한 값과 고정 문자열뿐이라 따옴표 없이 이어 붙여도 된다.
  return spawnSync([cli.command, ...args].join(' '), { encoding: 'utf8', shell: true });
}

/** `claude mcp get`의 Environment 줄에서 이미 등록된 계정 값을 읽는다. */
function readExisting(cli: ClaudeCli): Existing | undefined {
  const result = runClaude(cli, ['mcp', 'get', SERVER_NAME]);
  if (result.status !== 0) return undefined;
  return parseExisting(result.stdout);
}

/** 기존 값을 제대로 읽지 못한 채 다시 등록하면 다른 계정이 사라지므로, 의심스러우면 던져서 멈춘다 (PRD §3-1). */
export function parseExisting(output: string): Existing {
  const scope = output.match(/Scope:\s*(\w+)/)?.[1]?.toLowerCase();
  if (scope !== 'user' && scope !== 'local') {
    throw new Error(`이 설정에서 처리할 수 없는 등록 범위입니다: ${scope ?? '알 수 없음'}. 기존 등록을 삭제한 뒤 다시 실행해 주세요.`);
  }
  const env = parseEnvironment(output);
  if (env && Object.values(env).some((value) => MASKED_VALUE.test(value))) {
    throw new Error('기존 등록의 값이 가림 문자(*)로 표시되어 읽을 수 없습니다. 기존 등록을 지우지 않고 중단합니다.');
  }
  if (!env || !loadAccounts(env).accounts.length) {
    throw new Error('기존 등록의 계정 정보를 읽지 못했습니다. 기존 등록을 지우지 않고 중단합니다.');
  }
  return { scope, env, server: parseServerCommand(output) };
}

/** `Command:`·`Args:` 줄을 등록할 때와 같은 모양(공백으로 이은 문자열)으로 읽는다. */
export function parseServerCommand(output: string): string | undefined {
  const command = output.match(/^\s+Command:[ \t]*(.*)$/m)?.[1]?.trim();
  if (!command) return undefined;
  const args = output.match(/^\s+Args:[ \t]*(.*)$/m)?.[1]?.trim();
  return args ? `${command} ${args}` : command;
}

/**
 * `Environment:` 줄 다음에서 그 줄보다 깊이 들여쓴 `KEY=VALUE` 줄을 이어서 읽는다.
 * 빈 줄이나 형식이 다른 줄을 만나면 멈춘다. 키는 대소문자를 가리지 않는다.
 */
export function parseEnvironment(output: string): Env | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Environment:');
  if (start < 0) return undefined;
  const headerIndent = indentOf(lines[start]);
  const env: Env = {};
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1].length <= headerIndent) break;
    env[match[2]] = match[3];
  }
  return env;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

export function register(lookup: ClaudeLookup, existing: Existing | undefined, env: Env): void {
  if (!loadAccounts(env).accounts.length) {
    unregister(lookup, existing);
    return;
  }
  const server = serverCommand();
  const { cli } = lookup;
  if (!cli) {
    console.log(`\n${lookup.problem} 자동으로 등록하지 못했습니다.`);
    console.log('주의: 기존 등록을 읽지 못하여 기존에 등록한 계정은 아래 명령에 들어 있지 않습니다. 기존에 등록한 계정이 있으면 그 계정의 -e 항목도 함께 넣어 실행해 주세요. 넣지 않으면 그 계정은 등록에서 빠집니다.');
    printManualCommand(env, server);
    return;
  }
  // 복구할 때 넘길 기존 값까지 미리 검사해, 지운 뒤에 복구를 못 하는 일이 없게 한다.
  if (cli.viaShell && !shellSafeArgs(cli.command, server, [env, existing?.env ?? {}])) {
    console.log('\n등록할 값이나 경로에 자동 등록에서 다룰 수 없는 문자(한글·공백·특수 문자 등)가 있어 자동으로 등록하지 못했습니다.');
    printManualCommand(env, server);
    return;
  }
  if (existing) {
    if (existing.scope === 'local') {
      console.log('\n기존 등록은 현재 폴더에서만 쓰는 범위(local)입니다. 모든 프로젝트에서 쓰도록 사용자 범위(user)로 옮겨 등록합니다.');
    }
    const removed = runClaude(cli, ['mcp', 'remove', SERVER_NAME, '-s', existing.scope]);
    if (removed.status !== 0) {
      console.log(`\n기존 등록을 지우지 못하여 중단합니다. 기존 등록은 바뀌지 않았습니다. 원인: ${failureReason(removed, [env, existing.env])}`);
      return;
    }
  }
  const added = runClaude(cli, addArgs('user', env, server));
  if (added.status === 0) {
    console.log('\n✅ Claude Code에 등록했습니다. Claude Code를 다시 시작하면 메일 도구를 사용할 수 있습니다.');
    return;
  }
  console.log(`\n등록에 실패했습니다: ${failureReason(added, [env, existing?.env ?? {}])}`);
  if (existing && restore(cli, existing, server, env)) return;
  printManualCommand(env, server);
}

/** 셸로 넘길 인자가 모두 안전한지. 환경변수 인자 KEY=VALUE는 키와 값을 따로 검사한다 (PRD §3-1). */
function shellSafeArgs(command: string, server: string[], envs: Env[]): boolean {
  const envSafe = envs.every((env) => Object.entries(env).every(([key, value]) => SHELL_SAFE_KEY.test(key) && isShellSafe(value)));
  return envSafe && [command, ...server].every(isShellSafe);
}

/** 새 등록이 실패하면 지운 기존 등록을 원래 범위와 값으로 되살린다. 되살렸으면 true */
function restore(cli: ClaudeCli, existing: Existing, server: string[], env: Env): boolean {
  const restored = runClaude(cli, addArgs(existing.scope, existing.env, server));
  if (restored.status === 0) {
    console.log('기존 등록을 이전 계정 값으로 되돌렸습니다. 이번 변경 내용은 저장되지 않았습니다.');
    return true;
  }
  console.log(`기존 등록도 되돌리지 못하여 지금은 등록이 없습니다. 원인: ${failureReason(restored, [env, existing.env])}`);
  return false;
}

function unregister(lookup: ClaudeLookup, existing: Existing | undefined): void {
  if (!lookup.cli) {
    // 기존 등록을 읽지 못한 상태라, 해제 명령을 안내하면 화면에 나오지 않은 계정까지 지워진다.
    console.log(
      `\n${lookup.problem} 기존 등록을 확인하지 못해 Claude Code 등록을 바꾸지 않았습니다. 등록 전체를 지우려면 README의 '제거' 절을 참고해 주세요.`,
    );
    return;
  }
  if (!existing) {
    console.log('\n등록할 계정이 없어 Claude Code 등록을 변경하지 않았습니다.');
    return;
  }
  const removed = runClaude(lookup.cli, ['mcp', 'remove', SERVER_NAME, '-s', existing.scope]);
  if (removed.status !== 0) {
    console.log(`\n등록을 해제하지 못했습니다: ${failureReason(removed, [existing.env])}`);
    console.log(`직접 해제하려면 다음 명령을 실행해 주세요: claude mcp remove ${SERVER_NAME} -s ${existing.scope}`);
    return;
  }
  console.log(`\n모든 계정을 삭제하여 Claude Code 등록을 해제했습니다(등록 이름: ${SERVER_NAME}). Claude Code를 다시 시작하면 반영됩니다.`);
}

function addArgs(scope: Scope, env: Env, server: string[]): string[] {
  return ['mcp', 'add', '--scope', scope, SERVER_NAME, ...envArgs(env).flatMap((arg) => ['-e', arg]), '--', ...server];
}

function envArgs(env: Env): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

/**
 * 실행 실패의 원인 문구. 실행 자체가 안 되면 stderr 없이 error만 온다.
 * claude가 오류에 인자를 되풀이해 보여 줄 수 있으므로, 화면에 보여 주지 않는 값은 가린다.
 */
export function failureReason(result: Pick<SpawnSyncReturns<string>, 'error' | 'stderr' | 'status'>, envs: Env[]): string {
  const text = result.error?.message ?? (result.stderr?.trim() || `종료 코드 ${result.status}`);
  const hidden = envs.flatMap((env) => Object.keys(env).filter((key) => !isShownKey(key, env)).map((key) => env[key]));
  return hidden.filter(Boolean).reduce((reason, value) => reason.split(value).join(HIDDEN_TEXT), text);
}

/** 계정 주소 키만 값을 그대로 보여 준다. 비밀번호와 그 밖의 값은 가린다. */
function isShownKey(key: string, env: Env): boolean {
  return loadAccounts(env).accounts.some((account) => envKeys(account.service, account.slot).email === key);
}

/** npx 캐시에서 실행됐으면 지금 버전으로 고정한 npx 형태로, 아니면 지금 실행 중인 파일을 등록한다 (PRD §3-1). */
function serverCommand(): string[] {
  return serverCommandFor(process.argv[1], process.platform, process.execPath);
}

export function serverCommandFor(script: string, platform: NodeJS.Platform, nodePath: string): string[] {
  const fromNpxCache = script.split(/[\\/]/).includes(NPX_CACHE_MARKER);
  if (!fromNpxCache) return [nodePath, script];
  const npx = ['npx', '-y', `${PACKAGE_NAME}@${version}`];
  return platform === 'win32' ? ['cmd', '/c', ...npx] : npx;
}

/** 등록하지 못한 이유는 부르는 쪽에서 먼저 알린다. */
function printManualCommand(env: Env, server: string[]): void {
  console.log('직접 등록하려면 아래 명령에서 < >로 표시한 자리를 실제 값으로 바꾸어 실행해 주세요.');
  console.log('직접 입력하면 비밀번호가 터미널 명령 기록에 남습니다.');
  console.log(manualCommand(env, server));
}

export function manualCommand(env: Env, server: string[]): string {
  const envPart = Object.keys(env).map((key) => `-e ${key}=${manualValue(key, env)}`);
  const serverPart = server.map((arg) => (path.isAbsolute(arg) && !CMD_SWITCH.test(arg) ? `"${arg}"` : arg));
  return ['claude', 'mcp', 'add', '--scope', 'user', SERVER_NAME, ...envPart, '--', ...serverPart].join(' ');
}

function manualValue(key: string, env: Env): string {
  if (isShownKey(key, env)) return env[key];
  return key.endsWith(PASSWORD_KEY_SUFFIX) ? PASSWORD_PLACEHOLDER : OTHER_VALUE_PLACEHOLDER;
}
