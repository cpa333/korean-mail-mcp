export const ACCOUNT_IDS = ['naver', 'daum'] as const;
export type AccountId = (typeof ACCOUNT_IDS)[number];

export interface Service {
  label: string;
  envPrefix: string;
  host: string;
  loginName: (email: string) => string;
  /** setup이 보여 주는 준비 단계 (PRD §3-1 안내 문구) */
  setupSteps: string[];
  guideUrl: string;
  /** 로그인이 거절됐을 때 덧붙이는 서비스별 안내 */
  authHint: string;
}

const SERVICES: Record<AccountId, Service> = {
  naver: {
    label: '네이버',
    envPrefix: 'NAVER',
    host: 'imap.naver.com',
    // 네이버 IMAP 로그인 이름은 아이디만이다. 05 프로젝트에서 이 형식으로 접속을 실측했다.
    loginName: (email) => email.split('@')[0],
    setupSteps: [
      "1. IMAP 켜기: 네이버 메일 → 환경설정 → POP3/IMAP 설정 → IMAP/SMTP 사용 → '사용함'",
      '2. 앱 비밀번호 만들기(2단계 인증이 꺼져 있으면 먼저 켭니다):',
      "   네이버 내정보 → 보안설정 → 2단계 인증 '관리' → 애플리케이션 비밀번호 관리",
      "   → '직접 입력'에 10자 이내 이름(예: mailmcp) → 생성. 비밀번호는 한 번만 보이니 바로 복사하세요.",
    ],
    guideUrl: 'https://help.naver.com/service/5640/contents/8584?osType=COMMONOS',
    authHint: '네이버 로그인 비밀번호가 아니라 애플리케이션 비밀번호를 넣었는지, IMAP을 사용함으로 켰는지 확인하세요.',
  },
  daum: {
    label: '다음',
    envPrefix: 'DAUM',
    host: 'imap.daum.net',
    loginName: (email) => email,
    setupSteps: [
      "1. IMAP 켜기: 다음 메일 → 환경설정 → IMAP/POP3 → IMAP/SMTP 사용 → '사용함' → 저장",
      '2. 앱 비밀번호 만들기: 다음 회원 → 마이페이지에서 앱 비밀번호 생성',
      '   (2025-12-01부터 다음 메일 앱 비밀번호는 여기서만 만듭니다. 카카오계정에서 만든 것은 안 됩니다)',
    ],
    guideUrl: 'https://cs.daum.net/faq/43/9234.html?faqId=31143',
    authHint: '다음 회원 마이페이지에서 만든 앱 비밀번호인지(카카오계정 것은 안 됨), IMAP을 사용함으로 켰는지 확인하세요.',
  },
};

export function serviceOf(id: AccountId): Service {
  return SERVICES[id];
}

export interface Account {
  id: AccountId;
  label: string;
  email: string;
  host: string;
  loginName: string;
  password: string;
}

export function makeAccount(id: AccountId, email: string, password: string): Account {
  const service = SERVICES[id];
  return { id, label: service.label, email, host: service.host, loginName: service.loginName(email), password };
}

export function envKeys(id: AccountId): { email: string; password: string } {
  const { envPrefix } = SERVICES[id];
  return { email: `${envPrefix}_EMAIL`, password: `${envPrefix}_APP_PASSWORD` };
}

export interface LoadedAccounts {
  accounts: Account[];
  warnings: string[];
}

export function loadAccounts(env: NodeJS.ProcessEnv): LoadedAccounts {
  const accounts: Account[] = [];
  const warnings: string[] = [];
  for (const id of ACCOUNT_IDS) {
    const { label } = SERVICES[id];
    const keys = envKeys(id);
    const email = env[keys.email]?.trim();
    const password = env[keys.password]?.trim();
    if (!email && !password) continue;
    if (!email || !password) {
      warnings.push(`${label}: ${keys.email}과 ${keys.password}를 둘 다 넣어야 합니다. 이 계정은 건너뜁니다.`);
      continue;
    }
    if (!email.includes('@')) {
      warnings.push(`${label}: ${keys.email}에는 메일 주소 전체를 넣어야 합니다. 이 계정은 건너뜁니다.`);
      continue;
    }
    accounts.push(makeAccount(id, email, password));
  }
  return { accounts, warnings };
}

function envKeysText(id: AccountId): string {
  const keys = envKeys(id);
  return `${keys.email}, ${keys.password}`;
}

export function notConfiguredMessage(id: AccountId): string {
  return `${SERVICES[id].label} 계정이 설정되지 않았습니다. 터미널에서 npx -y @cpal1828/korean-mail-mcp setup을 실행하거나 환경변수 ${envKeysText(id)}를 넣어 다시 등록해 주세요.`;
}

export function noAccountsMessage(): string {
  return '설정된 메일 계정이 없습니다. 터미널에서 npx -y @cpal1828/korean-mail-mcp setup을 실행해 계정을 등록해 주세요.';
}
