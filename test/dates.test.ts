import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownDate, parseDay, toLocalDisplay, toLocalIso } from '../src/dates.js';

// 시간대에 따라 결과가 달라지므로 한국 시간으로 고정해 검사한다.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Seoul';
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('날짜 표시', () => {
  // 2026-11-16 실측: 원본 Date 머리말이 미국 시간대로 와서 인용에 그대로 보였다.
  const original = new Date('Fri, 23 Oct 2026 04:14:52 -0500');

  it('PC 시간대의 ISO 형식', () => {
    expect(toLocalIso(original)).toBe('2026-10-23T18:14:52+09:00');
  });

  it('답장 인용용 형식', () => {
    expect(toLocalDisplay(original)).toBe('2026-10-23 18:14 (UTC+09:00)');
  });
});

describe('knownDate·parseDay', () => {
  it('1980년 이전이나 해석할 수 없는 날짜는 모르는 것으로 본다', () => {
    expect(knownDate('Thu, 01 Jan 1970 00:00:00 +0000')).toBeUndefined();
    expect(knownDate('날짜 아님')).toBeUndefined();
    expect(knownDate(undefined)).toBeUndefined();
  });

  it('실제로 없는 날짜는 받지 않는다', () => {
    expect(parseDay('2026-02-30')).toBeUndefined();
    expect(parseDay('2026-02-28')?.getDate()).toBe(28);
  });
});
