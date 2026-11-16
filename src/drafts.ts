import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { ListResponse } from 'imapflow';
import type { Address } from './mail/reply.js';

const DRAFTS_SPECIAL_USE = '\\Drafts';
const DRAFTS_FOLDER_NAMES = ['drafts', '임시보관함'];
export const DRAFT_FLAGS = ['\\Draft', '\\Seen'];

// 다음은 SPECIAL-USE를 광고하지 않고 LIST 속성으로만 \Drafts를 준다(05 실측). imapflow는 LIST 속성과
// 흔한 폴더 이름으로 specialUse를 채우므로 이름 비교는 그것마저 없을 때의 대비다.
export function findDraftsPath(folders: ListResponse[]): string | undefined {
  const bySpecialUse = folders.find((f) => f.specialUse === DRAFTS_SPECIAL_USE);
  if (bySpecialUse) return bySpecialUse.path;
  return folders.find((f) => DRAFTS_FOLDER_NAMES.includes(f.name.toLowerCase()))?.path;
}

export interface DraftMessage {
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body: string;
  attachmentPaths: string[];
  inReplyTo?: string;
  references?: string[];
}

export async function buildDraft(draft: DraftMessage): Promise<Buffer> {
  const node = new MailComposer({
    from: draft.from,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.body,
    date: new Date(),
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    attachments: draft.attachmentPaths.map((path) => ({ path })),
  }).compile();
  // 초안은 사람이 웹메일에서 숨은참조를 확인하고 보내야 하므로 Bcc 머리말을 남긴다.
  node.keepBcc = true;
  return node.build();
}
