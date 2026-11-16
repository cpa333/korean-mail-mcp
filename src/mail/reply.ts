export interface Address {
  name?: string;
  address: string;
}

export const REPLY_MODES = ["reply_all", "reply"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export type ParseAddressesResult =
  | { ok: true; addresses: Address[] }
  | { ok: false; invalid: string[] };

export interface OriginalMessage {
  from: Address[];
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  /** 원본 Date 머리말 문자열 그대로. 인용에 가공 없이 쓴다. */
  date: string;
  subject: string;
  messageId?: string;
  references: string[];
  text: string;
}

export interface ReplyRecipientsInput {
  original: OriginalMessage;
  myAddress: string;
  mode: ReplyMode;
  extraCc: Address[];
  bcc: Address[];
}

export interface ReplyRecipients {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  /** To에 남긴 회신 불가 주소. 사람이 확인하는 초안이라 빼지 않고 알리기만 한다. */
  noReplyTo: Address[];
}

export interface ThreadHeaders {
  inReplyTo: string;
  references: string[];
}

const NO_REPLY_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
]);

const REPLY_SUBJECT_PREFIX = "Re: ";
const REPLY_SUBJECT_PATTERN = /^\s*re:/i;
const ORIGINAL_MESSAGE_SEPARATOR = "-----Original Message-----";
const ADDRESS_LIST_SEPARATOR = ", ";
const LINE_BREAK_PATTERN = /\r\n|\r|\n/g;

// 표시 이름 + <주소>. 이름에 쉼표가 있어도 입력 하나가 주소 하나라서 쉼표로 나누지 않는다.
const NAMED_ADDRESS_PATTERN = /^(.*?)\s*<([^<>]*)>$/s;
// 로컬 부분과 도메인이 모두 있어야 하고, 공백·꺾쇠·두 번째 @가 끼면 주소로 보지 않는다.
const ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+$/;
const SURROUNDING_QUOTES_PATTERN = /^"(.*)"$/s;

// String.prototype.trim은 전각 공백(U+3000)과 NBSP(U+00A0)도 깎는다.
function parseAddress(raw: string): Address | undefined {
  const value = raw.trim();
  const named = NAMED_ADDRESS_PATTERN.exec(value);
  const address = (named ? named[2] : value).trim();
  if (!ADDRESS_PATTERN.test(address)) return undefined;

  const name = named ? unquoteName(named[1]) : "";
  return name ? { name, address } : { address };
}

function unquoteName(raw: string): string {
  const trimmed = raw.trim();
  const quoted = SURROUNDING_QUOTES_PATTERN.exec(trimmed);
  return (quoted ? quoted[1] : trimmed).trim();
}

export function parseAddresses(inputs: readonly string[]): ParseAddressesResult {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const raw of inputs) {
    const parsed = parseAddress(raw);
    if (parsed) addresses.push(parsed);
    else invalid.push(raw);
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, addresses };
}

export function isNoReplyAddress(address: string): boolean {
  const atIndex = address.lastIndexOf("@");
  const localPart = atIndex < 0 ? address : address.slice(0, atIndex);
  return NO_REPLY_LOCAL_PARTS.has(localPart.toLowerCase());
}

function addressKey(address: Address | string): string {
  return (typeof address === "string" ? address : address.address).toLowerCase();
}

/** 순서를 지키며 중복과 excluded에 든 주소를 뺀다. 남긴 주소는 excluded에 더한다. */
function takeNew(addresses: readonly Address[], excluded: Set<string>): Address[] {
  const kept: Address[] = [];
  for (const address of addresses) {
    const key = addressKey(address);
    if (excluded.has(key)) continue;
    excluded.add(key);
    kept.push(address);
  }
  return kept;
}

export function computeReplyRecipients(input: ReplyRecipientsInput): ReplyRecipients {
  const { original } = input;
  const to = takeNew(original.replyTo.length > 0 ? original.replyTo : original.from, new Set());

  const ccExcluded = new Set(to.map(addressKey));
  ccExcluded.add(addressKey(input.myAddress));
  const replyAllCandidates = [...original.to, ...original.cc].filter(
    (address) => !isNoReplyAddress(address.address),
  );
  const replyAllCc = input.mode === "reply_all" ? takeNew(replyAllCandidates, ccExcluded) : [];

  // 추가 cc·bcc는 사용자가 직접 고른 주소라 내 주소·회신 불가 제외를 적용하지 않고 To·Cc 중복만 뺀다.
  const toAndCc = new Set([...to, ...replyAllCc].map(addressKey));
  const extraCc = takeNew(input.extraCc, toAndCc);
  const bcc = takeNew(input.bcc, toAndCc);

  return {
    to,
    cc: [...replyAllCc, ...extraCc],
    bcc,
    noReplyTo: to.filter((address) => isNoReplyAddress(address.address)),
  };
}

export function replySubject(subject: string): string {
  return REPLY_SUBJECT_PATTERN.test(subject) ? subject : REPLY_SUBJECT_PREFIX + subject;
}

export function replyThreadHeaders(
  messageId: string | undefined,
  references: readonly string[],
): ThreadHeaders | undefined {
  if (!messageId) return undefined;
  // 부모 Message-ID는 References 맨 끝에 와야 하므로(RFC 5322 §3.6.4), 이미 있으면 그 자리에서 빼고 끝에 붙인다.
  const earlier = [...new Set(references)].filter((reference) => reference !== messageId);
  return { inReplyTo: messageId, references: [...earlier, messageId] };
}

export function formatAddress(address: Address): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function formatAddressList(addresses: readonly Address[]): string {
  return addresses.map(formatAddress).join(ADDRESS_LIST_SEPARATOR);
}

// 원본 제목·이름에 줄바꿈을 넣어 인용 안에 가짜 머리말 줄을 만들지 못하게 한다.
function oneLine(value: string): string {
  return value.replace(LINE_BREAK_PATTERN, " ");
}

export function buildQuotedBody(body: string, original: OriginalMessage): string {
  const headerLines = [
    ORIGINAL_MESSAGE_SEPARATOR,
    `From: ${oneLine(formatAddressList(original.from))}`,
    `To: ${oneLine(formatAddressList(original.to))}`,
  ];
  if (original.cc.length > 0) headerLines.push(`Cc: ${oneLine(formatAddressList(original.cc))}`);
  headerLines.push(`Date: ${oneLine(original.date)}`, `Subject: ${oneLine(original.subject)}`);

  return [body, "", ...headerLines, "", original.text].join("\n");
}
