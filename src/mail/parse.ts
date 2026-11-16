import { isUtf8 } from 'node:buffer';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { Splitter, type MimeNode, type SplitterChunk } from '@zone-eu/mailsplit';
import FlowedDecoder from '@zone-eu/mailsplit/lib/flowed-decoder.js';
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from 'mailparser';
import { knownDate } from '../dates.js';
import { sanitizeFileName } from '../files/names.js';
import type { Address } from './reply.js';

export interface MailAttachment {
  /** 1부터. 이름 없는 첨부의 `첨부N`과 같은 번호다. */
  index: number;
  fileName: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ParsedMessage {
  from?: Address;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  /** 원본 Date 머리말 문자열 그대로. */
  date?: string;
  /** Date가 없거나 해석할 수 없거나 1980년 이전이면 없다 (PRD §9). */
  dateValue?: Date;
  messageId?: string;
  references: string[];
  plain?: string;
  html?: string;
  attachments: MailAttachment[];
}

type MessageHeaders = Omit<ParsedMessage, 'plain' | 'html' | 'attachments'>;

const BODY_TYPES = new Set(['text/plain', 'text/html']);
const FORWARDED_TYPE = 'message/rfc822';
const FORWARDED_EXTENSION = '.eml';
const NAME_HEADERS = new Set(['content-type', 'content-disposition']);
// TextDecoder(WHATWG)가 모르는 CP949 이름. 국내 메일이 charset으로 쓴다
const CHARSET_ALIASES: Record<string, string> = { cp949: 'euc-kr', ms949: 'euc-kr', 'x-windows-949': 'euc-kr' };
const BODY_PART_SEPARATOR = '\n';

const eucKr = new TextDecoder('euc-kr', { fatal: true });

interface Leaf {
  node: MimeNode;
  body: Buffer[];
}

/**
 * 메일 원문을 한 번에 해석한다. 본문과 첨부는 MIME 트리를 직접 보고 나누고, 머리말만 mailparser로 푼다 (PRD §9).
 *
 * mailparser에 본문·첨부를 맡기지 않는다. 이름 있는 `text/plain`을 본문에 합치고,
 * 부분의 부모(`multipart/alternative`인지)를 알려 주지 않으며, inline 전달 메일의 속을 바깥 본문에 섞는다.
 */
export async function parseMail(source: Buffer): Promise<ParsedMessage> {
  const headers = await readHeaders(source);
  const leaves = await splitLeaves(source);
  return {
    ...headers,
    plain: await bodyOf(leaves, 'text/plain'),
    html: await bodyOf(leaves, 'text/html'),
    attachments: await attachmentsOf(leaves),
  };
}

/**
 * 전달된 메일은 속으로 들어가지 않고 통째로 한 부분으로 받는다(`ignoreEmbedded`).
 * 들어가면 그 안의 본문·첨부가 바깥 메일의 것처럼 섞인다.
 */
async function splitLeaves(source: Buffer): Promise<Leaf[]> {
  const leaves: Leaf[] = [];
  const byNode = new Map<MimeNode, Leaf>();
  const splitter = new Splitter({ ignoreEmbedded: true });

  splitter.on('data', (chunk: SplitterChunk) => {
    if (chunk.type === 'node') {
      if (!chunk.multipart) {
        const leaf: Leaf = { node: chunk, body: [] };
        leaves.push(leaf);
        byNode.set(chunk, leaf);
      }
      return;
    }
    if (chunk.type === 'body') {
      byNode.get(chunk.node)?.body.push(chunk.value);
    }
  });

  await pipeline(Readable.from([source]), splitter);
  return leaves;
}

// 머리말

/** 머리말만 해석한다. 본문·첨부는 mailparser에 넘기지 않는다. */
async function readHeaders(message: Buffer): Promise<MessageHeaders> {
  const headerEnd = message.toString('latin1').search(/\r?\n\r?\n/);
  const header = headerEnd < 0 ? message : message.subarray(0, headerEnd);
  // mailparser는 charset 없는 8비트 EUC-KR 머리말을 U+FFFD로 바꿔 버려 되살릴 수 없으므로 먼저 UTF-8로 바꿔 넘긴다
  const parsed = await simpleParser(eightBitHeaderToUtf8(header));
  // mailparser는 해석할 수 없는 Date를 지금 시각으로 바꾸므로 원문에서 다시 읽는다
  const date = rawHeader(parsed, 'date');
  const references = parsed.references ?? [];

  return {
    from: addressesOf(parsed.from)[0],
    replyTo: addressesOf(parsed.replyTo),
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    subject: parsed.subject ?? '',
    date,
    dateValue: knownDate(date),
    messageId: parsed.messageId,
    references: typeof references === 'string' ? [references] : references,
  };
}

/**
 * charset 없이 8비트로 적힌 머리말을 UTF-8로 바꾼다. 국내 메일은 EUC-KR(CP949)로 적는다.
 * UTF-8로 맞는 머리말이나 EUC-KR로도 풀리지 않는 머리말은 그대로 돌려준다.
 */
function eightBitHeaderToUtf8(header: Buffer): Buffer {
  if (isUtf8(header)) {
    return header;
  }
  const korean = decodeEucKr(header);
  return korean === undefined ? header : Buffer.from(korean, 'utf8');
}

function rawHeader(parsed: ParsedMail, key: string): string | undefined {
  const binary = parsed.headerLines.find((headerLine) => headerLine.key === key)?.line;
  if (binary === undefined) {
    return undefined;
  }
  // mailparser는 머리말 줄을 바이트 그대로(latin1) 준다. 넘긴 머리말은 UTF-8로 맞춰 두었다
  const line = Buffer.from(binary, 'latin1').toString('utf8');
  const value = line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
  return value === '' ? undefined : value;
}

/** 그룹(`팀: a@x, b@x;`)은 구성원으로 펼친다. 주소 없는 항목은 답장에 쓸 수 없어 뺀다. */
function addressesOf(header: AddressObject | AddressObject[] | undefined): Address[] {
  const objects = header === undefined ? [] : [header].flat();
  return objects
    .flatMap((object) => object.value)
    .flatMap((entry) => entry.group ?? [entry])
    .flatMap(toAddress);
}

function toAddress(entry: EmailAddress): Address[] {
  if (!entry.address) {
    return [];
  }
  return entry.name ? [{ name: entry.name, address: entry.address }] : [{ address: entry.address }];
}

// 본문

/**
 * 같은 형식의 본문 부분을 모두 잇는다. Apple Mail 등은 본문 속 그림을 사이에 두고 본문을 여러 부분으로 나눠 보낸다 —
 * 첫 부분만 쓰면 그림 뒤의 글이 사라진다.
 */
async function bodyOf(leaves: Leaf[], contentType: string): Promise<string | undefined> {
  const parts = leaves.filter((leaf) => isBody(leaf.node) && leaf.node.contentType === contentType);
  if (parts.length === 0) {
    return undefined;
  }
  const texts = await Promise.all(parts.map(bodyText));
  return texts.join(BODY_PART_SEPARATOR);
}

async function bodyText(leaf: Leaf): Promise<string> {
  let bytes = await decode(leaf);
  if (leaf.node.flowed) {
    const flowed = new FlowedDecoder({ delSp: leaf.node.delSp });
    const unflowed = buffer(flowed);
    flowed.end(bytes);
    bytes = await unflowed;
  }
  return decodeCharset(bytes, leaf.node.charset);
}

/** charset이 없으면 8비트 머리말과 같은 규칙: UTF-8로 맞지 않을 때만 EUC-KR로 푼다. */
function decodeCharset(bytes: Buffer, charset: string | false): string {
  if (!charset) {
    return isUtf8(bytes) ? bytes.toString('utf8') : (decodeEucKr(bytes) ?? bytes.toString('utf8'));
  }
  const label = CHARSET_ALIASES[charset.toLowerCase()] ?? charset;
  return decoderFor(label).decode(bytes);
}

/** 모르는 charset이면 UTF-8로 읽는다. 본문을 통째로 버리는 것보다 낫다. */
function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch (error) {
    if (error instanceof RangeError) {
      return new TextDecoder('utf-8');
    }
    throw error;
  }
}

/** 본문으로 쓰는 부분: 이름도 「첨부」 표시도 없는 글자·HTML. */
function isBody(node: MimeNode): boolean {
  return BODY_TYPES.has(node.contentType || '') && !node.filename && node.disposition !== 'attachment';
}

// 첨부

async function attachmentsOf(leaves: Leaf[]): Promise<MailAttachment[]> {
  const attachments: MailAttachment[] = [];

  for (const leaf of leaves) {
    if (isBody(leaf.node) || isAlternativeRendering(leaf.node)) {
      continue;
    }

    const index = attachments.length + 1;
    const contentType = leaf.node.contentType || 'application/octet-stream';
    const content = await decode(leaf);
    const fileName =
      contentType === FORWARDED_TYPE
        ? await forwardedName(leaf.node, content, index)
        : sanitizeFileName(givenName(leaf.node), index, contentType);

    attachments.push({ index, fileName, contentType, size: content.length, content });
  }

  return attachments;
}

/** 전송 인코딩(base64 등)만 푼다. 첨부는 받은 바이트를 그대로 저장하므로 문자셋은 바꾸지 않는다 (PRD §6-5). */
async function decode(leaf: Leaf): Promise<Buffer> {
  const decoder = leaf.node.getDecoder();
  const decoded = buffer(decoder);
  for (const chunk of leaf.body) {
    decoder.write(chunk);
  }
  decoder.end();
  return decoded;
}

/**
 * 본문의 다른 표현 — 이름 없이 글·HTML 곁에 놓인 일정 초대(text/calendar) 등. 본문의 일부라 첨부로 넣지 않는다.
 * 「첨부」 표시가 붙었으면 보낸 쪽이 첨부로 보냈으므로 넣는다.
 */
function isAlternativeRendering(node: MimeNode): boolean {
  const parent = node.parentNode;
  return parent !== false && parent.multipart === 'alternative' && !node.filename && node.disposition !== 'attachment';
}

/**
 * mailsplit은 UTF-8로 맞지 않는 8비트 머리말을 latin1로 읽는다. 그렇게 읽힌 이름만 EUC-KR로 다시 푼다.
 * 인코딩된 단어(`=?iso-8859-1?…`)로 바르게 온 라틴 글자 이름까지 다시 풀면 엉뚱한 한글이 된다.
 */
function givenName(node: MimeNode): string | undefined {
  if (!node.filename) {
    return undefined;
  }
  if (!hasRawEightBitName(node) || /[^\u0000-\u00FF]/.test(node.filename)) {
    return node.filename;
  }
  return decodeEucKr(Buffer.from(node.filename, 'latin1')) ?? node.filename;
}

function hasRawEightBitName(node: MimeNode): boolean {
  if (node.headers === false) {
    return false;
  }
  return node.headers
    .getList()
    .some(({ key, line }) => NAME_HEADERS.has(key) && !isUtf8(Buffer.from(line, 'latin1')));
}

/**
 * 이름 우선순위: Content-Disposition 이름 → Content-Type 이름 → 전달된 메일의 제목.
 * 이름이 무엇이든 속은 메일이므로 `.eml`로 끝나게 한다. `.txt`로 붙여 보내 메일이 아닌 척하는 것을 막는다.
 */
async function forwardedName(node: MimeNode, message: Buffer, index: number): Promise<string> {
  // 제목은 경로가 아니다. `1/2분기 보고`의 앞부분이 경로로 잘려 나가지 않게 한다
  const given = givenName(node) ?? (await readHeaders(message)).subject.replace(/[\\/]/g, '_');
  const name = sanitizeFileName(given, index, FORWARDED_TYPE);
  if (name.toLowerCase().endsWith(FORWARDED_EXTENSION)) {
    return name;
  }
  return sanitizeFileName(name + FORWARDED_EXTENSION, index, FORWARDED_TYPE);
}

/** EUC-KR로 맞지 않으면 undefined. 오류는 "이 문자셋이 아님"이라는 판정 결과다. */
function decodeEucKr(bytes: Buffer): string | undefined {
  try {
    return eucKr.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}
