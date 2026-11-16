import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName, uniqueSavePath } from '../src/files/names.js';

const RLO = '\u202E';
const TAG_A = '\u{E0041}';

describe('sanitizeFileName', () => {
  it.each([
    ['..\\..\\windows\\system32\\evil.pdf', 'evil.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['a:b*c?.txt', 'a_b_c_.txt'],
    ['a\u2028- 첨부\n9개.exe', 'a_- 첨부_9개.exe'],
    ['CON.txt', '_CON.txt'],
    ['nul', '_nul'],
    ['COM¹.txt', '_COM¹.txt'],
    ['CONSOLE.txt', 'CONSOLE.txt'],
    ['견적서.pdf. . ', '견적서.pdf'],
    ['  견적서.pdf', '견적서.pdf'],
    ['견적서.pdf', '견적서.pdf'],
  ])('%j → %j', (given, expected) => {
    expect(sanitizeFileName(given, 1, 'application/octet-stream')).toBe(expected);
  });

  it('글자 방향을 뒤집는 글자를 지워 실제 확장자가 보이게 한다', () => {
    // 화면에는 「견적서exe.pdf」로 보이지만 실제 확장자는 .exe다
    expect(sanitizeFileName(`견적서${RLO}fdp.exe`, 1, 'application/pdf')).toBe('견적서fdp.exe');
  });

  it('너비 없는 글자·태그 문자·한글 채움 글자를 지운다', () => {
    expect(sanitizeFileName(`견\u200B적\uFEFF서${TAG_A}\u3164.pdf`, 1, 'application/pdf')).toBe('견적서.pdf');
  });

  it('맥에서 온 NFD 한글을 NFC로 맞춘다', () => {
    const result = sanitizeFileName('견적서.pdf'.normalize('NFD'), 1, 'application/pdf');
    expect(result).toBe('견적서.pdf');
    expect(result.length).toBe('견적서.pdf'.length);
  });

  it('점으로 시작하는 이름은 앞에 _를 붙여 설정 파일로 저장되지 않게 한다', () => {
    expect(sanitizeFileName('.gitconfig', 1, 'text/plain')).toBe('_.gitconfig');
    expect(sanitizeFileName('..\\.bashrc', 1, 'text/plain')).toBe('_.bashrc');
    expect(sanitizeFileName('보고서.pdf', 1, 'application/pdf')).toBe('보고서.pdf');
  });

  it('비면 첨부N에 형식의 확장자를 붙인다', () => {
    expect(sanitizeFileName(undefined, 3, 'image/png')).toBe('첨부3.png');
    expect(sanitizeFileName('...', 2, 'text/calendar')).toBe('첨부2.ics');
    expect(sanitizeFileName('dir/', 4, 'Application/PDF')).toBe('첨부4.pdf');
    expect(sanitizeFileName(RLO, 5, 'application/x-unknown')).toBe('첨부5');
  });

  it('100자를 넘으면 확장자를 살려 자른다', () => {
    const result = sanitizeFileName(`${'가'.repeat(150)}.xlsx`, 1, 'application/octet-stream');
    expect(result).toBe(`${'가'.repeat(95)}.xlsx`);
  });

  it('자른 끝의 점·공백을 떼고, 두 칸짜리 글자를 반으로 가르지 않는다', () => {
    expect(sanitizeFileName(`${'a'.repeat(94)}. ${'b'.repeat(10)}.pdf`, 1, '')).toBe(`${'a'.repeat(94)}.pdf`);
    const emoji = sanitizeFileName(`${'a'.repeat(95)}😀😀.pdf`, 1, '');
    expect(emoji).toBe(`${'a'.repeat(95)}.pdf`);
  });

  it('연속 공백을 하나로 줄여 확장자를 밀어내지 못하게 한다', () => {
    expect(sanitizeFileName('견적서.pdf        .exe', 1, '')).toBe('견적서.pdf .exe');
    expect(sanitizeFileName('a  　 b.txt', 1, '')).toBe('a b.txt');
  });

  it('점·공백이 수만 개인 이름도 빨리 끝난다', () => {
    const started = Date.now();
    expect(sanitizeFileName(`${'.'.repeat(100_000)}a`, 1, '')).toBe('첨부1');
    expect(sanitizeFileName(`a${'. '.repeat(100_000)}`, 1, '')).toBe('a');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('정리하기 전에 1,000자로 먼저 자른다', () => {
    const result = sanitizeFileName(`${'가'.repeat(1_200)}.exe`, 1, '');
    expect(result).toBe('가'.repeat(100));
  });

  it('너무 긴 확장자는 확장자로 보지 않고 그냥 자른다', () => {
    const result = sanitizeFileName(`name.${'x'.repeat(150)}`, 1, '');
    expect(result).toBe(`name.${'x'.repeat(95)}`);
  });
});

describe('uniqueSavePath', () => {
  const dir = join('C:', 'Users', 'me', 'Downloads');

  it('같은 이름이 없으면 그대로', () => {
    expect(uniqueSavePath(dir, '견적서.pdf', () => false)).toBe(join(dir, '견적서.pdf'));
  });

  it('같은 이름이 있으면 (1), (2) … 를 확장자 앞에 붙인다', () => {
    const taken = new Set([join(dir, '견적서.pdf'), join(dir, '견적서 (1).pdf')]);
    expect(uniqueSavePath(dir, '견적서.pdf', (path) => taken.has(path))).toBe(join(dir, '견적서 (2).pdf'));
  });

  it('확장자가 없거나 점으로 시작하는 이름은 끝에 붙인다', () => {
    const taken = new Set([join(dir, 'README'), join(dir, '.env')]);
    const exists = (path: string) => taken.has(path);
    expect(uniqueSavePath(dir, 'README', exists)).toBe(join(dir, 'README (1)'));
    expect(uniqueSavePath(dir, '.env', exists)).toBe(join(dir, '.env (1)'));
  });

  it('겹친 확장자는 마지막 확장자 앞에 붙인다', () => {
    const taken = new Set([join(dir, 'backup.tar.gz')]);
    expect(uniqueSavePath(dir, 'backup.tar.gz', (path) => taken.has(path))).toBe(join(dir, 'backup.tar (1).gz'));
  });
});
