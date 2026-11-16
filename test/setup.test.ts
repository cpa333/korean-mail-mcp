import { describe, expect, it } from 'vitest';
import { loadAccounts } from '../src/accounts.js';
import { EscPressed, ask, parseEnvironment, withAccount, withoutAccount } from '../src/setup.js';

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
