import { htmlToText } from 'html-to-text';

// htmlparser2는 중첩 깊이에 제곱으로 느려지고 html-to-text는 약 2,000단계에서 호출 스택이 넘친다.
// mailparser와 같은 값을 쓴다.
const MAX_HTML_NESTING_DEPTH = 1000;

/** text/plain이 있으면 그대로, 없으면 HTML을 텍스트로 바꾼다 (PRD §6-4). */
export function bodyTextOf(plain: string | undefined, html: string | undefined): string {
  if (plain?.trim()) return plain;
  if (!html?.trim()) return '';
  return htmlToText(html, {
    wordwrap: false,
    limits: { maxDepth: MAX_HTML_NESTING_DEPTH },
    selectors: [{ selector: 'img', format: 'skip' }],
  });
}
