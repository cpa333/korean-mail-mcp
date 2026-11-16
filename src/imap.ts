import { ImapFlow } from 'imapflow';
import type { Account, AccountId } from './accounts.js';

const IMAP_PORT = 993;
const CONNECT_TIMEOUT_MS = 30_000;

const TLS_CERT_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TIMEOUT_CODES = new Set([
  'ETIMEOUT',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'LockTimeout',
]);

const NETWORK_CODES = new Set([
  'NoConnection',
  'EConnectionClosed',
  'StateLogout',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
]);

const AUTH_REJECTED_MESSAGE = '로그인이 거절됐습니다. 앱 비밀번호와 IMAP 사용 설정을 확인해 주세요.';

/** 사용자에게 그대로 보여 줄 수 있는 오류. 비밀번호나 메일 내용을 담지 않는다. */
export class MailError extends Error {}

interface ImapErrorFields {
  code?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  mailboxMissing?: boolean;
  path?: string;
  responseStatus?: string;
  responseText?: string;
}

export function toMailError(account: Account, error: unknown): MailError {
  if (error instanceof MailError) return error;
  const e = (error ?? {}) as ImapErrorFields & { message?: string };
  const prefix = `[${account.label}] `;
  const code = e.code ?? '';

  if (e.authenticationFailed) return new MailError(prefix + AUTH_REJECTED_MESSAGE);
  // 2026-10-13 네이버 IMAP이 폐기된 인증서를 내밀었을 때 "인터넷 연결 확인"으로 보여 원인을 잘못 짚었다.
  if (e.tlsFailed || TLS_CERT_ERROR_CODES.has(code)) {
    return new MailError(prefix + '메일 서버의 보안 인증서에 문제가 있습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (TIMEOUT_CODES.has(code)) {
    return new MailError(prefix + '메일 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (NETWORK_CODES.has(code)) {
    return new MailError(prefix + '메일 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.');
  }
  if (e.mailboxMissing) {
    return new MailError(prefix + `메일함을 찾을 수 없습니다: ${e.path ?? ''}. list_folders로 경로를 확인해 주세요.`);
  }
  if (e.responseStatus === 'NO' || e.responseStatus === 'BAD') {
    return new MailError(prefix + `메일 서버가 요청을 거절했습니다: ${e.responseText ?? ''}`);
  }
  return new MailError(prefix + `알 수 없는 오류: ${e.message ?? String(error)}`);
}

/**
 * 계정마다 연결 하나를 여러 도구 호출에 재사용한다. 우리 쪽에서는 끊지 않고,
 * 서버가 끊으면 다음 호출 때 다시 연다 (PRD §5).
 */
export class ImapConnections {
  private readonly pending = new Map<AccountId, Promise<ImapFlow>>();
  // 틀린 비밀번호로 로그인을 되풀이하면 서버가 계정을 막을 수 있어, 거절된 계정은 재시작 전까지 다시 시도하지 않는다.
  private readonly authRejected = new Set<AccountId>();

  async withMailbox<T>(
    account: Account,
    path: string,
    options: { readOnly: boolean },
    work: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    return this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: options.readOnly });
      try {
        return await work(client);
      } finally {
        lock.release();
      }
    });
  }

  async withClient<T>(account: Account, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    try {
      const client = await this.clientFor(account);
      return await work(client);
    } catch (error) {
      if ((error as ImapErrorFields).authenticationFailed) this.authRejected.add(account.id);
      throw toMailError(account, error);
    }
  }

  private async clientFor(account: Account): Promise<ImapFlow> {
    if (this.authRejected.has(account.id)) {
      throw new MailError(`[${account.label}] ${AUTH_REJECTED_MESSAGE} 설정을 고친 뒤 Claude Code를 다시 시작해 주세요.`);
    }
    const existing = this.pending.get(account.id);
    if (!existing) return this.reconnect(account, undefined);
    const client = await existing;
    return client.usable ? client : this.reconnect(account, existing);
  }

  /**
   * 끊긴 연결을 여러 호출이 동시에 발견해도 로그인은 한 번만 하도록,
   * 이미 누군가 새로 연결 중이면 그 연결을 함께 기다린다.
   */
  private reconnect(account: Account, stale: Promise<ImapFlow> | undefined): Promise<ImapFlow> {
    const current = this.pending.get(account.id);
    if (current && current !== stale) return current;
    const connecting = this.connect(account);
    this.pending.set(account.id, connecting);
    connecting.catch(() => {
      if (this.pending.get(account.id) === connecting) this.pending.delete(account.id);
    });
    return connecting;
  }

  private async connect(account: Account): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: account.host,
      port: IMAP_PORT,
      secure: true,
      auth: { user: account.loginName, pass: account.password },
      logger: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
    });
    // 'error' 이벤트에 듣는 쪽이 없으면 Node 프로세스가 죽는다. 원인은 다음 호출에서 오류로 드러난다.
    client.on('error', (error: ImapErrorFields) => {
      console.error(`[${account.id}] IMAP 연결 오류: ${error.code ?? 'unknown'}`);
    });
    await client.connect();
    return client;
  }
}
