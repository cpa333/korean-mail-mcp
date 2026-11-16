import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 실제 claude를 실행하지 않도록 spawnSync를 가짜로 바꾸고, 넘긴 인자와 돌려줄 결과를 정한다.
vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
// setup 전체 흐름을 볼 때 질문 답을 정해 두고, 메일 서버에는 접속하지 않는다.
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(), input: vi.fn(), password: vi.fn(), select: vi.fn() }));
vi.mock('../src/imap.js', () => ({ checkLogin: vi.fn(async () => 3), MailError: class extends Error {} }));

const { spawnSync } = await import('node:child_process');
const prompts = await import('@inquirer/prompts');
const { register, runSetup } = await import('../src/setup.js');

const mockedSpawn = vi.mocked(spawnSync);
const cli = { command: 'C:\tools\claude.exe', viaShell: false };
const oldEnv = { NAVER_EMAIL: 'me@naver.com', NAVER_APP_PASSWORD: 'OLDSECRET' };
const newEnv = { ...oldEnv, DAUM_EMAIL: 'me@hanmail.net', DAUM_APP_PASSWORD: 'NEWSECRET' };

const ok = { status: 0, stdout: '', stderr: '' };
const failed = (stderr: string) => ({ status: 1, stdout: '', stderr });

let printed: string[];

function respond(...results: object[]): void {
  for (const result of results) mockedSpawn.mockReturnValueOnce(result as ReturnType<typeof spawnSync>);
}

/** 실행한 claude 명령마다 넘긴 인자를 꺼낸다. */
function calls(): string[][] {
  return mockedSpawn.mock.calls.map(([, args]) => args as string[]);
}

beforeEach(() => {
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((text: string) => void printed.push(text));
});

afterEach(() => {
  vi.restoreAllMocks();
  mockedSpawn.mockReset();
});

describe('register (등록 갱신)', () => {
  it('기존 등록을 지운 뒤 사용자 범위로 다시 등록한다', () => {
    respond(ok, ok);
    register({ cli }, { scope: 'user', env: oldEnv }, newEnv);
    expect(calls()[0]).toEqual(['mcp', 'remove', 'korean-mail', '-s', 'user']);
    expect(calls()[1].slice(0, 5)).toEqual(['mcp', 'add', '--scope', 'user', 'korean-mail']);
    expect(calls()[1]).toContain('DAUM_APP_PASSWORD=NEWSECRET');
    expect(printed.join('\n')).toContain('Claude Code에 등록했습니다');
  });

  it('기존 등록 지우기가 실패하면 새로 등록하지 않고 멈춘다', () => {
    respond(failed('permission denied'));
    register({ cli }, { scope: 'user', env: oldEnv }, newEnv);
    expect(calls()).toHaveLength(1);
    expect(printed.join('\n')).toContain('기존 등록을 지우지 못하여 중단합니다');
  });

  it('새 등록이 실패하면 기존 범위와 값으로 되돌린다', () => {
    respond(ok, failed('boom NEWSECRET'), ok);
    register({ cli }, { scope: 'local', env: oldEnv }, newEnv);
    const restore = calls()[2];
    expect(restore.slice(0, 5)).toEqual(['mcp', 'add', '--scope', 'local', 'korean-mail']);
    expect(restore).toContain('NAVER_APP_PASSWORD=OLDSECRET');
    expect(restore).not.toContain('DAUM_APP_PASSWORD=NEWSECRET');
    const text = printed.join('\n');
    expect(text).toContain('사용자 범위(user)로 옮겨 등록합니다');
    expect(text).toContain('기존 등록을 이전 계정 값으로 되돌렸습니다');
    expect(text).not.toContain('NEWSECRET');
  });

  it('되돌리기도 실패하면 그 사실과 수동 명령을 알린다(비밀번호는 보이지 않음)', () => {
    respond(ok, failed('boom'), { status: null, stdout: null, stderr: null, error: new Error('spawnSync claude ENOENT') });
    register({ cli }, { scope: 'user', env: oldEnv }, newEnv);
    const text = printed.join('\n');
    expect(text).toContain('기존 등록도 되돌리지 못하여 지금은 등록이 없습니다. 원인: spawnSync claude ENOENT');
    expect(text).toContain('직접 입력하면 비밀번호가 터미널 명령 기록에 남습니다');
    expect(text).toContain('-e DAUM_APP_PASSWORD=<앱 비밀번호>');
    expect(text).not.toMatch(/OLDSECRET|NEWSECRET/);
  });

  it('기존 등록이 없을 때 등록이 실패하면 수동 명령을 알린다', () => {
    respond(failed('boom'));
    register({ cli }, undefined, newEnv);
    expect(calls()).toHaveLength(1);
    const text = printed.join('\n');
    expect(text).toContain('등록에 실패했습니다: boom');
    expect(text).toContain('직접 등록하려면 아래 명령에서');
  });

  it('claude를 쓸 수 없으면 실행하지 않고, 기존 계정이 빠져 있다는 경고와 함께 수동 명령을 알린다', () => {
    register({ problem: 'claude 명령을 찾을 수 없어' }, undefined, newEnv);
    expect(calls()).toHaveLength(0);
    const text = printed.join('\n');
    expect(text).toContain('claude 명령을 찾을 수 없어 자동으로 등록하지 못했습니다');
    expect(text.indexOf('기존에 등록한 계정이 있으면')).toBeGreaterThan(-1);
    expect(text.indexOf('기존에 등록한 계정이 있으면')).toBeLessThan(text.indexOf('claude mcp add'));
  });
});

describe('register (셸을 거치는 claude.cmd)', () => {
  const shellCli = { command: 'C:\\npm\\claude.cmd', viaShell: true };
  const realArgv1 = process.argv[1];

  // 서버 실행 명령을 npx 형태로 고정해, 테스트를 실행한 node 경로(공백이 있을 수 있음)에 따라 결과가 바뀌지 않게 한다.
  beforeEach(() => {
    process.argv[1] = 'C:\\cache\\_npx\\abc\\node_modules\\@cpal1828\\korean-mail-mcp\\dist\\index.cjs';
  });

  afterEach(() => {
    process.argv[1] = realArgv1;
  });

  it('KEY=VALUE의 키와 값을 따로 검사하므로 = 가 있어도 셸을 거쳐 등록한다', () => {
    respond(ok, ok);
    register({ cli: shellCli }, { scope: 'user', env: oldEnv }, newEnv);
    const [remove, add] = mockedSpawn.mock.calls;
    expect(remove).toEqual(['C:\\npm\\claude.cmd mcp remove korean-mail -s user', { encoding: 'utf8', shell: true }]);
    expect(add[1]).toEqual({ encoding: 'utf8', shell: true });
    expect(add[0]).toMatch(/^C:\\npm\\claude\.cmd mcp add --scope user korean-mail /);
    expect(add[0]).toContain(' -e NAVER_EMAIL=me@naver.com -e NAVER_APP_PASSWORD=OLDSECRET -e DAUM_EMAIL=me@hanmail.net -e DAUM_APP_PASSWORD=NEWSECRET -- ');
    expect(add[0]).toMatch(/ npx -y @cpal1828\/korean-mail-mcp@\S+$/);
    expect(printed.join('\n')).toContain('Claude Code에 등록했습니다');
  });

  it('값에 셸 특수 문자가 있으면 아무것도 실행하지 않는다(복구할 기존 값도 검사)', () => {
    register({ cli: shellCli }, { scope: 'user', env: { ...oldEnv, NAVER_APP_PASSWORD: 'a&b' } }, newEnv);
    expect(calls()).toHaveLength(0);
    expect(printed.join('\n')).toContain('자동 등록에서 다룰 수 없는 문자(한글·공백·특수 문자 등)가 있어 자동으로 등록하지 못했습니다');
  });

  it('키에 영대문자·숫자·_ 밖의 글자가 있으면 아무것도 실행하지 않는다', () => {
    register({ cli: shellCli }, undefined, { ...newEnv, 'A&B': 'x' });
    expect(calls()).toHaveLength(0);
  });
});

describe('runSetup (claude.cmd 경로에 한글이 있을 때)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('claude를 실행하지 않고, 시작할 때 알린 뒤 완료하면 경고와 수동 명령을 보여 준다', async () => {
    respond({ status: 0, stdout: 'C:\\Users\\홍길동\\AppData\\Roaming\\npm\\claude.cmd\r\n', stderr: '' });
    const select = vi.mocked(prompts.select) as unknown as ReturnType<typeof vi.fn>;
    select.mockResolvedValueOnce('add').mockResolvedValueOnce('naver').mockResolvedValueOnce('save');
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);
    vi.mocked(prompts.input).mockResolvedValueOnce('me@naver.com');
    vi.mocked(prompts.password).mockResolvedValueOnce('SECRET1234');

    await runSetup();

    // where.exe로 찾기만 하고 claude는 실행하지 않는다.
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(String(mockedSpawn.mock.calls[0][0]).toLowerCase()).toMatch(/where\.exe$/);
    const text = printed.join('\n');
    const notice = text.indexOf('한글·공백 등)가 있어 기존 등록을 읽지 못합니다');
    const warning = text.indexOf('기존에 등록한 계정이 있으면');
    const command = text.indexOf('claude mcp add --scope user korean-mail -e NAVER_EMAIL=me@naver.com -e NAVER_APP_PASSWORD=<앱 비밀번호>');
    expect(notice).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(notice);
    expect(command).toBeGreaterThan(warning);
    expect(text).not.toContain('SECRET1234');
  });
});

describe('register (모든 계정 삭제)', () => {
  it('지우기가 성공했을 때만 해제했다고 알린다', () => {
    respond(ok);
    register({ cli }, { scope: 'local', env: oldEnv }, {});
    expect(calls()).toEqual([['mcp', 'remove', 'korean-mail', '-s', 'local']]);
    expect(printed.join('\n')).toContain('등록을 해제했습니다');
  });

  it('지우기가 실패하면 해제하지 못했다고 알린다', () => {
    respond(failed('nope'));
    register({ cli }, { scope: 'user', env: oldEnv }, {});
    const text = printed.join('\n');
    expect(text).toContain('등록을 해제하지 못했습니다: nope');
    expect(text).not.toContain('해제했습니다');
  });

  it('기존 등록이 없으면 아무것도 실행하지 않는다', () => {
    register({ cli }, undefined, {});
    expect(calls()).toHaveLength(0);
    expect(printed.join('\n')).not.toContain('해제했습니다');
  });
});
