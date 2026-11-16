import { describe, expect, it } from 'vitest';
import { envKeys, loadAccounts, makeAccount, nextFreeSlot, noAccountsMessage, unknownAccountMessage } from '../src/accounts.js';

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
    expect(warnings).toContain('같은 메일 주소가 두 번 설정되어 있습니다: NAVER_EMAIL, NAVER_2_EMAIL. 뒤의 항목은 건너뜁니다.');
  });

  it('시작 경고에는 메일 주소를 넣지 않고 환경변수 키 이름만 쓴다', () => {
    const { warnings } = loadAccounts({
      NAVER_EMAIL: 'secret@naver.com',
      NAVER_APP_PASSWORD: 'p1',
      NAVER_2_EMAIL: 'secret@naver.com',
      NAVER_2_APP_PASSWORD: 'p2',
      DAUM_EMAIL: 'secret@daum.net',
      DAUM_2_EMAIL: 'secret',
      DAUM_2_APP_PASSWORD: 'p',
    });
    expect(warnings).toHaveLength(3);
    for (const warning of warnings) expect(warning).not.toContain('secret');
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

describe('계정 안내 문구 (PRD §7)', () => {
  it('설정되지 않은 계정은 설정된 계정과 setup 명령을 알린다', () => {
    const accounts = [makeAccount('naver', 'me@naver.com', 'p')];
    expect(unknownAccountMessage('other@naver.com', accounts)).toBe(
      '설정되지 않은 계정입니다: other@naver.com. 설정된 계정: me@naver.com(네이버). 계정을 추가하려면 터미널에서 다음 명령을 실행해 주세요: npx -y @cpal1828/korean-mail-mcp@latest setup',
    );
  });

  it('계정이 하나도 없으면 setup 명령을 알린다', () => {
    expect(noAccountsMessage()).toBe(
      '설정된 메일 계정이 없습니다. 터미널에서 다음 명령을 실행해 계정을 등록해 주세요: npx -y @cpal1828/korean-mail-mcp@latest setup',
    );
  });
});
