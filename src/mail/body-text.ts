// 메일 본문 텍스트 (PRD §6-4, §8 숨긴 글 방어).
// 정규식에 시간 한도를 걸 수 없는 JavaScript라서 HTML은 한 번 훑는 스캐너로 읽고,
// 남은 정규식은 역추적이 입력 길이에 비례하지 않는 패턴만 쓴다.

/** plain을 이 길이(UTF-16 단위)씩 끊어 화면 글에 있는지 본다. */
const PIECE_LENGTH = 8;
/** 화면 글에 없는 조각이 이만큼이면 숨긴 글로 본다. */
const UNSEEN_PIECES_FOR_HIDDEN = 2;
/** 화면 글의 글자 수가 이를 넘으면 견주지 않고 화면 글을 쓴다. */
const MAX_SEEN_LETTERS = 1_000_000;

const REPLACEMENT_CHARACTER = "\uFFFD";
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/** 속(글)까지 통째로 버리고 닫는 태그만 찾는 요소. 닫히지 않으면 끝까지 버린다. */
const RAW_TEXT_TAGS = ["title", "script", "style", "iframe", "noscript", "noembed", "noframes"];
/** 속까지 버리되 안의 태그는 그대로 읽어 짝을 맞추는 요소. */
const REMOVED_WITH_CONTENT = new Set(["head", "template"]);
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);
const LINE_BREAK_TAGS = new Set([
  "br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "ul", "ol",
  "table", "pre", "dl", "dt", "dd", "section", "article", "header", "footer", "address",
]);
/** 닫는 태그에서 칸 사이를 띄운다. 여는 태그에서 띄우면 줄 첫머리에 빈칸이 남는다. */
const CELL_TAGS = new Set(["td", "th"]);

const RAW_TEXT_CLOSERS = new Map(
  RAW_TEXT_TAGS.map((name) => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi")]),
);

const HTML_SPACE = /[\t\n\f\r ]/;
const HTML_SPACES = /[\t\n\f\r ]+/g;
const ATTRIBUTE_NAME_END = /[\t\n\f\r />=]/;

// 수량자가 모두 유한해 '&' 하나마다 훑는 길이가 40자를 넘지 않는다
const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,9})|([a-zA-Z][a-zA-Z0-9]{0,31}));/g;
const NAMED_ENTITY = /&[a-zA-Z][a-zA-Z0-9]*;/;
const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"],
  ["nbsp", "\u00A0"], ["ensp", "\u2002"], ["emsp", "\u2003"], ["thinsp", "\u2009"],
  ["zwnj", "\u200C"], ["zwj", "\u200D"], ["lrm", "\u200E"], ["rlm", "\u200F"], ["shy", "\u00AD"],
  ["copy", "©"], ["reg", "®"], ["trade", "™"], ["hellip", "…"], ["mdash", "—"], ["ndash", "–"],
  ["lsquo", "‘"], ["rsquo", "’"], ["sbquo", "‚"], ["ldquo", "“"], ["rdquo", "”"], ["bdquo", "„"],
  ["laquo", "«"], ["raquo", "»"], ["lsaquo", "‹"], ["rsaquo", "›"], ["middot", "·"], ["bull", "•"],
  ["deg", "°"], ["plusmn", "±"], ["times", "×"], ["divide", "÷"], ["micro", "µ"], ["para", "¶"],
  ["sect", "§"], ["cent", "¢"], ["pound", "£"], ["yen", "¥"], ["euro", "€"], ["curren", "¤"],
  ["iexcl", "¡"], ["iquest", "¿"], ["larr", "←"], ["rarr", "→"], ["uarr", "↑"], ["darr", "↓"],
  ["harr", "↔"], ["hearts", "♥"], ["colon", ":"], ["semi", ";"], ["comma", ","], ["period", "."],
  ["excl", "!"], ["quest", "?"], ["num", "#"], ["percnt", "%"], ["lpar", "("], ["rpar", ")"],
  ["sol", "/"], ["bsol", "\\"], ["equals", "="], ["plus", "+"], ["ast", "*"],
]);

/** 숨기는 선언. 크기·투명도는 0일 때만이다 — `0.8em`·`0.5`는 보인다. */
const HIDING_DECLARATION =
  /(?<![-\w])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|mso-hide\s*:\s*all|(?:font-size|opacity)\s*:\s*0+(?:\.0+)?(?![\d.]))/gi;
const HIDES = new RegExp(HIDING_DECLARATION.source, "i");
const ZERO_FONT_SIZE = /^font-size/i;
/** 0이 아닌 글자 크기 선언. */
const SIZED_TEXT = /font-size\s*:\s*(?!0+(?:\.0+)?(?![\d.]))[\w.]/i;
const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f0-9a-fA-F]))/g;
const HTML_COMMENT_MARKS = /<!--|-->/g;
/**
 * 선택자에서 따지지 않는 것 — 속성 조건(`[…]`)과 가상 클래스(`:hover`·`::before`·`:not(…)`).
 * `[` 안에 `[`를 받지 않아, 닫히지 않은 `[`가 수없이 있어도 저마다 다음 `[`까지만 훑는다.
 */
const SELECTOR_EXTRAS = /\[[^\][]*\]|::?[-\w]+(?:\([^()]*\))?/g;
const COMBINATORS = /[\s>+~]+/;
const COMPOUND_TAG = /^(?:[a-z][a-z0-9-]*|\*)/i;
const COMPOUND_PARTS = /[.#][^.#]+/g;
/**
 * `<style>` 규칙과 요소를 견주는 횟수 상한. 넘으면 그 뒤 요소는 숨김 규칙과 클래스·아이디·태그 하나만 겹쳐도
 * 숨긴 것으로 본다 — 규칙 수 × 요소 수만큼 걸리게 꾸민 메일에서도 선형으로 끝내고, 숨긴 글은 새지 않게 한다.
 */
const MAX_RULE_CHECKS = 1_000_000;

/**
 * 글자로 견주는 것 — 글자·숫자와, 글자처럼 읽히는 기호(글자 모양 기호 U+2100–214F, 동그라미 친 글자
 * U+2460–24FF, 네모 친 글자·나라 글자 U+1F100–1F1FF). 뒤의 것은 NFKC로 풀리지 않는 것(🅸·🇮)이 있는데
 * AI는 글자로 읽으므로 빼면 숨긴 지시문이 비교를 빠져나간다.
 */
const NOT_COMPARED = /[^\p{L}\p{N}\u2100-\u214F\u2460-\u24FF\u{1F100}-\u{1F1FF}]+/gu;

/**
 * 태그 문자, 이체 선택자 보충, 너비 없는 글자, 방향 제어 글자, 한글 채움 글자.
 * 이체 선택자 보충(U+E0100–E01EF)은 PRD 목록 밖이지만 글자 뒤에 줄줄이 붙여 숨긴 글을 싣는 데 쓰인다.
 */
const INVISIBLE =
  /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u200B-\u200F\u2060-\u2064\uFEFF\u180E\u00AD\u061C\u202A-\u202E\u2066-\u2069\u3164\uFFA0\u115F\u1160]/gu;
const NBSP = /\u00A0/g;
const LINE_ENDINGS = /\r\n?/g;
const MANY_BLANK_LINES = /\n{3,}/g;

type Token =
  | { kind: "text"; text: string }
  | { kind: "start"; name: string; attributes: Map<string, string> }
  | { kind: "end"; name: string };

type StartToken = Extract<Token, { kind: "start" }>;

interface Markup {
  /** 이 표시가 끝난 다음 위치. 닫히지 않았으면 입력 끝이다. */
  end: number;
  token?: Token;
}

/** 숨김 — 아니다, 숨겼다, 글자 크기만 0으로 했다(속에 크기를 준 글은 보인다). */
type Hiding = "none" | "hidden" | "zeroSize";

interface Look {
  hiding: Hiding;
  /** 0이 아닌 글자 크기를 주었는가. */
  sized: boolean;
}

/** `<style>` 규칙 선택자의 마지막 단 — 태그 이름(`*`는 모두)·클래스·아이디. 모두 소문자. */
interface Selector {
  tag?: string;
  classes: string[];
  id?: string;
}

/** 숨김 규칙을 찾아보는 열쇠(`#아이디`·`.첫 클래스`·`<태그`)별로 모은 것. 요소는 자기 열쇠의 규칙만 견준다. */
type HidingRules = Map<string, Selector[]>;

interface Element {
  name: string;
  classes: Set<string>;
  id?: string;
}

const PLAIN_LOOK: Look = { hiding: "none", sized: false };
const HIDDEN_LOOK: Look = { hiding: "hidden", sized: false };

/**
 * 메일 본문 텍스트. text/plain을 쓰되, HTML 화면에 없는 글이 plain에 있으면 HTML을 정리한 글을 쓴다.
 * plain이 비었으면 HTML을 정리한 글. 둘 다 비었으면 빈 문자열.
 */
export function bodyTextOf(plain: string | undefined, html: string | undefined): string {
  const hasPlain = isPresent(plain);
  const hasHtml = isPresent(html);
  if (!hasHtml) {
    return hasPlain ? tidy(removeInvisible(plain)) : "";
  }

  const shown = removeInvisible(htmlToText(html));
  if (!hasPlain) {
    return tidy(shown);
  }

  const visiblePlain = removeInvisible(plain);
  return tidy(hasUnseenText(visiblePlain, shown) ? shown : visiblePlain);
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function removeInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

function tidy(text: string): string {
  return text.replace(LINE_ENDINGS, "\n").replace(MANY_BLANK_LINES, "\n\n").trim();
}

/** plain을 8자씩 끊어 화면 글에 없는 조각이 2개 이상인가. 끝에 남는 8자 미만은 끝에서 8자를 떼어 본다. */
function hasUnseenText(plain: string, shown: string): boolean {
  const seen = lettersOf(shown);
  // 너무 길면 조각 목록이 메모리를 많이 쓴다. 그때는 사람이 보는 화면 글을 쓴다
  if (seen.length > MAX_SEEN_LETTERS) {
    return true;
  }

  const text = lettersOf(plain);
  // 조각이 하나뿐이면 2개 기준에 닿을 수 없다
  if (text.length <= PIECE_LENGTH) {
    return false;
  }

  const seenPieces = piecesOf(seen);
  let unseen = 0;
  for (let at = 0; at < text.length; at += PIECE_LENGTH) {
    const start = Math.min(at, text.length - PIECE_LENGTH);
    if (!seenPieces.has(text.slice(start, start + PIECE_LENGTH))) {
      unseen++;
    }
    if (unseen >= UNSEEN_PIECES_FOR_HIDDEN) {
      return true;
    }
  }
  return false;
}

/** 화면 글의 8자 조각 전부. 조각마다 화면 글 전체를 훑으면 두 길이의 곱만큼 걸린다. */
function piecesOf(seen: string): Set<string> {
  const pieces = new Set<string>();
  for (let at = 0; at + PIECE_LENGTH <= seen.length; at++) {
    pieces.add(seen.slice(at, at + PIECE_LENGTH));
  }
  return pieces;
}

function lettersOf(text: string): string {
  return text.normalize("NFKC").replace(NOT_COMPARED, "");
}

// ── HTML 정리 ─────────────────────────────────────────────

function htmlToText(html: string): string {
  const { tokens, styleSheets } = tokenize(html);
  const rules = hidingRules(styleSheets);
  const ruleChecks = { count: 0 };
  const looks = tokens.map((token) => lookOf(token, rules, ruleChecks));
  const ends = matchingEnds(tokens);
  const sizedBefore = sizedCounts(looks);
  const parts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "text") {
      parts.push(textOf(token.text));
      continue;
    }

    const look = looks[i];
    // 글자 크기 0인 감싸개 안에 크기를 준 글이 있으면 반응형 메일의 칸 맞추기다 — 그 글은 보인다
    const hidden = look.hiding === "hidden"
      || (look.hiding === "zeroSize" && sizedBefore[ends[i]] === sizedBefore[i + 1]);
    if (hidden) {
      i = ends[i];
      continue;
    }

    if (LINE_BREAK_TAGS.has(token.name)) {
      parts.push("\n");
    } else if (token.kind === "end" && CELL_TAGS.has(token.name)) {
      parts.push("\t");
    }
  }

  return parts.join("").split("\n").map((line) => line.trim()).join("\n");
}

/** HTML 글 조각을 화면에 보이는 글로. 빈칸 묶음은 하나로 보이고, 엔티티는 한 번만 푼다. */
function textOf(raw: string): string {
  return decodeEntities(raw.replace(HTML_SPACES, " ")).replace(NBSP, " ");
}

/**
 * HTML을 글·여는 태그·닫는 태그로 나눈다. 앞에서 뒤로 한 번만 지나간다.
 * 주석과 속을 글로 읽는 요소(script 등)는 토큰을 남기지 않는다. `<style>`의 속은 숨김 규칙을 찾으려고 따로 모은다.
 */
function tokenize(html: string): { tokens: Token[]; styleSheets: string[] } {
  const tokens: Token[] = [];
  const styleSheets: string[] = [];
  let textStart = 0;
  let at = 0;

  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) {
      break;
    }

    const markup = readMarkup(html, lt);
    if (markup === undefined) {
      at = lt + 1;
      continue;
    }

    pushText(tokens, html.slice(textStart, lt));
    let end = markup.end;
    const token = markup.token;
    if (token?.kind === "start" && RAW_TEXT_CLOSERS.has(token.name)) {
      const raw = rawTextOf(html, token.name, end);
      if (token.name === "style") {
        styleSheets.push(raw.content);
      }
      end = raw.end;
    } else if (token !== undefined) {
      tokens.push(token);
    }
    at = textStart = end;
  }

  pushText(tokens, html.slice(textStart));
  return { tokens, styleSheets };
}

function pushText(tokens: Token[], text: string): void {
  if (text !== "") {
    tokens.push({ kind: "text", text });
  }
}

/** `<`에서 시작하는 표시를 읽는다. 태그가 아니면(`3 < 5`) undefined — 브라우저도 글로 보인다. */
function readMarkup(html: string, lt: number): Markup | undefined {
  const next = html.charAt(lt + 1);
  if (html.startsWith("<!--", lt)) {
    const close = html.indexOf("-->", lt + 4);
    return { end: close < 0 ? html.length : close + 3 };
  }
  if (isAsciiLetter(next)) {
    return readTag(html, lt + 1, "start");
  }
  if (next === "/" && isAsciiLetter(html.charAt(lt + 2))) {
    return readTag(html, lt + 2, "end");
  }
  if (next === "!" || next === "?" || next === "/") {
    const close = html.indexOf(">", lt + 2);
    return { end: close < 0 ? html.length : close + 1 };
  }
  return undefined;
}

function isAsciiLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/**
 * 태그 이름과 속성을 읽는다. 따옴표는 `=` 바로 뒤(빈칸 건너)에서만 값을 묶는다 — `a=b"c`의 `"`는 값의 한 글자다.
 * 끝내 `>`가 없거나 연 따옴표가 닫히지 않으면 브라우저는 문서 끝까지 태그 속으로 보아 그리지 않는다. 그래서 끝까지 버린다.
 */
function readTag(html: string, nameStart: number, kind: "start" | "end"): Markup {
  let at = nameStart;
  while (at < html.length && !HTML_SPACE.test(html[at]) && html[at] !== "/" && html[at] !== ">") {
    at++;
  }
  const name = html.slice(nameStart, at).toLowerCase();
  const attributes = new Map<string, string>();

  while (at < html.length) {
    const c = html[at];
    if (c === ">") {
      const token: Token = kind === "start" ? { kind, name, attributes } : { kind, name };
      return { end: at + 1, token };
    }
    if (HTML_SPACE.test(c) || c === "/") {
      at++;
      continue;
    }

    const attribute = readAttribute(html, at);
    if (attribute === undefined) {
      break;
    }
    // 같은 이름이 또 나오면 브라우저는 첫 것을 쓴다
    if (!attributes.has(attribute.name)) {
      attributes.set(attribute.name, attribute.value);
    }
    at = attribute.end;
  }

  return { end: html.length };
}

/** 속성 하나. 연 따옴표가 닫히지 않았으면 undefined. */
function readAttribute(html: string, start: number): { name: string; value: string; end: number } | undefined {
  // 첫 글자는 `=`라도 이름이다 — 브라우저가 그렇다. 그래야 늘 한 글자 이상 나아간다
  let nameEnd = start + 1;
  while (nameEnd < html.length && !ATTRIBUTE_NAME_END.test(html[nameEnd])) {
    nameEnd++;
  }
  const name = html.slice(start, nameEnd).toLowerCase();

  let at = skipSpaces(html, nameEnd);
  if (html[at] !== "=") {
    return { name, value: "", end: nameEnd };
  }

  at = skipSpaces(html, at + 1);
  const quote = html[at];
  if (quote === "\"" || quote === "'") {
    const close = html.indexOf(quote, at + 1);
    return close < 0 ? undefined : { name, value: html.slice(at + 1, close), end: close + 1 };
  }

  let valueEnd = at;
  while (valueEnd < html.length && !HTML_SPACE.test(html[valueEnd]) && html[valueEnd] !== ">") {
    valueEnd++;
  }
  return { name, value: html.slice(at, valueEnd), end: valueEnd };
}

function skipSpaces(html: string, from: number): number {
  let at = from;
  while (at < html.length && HTML_SPACE.test(html[at])) {
    at++;
  }
  return at;
}

/**
 * script 등의 속과 닫는 태그 뒤. `</style foo>`도 닫는 태그다. 닫히지 않으면 브라우저처럼 끝까지 속으로 본다.
 */
function rawTextOf(html: string, name: string, from: number): { content: string; end: number } {
  const closer = RAW_TEXT_CLOSERS.get(name)!;
  closer.lastIndex = from;
  const found = closer.exec(html);
  if (found === null) {
    return { content: html.slice(from), end: html.length };
  }
  const gt = html.indexOf(">", found.index);
  return { content: html.slice(from, found.index), end: gt < 0 ? html.length : gt + 1 };
}

/**
 * 여는 태그마다 짝이 되는 닫는 태그의 토큰 번호. 같은 이름의 태그를 겹친 만큼 세어 짝을 맞춘다.
 * 속이 없는 태그는 자기 자신, 끝내 닫히지 않으면 토큰 끝 — 숨긴 글이 새는 것보다 본문 끝자락을 잃는 편이 낫다.
 * 한 번에 모두 구해 두므로 숨긴 요소를 수만 겹 겹쳐도 겹마다 끝까지 다시 훑지 않는다.
 */
function matchingEnds(tokens: Token[]): number[] {
  const ends = tokens.map((token, i) => (token.kind === "start" && !VOID_TAGS.has(token.name) ? tokens.length : i));
  const open = new Map<string, number[]>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "text" || VOID_TAGS.has(token.name)) {
      continue;
    }
    // head는 닫는 태그를 빼도 되는 요소다. 본문이 시작되면 닫힌 것으로 본다 — 끝까지 버리면 본문이 통째로 사라진다
    if (token.kind === "start" && token.name === "body") {
      for (const head of open.get("head") ?? []) {
        ends[head] = i - 1;
      }
      open.delete("head");
    }

    const stack = open.get(token.name) ?? [];
    open.set(token.name, stack);
    if (token.kind === "start") {
      stack.push(i);
    } else if (stack.length > 0) {
      ends[stack.pop()!] = i;
    }
  }

  return ends;
}

/** `counts[k]` = 토큰 0..k-1 가운데 0이 아닌 글자 크기를 준 것의 수. 어느 구간에 있는지를 바로 셀 수 있다. */
function sizedCounts(looks: Look[]): number[] {
  const counts = [0];
  looks.forEach((look, i) => counts.push(counts[i] + (look.sized ? 1 : 0)));
  return counts;
}

/** 여는 태그가 숨긴 요소인가 — `hidden` 속성, head·template, 인라인 `style`, `<style>` 숨김 규칙. */
function lookOf(token: Token, rules: HidingRules, ruleChecks: { count: number }): Look {
  if (token.kind !== "start") {
    return PLAIN_LOOK;
  }
  if (REMOVED_WITH_CONTENT.has(token.name) || token.attributes.has("hidden")) {
    return HIDDEN_LOOK;
  }

  const style = token.attributes.get("style");
  const inline = style === undefined ? PLAIN_LOOK : inlineLookOf(style);
  if (inline.hiding !== "hidden" && isHiddenByRules(token, rules, ruleChecks)) {
    return { hiding: "hidden", sized: inline.sized };
  }
  return inline;
}

/**
 * 인라인 `style` 값. HTML 엔티티와 CSS 표기(`d\69 splay`)·주석(`display:/**\/none`)을 푼 뒤에 본다 —
 * 브라우저가 그렇게 읽는다. 풀고도 엔티티 이름(`&colon;` 따위)이 남으면 숨긴 것으로 본다 — 여기서는 HTML5 이름을 다 풀지 못한다.
 */
function inlineLookOf(style: string): Look {
  const decoded = decodeEntities(style);
  if (NAMED_ENTITY.test(decoded)) {
    return HIDDEN_LOOK;
  }

  const css = cleanCss(decoded);
  const declarations = css.match(HIDING_DECLARATION) ?? [];
  const sized = SIZED_TEXT.test(css);
  if (declarations.some((declaration) => !ZERO_FONT_SIZE.test(declaration))) {
    return { hiding: "hidden", sized };
  }
  return { hiding: declarations.length > 0 ? "zeroSize" : "none", sized };
}

// ── <style> 숨김 규칙 ─────────────────────────────────────

/**
 * `<style>`에서 숨기는 선언이 든 규칙의 선택자. 규칙을 `<!-- -->`로 감싸도 브라우저는 따른다.
 * `@media` 안의 규칙도 센다 — 숨긴 글이 새는 것보다 어느 화면에서만 숨긴 글을 잃는 편이 낫다.
 */
function hidingRules(styleSheets: string[]): HidingRules {
  const rules: HidingRules = new Map();
  const selectors = styleSheets
    .flatMap((sheet) => cssRules(cleanCss(sheet.replace(HTML_COMMENT_MARKS, " "))))
    .filter((rule) => HIDES.test(rule.body))
    .flatMap((rule) => rule.selector.split(","))
    .map(selectorOf);

  for (const selector of selectors) {
    if (selector === undefined) {
      continue;
    }
    const key = selector.id !== undefined ? `#${selector.id}`
      : selector.classes.length > 0 ? `.${selector.classes[0]}`
      : `<${selector.tag}`;
    const list = rules.get(key) ?? [];
    list.push(selector);
    rules.set(key, list);
  }
  return rules;
}

/**
 * `선택자{선언}` 목록. 중괄호가 없는 선언 바로 앞의 글을 선택자로 본다 — `@media x{ .h{…} }`에서는 `.h`.
 * 정규식(`[^{}]*\{…\}`)은 `{` 없는 긴 글에서 자리마다 다시 훑으므로 한 번 지나가며 가른다.
 */
function cssRules(css: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  let boundary = 0;
  let selector = "";
  let open = -1;

  for (let at = 0; at < css.length; at++) {
    const c = css[at];
    if (c === "{") {
      selector = css.slice(boundary, at);
      open = at;
      boundary = at + 1;
    } else if (c === "}") {
      if (open >= 0) {
        rules.push({ selector, body: css.slice(open + 1, at) });
      }
      open = -1;
      boundary = at + 1;
    }
  }
  return rules;
}

/**
 * 선택자 하나의 마지막 단(`u + #body .h`의 `.h`). 앞 단을 따지지 않아 더 걷어 낼 수는 있어도 덜 걷어 내지는 않는다.
 * 속성 조건·가상 클래스를 뗐더니 태그 이름만 남으면(`td[class=mobile-hide]`) 쓰지 않는다 — 조건에 맞는 것만
 * 숨기는 규칙으로 모든 칸을 걷게 된다. 해석하지 못하면 undefined.
 */
function selectorOf(selector: string): Selector | undefined {
  const plain = selector.replace(SELECTOR_EXTRAS, "");
  const parts = plain.trim().split(COMBINATORS);
  const last = parts[parts.length - 1];
  const tag = COMPOUND_TAG.exec(last)?.[0];
  const rest = last.slice(tag?.length ?? 0);
  const pieces = rest.match(COMPOUND_PARTS) ?? [];
  if (last === "" || pieces.join("").length !== rest.length) {
    return undefined;
  }

  const classes = pieces.filter((piece) => piece[0] === ".").map((piece) => piece.slice(1).toLowerCase());
  const id = pieces.filter((piece) => piece[0] === "#").map((piece) => piece.slice(1).toLowerCase()).pop();
  if (classes.length === 0 && id === undefined && plain.length !== selector.length) {
    return undefined;
  }
  return { tag: tag?.toLowerCase(), classes, id };
}

/** 요소가 숨김 규칙에 드는가. 견준 횟수가 상한을 넘으면 열쇠가 겹치는 규칙이 있기만 해도 숨긴 것으로 본다. */
function isHiddenByRules(token: StartToken, rules: HidingRules, ruleChecks: { count: number }): boolean {
  if (rules.size === 0) {
    return false;
  }

  const element = elementOf(token);
  for (const key of keysOf(element)) {
    for (const selector of rules.get(key) ?? []) {
      ruleChecks.count++;
      if (ruleChecks.count > MAX_RULE_CHECKS || matches(selector, element)) {
        return true;
      }
    }
  }
  return false;
}

/** 클래스·아이디는 엔티티를 푼 값으로 견준다(`class="&#104;"`는 `h`). 대소문자는 가리지 않는다. */
function elementOf(token: StartToken): Element {
  const classes = decodeEntities(token.attributes.get("class") ?? "").toLowerCase().split(HTML_SPACES).filter((c) => c !== "");
  const id = token.attributes.get("id");
  return {
    name: token.name,
    classes: new Set(classes),
    id: id === undefined ? undefined : decodeEntities(id).trim().toLowerCase(),
  };
}

function keysOf(element: Element): string[] {
  const keys = [`<${element.name}`, "<*", ...[...element.classes].map((c) => `.${c}`)];
  return element.id === undefined ? keys : [...keys, `#${element.id}`];
}

function matches(selector: Selector, element: Element): boolean {
  const tagMatches = selector.tag === undefined || selector.tag === "*" || selector.tag === element.name;
  const idMatches = selector.id === undefined || selector.id === element.id;
  return tagMatches && idMatches && selector.classes.every((c) => element.classes.has(c));
}

function cleanCss(css: string): string {
  return css.replace(CSS_COMMENT, "").replace(CSS_ESCAPE, (_, hex: string | undefined, char: string | undefined) =>
    hex === undefined ? (char ?? "") : fromCodePoint(Number.parseInt(hex, 16)));
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (hex !== undefined) {
      return fromCodePoint(Number.parseInt(hex, 16));
    }
    if (decimal !== undefined) {
      return fromCodePoint(Number.parseInt(decimal, 10));
    }
    return NAMED_ENTITIES.get(name ?? "") ?? whole;
  });
}

/** 글자가 될 수 없는 번호(0·서로게이트·범위 밖)는 브라우저처럼 대체 글자로. */
function fromCodePoint(code: number): string {
  const invalid = code === 0 || code > MAX_CODE_POINT || (code >= SURROGATE_FIRST && code <= SURROGATE_LAST);
  return invalid ? REPLACEMENT_CHARACTER : String.fromCodePoint(code);
}
