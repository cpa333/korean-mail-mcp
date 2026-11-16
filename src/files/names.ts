import { join } from 'node:path';

const MAX_NAME_LENGTH = 100;
const MAX_RAW_NAME_LENGTH = 1_000;
// 일반 공백·NBSP·전각 공백 등이 둘 이상 이어진 것
const CONSECUTIVE_SPACES = /\s{2,}/g;
// 이보다 긴 "확장자"는 이름의 일부로 본다. 살리면 자를 때 이름이 거의 남지 않는다.
const MAX_EXTENSION_LENGTH = 20;
const FALLBACK_STEM = '첨부';

// Windows가 파일 이름에 받지 않는 글자(제어 문자 포함)와 줄을 가르는 글자.
// 줄 가르는 글자는 Windows가 받지만, 이름을 한 줄로 보여 줄 때 가짜 줄을 만든다.
const FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u0085\u2028\u2029]/g;

// 태그 문자·이체 선택자 보충, 너비 없는 글자, 방향 제어 글자, 한글 채움 글자.
// 방향 제어 글자는 `견적서<U+202E>fdp.exe`를 화면에 `견적서exe.pdf`로 보이게 해 실행 파일을 숨긴다.
const INVISIBLE_CHARACTERS =
  /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u200B-\u200D\u2060-\u2064\uFEFF\u180E\u00AD\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u3164\uFFA0\u115F\u1160]/gu;

// Windows가 확장자와 상관없이 장치로 여는 이름. 윗첨자 숫자도 같은 장치로 본다.
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'COM¹', 'COM²', 'COM³',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9', 'LPT¹', 'LPT²', 'LPT³',
]);

// 이름 없는 첨부에 붙일 확장자. 확장자가 있어야 받은 파일을 연결 프로그램과 AI가 알아본다.
const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/x-hwp': '.hwp',
  'application/haansofthwp': '.hwp',
  'application/vnd.hancom.hwp': '.hwp',
  'application/vnd.hancom.hwpx': '.hwpx',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/csv': '.csv',
  'text/calendar': '.ics',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
  'message/rfc822': '.eml',
};

/**
 * 메일이 준 첨부 이름을 PC에 저장할 수 있는 이름으로 다듬는다 (PRD §8).
 * `index`는 이름이 비었을 때 `첨부N`의 N이다.
 */
export function sanitizeFileName(name: string | undefined, index: number, contentType: string): string {
  // 보낸 쪽이 `..\..\windows\evil.exe`처럼 경로를 적어 보낼 수 있다
  // 아래 정리 단계가 이름 길이에 비례해 오래 걸리지 않게 먼저 자른다
  let result = sliceWhole(name ?? '', MAX_RAW_NAME_LENGTH).replaceAll('/', '\\');
  result = result.slice(result.lastIndexOf('\\') + 1);

  result = result.replace(FORBIDDEN_CHARACTERS, '_').replace(INVISIBLE_CHARACTERS, '');
  // 맥에서 온 한글은 자모가 갈라져(NFD) 있다
  result = result.normalize('NFC');
  // `견적서.pdf        .exe`처럼 공백을 늘어놓아 진짜 확장자를 화면 밖으로 밀어내지 못하게 한다
  result = result.replace(CONSECUTIVE_SPACES, ' ');
  // Windows는 끝의 점·공백을 조용히 떼어 내 저장한 이름과 알린 이름이 달라진다
  result = trimTrailingDotsAndSpaces(result.trim());

  if (result.length === 0) {
    return `${FALLBACK_STEM}${index}${EXTENSION_BY_TYPE[contentType.toLowerCase()] ?? ''}`;
  }

  if (isReserved(result)) {
    result = `_${result}`;
  }
  // `.gitconfig`·`.bashrc`처럼 프로그램이 읽는 설정 파일로 저장되지 않게 한다 (PRD §8-1)
  if (result.startsWith('.')) {
    result = `_${result}`;
  }

  return result.length > MAX_NAME_LENGTH ? shorten(result) : result;
}

/**
 * `dir`에 `fileName`으로 저장할 전체 경로. 이미 있으면 `이름 (1).확장자`, `이름 (2).확장자` … (PRD §6-5).
 * 대소문자를 가릴지는 `exists`(파일 시스템)에 맡긴다. Windows·macOS는 `A.pdf`가 있으면 `a.pdf`도 있다고 답한다.
 */
export function uniqueSavePath(dir: string, fileName: string, exists: (path: string) => boolean): string {
  const first = join(dir, fileName);
  if (!exists(first)) {
    return first;
  }

  const { stem, extension } = splitExtension(fileName);
  for (let n = 1; ; n++) {
    const candidate = join(dir, `${stem} (${n})${extension}`);
    if (!exists(candidate)) {
      return candidate;
    }
  }
}

function isReserved(name: string): boolean {
  const dot = name.indexOf('.');
  const stem = (dot < 0 ? name : name.slice(0, dot)).trimEnd();
  return RESERVED_NAMES.has(stem.toUpperCase());
}

/** 앞을 남기고 확장자 앞을 잘라 `MAX_NAME_LENGTH`에 맞춘다. */
function shorten(name: string): string {
  const split = splitExtension(name);
  const extension = split.extension.length > MAX_EXTENSION_LENGTH ? '' : split.extension;

  return trimTrailingDotsAndSpaces(sliceWhole(name, MAX_NAME_LENGTH - extension.length)) + extension;
}

/** 앞에서 `length`자까지 남긴다. 이모지 같은 두 칸짜리 글자를 반으로 가르지 않는다. */
function sliceWhole(text: string, length: number): string {
  const keep = /[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? length - 1 : length;
  return text.slice(0, keep);
}

// 정규식 `/[. ]+$/`는 점이 수만 개인 이름에서 제곱 시간이 걸린다(2026-11-16 재현).
function trimTrailingDotsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ' ')) {
    end--;
  }
  return text.slice(0, end);
}

/** `.bashrc`처럼 점으로 시작하는 이름은 확장자 없이 이름 전체를 이름으로 본다. */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}
