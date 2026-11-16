import { htmlToText } from 'html-to-text';

// htmlparser2는 중첩 깊이에 제곱으로 느려지고 html-to-text는 약 2,000단계에서 호출 스택이 넘친다.
// mailparser와 같은 값을 쓴다.
const MAX_HTML_NESTING_DEPTH = 1000;

/** text/plain이 있으면 그대로, 없으면 HTML을 텍스트로 바꾼다 (PRD §6-4). */
export function bodyTextOf(plain: string | undefined, html: string | undefined): string {
  if (plain?.trim()) return unifyLineBreaks(plain);
  if (!html?.trim()) return '';
  const text = htmlToText(html, {
    wordwrap: false,
    limits: { maxDepth: MAX_HTML_NESTING_DEPTH },
    selectors: [{ selector: 'img', format: 'skip' }],
  });
  return unifyLineBreaks(text);
}

// 메일마다 \r\n과 \n이 섞여 와서, 답장 인용에서 줄바꿈이 뒤섞이지 않게 한 가지로 맞춘다.
function unifyLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
