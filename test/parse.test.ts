import { describe, expect, it } from 'vitest';
import { parseMail } from '../src/mail/parse.js';

// EUC-KR(= ks_c_5601-1987) 바이트. 「보고서」, 「김부장」
const EUC_KR_REPORT = Buffer.from('bab8b0edbcad', 'hex');
const EUC_KR_BOSS = Buffer.from('b1e8bacec0e5', 'hex');

function mail(...lines: (string | Buffer)[]): Buffer {
  return Buffer.concat(lines.map((line) => (typeof line === 'string' ? Buffer.from(`${line}\r\n`) : line)));
}

const baseHeaders = ['From: a@example.com', 'To: b@example.com', 'Subject: test', 'MIME-Version: 1.0'];

describe('parseMail — 본문', () => {
  it('이름 있는 text/plain은 본문에 섞지 않고 첨부로 둔다', async () => {
    const parsed = await parseMail(
      mail(
        ...baseHeaders,
        'Content-Type: multipart/mixed; boundary="MIX"',
        '',
        '--MIX',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '본문입니다',
        '--MIX',
        'Content-Type: text/plain; name="memo.txt"',
        '',
        '메모 내용',
        '--MIX--',
      ),
    );
    expect(parsed.plain).toBe('본문입니다');
    expect(parsed.html).toBeUndefined();
    expect(parsed.attachments.map((attachment) => attachment.fileName)).toEqual(['memo.txt']);
  });

  it('inline 전달 메일의 속은 본문에 섞지 않는다', async () => {
    const parsed = await parseMail(
      mail(
        ...baseHeaders,
        'Content-Type: multipart/mixed; boundary="MIX"',
        '',
        '--MIX',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '바깥 본문',
        '--MIX',
        'Content-Type: message/rfc822',
        'Content-Disposition: inline',
        '',
        'From: x@example.com',
        'Subject: inner',
        'Content-Type: text/plain',
        '',
        '전달된 본문',
        '--MIX--',
      ),
    );
    expect(parsed.plain).toBe('바깥 본문');
    expect(parsed.attachments.map((attachment) => attachment.fileName)).toEqual(['inner.eml']);
  });

  it('html만 있는 메일', async () => {
    const parsed = await parseMail(
      mail(...baseHeaders, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from('<p>안녕</p>').toString('base64')),
    );
    expect(parsed.plain).toBeUndefined();
    expect(parsed.html).toBe('<p>안녕</p>');
    expect(parsed.attachments).toEqual([]);
  });

  it('alternative의 plain과 html을 각각 문자셋에 맞게 푼다', async () => {
    const parsed = await parseMail(
      mail(
        ...baseHeaders,
        'Content-Type: multipart/alternative; boundary="ALT"',
        '',
        '--ALT',
        'Content-Type: text/plain; charset=ks_c_5601-1987',
        'Content-Transfer-Encoding: base64',
        '',
        EUC_KR_REPORT.toString('base64'),
        '--ALT',
        'Content-Type: text/html; charset=cp949',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.concat([Buffer.from('<b>'), EUC_KR_REPORT, Buffer.from('</b>')]).toString('base64'),
        '--ALT--',
      ),
    );
    expect(parsed.plain).toBe('보고서');
    expect(parsed.html).toBe('<b>보고서</b>');
  });

  it('charset 없는 8비트 EUC-KR 본문', async () => {
    const parsed = await parseMail(mail(...baseHeaders, 'Content-Type: text/plain', '', EUC_KR_REPORT));
    expect(parsed.plain).toBe('보고서');
  });

  it('그림을 사이에 두고 나뉜 본문은 이어 붙인다', async () => {
    const parsed = await parseMail(
      mail(
        ...baseHeaders,
        'Content-Type: multipart/mixed; boundary="MIX"',
        '',
        '--MIX',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '앞',
        '--MIX',
        'Content-Type: image/png; name="shot.png"',
        'Content-Disposition: inline; filename="shot.png"',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--MIX',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '뒤',
        '--MIX--',
      ),
    );
    expect(parsed.plain).toBe('앞\n뒤');
    expect(parsed.attachments.map((attachment) => attachment.fileName)).toEqual(['shot.png']);
  });

  it('format=flowed 줄을 잇는다', async () => {
    const parsed = await parseMail(
      mail(...baseHeaders, 'Content-Type: text/plain; charset=utf-8; format=flowed', '', '긴 줄은 ', '이어진다', ''),
    );
    // mailsplit의 flowed 해석은 줄 끝을 \n으로 바꾼다
    expect(parsed.plain).toBe('긴 줄은 이어진다\n');
  });
});

describe('parseMail — 머리말', () => {
  it('주소·제목·Message-ID·Date', async () => {
    const parsed = await parseMail(
      mail(
        'From: "Kim" <kim@example.com>',
        'Reply-To: reply@example.com',
        'To: b@example.com, "C" <c@example.com>',
        'Cc: team: d@example.com, e@example.com;',
        `Subject: =?UTF-8?B?${Buffer.from('견적 요청').toString('base64')}?=`,
        'Message-ID: <m1@example.com>',
        'Date: Mon, 16 Nov 2026 10:00:00',
        ' +0900',
        '',
        'body',
      ),
    );
    expect(parsed.from).toEqual({ name: 'Kim', address: 'kim@example.com' });
    expect(parsed.replyTo).toEqual([{ address: 'reply@example.com' }]);
    expect(parsed.to).toEqual([{ address: 'b@example.com' }, { name: 'C', address: 'c@example.com' }]);
    expect(parsed.cc).toEqual([{ address: 'd@example.com' }, { address: 'e@example.com' }]);
    expect(parsed.subject).toBe('견적 요청');
    expect(parsed.messageId).toBe('<m1@example.com>');
    expect(parsed.date).toBe('Mon, 16 Nov 2026 10:00:00 +0900');
    expect(parsed.dateValue?.toISOString()).toBe('2026-11-16T01:00:00.000Z');
    expect(parsed.references).toEqual([]);
    expect(parsed.plain).toBe('body\r\n');
  });

  it('charset 없는 8비트 EUC-KR 제목', async () => {
    const parsed = await parseMail(
      mail('From: a@example.com', Buffer.concat([Buffer.from('Subject: '), EUC_KR_REPORT, Buffer.from('\r\n')]), '', 'body'),
    );
    expect(parsed.subject).toBe('보고서');
  });

  it('ks_c_5601-1987로 인코딩된 보낸사람 이름', async () => {
    const parsed = await parseMail(
      mail(`From: =?ks_c_5601-1987?B?${EUC_KR_BOSS.toString('base64')}?= <boss@example.com>`, 'Subject: s', '', 'body'),
    );
    expect(parsed.from).toEqual({ name: '김부장', address: 'boss@example.com' });
  });

  it('References는 하나여도 여럿이어도 배열', async () => {
    const one = await parseMail(mail('From: a@example.com', 'References: <r1@example.com>', '', 'body'));
    expect(one.references).toEqual(['<r1@example.com>']);

    const many = await parseMail(
      mail('From: a@example.com', 'References: <r1@example.com>', ' <r2@example.com> <r3@example.com>', '', 'body'),
    );
    expect(many.references).toEqual(['<r1@example.com>', '<r2@example.com>', '<r3@example.com>']);
  });

  it('Date가 없거나 해석할 수 없거나 1980년 이전이면 날짜를 모른다', async () => {
    const missing = await parseMail(mail('From: a@example.com', '', 'body'));
    expect(missing.date).toBeUndefined();
    expect(missing.dateValue).toBeUndefined();

    const broken = await parseMail(mail('From: a@example.com', 'Date: 언젠가', '', 'body'));
    expect(broken.date).toBe('언젠가');
    expect(broken.dateValue).toBeUndefined();

    const old = await parseMail(mail('From: a@example.com', 'Date: Thu, 1 Jan 1970 00:00:00 +0000', '', 'body'));
    expect(old.date).toBe('Thu, 1 Jan 1970 00:00:00 +0000');
    expect(old.dateValue).toBeUndefined();

    const edge = await parseMail(mail('From: a@example.com', 'Date: Tue, 1 Jan 1980 00:00:00 +0000', '', 'body'));
    expect(edge.dateValue?.toISOString()).toBe('1980-01-01T00:00:00.000Z');
  });

  it('보낸사람이 없으면 from이 없다', async () => {
    const parsed = await parseMail(mail('Subject: s', '', 'body'));
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toEqual([]);
  });
});
