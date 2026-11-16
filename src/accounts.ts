export const ACCOUNT_IDS = ['naver', 'daum'] as const;
export type AccountId = (typeof ACCOUNT_IDS)[number];

interface Service {
  label: string;
  envPrefix: string;
  host: string;
  loginName: (email: string) => string;
}

const SERVICES: Record<AccountId, Service> = {
  naver: {
    label: '네이버',
    envPrefix: 'NAVER',
    host: 'imap.naver.com',
    // 네이버 IMAP 로그인 이름은 아이디만이다. 05 프로젝트에서 이 형식으로 접속을 실측했다.
    loginName: (email) => email.split('@')[0],
  },
  daum: {
    label: '다음',
    envPrefix: 'DAUM',
    host: 'imap.daum.net',
    loginName: (email) => email,
  },
};

export interface Account {
  id: AccountId;
  label: string;
  email: string;
  host: string;
  loginName: string;
  password: string;
}

export interface LoadedAccounts {
  accounts: Account[];
  warnings: string[];
}

export function loadAccounts(env: NodeJS.ProcessEnv): LoadedAccounts {
  const accounts: Account[] = [];
  const warnings: string[] = [];
  for (const id of ACCOUNT_IDS) {
    const service = SERVICES[id];
    const emailKey = `${service.envPrefix}_EMAIL`;
    const passwordKey = `${service.envPrefix}_APP_PASSWORD`;
    const email = env[emailKey]?.trim();
    const password = env[passwordKey]?.trim();
    if (!email && !password) continue;
    if (!email || !password) {
      warnings.push(`${service.label}: ${emailKey}과 ${passwordKey}를 둘 다 넣어야 합니다. 이 계정은 건너뜁니다.`);
      continue;
    }
    if (!email.includes('@')) {
      warnings.push(`${service.label}: ${emailKey}에는 메일 주소 전체(예: me@${service.host.replace('imap.', '')})를 넣어야 합니다. 이 계정은 건너뜁니다.`);
      continue;
    }
    accounts.push({ id, label: service.label, email, host: service.host, loginName: service.loginName(email), password });
  }
  return { accounts, warnings };
}

function envKeysOf(id: AccountId): string {
  const { envPrefix } = SERVICES[id];
  return `${envPrefix}_EMAIL, ${envPrefix}_APP_PASSWORD`;
}

export function notConfiguredMessage(id: AccountId): string {
  return `${SERVICES[id].label} 계정이 설정되지 않았습니다. 환경변수 ${envKeysOf(id)}를 넣어 다시 등록해 주세요.`;
}

export function noAccountsMessage(): string {
  const options = ACCOUNT_IDS.map((id) => `${SERVICES[id].label}(${envKeysOf(id)})`).join(' 또는 ');
  return `설정된 메일 계정이 없습니다. ${options}를 넣어 다시 등록해 주세요.`;
}
