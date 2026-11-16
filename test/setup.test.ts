import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/setup.js';

// `claude mcp get` 실제 출력 형식(Claude Code 2.1.325에서 확인)
const OUTPUT = `korean-mail:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: C:\\x\\index.cjs
  Environment:
    NAVER_EMAIL=me@naver.com
    NAVER_APP_PASSWORD=ABCD1234EFGH

To remove this server, run: claude mcp remove korean-mail -s user
`;

describe('parseEnvironment', () => {
  it('Environment 아래의 키=값을 읽는다', () => {
    expect(parseEnvironment(OUTPUT)).toEqual({ NAVER_EMAIL: 'me@naver.com', NAVER_APP_PASSWORD: 'ABCD1234EFGH' });
  });

  it('값에 = 가 있어도 첫 = 에서만 나눈다', () => {
    expect(parseEnvironment('  Environment:\n    A=b=c\n')).toEqual({ A: 'b=c' });
  });

  it('Environment 줄이 없으면 읽지 못한 것으로 본다', () => {
    expect(parseEnvironment('korean-mail:\n  Type: stdio\n')).toBeUndefined();
  });
});
