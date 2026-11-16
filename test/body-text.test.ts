import { describe, expect, it } from 'vitest';
import { bodyTextOf } from '../src/mail/body-text.js';

describe('bodyTextOf', () => {
  it('text/plain이 있으면 그대로 쓴다', () => {
    expect(bodyTextOf('안녕하세요\n견적 보내드립니다', '<p>다른 내용</p>')).toBe('안녕하세요\n견적 보내드립니다');
  });

  it('text/plain이 공백뿐이면 HTML을 텍스트로 바꾼다', () => {
    expect(bodyTextOf('  \n ', '<p>본문</p>')).toBe('본문');
  });

  it('HTML만 있으면 블록은 줄을 나누고 script·style은 버린다', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>첫 줄</p><script>x()</script><div>둘째 줄</div></body></html>';
    const text = bodyTextOf(undefined, html);
    expect(text).toContain('첫 줄');
    expect(text).toContain('둘째 줄');
    expect(text).not.toContain('color');
    expect(text).not.toContain('x()');
    expect(text.indexOf('첫 줄')).toBeLessThan(text.indexOf('둘째 줄'));
  });

  it('그림은 빼고 엔티티는 푼다', () => {
    expect(bodyTextOf(undefined, '<p>A&amp;B <img src="https://track.example/x.png" alt="로고"></p>')).toBe('A&B');
  });

  it('긴 줄을 임의로 접지 않는다', () => {
    const line = '가'.repeat(200);
    expect(bodyTextOf(undefined, `<p>${line}</p>`)).toBe(line);
  });

  it('본문이 없으면 빈 문자열', () => {
    expect(bodyTextOf(undefined, undefined)).toBe('');
  });

  it('지나치게 깊은 중첩도 빨리 끝난다', () => {
    const depth = 50_000;
    const html = '<div>'.repeat(depth) + '끝' + '</div>'.repeat(depth);
    const started = Date.now();
    bodyTextOf(undefined, html);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
