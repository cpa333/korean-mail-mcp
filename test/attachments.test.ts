import { describe, expect, it } from 'vitest';
import { type MailAttachment, parseMail } from '../src/mail/parse.js';

async function collectAttachments(source: Buffer): Promise<MailAttachment[]> {
  return (await parseMail(source)).attachments;
}

// EUC-KR(= ks_c_5601-1987) 바이트. 「견적서.pdf」, 「보고서」
const EUC_KR_QUOTE_PDF = Buffer.from('b0dfc0fbbcad2e706466', 'hex');
const EUC_KR_REPORT = Buffer.from('bab8b0edbcad', 'hex');

const PDF_BASE64 = Buffer.from('%PDF-1.4').toString('base64');
const PNG_BASE64 = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64');
const JPEG_BASE64 = Buffer.from('\xff\xd8\xff\xe0', 'latin1').toString('base64');
const GIF_BASE64 = Buffer.from('GIF89a').toString('base64');

function mail(...parts: (string | Buffer)[]): Buffer {
  return Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(`${part}\r\n`) : part)));
}

function mixed(...parts: string[][]): Buffer {
  const lines = ['From: a@example.com', 'Subject: test', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="MIX"', ''];
  for (const part of parts) {
    lines.push('--MIX', ...part);
  }
  lines.push('--MIX--');
  return mail(...lines);
}

const plainBody = ['Content-Type: text/plain; charset=utf-8', '', '본문'];

async function names(source: Buffer): Promise<string[]> {
  return (await collectAttachments(source)).map((attachment) => attachment.fileName);
}

describe('collectAttachments — 첨부 판정 (PRD §9)', () => {
  it('이름·첨부 표시 없는 text/plain·text/html은 본문이라 첨부가 아니다', async () => {
    const source = mixed([
      'Content-Type: multipart/alternative; boundary="ALT"',
      '',
      '--ALT',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '본문',
      '--ALT',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>본문</p>',
      '--ALT--',
    ]);
    expect(await collectAttachments(source)).toEqual([]);
  });

  it('이름 없는 첨부·Content-Disposition 없는 파일도 첨부다. 번호는 1부터 메일 안의 순서', async () => {
    const source = mixed(
      plainBody,
      ['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64', '', 'AAEC'],
      ['Content-Type: application/pdf; name="noDisposition.pdf"', 'Content-Transfer-Encoding: base64', '', PDF_BASE64],
      ['Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', '', PDF_BASE64],
    );
    const attachments = await collectAttachments(source);
    expect(attachments.map(({ index, fileName, contentType, size }) => ({ index, fileName, contentType, size }))).toEqual([
      { index: 1, fileName: '첨부1', contentType: 'application/octet-stream', size: 3 },
      { index: 2, fileName: 'noDisposition.pdf', contentType: 'application/pdf', size: 8 },
      { index: 3, fileName: '첨부3.pdf', contentType: 'application/pdf', size: 8 },
    ]);
    expect(attachments[0].content).toEqual(Buffer.from([0, 1, 2]));
    expect(attachments[1].content.toString()).toBe('%PDF-1.4');
  });

  it('이름 있는 text/plain은 Content-Disposition이 없거나 inline이어도 첨부다', async () => {
    const source = mixed(
      plainBody,
      ['Content-Type: text/plain; name="memo.txt"', '', 'memo'],
      ['Content-Type: text/html', 'Content-Disposition: inline; filename="page.html"', '', '<p>page</p>'],
      ['Content-Type: text/plain', 'Content-Disposition: attachment', '', 'marked'],
    );
    expect(await names(source)).toEqual(['memo.txt', 'page.html', '첨부3.txt']);
  });

  it('multipart/alternative 안의 이름 없는 text/calendar는 빼고, 밖에 있거나 이름이 있으면 넣는다', async () => {
    const source = mixed(
      [
        'Content-Type: multipart/alternative; boundary="ALT"',
        '',
        '--ALT',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '회의 초대',
        '--ALT',
        'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
        '',
        'BEGIN:VCALENDAR',
        'END:VCALENDAR',
        '--ALT--',
      ],
      ['Content-Type: text/calendar; method=REQUEST', '', 'BEGIN:VCALENDAR', 'END:VCALENDAR'],
    );
    expect(await names(source)).toEqual(['첨부1.ics']);

    const named = mixed([
      'Content-Type: multipart/alternative; boundary="ALT"',
      '',
      '--ALT',
      'Content-Type: text/plain',
      '',
      '초대',
      '--ALT',
      'Content-Type: text/calendar; name="invite.ics"',
      '',
      'BEGIN:VCALENDAR',
      '--ALT--',
    ]);
    expect(await names(named)).toEqual(['invite.ics']);

    const marked = mixed([
      'Content-Type: multipart/alternative; boundary="ALT"',
      '',
      '--ALT',
      'Content-Type: text/plain',
      '',
      '초대',
      '--ALT',
      'Content-Type: text/calendar',
      'Content-Disposition: attachment',
      '',
      'BEGIN:VCALENDAR',
      '--ALT--',
    ]);
    expect(await names(marked)).toEqual(['첨부1.ics']);
  });

  it('본문 속(cid) 그림은 형식과 관계없이 모두 첨부다(서명 로고 GIF 포함)', async () => {
    const source = mixed([
      'Content-Type: multipart/related; boundary="REL"',
      '',
      '--REL',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<img src="cid:png1"><img src="cid:jpg1"><img src="cid:gif1">',
      '--REL',
      'Content-Type: image/png',
      'Content-ID: <png1>',
      'Content-Transfer-Encoding: base64',
      '',
      PNG_BASE64,
      '--REL',
      'Content-Type: image/jpeg; name="photo.jpg"',
      'Content-ID: <jpg1>',
      'Content-Disposition: inline; filename="photo.jpg"',
      'Content-Transfer-Encoding: base64',
      '',
      JPEG_BASE64,
      '--REL',
      'Content-Type: image/gif',
      'Content-ID: <gif1>',
      'Content-Transfer-Encoding: base64',
      '',
      GIF_BASE64,
      '--REL--',
    ]);
    expect(await names(source)).toEqual(['첨부1.png', 'photo.jpg', '첨부3.gif']);
  });

  it('메일 전체가 파일 하나면 그것이 첨부다', async () => {
    const source = mail(
      'From: a@example.com',
      'Content-Type: application/pdf; name="scan.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      PDF_BASE64,
    );
    expect(await names(source)).toEqual(['scan.pdf']);
  });

  it('받은 바이트를 문자셋 변환 없이 그대로 담는다', async () => {
    const source = mixed(plainBody, [
      'Content-Type: text/plain; charset=euc-kr; name="old.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      EUC_KR_REPORT.toString('base64'),
    ]);
    const [attachment] = await collectAttachments(source);
    expect(attachment.content).toEqual(EUC_KR_REPORT);
  });
});

describe('collectAttachments — 전달된 메일', () => {
  const inner = [
    'From: x@example.com',
    `Subject: =?UTF-8?B?${Buffer.from('1/2분기 보고').toString('base64')}?=`,
    'Content-Type: multipart/mixed; boundary="INNER"',
    '',
    '--INNER',
    'Content-Type: text/plain',
    '',
    'inner body',
    '--INNER',
    'Content-Type: application/zip; name="inner.zip"',
    'Content-Disposition: attachment; filename="inner.zip"',
    'Content-Transfer-Encoding: base64',
    '',
    'UEsDBA==',
    '--INNER--',
  ];

  it('message/rfc822는 속을 풀지 않고 .eml 하나로, 이름이 없으면 제목으로 짓는다', async () => {
    const source = mixed(plainBody, ['Content-Type: message/rfc822', '', ...inner]);
    const attachments = await collectAttachments(source);
    expect(attachments.map((attachment) => attachment.fileName)).toEqual(['1_2분기 보고.eml']);
    expect(attachments[0].contentType).toBe('message/rfc822');
    expect(attachments[0].content.toString()).toContain('Content-Type: application/zip; name="inner.zip"');
  });

  it('Content-Disposition: inline이어도 속을 풀지 않는다', async () => {
    const source = mixed(plainBody, ['Content-Type: message/rfc822', 'Content-Disposition: inline', '', ...inner]);
    expect(await names(source)).toEqual(['1_2분기 보고.eml']);
  });

  it('이름 우선순위는 Content-Disposition → Content-Type 이름, 확장자가 .eml이 아니면 붙인다', async () => {
    const source = mixed(
      plainBody,
      ['Content-Type: message/rfc822; name="type.eml"', 'Content-Disposition: attachment; filename="disposition.txt"', '', ...inner],
      ['Content-Type: message/rfc822; name="type.EML"', '', ...inner],
    );
    expect(await names(source)).toEqual(['disposition.txt.eml', 'type.EML']);
  });

  it('제목도 이름도 없으면 첨부N.eml', async () => {
    const source = mixed(plainBody, ['Content-Type: message/rfc822', '', 'From: x@example.com', '', 'body']);
    expect(await names(source)).toEqual(['첨부1.eml']);
  });

  it('charset 없는 8비트 EUC-KR 제목을 바르게 푼다', async () => {
    const source = mail(
      'From: a@example.com',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="MIX"',
      '',
      '--MIX',
      'Content-Type: message/rfc822',
      '',
      'From: x@example.com',
      Buffer.concat([Buffer.from('Subject: '), EUC_KR_REPORT, Buffer.from('\r\n')]),
      '',
      'body',
      '--MIX--',
    );
    expect(await names(source)).toEqual(['보고서.eml']);
  });
});

describe('collectAttachments — 한글 파일 이름', () => {
  it('RFC2231 UTF-8 이름', async () => {
    const source = mixed(plainBody, [
      'Content-Type: application/pdf',
      "Content-Disposition: attachment; filename*=UTF-8''%EA%B2%AC%EC%A0%81%EC%84%9C.pdf",
      '',
      'x',
    ]);
    expect(await names(source)).toEqual(['견적서.pdf']);
  });

  it('RFC2231 ks_c_5601-1987 이름', async () => {
    const percent = [...EUC_KR_QUOTE_PDF].map((byte) => `%${byte.toString(16).toUpperCase()}`).join('');
    const source = mixed(plainBody, [
      'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename*=ks_c_5601-1987''${percent}`,
      '',
      'x',
    ]);
    expect(await names(source)).toEqual(['견적서.pdf']);
  });

  it('RFC2047 ks_c_5601-1987 인코딩된 이름', async () => {
    const word = `=?ks_c_5601-1987?B?${EUC_KR_QUOTE_PDF.toString('base64')}?=`;
    const source = mixed(plainBody, [`Content-Type: application/pdf; name="${word}"`, `Content-Disposition: attachment; filename="${word}"`, '', 'x']);
    expect(await names(source)).toEqual(['견적서.pdf']);
  });

  it('charset 없는 8비트 EUC-KR 이름', async () => {
    const source = mail(
      'From: a@example.com',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="MIX"',
      '',
      '--MIX',
      'Content-Type: application/pdf',
      Buffer.concat([Buffer.from('Content-Disposition: attachment; filename="'), EUC_KR_REPORT, Buffer.from('.pdf"\r\n')]),
      '',
      'x',
      '--MIX--',
    );
    expect(await names(source)).toEqual(['보고서.pdf']);
  });

  it('charset 없는 8비트 UTF-8 이름', async () => {
    const source = mail(
      'From: a@example.com',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="MIX"',
      '',
      '--MIX',
      'Content-Type: application/pdf; name="견적서.pdf"',
      '',
      'x',
      '--MIX--',
    );
    expect(await names(source)).toEqual(['견적서.pdf']);
  });

  it('인코딩된 라틴 글자 이름은 EUC-KR로 다시 풀지 않는다', async () => {
    // ö·ß의 latin1 바이트 F6 DF는 CP949로도 풀린다(秤). 다시 풀면 「Gr秤e.pdf」가 된다
    const source = mixed(plainBody, ['Content-Type: application/pdf', 'Content-Disposition: attachment; filename="=?iso-8859-1?Q?Gr=F6=DFe.pdf?="', '', 'x']);
    expect(await names(source)).toEqual(['Größe.pdf']);
  });

  it('보낸 쪽이 적은 경로와 방향 글자를 지운다', async () => {
    const source = mixed(plainBody, [
      'Content-Type: application/octet-stream',
      `Content-Disposition: attachment; filename*=UTF-8''..%5C..%5Cwindows%5C%EA%B2%AC%E2%80%AEfdp.exe`,
      '',
      'x',
    ]);
    expect(await names(source)).toEqual(['견fdp.exe']);
  });
});
