import { describe, expect, it } from 'vitest';
import { envKeys, loadAccounts, nextFreeSlot } from '../src/accounts.js';

describe('loadAccounts', () => {
  it('같은 서비스의 여러 계정을 번호 키로 읽는다', () => {
    const { accounts, warnings } = loadAccounts({
      NAVER_EMAIL: 'me@naver.com',
      NAVER_APP_PASSWORD: 'p1',
      NAVER_3_EMAIL: 'work@naver.com',
      NAVER_3_APP_PASSWORD: 'p3',
      DAUM_EMAIL: 'me@hanmail.net',
      DAUM_APP_PASSWORD: 'p4',
    });
    expect(warnings).toEqual([]);
    expect(accounts.map((a) => [a.service, a.slot, a.email, a.loginName])).toEqual([
      ['naver', 1, 'me@naver.com', 'me'],
      ['naver', 3, 'work@naver.com', 'work'],
      ['daum', 1, 'me@hanmail.net', 'me@hanmail.net'],
    ]);
    expect(accounts[0].label).toBe('네이버 me@naver.com');
  });

  it('짝이 없거나 @가 없거나 같은 주소가 두 번이면 건너뛰고 알린다', () => {
    const { accounts, warnings } = loadAccounts({
      NAVER_EMAIL: 'me@naver.com',
      NAVER_APP_PASSWORD: 'p1',
      NAVER_2_EMAIL: 'ME@naver.com',
      NAVER_2_APP_PASSWORD: 'p2',
      DAUM_EMAIL: 'nopassword@daum.net',
      DAUM_2_EMAIL: 'noat',
      DAUM_2_APP_PASSWORD: 'p',
    });
    expect(accounts.map((a) => a.email)).toEqual(['me@naver.com']);
    expect(warnings).toHaveLength(3);
  });

  it('모르는 접두어나 다른 환경변수는 무시한다', () => {
    expect(loadAccounts({ GMAIL_EMAIL: 'x@gmail.com', PATH: 'C:\\' }).accounts).toEqual([]);
  });
});

describe('envKeys·nextFreeSlot', () => {
  it('첫 번째는 번호 없는 키, 그다음은 번호 키', () => {
    expect(envKeys('naver', 1)).toEqual({ email: 'NAVER_EMAIL', password: 'NAVER_APP_PASSWORD' });
    expect(envKeys('daum', 2)).toEqual({ email: 'DAUM_2_EMAIL', password: 'DAUM_2_APP_PASSWORD' });
  });

  it('비어 있는 가장 작은 번호를 고른다', () => {
    const { accounts } = loadAccounts({ NAVER_EMAIL: 'a@naver.com', NAVER_APP_PASSWORD: 'p', NAVER_3_EMAIL: 'b@naver.com', NAVER_3_APP_PASSWORD: 'p' });
    expect(nextFreeSlot(accounts, 'naver')).toBe(2);
    expect(nextFreeSlot(accounts, 'daum')).toBe(1);
  });
});
