import { describe, expect, it } from 'vitest';
import { MAX_HTML_INPUT_CHARS, bodyTextOf } from '../src/mail/body-text.js';

const textOf = (plain: string | undefined, html: string | undefined) => bodyTextOf(plain, html).text;

describe('bodyTextOf', () => {
  it('text/plain이 있으면 그대로 쓴다', () => {
    expect(textOf('안녕하세요\n견적 보내드립니다', '<p>다른 내용</p>')).toBe('안녕하세요\n견적 보내드립니다');
  });

  it('text/plain이 공백뿐이면 HTML을 텍스트로 바꾼다', () => {
    expect(textOf('  \n ', '<p>본문</p>')).toBe('본문');
  });

  it('HTML만 있으면 블록은 줄을 나누고 script·style은 버린다', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>첫 줄</p><script>x()</script><div>둘째 줄</div></body></html>';
    const text = textOf(undefined, html);
    expect(text).toContain('첫 줄');
    expect(text).toContain('둘째 줄');
    expect(text).not.toContain('color');
    expect(text).not.toContain('x()');
    expect(text.indexOf('첫 줄')).toBeLessThan(text.indexOf('둘째 줄'));
  });

  it('그림은 빼고 엔티티는 푼다', () => {
    expect(textOf(undefined, '<p>A&amp;B <img src="https://track.example/x.png" alt="로고"></p>')).toBe('A&B');
  });

  it('긴 줄을 임의로 접지 않는다', () => {
    const line = '가'.repeat(200);
    expect(textOf(undefined, `<p>${line}</p>`)).toBe(line);
  });

  it('줄바꿈을 \\n 하나로 통일한다', () => {
    expect(textOf('첫 줄\r\n둘째 줄\r셋째 줄\n넷째 줄', undefined)).toBe('첫 줄\n둘째 줄\n셋째 줄\n넷째 줄');
  });

  it('본문이 없으면 빈 문자열', () => {
    expect(bodyTextOf(undefined, undefined)).toEqual({ text: '', htmlTruncated: false });
  });

  it('지나치게 깊은 중첩도 호출 스택이 넘치지 않고 빨리 끝난다', () => {
    // html-to-text는 제한이 없으면 약 2,000단계에서 스택이 넘친다. 그 몇 배 깊이로 확인한다.
    // 파서가 깊이에 제곱으로 느려져 5만 단계는 느린 PC에서 2초를 넘었으므로(2026-11-16 보고) 1만 단계로 본다.
    const depth = 10_000;
    const html = '<div>'.repeat(depth) + '끝' + '</div>'.repeat(depth);
    const started = Date.now();
    bodyTextOf(undefined, html);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('HTML은 앞의 200KB까지만 텍스트로 바꾸고 잘렸다고 알린다', () => {
    const html = `<p>앞부분</p>${' '.repeat(MAX_HTML_INPUT_CHARS)}<p>뒷부분</p>`;
    const result = bodyTextOf(undefined, html);
    expect(result.text).toContain('앞부분');
    expect(result.text).not.toContain('뒷부분');
    expect(result.htmlTruncated).toBe(true);
  });

  it('text/plain이 있으면 HTML 길이와 관계없이 잘리지 않는다', () => {
    expect(bodyTextOf('본문', 'x'.repeat(MAX_HTML_INPUT_CHARS + 1)).htmlTruncated).toBe(false);
  });

  // 2026-11-16 재현: 닫지 않은 태그만 반복한 HTML 2MB는 30초~2분 넘게 걸렸다.
  it('닫지 않은 태그를 상한까지 채운 HTML도 빨리 끝난다', () => {
    const html = '<b>'.repeat(Math.ceil(MAX_HTML_INPUT_CHARS / 3) + 10);
    const started = Date.now();
    bodyTextOf(undefined, html);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
