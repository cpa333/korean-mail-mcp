import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPath, isExecutableName, markAsDownloaded, type PathSystem } from '../src/files/paths.js';

const WINDOWS: PathSystem = {
  platform: 'win32',
  home: 'C:\\Users\\me',
  env: {
    USERPROFILE: 'C:\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    SystemRoot: 'C:\\WINDOWS',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
  },
};
const MAC: PathSystem = { platform: 'darwin', home: '/Users/me', env: {} };
const LINUX: PathSystem = { platform: 'linux', home: '/home/me', env: {} };

const reasonOf = (target: string, system: PathSystem) => checkPath(target, system).blockedReason;

describe('checkPath — Windows', () => {
  it.each([
    'C:\\Users\\me\\Downloads',
    'C:\\Users\\me\\Documents\\견적\\견적서.pdf',
    'd:/작업/보고서.xlsx',
    'C:\\',
  ])('일반 위치는 허용한다: %s', (target) => {
    expect(reasonOf(target, WINDOWS)).toBeUndefined();
  });

  it.each([
    '\\\\attacker.example\\share',
    '\\\\?\\C:\\Users\\me\\Downloads',
    '\\\\.\\PhysicalDrive0',
    '//attacker.example/share',
    '/\\attacker.example\\share',
  ])('네트워크·장치 경로를 막는다: %s', (target) => {
    expect(reasonOf(target, WINDOWS)).toBe('네트워크·장치 경로');
  });

  it('드라이브 문자가 없는 루트 경로를 막는다', () => {
    expect(reasonOf('\\Users\\me\\Downloads', WINDOWS)).toBe('드라이브 문자가 없는 경로');
    expect(reasonOf('/Users/me/Downloads', WINDOWS)).toBe('드라이브 문자가 없는 경로');
  });

  it('시작프로그램 폴더는 앱 데이터·시스템 폴더보다 구체적인 이유로 알린다', () => {
    expect(reasonOf('C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', WINDOWS)).toBe(
      '시작프로그램 폴더',
    );
    expect(reasonOf('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\a.bat', WINDOWS)).toBe(
      '시작프로그램 폴더',
    );
  });

  it.each([
    'C:\\Windows\\System32',
    'C:\\Program Files\\App',
    'C:\\Program Files (x86)',
    'C:\\ProgramData\\App\\config.ini',
  ])('시스템 폴더를 막는다: %s', (target) => {
    expect(reasonOf(target, WINDOWS)).toBe('시스템 폴더');
  });

  it.each([
    'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data',
    'C:\\Users\\me\\AppData\\Local',
    'C:\\Users\\me\\AppData\\LocalLow\\Sun\\Java',
    'C:\\Users\\me\\AppData',
    'C:\\Users\\me\\AppData\\a.txt',
  ])('앱 데이터 폴더를 막는다: %s', (target) => {
    expect(reasonOf(target, WINDOWS)).toBe('앱 데이터 폴더');
  });

  it('대소문자와 ..를 무시하고 정규화한 경로로 비교한다', () => {
    expect(reasonOf('c:\\users\\ME\\appdata\\LOCAL\\x', WINDOWS)).toBe('앱 데이터 폴더');
    expect(reasonOf('C:\\Users\\me\\Downloads\\..\\AppData\\Roaming\\x', WINDOWS)).toBe('앱 데이터 폴더');
    expect(checkPath('C:\\Users\\me\\Downloads\\..\\AppData\\Roaming\\x', WINDOWS).path).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\x',
    );
  });

  it('이름이 비슷할 뿐 다른 폴더는 막지 않는다', () => {
    expect(reasonOf('C:\\Program Files Backup\\a.txt', WINDOWS)).toBeUndefined();
    expect(reasonOf('C:\\WindowsApps-export', WINDOWS)).toBeUndefined();
  });

  it.each([
    'C:\\Users\\me\\.ssh\\id_ed25519',
    'C:\\Users\\me\\.claude',
    'C:\\Users\\me\\project\\.git\\hooks',
    'C:\\Users\\me\\.aws\\credentials',
    'C:\\Users\\me\\project\\.env',
  ])('점으로 시작하는 폴더나 파일을 막는다: %s', (target) => {
    expect(reasonOf(target, WINDOWS)).toBe('점으로 시작하는 폴더나 파일');
  });

  it('USERPROFILE이 없으면 LOCALAPPDATA의 상위 폴더로 AppData 전체를 막는다', () => {
    const { USERPROFILE: _, ...withoutProfile } = WINDOWS.env;
    expect(reasonOf('C:\\Users\\me\\AppData\\LocalLow\\x', { ...WINDOWS, env: withoutProfile })).toBe('앱 데이터 폴더');
  });

  it('상위 폴더 이름이 AppData가 아니면 APPDATA·LOCALAPPDATA만 막는다', () => {
    const redirected = { APPDATA: 'D:\\Profiles\\me\\Roaming', LOCALAPPDATA: 'D:\\Profiles\\me\\Local' };
    const system: PathSystem = { ...WINDOWS, env: redirected };
    expect(reasonOf('D:\\Profiles\\me\\Roaming\\x', system)).toBe('앱 데이터 폴더');
    expect(reasonOf('D:\\Profiles\\me\\문서\\x', system)).toBeUndefined();
  });

  it('APPDATA가 AppData 밖으로 옮겨져 있어도 막는다', () => {
    const system: PathSystem = { ...WINDOWS, env: { ...WINDOWS.env, APPDATA: 'D:\\Redirected\\Roaming' } };
    expect(reasonOf('D:\\Redirected\\Roaming\\x', system)).toBe('앱 데이터 폴더');
  });

  it('환경변수가 없는 위치는 건너뛴다', () => {
    expect(reasonOf('C:\\Windows\\System32', { ...WINDOWS, env: {} })).toBeUndefined();
  });
});

describe('checkPath — macOS·Linux', () => {
  it('일반 위치는 허용한다', () => {
    expect(reasonOf('/Users/me/Downloads', MAC)).toBeUndefined();
    expect(reasonOf('/home/me/Documents/a.pdf', LINUX)).toBeUndefined();
  });

  it('시작프로그램 폴더를 막는다', () => {
    expect(reasonOf('/Users/me/Library/LaunchAgents/x.plist', MAC)).toBe('시작프로그램 폴더');
    expect(reasonOf('/home/me/.config/autostart/x.desktop', LINUX)).toBe('시작프로그램 폴더');
  });

  it.each(['/etc', '/usr/local/bin', '/bin', '/sbin', '/System/Library', '/Library/LaunchDaemons'])(
    '시스템 폴더를 막는다: %s',
    (target) => {
      expect(reasonOf(target, MAC)).toBe('시스템 폴더');
      expect(reasonOf(target, LINUX)).toBe('시스템 폴더');
    },
  );

  it('macOS ~/Library를 앱 데이터 폴더로 막는다', () => {
    expect(reasonOf('/Users/me/Library/Application Support/Google/Chrome', MAC)).toBe('앱 데이터 폴더');
  });

  it('점으로 시작하는 폴더와 //로 시작하는 경로를 막는다', () => {
    expect(reasonOf('/home/me/.ssh/id_rsa', LINUX)).toBe('점으로 시작하는 폴더나 파일');
    expect(reasonOf('/Users/me/.zshrc', MAC)).toBe('점으로 시작하는 폴더나 파일');
    expect(reasonOf('//server/share', LINUX)).toBe('네트워크·장치 경로');
  });
});

describe('checkPath — 실제 위치로 다시 검사', () => {
  // 2026-11-16 재현: 글자만 보면 짧은 별명(SSH~1 = .ssh)과 시스템 연결 폴더(Application Data)를 놓쳤다.
  const realPaths: Record<string, string> = {
    'c:\\users\\me\\ssh~1\\id_rsa': 'C:\\Users\\me\\.ssh\\id_rsa',
    'c:\\users\\me\\application data\\x': 'C:\\Users\\me\\AppData\\Roaming\\x',
  };
  const withRealPath: PathSystem = { ...WINDOWS, realPath: (path) => realPaths[path.toLowerCase()] };

  it('짧은 별명으로 점 폴더 규칙을 피하지 못한다', () => {
    expect(reasonOf('C:\\Users\\me\\SSH~1\\id_rsa', withRealPath)).toBe('점으로 시작하는 폴더나 파일');
  });

  it('시스템 연결 폴더로 앱 데이터 규칙을 피하지 못한다', () => {
    expect(reasonOf('C:\\Users\\me\\Application Data\\x', withRealPath)).toBe('앱 데이터 폴더');
  });

  it('실제 위치가 일반 폴더면 허용한다', () => {
    expect(reasonOf('C:\\Users\\me\\Downloads\\a.pdf', withRealPath)).toBeUndefined();
  });
});

describe('checkPath — 매핑 네트워크 드라이브', () => {
  // 사용자가 연결한 드라이브(Z:\)는 실제 위치가 \\서버\공유로 풀린다.
  const mapped: PathSystem = { ...WINDOWS, realPath: (path) => path.replace(/^z:/i, '\\\\fileserver\\share') };

  it('드라이브 문자로 연결한 네트워크 드라이브는 허용한다', () => {
    expect(reasonOf('Z:\\보고서', mapped)).toBeUndefined();
    expect(checkPath('Z:\\보고서\\견적서.pdf', mapped).path).toBe('Z:\\보고서\\견적서.pdf');
  });

  it('네트워크 규칙 말고 나머지 규칙은 그대로 적용한다', () => {
    expect(reasonOf('Z:\\.ssh\\x', mapped)).toBe('점으로 시작하는 폴더나 파일');
    const hiddenOnServer: PathSystem = { ...WINDOWS, realPath: () => '\\\\fileserver\\share\\.git\\x' };
    expect(reasonOf('Z:\\작업\\x', hiddenOnServer)).toBe('점으로 시작하는 폴더나 파일');
  });

  it('네트워크 경로를 직접 입력하면 그대로 막는다', () => {
    expect(reasonOf('\\\\fileserver\\share\\보고서', mapped)).toBe('네트워크·장치 경로');
    expect(reasonOf('//fileserver/share/보고서', mapped)).toBe('네트워크·장치 경로');
  });

  it('장치 경로로 풀리면 막는다', () => {
    const device: PathSystem = { ...WINDOWS, realPath: () => '\\\\.\\PhysicalDrive0' };
    expect(reasonOf('Z:\\x', device)).toBe('네트워크·장치 경로');
  });
});

describe('checkPath — 지금 PC', () => {
  it('운영체제가 알려 주는 홈 폴더로 계산한다', () => {
    expect(checkPath(join(homedir(), 'Downloads')).blockedReason).toBeUndefined();
    expect(checkPath(join(homedir(), '.ssh', 'id_rsa')).blockedReason).toBe('점으로 시작하는 폴더나 파일');
  });

  // 짧은 별명은 PC 설정에 따라 없을 수 있어, 있을 때만 확인한다.
  const shortSsh = join(homedir(), 'SSH~1');
  it.runIf(process.platform === 'win32' && existsSync(shortSsh))('Windows 짧은 별명 경로도 막는다', () => {
    expect(checkPath(join(shortSsh, 'id_rsa')).blockedReason).toBe('점으로 시작하는 폴더나 파일');
  });

  const legacyAppData = join(homedir(), 'Application Data');
  it.runIf(process.platform === 'win32' && existsSync(legacyAppData))('Windows 연결 폴더 경로도 막는다', () => {
    expect(checkPath(join(legacyAppData, 'x.txt')).blockedReason).toBe('앱 데이터 폴더');
  });
});

describe('isExecutableName', () => {
  it.each(['setup.exe', 'RUN.BAT', 'a.ps1', 'invoice.pdf.js', 'link.lnk', 'x.url', 'tool.jar', 'run.sh', 'Mac.app'])(
    '실행 파일: %s',
    (name) => {
      expect(isExecutableName(name)).toBe(true);
    },
  );

  it.each(['문서.library-ms', 'search.searchConnector-ms', 'disk.ISO', 'disk.img', 'disk.vhd', 'disk.vhdx'])(
    '열기만 해도 위험한 파일과 디스크 이미지: %s',
    (name) => {
      expect(isExecutableName(name)).toBe(true);
    },
  );

  it.each(['desktop.ini', 'Desktop.INI', 'desktop.ini. '])('폴더 설정 파일: %s', (name) => {
    expect(isExecutableName(name)).toBe(true);
  });

  it('끝의 공백·점을 떼고 판정한다', () => {
    expect(isExecutableName('setup.exe. . ')).toBe(true);
    expect(isExecutableName('setup.EXE...')).toBe(true);
  });

  it.each(['견적서.pdf', '자료.zip', '보고서.xlsx', 'exe', 'script.json', 'archive.7z', '이름 없음', 'my-desktop.ini', 'desktop.ini.txt'])('실행 파일 아님: %s', (name) => {
    expect(isExecutableName(name)).toBe(false);
  });
});

describe('markAsDownloaded', () => {
  const missing = join(homedir(), 'korean-mail-mcp-test-missing-folder', 'a.pdf');

  it('Windows가 아니면 아무것도 쓰지 않는다', () => {
    expect(markAsDownloaded(missing, 'linux')).toBeUndefined();
    expect(markAsDownloaded(missing, 'darwin')).toBeUndefined();
  });

  it('표시를 붙이지 못하면 오류 코드를 돌려준다(저장은 그대로 둔다)', () => {
    expect(existsSync(missing)).toBe(false);
    expect(markAsDownloaded(missing, 'win32')).toBeTypeOf('string');
  });
});
