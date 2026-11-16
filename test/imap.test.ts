import { describe, expect, it } from 'vitest';
import { makeAccount } from '../src/accounts.js';
import { toMailError } from '../src/imap.js';
import { megabytes } from '../src/mailbox.js';

const account = makeAccount('naver', 'me@naver.com', 'unused');
const MB = 1024 * 1024;

describe('toMailError', () => {
  it('서버 거절은 서버 응답을 "서버 응답:" 뒤에 300자까지 붙인다', () => {
    const message = toMailError(account, { responseStatus: 'NO', responseText: '가'.repeat(500) }).message;
    expect(message).toBe(`[네이버 me@naver.com] 메일 서버가 요청을 거절했습니다. 서버 응답: ${'가'.repeat(300)}…`);
  });

  it('서버 응답이 짧으면 그대로, 없으면 붙이지 않는다', () => {
    expect(toMailError(account, { responseStatus: 'BAD', responseText: 'Message too large' }).message).toBe(
      '[네이버 me@naver.com] 메일 서버가 요청을 거절했습니다. 서버 응답: Message too large',
    );
    expect(toMailError(account, { responseStatus: 'NO' }).message).toBe('[네이버 me@naver.com] 메일 서버가 요청을 거절했습니다.');
  });

  it('메일함이 없으면 메일함 목록 도구로 경로를 확인하라고 알린다', () => {
    expect(toMailError(account, { mailboxMissing: true, path: '받은편지함2' }).message).toBe(
      '[네이버 me@naver.com] 메일함을 찾을 수 없습니다: 받은편지함2. 메일함 목록 도구(list_folders)로 경로를 확인해 주세요.',
    );
  });

  it('알 수 없는 오류의 원문 메시지도 300자까지만 붙인다', () => {
    const message = toMailError(account, new Error('x'.repeat(1_000))).message;
    expect(message).toBe(`[네이버 me@naver.com] 알 수 없는 오류가 발생했습니다: ${'x'.repeat(300)}…`);
  });
});

describe('megabytes', () => {
  it('소수 한 자리로 올림해 한도를 조금 넘은 크기가 한도와 같아 보이지 않게 한다', () => {
    expect(megabytes(50 * MB)).toBe('50.0');
    expect(megabytes(50 * MB + 1)).toBe('50.1');
    expect(megabytes(1.25 * MB)).toBe('1.3');
  });
});
