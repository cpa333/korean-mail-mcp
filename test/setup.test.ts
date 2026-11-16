import { describe, expect, it } from 'vitest';
import { loadAccounts } from '../src/accounts.js';
import packageJson from '../package.json' with { type: 'json' };
import {
  EscPressed,
  ask,
  emailProblem,
  failureReason,
  isShellSafe,
  manualCommand,
  parseEnvironment,
  parseExisting,
  passwordProblem,
  pickClaudeCli,
  serverCommandFor,
  withAccount,
  withoutAccount,
} from '../src/setup.js';

describe('ask (Esc 취소)', () => {
  // 실제 질문 대신, 중단 신호를 받으면 실패하는 가짜 질문을 쓴다.
  const waitForAbort = (context: { signal: AbortSignal }) =>
    new Promise<string>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted'))));

  it('Esc를 누르면 EscPressed로 멈춘다', async () => {
    const pending = ask(waitForAbort);
    process.stdin.emit('keypress', '', { name: 'escape' });
    await expect(pending).rejects.toBeInstanceOf(EscPressed);
  });

  it('다른 키는 무시하고 답을 그대로 돌려준다', async () => {
    const pending = ask(async () => {
      process.stdin.emit('keypress', 'a', { name: 'a' });
      return '답';
    });
    await expect(pending).resolves.toBe('답');
  });

  it('질문이 끝나면 키 듣기를 그만둔다', async () => {
    const before = process.stdin.listenerCount('keypress');
    await ask(async () => '답');
    expect(process.stdin.listenerCount('keypress')).toBe(before);
  });
});

// `claude mcp get` 실제 출력 형식(Claude Code 2.1.325에서 확인)
const OUTPUT = `korean-mail:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: C:\\x\\index.cjs
  Environment:
    NAVER_EMAIL=me@naver.com
    NAVER_APP_PASSWORD=ABCD1234EFGH

To remove this server, run: claude mcp remove korean-mail -s user
`;

describe('parseEnvironment', () => {
  it('Environment 아래의 키=값을 읽는다', () => {
    expect(parseEnvironment(OUTPUT)).toEqual({ NAVER_EMAIL: 'me@naver.com', NAVER_APP_PASSWORD: 'ABCD1234EFGH' });
  });

  it('값에 = 가 있어도 첫 = 에서만 나눈다', () => {
    expect(parseEnvironment('  Environment:\n    A=b=c\n')).toEqual({ A: 'b=c' });
  });

  it('Environment 줄이 없으면 읽지 못한 것으로 본다', () => {
    expect(parseEnvironment('korean-mail:\n  Type: stdio\n')).toBeUndefined();
  });

  it('대문자가 아닌 키가 섞여도 뒤의 키를 계속 읽는다', () => {
    const output = '  Environment:\n    NAVER_EMAIL=me@naver.com\n    http_proxy=x\n    NAVER_APP_PASSWORD=p\n';
    expect(parseEnvironment(output)).toEqual({ NAVER_EMAIL: 'me@naver.com', http_proxy: 'x', NAVER_APP_PASSWORD: 'p' });
  });

  it('빈 줄에서 멈춘다', () => {
    expect(parseEnvironment('  Environment:\n    A=1\n\n    B=2\n')).toEqual({ A: '1' });
  });

  it('형식이 다른 줄에서 멈춘다', () => {
    expect(parseEnvironment('  Environment:\n    A=1\n    not a pair\n    B=2\n')).toEqual({ A: '1' });
  });

  it('Environment 줄보다 깊게 들여쓰지 않은 줄에서 멈춘다', () => {
    expect(parseEnvironment('  Environment:\n    A=1\n  B=2\n')).toEqual({ A: '1' });
  });
});

describe('parseExisting (기존 등록 읽기 안전장치)', () => {
  it('범위와 계정 값을 읽는다', () => {
    expect(parseExisting(OUTPUT)).toEqual({
      scope: 'user',
      env: { NAVER_EMAIL: 'me@naver.com', NAVER_APP_PASSWORD: 'ABCD1234EFGH' },
    });
  });

  it('프로젝트 범위(local)도 읽는다', () => {
    const local = OUTPUT.replace('User config (available in all your projects)', 'Local config (private to you in this project)');
    expect(parseExisting(local).scope).toBe('local');
  });

  it('처리할 수 없는 범위면 멈춘다', () => {
    expect(() => parseExisting(OUTPUT.replace('User config', 'Project config'))).toThrow('범위');
  });

  it('값이 가림 문자(*)로만 되어 있으면 멈춘다', () => {
    expect(() => parseExisting(OUTPUT.replace('ABCD1234EFGH', '************'))).toThrow('가림 문자');
  });

  it('Environment 줄은 있는데 계정 키를 하나도 읽지 못하면 멈춘다', () => {
    const noAccount = OUTPUT.replace(/ {4}NAVER_EMAIL=.*\n {4}NAVER_APP_PASSWORD=.*\n/, '    OTHER=1\n');
    expect(() => parseExisting(noAccount)).toThrow('계정 정보를 읽지 못했습니다');
  });

  it('Environment 줄이 없어도 멈춘다', () => {
    expect(() => parseExisting('korean-mail:\n  Scope: User config\n  Type: stdio\n')).toThrow('계정 정보를 읽지 못했습니다');
  });
});

describe('pickClaudeCli (claude 실행 파일 찾기)', () => {
  const cwd = 'C:\\Users\\me\\Downloads\\unzipped';

  it('현재 폴더의 claude는 대소문자·끝 구분자와 관계없이 뺀다', () => {
    const paths = ['c:\\users\\ME\\downloads\\Unzipped\\claude.cmd', 'C:\\Users\\me\\.local\\bin\\claude.exe'];
    expect(pickClaudeCli(paths, `${cwd}\\`)).toEqual({ command: paths[1], viaShell: false });
  });

  it('현재 폴더의 claude만 있으면 찾지 못한 것으로 본다', () => {
    expect(pickClaudeCli([`${cwd}\\claude.exe`], cwd)).toBeUndefined();
  });

  it('현재 폴더의 하위 폴더는 빼지 않는다(홈 폴더에서 실행하는 경우)', () => {
    const exe = 'C:\\Users\\me\\.local\\bin\\claude.exe';
    expect(pickClaudeCli([exe], 'C:\\Users\\me')).toEqual({ command: exe, viaShell: false });
  });

  it('PATH에서 먼저 나온 것을 쓴다(.cmd가 앞이면 .cmd를 셸로 실행)', () => {
    const cmd = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
    const paths = [cmd, 'C:\\Users\\me\\.local\\bin\\claude.exe'];
    expect(pickClaudeCli(paths, cwd)).toEqual({ command: cmd, viaShell: true });
  });

  it('같은 폴더에 둘 다 있으면 .exe를 쓴다', () => {
    const exe = 'C:\\tools\\claude.exe';
    expect(pickClaudeCli(['C:\\tools\\claude.cmd', exe], cwd)).toEqual({ command: exe, viaShell: false });
  });

  it('확장자가 .exe·.cmd가 아닌 결과와 빈 줄은 무시한다', () => {
    const exe = 'C:\\tools\\claude.EXE';
    expect(pickClaudeCli(['', 'C:\\npm\\claude', 'C:\\npm\\claude.ps1', ` ${exe}`], cwd)).toEqual({ command: exe, viaShell: false });
  });
});

describe('isShellSafe (셸을 거칠 때의 인자 검사)', () => {
  it('영숫자와 @._+-:\\/ 는 허용한다', () => {
    for (const value of ['me@naver.com', 'ABCD1234efgh', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', '@cpal1828/korean-mail-mcp@0.1.1', 'NAVER_2_EMAIL']) {
      expect(isShellSafe(value), value).toBe(true);
    }
  });

  it('공백·셸 특수 문자·한글·빈 값은 거절한다', () => {
    for (const value of ['C:\\Program Files\\nodejs\\node.exe', 'a&b', '100%', 'a^b', 'a"b', 'a|b', 'a<b', 'a>b', 'a(b)', 'a!b', 'a=b', 'C:\\Users\\홍길동', '']) {
      expect(isShellSafe(value), value).toBe(false);
    }
  });
});

describe('serverCommandFor (등록할 서버 실행 명령)', () => {
  const pinned = `@cpal1828/korean-mail-mcp@${packageJson.version}`;

  it('경로 구성 요소가 _npx면 지금 버전으로 고정한 npx 형태로 등록한다', () => {
    const script = '/home/me/.npm/_npx/abc123/node_modules/@cpal1828/korean-mail-mcp/dist/index.cjs';
    expect(serverCommandFor(script, 'linux', '/usr/bin/node')).toEqual(['npx', '-y', pinned]);
  });

  it('Windows는 cmd /c로 감싼다', () => {
    const script = 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\x\\dist\\index.cjs';
    expect(serverCommandFor(script, 'win32', 'C:\\node\\node.exe')).toEqual(['cmd', '/c', 'npx', '-y', pinned]);
  });

  it('_npx가 이름의 일부일 뿐이면 지금 실행 중인 파일을 node로 등록한다', () => {
    const script = '/home/me/my_npx/dist/index.cjs';
    expect(serverCommandFor(script, 'linux', '/usr/bin/node')).toEqual(['/usr/bin/node', script]);
  });
});

describe('manualCommand (수동 등록 명령)', () => {
  it('주소만 보여 주고 비밀번호와 그 밖의 값은 자리 표시로 바꾸며, 경로는 따옴표로 감싼다', () => {
    const env = { NAVER_EMAIL: 'me@naver.com', NAVER_APP_PASSWORD: 'secret', HTTP_PROXY: 'http://user:pw@proxy' };
    const command = manualCommand(env, [process.execPath, process.argv[1]]);
    expect(command).toBe(
      `claude mcp add --scope user korean-mail -e NAVER_EMAIL=me@naver.com -e NAVER_APP_PASSWORD=<앱 비밀번호> -e HTTP_PROXY=<기존 값> -- "${process.execPath}" "${process.argv[1]}"`,
    );
  });

  it('npx 형태는 따옴표 없이 그대로 쓴다', () => {
    expect(manualCommand({}, ['npx', '-y', '@cpal1828/korean-mail-mcp@0.1.1'])).toBe(
      'claude mcp add --scope user korean-mail -- npx -y @cpal1828/korean-mail-mcp@0.1.1',
    );
  });

  it('cmd /c 의 /c 는 경로가 아니므로 따옴표로 감싸지 않는다', () => {
    expect(manualCommand({}, ['cmd', '/c', 'npx', '-y', '@cpal1828/korean-mail-mcp@0.1.1'])).toBe(
      'claude mcp add --scope user korean-mail -- cmd /c npx -y @cpal1828/korean-mail-mcp@0.1.1',
    );
  });
});

describe('failureReason (실행 실패 원인)', () => {
  const env = { NAVER_EMAIL: 'me@naver.com', NAVER_APP_PASSWORD: 'SECRET123' };

  it('실행 자체가 안 되어 stderr가 없으면 error 메시지를 쓴다', () => {
    expect(failureReason({ error: new Error('spawnSync claude ENOENT'), stderr: undefined as unknown as string, status: null }, [env])).toBe(
      'spawnSync claude ENOENT',
    );
  });

  it('stderr가 비어 있으면 종료 코드를 쓴다', () => {
    expect(failureReason({ stderr: '', status: 1 }, [env])).toBe('종료 코드 1');
  });

  it('오류 문구에 비밀번호가 있으면 가린다(주소는 그대로)', () => {
    const stderr = 'Invalid environment variable format: NAVER_APP_PASSWORD=SECRET123 for me@naver.com\n';
    expect(failureReason({ stderr, status: 1 }, [env])).toBe('Invalid environment variable format: NAVER_APP_PASSWORD=*** for me@naver.com');
  });
});

describe('emailProblem·passwordProblem (setup 입력 검사)', () => {
  it('네이버는 @naver.com 주소만 받는다(대소문자 무시)', () => {
    expect(emailProblem('naver', 'me@naver.com')).toBeUndefined();
    expect(emailProblem('naver', 'me@NAVER.COM')).toBeUndefined();
    expect(emailProblem('naver', 'me@hanmail.net')).toBe('네이버 계정에 사용할 수 있는 주소: @naver.com');
    expect(emailProblem('naver', 'me@naver.com.evil.example')).toBeDefined();
  });

  it('다음은 @hanmail.net·@daum.net 주소만 받는다', () => {
    expect(emailProblem('daum', 'me@hanmail.net')).toBeUndefined();
    expect(emailProblem('daum', 'me@daum.net')).toBeUndefined();
    expect(emailProblem('daum', 'me@naver.com')).toBe('다음 계정에 사용할 수 있는 주소: @hanmail.net, @daum.net');
  });

  it('아이디만 넣거나 @가 여러 개면 주소 전체를 달라고 한다', () => {
    for (const email of ['me', '@naver.com', 'me@', 'a@b@naver.com']) {
      expect(emailProblem('naver', email), email).toBe('메일 주소 전체를 입력해 주세요(예: me@naver.com).');
    }
  });

  it('공백·제어 문자가 든 주소는 거절한다', () => {
    for (const email of ['me @naver.com', 'me\n@naver.com', 'me\u0000@naver.com', 'me\u2028@naver.com']) {
      expect(emailProblem('naver', email), JSON.stringify(email)).toBe('메일 주소에는 공백이나 제어 문자를 넣을 수 없습니다.');
    }
  });

  it('제어 문자가 든 비밀번호는 거절한다', () => {
    expect(passwordProblem('ABCD1234EFGH')).toBeUndefined();
    expect(passwordProblem('ABCD\nEFGH')).toBeDefined();
    expect(passwordProblem('ABCD\u0000EFGH')).toBeDefined();
  });
});

describe('withAccount·withoutAccount', () => {
  const env = { NAVER_EMAIL: 'me@naver.com', NAVER_APP_PASSWORD: 'old', DAUM_EMAIL: 'me@hanmail.net', DAUM_APP_PASSWORD: 'd' };
  const accounts = loadAccounts(env).accounts;

  it('같은 서비스의 새 주소는 다음 번호로 더하고 기존 계정은 그대로 둔다', () => {
    const next = withAccount(env, accounts, 'naver', { email: 'work@naver.com', password: 'w' });
    expect(next).toEqual({ ...env, NAVER_2_EMAIL: 'work@naver.com', NAVER_2_APP_PASSWORD: 'w' });
  });

  it('이미 있는 주소는 그 자리의 비밀번호만 바꾼다(대소문자 무시)', () => {
    const next = withAccount(env, accounts, 'naver', { email: 'ME@naver.com', password: 'new' });
    expect(next.NAVER_APP_PASSWORD).toBe('new');
    expect(Object.keys(next)).toHaveLength(4);
  });

  it('계정을 빼면 그 계정의 두 키만 지운다', () => {
    expect(withoutAccount(env, accounts[0])).toEqual({ DAUM_EMAIL: 'me@hanmail.net', DAUM_APP_PASSWORD: 'd' });
  });
});
