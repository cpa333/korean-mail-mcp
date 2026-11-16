export const SERVICE_IDS = ['naver', 'daum'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export interface Service {
  label: string;
  envPrefix: string;
  host: string;
  loginName: (email: string) => string;
  /** setup이 받는 메일 주소의 도메인. 다른 서비스 주소의 아이디로 이 서비스에 비밀번호를 보내지 않게 한다 (PRD §3-1) */
  domains: string[];
  /** setup이 보여 주는 준비 단계 (PRD §3-1 안내 문구) */
  setupSteps: string[];
  guideUrl: string;
  /** 로그인이 거절됐을 때 덧붙이는 서비스별 안내 */
  authHint: string;
}

const SERVICES: Record<ServiceId, Service> = {
  naver: {
    label: '네이버',
    envPrefix: 'NAVER',
    host: 'imap.naver.com',
    // 네이버 IMAP 로그인 이름은 아이디만이다. 05 프로젝트에서 이 형식으로 접속을 실측했다.
    loginName: (email) => email.split('@')[0],
    domains: ['naver.com'],
    setupSteps: [
      "1. IMAP 켜기: 네이버 메일 → 환경설정 → POP3/IMAP 설정 → IMAP/SMTP 사용 → '사용함'",
      '2. 앱 비밀번호 만들기(2단계 인증이 꺼져 있으면 먼저 켭니다):',
      "   네이버 내정보 → 보안설정 → 2단계 인증 '관리' → 애플리케이션 비밀번호 관리",
      "   → '직접 입력'에 10자 이내 이름(예: mailmcp) → 생성. 비밀번호는 한 번만 표시되므로 바로 복사해 주세요.",
    ],
    guideUrl: 'https://help.naver.com/service/5640/contents/8584?osType=COMMONOS',
    authHint: '네이버 로그인 비밀번호가 아니라 애플리케이션 비밀번호를 넣었는지, IMAP을 사용함으로 설정했는지 확인해 주세요.',
  },
  daum: {
    label: '다음',
    envPrefix: 'DAUM',
    host: 'imap.daum.net',
    loginName: (email) => email,
    domains: ['hanmail.net', 'daum.net'],
    setupSteps: [
      "1. IMAP 켜기: 다음 메일 → 환경설정 → IMAP/POP3 → IMAP/SMTP 사용 → '사용함' → 저장",
      '2. 앱 비밀번호 만들기: 다음 회원 → 마이페이지 → 계정 보안 → 앱 비밀번호',
      '   → 휴대폰 2차 인증 → 이름 입력(예: mailmcp) → 생성. 비밀번호는 한 번만 표시되므로 바로 복사해 주세요.',
      '   (2025-12-01부터 다음 메일 앱 비밀번호는 여기서만 만듭니다. 카카오계정에서 만든 비밀번호는 사용할 수 없습니다)',
    ],
    guideUrl: 'https://cs.daum.net/faq/43/9234.html?faqId=31143',
    authHint: '다음 회원 마이페이지에서 만든 앱 비밀번호인지(카카오계정에서 만든 비밀번호는 사용할 수 없습니다), IMAP을 사용함으로 설정했는지 확인해 주세요.',
  },
};

const FIRST_SLOT = 1;
// NAVER_EMAIL(첫 계정), NAVER_2_EMAIL, NAVER_3_EMAIL … (PRD §4)
const EMAIL_KEY = /^([A-Z]+)(?:_(\d+))?_EMAIL$/;

export function serviceOf(id: ServiceId): Service {
  return SERVICES[id];
}

export interface Account {
  service: ServiceId;
  /** 환경변수 번호. 1이면 번호 없는 키 */
  slot: number;
  email: string;
  /** 오류·목록에 쓰는 이름, 예: "네이버 me@naver.com" */
  label: string;
  host: string;
  loginName: string;
  password: string;
}

export function makeAccount(service: ServiceId, email: string, password: string, slot = FIRST_SLOT): Account {
  const s = SERVICES[service];
  return { service, slot, email, label: `${s.label} ${email}`, host: s.host, loginName: s.loginName(email), password };
}

export function envKeys(service: ServiceId, slot: number): { email: string; password: string } {
  const base = slot === FIRST_SLOT ? SERVICES[service].envPrefix : `${SERVICES[service].envPrefix}_${slot}`;
  return { email: `${base}_EMAIL`, password: `${base}_APP_PASSWORD` };
}

function serviceByPrefix(prefix: string): ServiceId | undefined {
  return SERVICE_IDS.find((id) => SERVICES[id].envPrefix === prefix);
}

export interface LoadedAccounts {
  accounts: Account[];
  warnings: string[];
}

export function loadAccounts(env: Record<string, string | undefined>): LoadedAccounts {
  const accounts: Account[] = [];
  const warnings: string[] = [];
  for (const key of Object.keys(env)) {
    const match = key.match(EMAIL_KEY);
    const service = match ? serviceByPrefix(match[1]) : undefined;
    if (!match || !service) continue;
    const slot = match[2] ? Number(match[2]) : FIRST_SLOT;
    const keys = envKeys(service, slot);
    const email = env[keys.email]?.trim();
    const password = env[keys.password]?.trim();
    const duplicate = email ? accounts.find((a) => sameEmail(a.email, email)) : undefined;
    if (!email || !password) {
      warnings.push(`다음 두 값을 모두 넣어야 합니다: ${keys.email}, ${keys.password}. 이 계정은 건너뜁니다.`);
    } else if (!email.includes('@')) {
      warnings.push(`메일 주소 전체를 넣어야 합니다: ${keys.email}. 이 계정은 건너뜁니다.`);
    } else if (duplicate) {
      // 시작 경고는 로그로 남으므로 메일 주소 대신 환경변수 키 이름만 쓴다 (PRD §8).
      const firstKey = envKeys(duplicate.service, duplicate.slot).email;
      warnings.push(`같은 메일 주소가 두 번 설정되어 있습니다: ${firstKey}, ${keys.email}. 뒤의 항목은 건너뜁니다.`);
    } else {
      accounts.push(makeAccount(service, email, password, slot));
    }
  }
  accounts.sort((a, b) => SERVICE_IDS.indexOf(a.service) - SERVICE_IDS.indexOf(b.service) || a.slot - b.slot);
  return { accounts, warnings };
}

export function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** 이 서비스에서 비어 있는 가장 작은 번호 (PRD §4) */
export function nextFreeSlot(accounts: Account[], service: ServiceId): number {
  const used = new Set(accounts.filter((a) => a.service === service).map((a) => a.slot));
  let slot = FIRST_SLOT;
  while (used.has(slot)) slot += 1;
  return slot;
}

export function accountList(accounts: Account[]): string {
  return accounts.map((a) => `${a.email}(${SERVICES[a.service].label})`).join(', ');
}

// 명령은 문장 끝에 두고 마침표를 붙이지 않는다(복사할 때 따라 들어가지 않게).
const SETUP_COMMAND = 'npx -y @cpal1828/korean-mail-mcp@latest setup';

export function unknownAccountMessage(email: string, accounts: Account[]): string {
  return `설정되지 않은 계정입니다: ${email}. 설정된 계정: ${accountList(accounts)}. 계정을 추가하려면 터미널에서 다음 명령을 실행해 주세요: ${SETUP_COMMAND}`;
}

export function noAccountsMessage(): string {
  return `설정된 메일 계정이 없습니다. 터미널에서 다음 명령을 실행해 계정을 등록해 주세요: ${SETUP_COMMAND}`;
}
