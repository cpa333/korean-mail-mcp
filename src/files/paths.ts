import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, win32, type PlatformPath } from 'node:path';

/** 경로 규칙을 계산할 운영체제 정보. 테스트에서 다른 운영체제의 규칙을 검사할 수 있게 주입한다. */
export interface PathSystem {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** 경로의 실제 위치. 짧은 별명(`SSH~1`)·연결 폴더를 푼다. 알 수 없으면 undefined. */
  realPath?: (path: string) => string | undefined;
}

export interface PathCheck {
  /** 정규화한 전체 경로 */
  path: string;
  /** 경로 규칙에 걸린 이유. 걸리지 않으면 없다. */
  blockedReason?: string;
}

interface BlockedLocation {
  root: string;
  reason: string;
}

const REASON_NETWORK = '네트워크·장치 경로';
const REASON_NO_DRIVE = '드라이브 문자가 없는 경로';
const REASON_STARTUP = '시작프로그램 폴더';
const REASON_SYSTEM = '시스템 폴더';
const REASON_APP_DATA = '앱 데이터 폴더';
const REASON_DOT = '점으로 시작하는 폴더나 파일';

// `\\서버\공유`, `\\?\`, `\\.\`. Windows는 `/`도 구분자로 보므로 `//`, `/\`도 같다.
const NETWORK_PREFIX = /^[\\/]{2}/;
// `\\서버\공유`만. `\\?\`·`\\.\`는 네트워크가 아니라 장치 경로라 매핑 드라이브 예외에 넣지 않는다.
const NETWORK_SHARE_PREFIX = /^[\\/]{2}(?![?.][\\/])/;
const WINDOWS_DRIVE_ROOT = /^[a-z]:[\\/]/i;
const STARTUP_SUBPATH = ['Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'];
const APP_DATA_FOLDER = 'AppData';
const UNIX_SYSTEM_ROOTS = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library'];

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.scr',
  '.pif', '.cpl', '.msi', '.msp', '.msc', '.lnk', '.url', '.reg', '.jar', '.scf', '.appx', '.msix', '.sh',
  '.command', '.app', '.library-ms', '.searchconnector-ms', '.iso', '.img', '.vhd', '.vhdx',
]);
// 확장자가 아니라 이름으로 막는다. 탐색기가 폴더를 보여 주기만 해도 읽어 외부 서버로 인증 정보를 보낼 수 있다 (PRD §8-1).
const FOLDER_SETTINGS_FILE = 'desktop.ini';

// 브라우저가 인터넷에서 받은 파일에 붙이는 것과 같은 표시. ZoneId=3은 인터넷 영역이다.
const ZONE_IDENTIFIER_STREAM = ':Zone.Identifier';
const ZONE_IDENTIFIER_CONTENT = '[ZoneTransfer]\r\nZoneId=3\r\n';

export function currentPathSystem(): PathSystem {
  return { platform: process.platform, home: homedir(), env: process.env, realPath: realPathOfNearestExisting };
}

/**
 * 첨부 저장 폴더와 초안 첨부 파일에 같은 규칙을 적용한다 (PRD §8-1).
 * 특정 PC의 경로가 아니라 실행할 때 운영체제가 알려 주는 위치로 계산한다.
 */
export function checkPath(target: string, system: PathSystem = currentPathSystem()): PathCheck {
  const p = system.platform === 'win32' ? win32 : posix;
  const path = p.resolve(target);
  const literal = networkReasonOf(target, system) ?? locationReasonOf(path, system, p);
  if (literal) return { path, blockedReason: literal };

  // 글자만 보면 `C:\Users\me\SSH~1`(= `.ssh`)이나 `Application Data`(= `AppData\Roaming`)를 놓친다 (2026-11-16 재현).
  const real = system.realPath?.(path);
  if (real && real.toLowerCase() !== path.toLowerCase()) {
    // 여기까지 온 입력은 드라이브 문자 경로다. 그것이 네트워크 공유로 풀리면 사용자가 직접 연결한
    // 매핑 네트워크 드라이브(`Z:\`)라 공격자가 서버를 고를 수 없으므로 네트워크 규칙만 뺀다 (PRD §8-1).
    const mappedDrive = system.platform === 'win32' && NETWORK_SHARE_PREFIX.test(real);
    const network = mappedDrive ? undefined : networkReasonOf(real, system);
    const reason = network ?? locationReasonOf(p.resolve(real), system, p);
    if (reason) return { path, blockedReason: reason };
  }
  return { path };
}

function networkReasonOf(raw: string, system: PathSystem): string | undefined {
  if (NETWORK_PREFIX.test(raw)) return REASON_NETWORK;
  // `\foo`는 Windows가 절대 경로로 보지만 현재 드라이브에 따라 가리키는 곳이 달라진다.
  if (system.platform === 'win32' && !WINDOWS_DRIVE_ROOT.test(raw)) return REASON_NO_DRIVE;
  return undefined;
}

function locationReasonOf(path: string, system: PathSystem, p: PlatformPath): string | undefined {
  const location = blockedLocations(system, p).find((l) => isInside(path, l.root, p));
  if (location) return location.reason;
  if (hasDotSegment(path, p)) return REASON_DOT;
  return undefined;
}

/** 저장할 폴더는 아직 없을 수 있으므로, 실제로 있는 가장 가까운 상위 폴더를 풀고 나머지를 붙인다. */
function realPathOfNearestExisting(path: string): string | undefined {
  const rest: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync.native(current), ...rest);
  } catch {
    // 실제 위치를 알 수 없으면 글자 검사 결과만 쓴다(권한 없는 폴더 등).
    return undefined;
  }
}

function blockedLocations(system: PathSystem, p: PlatformPath): BlockedLocation[] {
  if (system.platform === 'win32') return windowsLocations(system.env);
  const locations = UNIX_SYSTEM_ROOTS.map((root) => ({ root, reason: REASON_SYSTEM }));
  if (system.platform === 'darwin') {
    return [
      { root: p.join(system.home, 'Library', 'LaunchAgents'), reason: REASON_STARTUP },
      ...locations,
      { root: p.join(system.home, 'Library'), reason: REASON_APP_DATA },
    ];
  }
  return [{ root: p.join(system.home, '.config', 'autostart'), reason: REASON_STARTUP }, ...locations];
}

/** 이유가 구체적인 것부터 둔다. 시작프로그램 폴더는 앱 데이터·시스템 폴더 안에 있다. */
function windowsLocations(env: PathSystem['env']): BlockedLocation[] {
  const startup = [env.APPDATA, env.ProgramData].map((base) => base && win32.join(base, ...STARTUP_SUBPATH));
  const system = [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData];
  // APPDATA·LOCALAPPDATA는 폴더 리디렉션으로 AppData 밖에 있을 수 있어 함께 막는다.
  const appData = [appDataRoot(env), env.APPDATA, env.LOCALAPPDATA];
  return [
    ...locationsOf(startup, REASON_STARTUP),
    ...locationsOf(system, REASON_SYSTEM),
    ...locationsOf(appData, REASON_APP_DATA),
  ];
}

/**
 * `%USERPROFILE%\AppData` 전체. LocalLow는 가리키는 환경변수가 없어 상위 폴더로 막는다.
 * USERPROFILE이 없으면 LOCALAPPDATA·APPDATA의 상위 폴더 중 이름이 AppData인 것을 쓴다.
 */
function appDataRoot(env: PathSystem['env']): string | undefined {
  if (env.USERPROFILE) return win32.join(env.USERPROFILE, APP_DATA_FOLDER);
  const parents = [env.LOCALAPPDATA, env.APPDATA].map((dir) => dir && win32.dirname(win32.resolve(dir)));
  return parents.find((parent) => parent && win32.basename(parent).toLowerCase() === APP_DATA_FOLDER.toLowerCase());
}

// 환경변수가 없는 PC에서는 그 위치를 계산할 수 없으므로 건너뛴다.
function locationsOf(roots: (string | undefined)[], reason: string): BlockedLocation[] {
  return roots.filter((root): root is string => Boolean(root)).map((root) => ({ root, reason }));
}

function isInside(path: string, root: string, p: PlatformPath): boolean {
  const target = path.toLowerCase();
  const base = p.resolve(root).toLowerCase();
  if (target === base) return true;
  return target.startsWith(base.endsWith(p.sep) ? base : base + p.sep);
}

function hasDotSegment(path: string, p: PlatformPath): boolean {
  return path.split(p.sep).some((segment) => segment.startsWith('.'));
}

/** 끝의 공백·점을 떼고(Windows가 떼어 내고 저장하므로) 확장자를 대소문자 없이 본다 (PRD §8-1). */
export function isExecutableName(fileName: string): boolean {
  let end = fileName.length;
  while (end > 0 && (fileName[end - 1] === ' ' || fileName[end - 1] === '.')) end--;
  const name = fileName.slice(0, end).toLowerCase();
  if (name === FOLDER_SETTINGS_FILE) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && EXECUTABLE_EXTENSIONS.has(name.slice(dot));
}

/**
 * Windows에서 저장한 파일에 "인터넷에서 받은 파일" 표시를 붙인다 (PRD §6-5).
 * 붙이지 못하면(FAT32·네트워크 드라이브 등) 저장은 유지해야 하므로 오류 코드를 돌려준다. 붙였거나 붙일 대상이 아니면 undefined.
 */
export function markAsDownloaded(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined;
  try {
    writeFileSync(path + ZONE_IDENTIFIER_STREAM, ZONE_IDENTIFIER_CONTENT);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error);
  }
}
