import type { FetchMessageObject, ImapFlow, MessageStructureObject } from 'imapflow';
import type { Account } from './accounts.js';
import { addDays, knownDate, toLocalIso } from './dates.js';
import { DRAFT_FLAGS, findDraftsPath } from './drafts.js';
import { ImapConnections, MailError } from './imap.js';

const DEFAULT_SEARCH_DAYS = 30;
const MAX_SCANNED_MESSAGES = 2_000;
const FETCH_BATCH_SIZE = 500;
const FORWARDED_TYPE = 'message/rfc822';

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
}

export async function listFolders(connections: ImapConnections, account: Account): Promise<FolderInfo[]> {
  return connections.withClient(account, async (client) => {
    const folders = await client.list();
    return folders.map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse || undefined }));
  });
}

export interface SearchCriteria {
  folder: string;
  from?: string;
  keyword?: string;
  since?: Date;
  before?: Date;
  unreadOnly: boolean;
  limit: number;
}

export interface MessageSummary {
  uid: number;
  date?: string;
  from: { name?: string; address?: string };
  subject: string;
  unread: boolean;
  hasAttachments: boolean;
}

export interface SearchResult {
  messages: MessageSummary[];
  /** 2,000통 한도 때문에 오래된 쪽을 살펴보지 못했다 */
  scanLimited: boolean;
  /** limit을 채워 멈췄고, 살펴보지 않은 메일이 더 남아 있다 */
  moreAvailable: boolean;
}

interface Range {
  since: Date;
  before?: Date;
}

/**
 * 서버에는 날짜와 안 읽음만 묻고, 보낸 사람·제목은 받아 온 ENVELOPE에서 거른다.
 * 한글 SEARCH를 서비스마다 믿을 수 없어서다 (PRD §6-3).
 */
export async function searchMessages(
  connections: ImapConnections,
  account: Account,
  criteria: SearchCriteria,
): Promise<SearchResult> {
  const range: Range = {
    since: criteria.since ?? addDays(criteria.before ?? new Date(), -DEFAULT_SEARCH_DAYS),
    before: criteria.before,
  };
  return connections.withMailbox(account, criteria.folder, { readOnly: true }, async (client) => {
    // 서버의 SINCE·BEFORE는 서버 시간대의 수신 날짜를 일 단위로 보므로 하루씩 넓혀 묻고 Date 머리말로 다시 거른다.
    const query: { since: Date; before?: Date; seen?: boolean } = { since: addDays(range.since, -1) };
    if (range.before) query.before = addDays(range.before, 1);
    if (criteria.unreadOnly) query.seen = false;

    const found = await client.search(query, { uid: true });
    if (!found) throw new MailError(`[${account.label}] 메일 서버가 검색을 거절했습니다.`);
    const scanned = [...found].sort((a, b) => b - a).slice(0, MAX_SCANNED_MESSAGES);

    const messages: MessageSummary[] = [];
    let start = 0;
    let droppedMatches = false;
    while (start < scanned.length && messages.length < criteria.limit) {
      const batch = scanned.slice(start, start + FETCH_BATCH_SIZE);
      const matched = await fetchMatches(client, batch, criteria, range);
      const room = criteria.limit - messages.length;
      droppedMatches = matched.length > room;
      messages.push(...matched.slice(0, room));
      start += FETCH_BATCH_SIZE;
    }

    messages.sort((a, b) => timeOf(b) - timeOf(a));
    return {
      messages,
      scanLimited: found.length > MAX_SCANNED_MESSAGES,
      moreAvailable: droppedMatches || (messages.length >= criteria.limit && start < scanned.length),
    };
  });
}

async function fetchMatches(client: ImapFlow, uids: number[], criteria: SearchCriteria, range: Range): Promise<MessageSummary[]> {
  const matched: MessageSummary[] = [];
  const query = { uid: true, envelope: true, flags: true, bodyStructure: true };
  for await (const msg of client.fetch(uids.join(','), query, { uid: true })) {
    const summary = toSummary(msg);
    if (matches(summary, criteria, range)) matched.push(summary);
  }
  // limit에서 자를 때 최신 메일이 남게 한다.
  return matched.sort((a, b) => b.uid - a.uid);
}

function toSummary(msg: FetchMessageObject): MessageSummary {
  const date = knownDate(msg.envelope?.date);
  const sender = msg.envelope?.from?.[0];
  return {
    uid: msg.uid,
    date: date ? toLocalIso(date) : undefined,
    from: { name: sender?.name || undefined, address: sender?.address },
    subject: msg.envelope?.subject ?? '',
    unread: !msg.flags?.has('\\Seen'),
    hasAttachments: msg.bodyStructure ? hasAttachmentPart(msg.bodyStructure) : false,
  };
}

function matches(summary: MessageSummary, criteria: SearchCriteria, range: Range): boolean {
  if (summary.date && !inRange(new Date(summary.date), range)) return false;
  if (criteria.from && !senderMatches(summary.from, criteria.from)) return false;
  if (criteria.keyword && !summary.subject.toLowerCase().includes(criteria.keyword.toLowerCase())) return false;
  return true;
}

function inRange(date: Date, range: Range): boolean {
  if (date < range.since) return false;
  return !range.before || date < range.before;
}

function senderMatches(from: MessageSummary['from'], text: string): boolean {
  const needle = text.toLowerCase();
  return (from.name?.toLowerCase() ?? '').includes(needle) || (from.address?.toLowerCase() ?? '').includes(needle);
}

function timeOf(summary: MessageSummary): number {
  return summary.date ? new Date(summary.date).getTime() : 0;
}

/** 목록에 표시할 대략적인 판정. 정확한 첨부 목록은 read_email이 MIME 트리를 보고 만든다 (PRD §6-3). */
function hasAttachmentPart(node: MessageStructureObject): boolean {
  const type = node.type.toLowerCase();
  if (type === FORWARDED_TYPE) return true;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachmentPart);
  if (node.disposition === 'attachment') return true;
  if (node.dispositionParameters?.filename || node.parameters?.name) return true;
  return !type.startsWith('text/') && !type.startsWith('multipart/');
}

export async function fetchSource(
  connections: ImapConnections,
  account: Account,
  folder: string,
  uid: number,
): Promise<Buffer> {
  return connections.withMailbox(account, folder, { readOnly: true }, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new MailError(`[${account.label}] 해당 메일을 찾을 수 없습니다: ${folder} / uid ${uid}`);
    return msg.source;
  });
}

export async function appendDraft(connections: ImapConnections, account: Account, raw: Buffer): Promise<string> {
  return connections.withClient(account, async (client) => {
    const path = findDraftsPath(await client.list());
    if (!path) throw new MailError(`[${account.label}] 임시보관함을 찾을 수 없습니다. list_folders로 메일함 이름을 확인해 주세요.`);
    await client.append(path, raw, DRAFT_FLAGS);
    return path;
  });
}
