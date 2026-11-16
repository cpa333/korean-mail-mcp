import { htmlToText } from 'html-to-text';

// htmlparser2는 중첩 깊이에 제곱으로 느려지고 html-to-text는 약 2,000단계에서 호출 스택이 넘친다.
// mailparser와 같은 값을 쓴다.
const MAX_HTML_NESTING_DEPTH = 1000;
// 닫지 않은 태그를 반복한 HTML은 길이에 제곱으로 느려져 2MB에서도 30초~2분 넘게 멈췄다(2026-11-16 재현).
// 일반 업무 메일의 HTML은 이보다 훨씬 작다 (PRD §6-4).
export const MAX_HTML_INPUT_CHARS = 200 * 1024;

export interface BodyText {
  text: string;
  /** HTML이 길어 앞부분만 텍스트로 바꿨다 */
  htmlTruncated: boolean;
}

/** text/plain이 있으면 그대로, 없으면 HTML을 텍스트로 바꾼다 (PRD §6-4). */
export function bodyTextOf(plain: string | undefined, html: string | undefined): BodyText {
  if (plain?.trim()) return { text: unifyLineBreaks(plain), htmlTruncated: false };
  if (!html?.trim()) return { text: '', htmlTruncated: false };
  const htmlTruncated = html.length > MAX_HTML_INPUT_CHARS;
  const text = htmlToText(htmlTruncated ? html.slice(0, MAX_HTML_INPUT_CHARS) : html, {
    wordwrap: false,
    limits: { maxDepth: MAX_HTML_NESTING_DEPTH },
    selectors: [{ selector: 'img', format: 'skip' }],
  });
  return { text: unifyLineBreaks(text), htmlTruncated };
}

// 메일마다 \r\n과 \n이 섞여 와서, 답장 인용에서 줄바꿈이 뒤섞이지 않게 한 가지로 맞춘다.
function unifyLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
