import { describe, expect, it } from "vitest";
import {
  type Address,
  type OriginalMessage,
  type ReplyRecipientsInput,
  buildQuotedBody,
  computeReplyRecipients,
  formatAddress,
  isNoReplyAddress,
  parseAddresses,
  replySubject,
  replyThreadHeaders,
} from "../src/mail/reply";

const FULLWIDTH_SPACE = "　";
const NBSP = " ";

function original(overrides: Partial<OriginalMessage> = {}): OriginalMessage {
  return {
    from: [{ name: "김부장", address: "boss@corp.com" }],
    replyTo: [],
    to: [{ address: "me@naver.com" }],
    cc: [],
    date: "Mon, 16 Nov 2026 09:30:00 +0900",
    subject: "보고서 요청",
    messageId: "<orig@corp.com>",
    references: [],
    text: "보고서 보내 주세요.",
    ...overrides,
  };
}

function recipients(overrides: Partial<ReplyRecipientsInput> = {}) {
  return computeReplyRecipients({
    original: original(),
    myAddress: "me@naver.com",
    mode: "reply_all",
    extraCc: [],
    bcc: [],
    ...overrides,
  });
}

const addressesOf = (list: Address[]) => list.map((a) => a.address);

describe("parseAddresses", () => {
  it("주소만 있는 값과 이름 <주소> 값을 읽는다", () => {
    expect(parseAddresses(["a@b.com", "홍길동 <hong@b.com>"])).toEqual({
      ok: true,
      addresses: [{ address: "a@b.com" }, { name: "홍길동", address: "hong@b.com" }],
    });
  });

  it("앞뒤의 일반·전각 공백과 NBSP를 깎는다", () => {
    const result = parseAddresses([
      `${FULLWIDTH_SPACE} a@b.com${NBSP}`,
      `${NBSP}홍길동${FULLWIDTH_SPACE}<${FULLWIDTH_SPACE}hong@b.com${NBSP}>${FULLWIDTH_SPACE}`,
    ]);
    expect(result).toEqual({
      ok: true,
      addresses: [{ address: "a@b.com" }, { name: "홍길동", address: "hong@b.com" }],
    });
  });

  it("이름에 쉼표가 든 따옴표 이름을 주소 하나로 읽는다", () => {
    expect(parseAddresses(['"Kim, Minsu" <kim@x.com>'])).toEqual({
      ok: true,
      addresses: [{ name: "Kim, Minsu", address: "kim@x.com" }],
    });
  });

  it("빈 이름은 이름 없이 둔다", () => {
    expect(parseAddresses(["<a@b.com>", '"" <c@d.com>'])).toEqual({
      ok: true,
      addresses: [{ address: "a@b.com" }, { address: "c@d.com" }],
    });
  });

  it("도메인이 없거나 형식이 틀린 값을 빼지 않고 모두 무효로 돌려준다", () => {
    const inputs = ["ok@b.com", "a@", "홍길동 <hong@>", "noat", "", `${FULLWIDTH_SPACE}`, "@b.com", "a b@c.com"];
    expect(parseAddresses(inputs)).toEqual({
      ok: false,
      invalid: ["a@", "홍길동 <hong@>", "noat", "", FULLWIDTH_SPACE, "@b.com", "a b@c.com"],
    });
  });

  it("빈 배열은 빈 목록이다", () => {
    expect(parseAddresses([])).toEqual({ ok: true, addresses: [] });
  });
});

describe("isNoReplyAddress", () => {
  it.each(["noreply@x.com", "no-reply@x.com", "donotreply@x.com", "do-not-reply@x.com", "mailer-daemon@x.com"])(
    "%s 는 회신 불가",
    (address) => expect(isNoReplyAddress(address)).toBe(true),
  );

  it("대소문자를 무시한다", () => {
    expect(isNoReplyAddress("NoReply@X.com")).toBe(true);
    expect(isNoReplyAddress("MAILER-DAEMON@x.com")).toBe(true);
  });

  it("로컬 부분이 정확히 같을 때만 회신 불가", () => {
    expect(isNoReplyAddress("noreply-team@x.com")).toBe(false);
    expect(isNoReplyAddress("user@noreply.com")).toBe(false);
    expect(isNoReplyAddress("noreplyx")).toBe(false);
  });
});

describe("computeReplyRecipients", () => {
  it("Reply-To가 없으면 From으로 답한다", () => {
    expect(addressesOf(recipients().to)).toEqual(["boss@corp.com"]);
  });

  it("Reply-To가 있으면 Reply-To로 답한다", () => {
    const result = recipients({ original: original({ replyTo: [{ address: "desk@corp.com" }] }) });
    expect(addressesOf(result.to)).toEqual(["desk@corp.com"]);
  });

  it("reply_all은 원본 To·Cc를 순서대로 Cc에 넣고 To·내 주소·회신 불가·중복을 뺀다", () => {
    const result = recipients({
      myAddress: "Me@Naver.com",
      original: original({
        to: [{ address: "me@naver.com" }, { address: "a@x.com" }, { address: "BOSS@corp.com" }],
        cc: [{ address: "A@X.com" }, { address: "No-Reply@x.com" }, { address: "b@x.com" }, { address: "ME@NAVER.COM" }],
      }),
    });
    expect(addressesOf(result.cc)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("reply는 Cc를 비운다", () => {
    const result = recipients({
      mode: "reply",
      original: original({ to: [{ address: "a@x.com" }], cc: [{ address: "b@x.com" }] }),
    });
    expect(result.cc).toEqual([]);
  });

  it("추가 cc는 뒤에 붙이고 To·Cc와 겹치거나 중복이면 뺀다", () => {
    const result = recipients({
      original: original({ to: [{ address: "a@x.com" }] }),
      extraCc: [{ address: "A@x.com" }, { address: "boss@CORP.com" }, { address: "c@x.com" }, { address: "C@x.com" }],
    });
    expect(addressesOf(result.cc)).toEqual(["a@x.com", "c@x.com"]);
  });

  it("bcc는 To·Cc(추가 cc 포함)와 겹치면 뺀다", () => {
    const result = recipients({
      original: original({ to: [{ address: "a@x.com" }] }),
      extraCc: [{ address: "c@x.com" }],
      bcc: [
        { address: "BOSS@corp.com" },
        { address: "a@X.com" },
        { address: "c@x.com" },
        { address: "d@x.com" },
        { address: "D@x.com" },
      ],
    });
    expect(addressesOf(result.bcc)).toEqual(["d@x.com"]);
  });

  it("To가 회신 불가 주소면 To에 그대로 두고 noReplyTo로 알린다", () => {
    const result = recipients({ original: original({ from: [{ address: "NoReply@shop.com" }] }) });
    expect(addressesOf(result.to)).toEqual(["NoReply@shop.com"]);
    expect(addressesOf(result.noReplyTo)).toEqual(["NoReply@shop.com"]);
  });

  it("평범한 To면 noReplyTo가 비어 있다", () => {
    expect(recipients().noReplyTo).toEqual([]);
  });

  it("원본 Cc가 비어도 To만으로 계산한다", () => {
    const result = recipients({ original: original({ to: [{ address: "me@naver.com" }, { address: "a@x.com" }], cc: [] }) });
    expect(addressesOf(result.cc)).toEqual(["a@x.com"]);
  });
});

describe("replySubject", () => {
  it("Re:로 시작하지 않으면 Re: 를 붙인다", () => {
    expect(replySubject("보고서 요청")).toBe("Re: 보고서 요청");
    expect(replySubject("")).toBe("Re: ");
    expect(replySubject("Fwd: 자료")).toBe("Re: Fwd: 자료");
  });

  it("대소문자·앞 공백을 무시하고 Re:로 시작하면 그대로 둔다", () => {
    expect(replySubject("Re: 보고서")).toBe("Re: 보고서");
    expect(replySubject("RE:보고서")).toBe("RE:보고서");
    expect(replySubject("  re: 보고서")).toBe("  re: 보고서");
  });

  it("Re로 시작해도 콜론이 없으면 붙인다", () => {
    expect(replySubject("Report")).toBe("Re: Report");
  });
});

describe("replyThreadHeaders", () => {
  it("References가 없으면 Message-ID 하나", () => {
    expect(replyThreadHeaders("<m@x>", [])).toEqual({ inReplyTo: "<m@x>", references: ["<m@x>"] });
  });

  it("원본 References 뒤에 Message-ID를 붙인다", () => {
    expect(replyThreadHeaders("<m@x>", ["<a@x>", "<b@x>"])).toEqual({
      inReplyTo: "<m@x>",
      references: ["<a@x>", "<b@x>", "<m@x>"],
    });
  });

  it("중복을 빼고 Message-ID는 맨 끝에 한 번만 둔다", () => {
    expect(replyThreadHeaders("<m@x>", ["<a@x>", "<m@x>", "<a@x>", "<b@x>"])).toEqual({
      inReplyTo: "<m@x>",
      references: ["<a@x>", "<b@x>", "<m@x>"],
    });
  });

  it("Message-ID가 없으면 둘 다 없다", () => {
    expect(replyThreadHeaders(undefined, ["<a@x>"])).toBeUndefined();
    expect(replyThreadHeaders("", ["<a@x>"])).toBeUndefined();
  });
});

describe("formatAddress", () => {
  it("이름이 있으면 이름 <주소>, 없으면 주소만", () => {
    expect(formatAddress({ name: "홍길동", address: "hong@b.com" })).toBe("홍길동 <hong@b.com>");
    expect(formatAddress({ address: "hong@b.com" })).toBe("hong@b.com");
  });
});

describe("buildQuotedBody", () => {
  it("PRD 형식으로 원문을 인용한다", () => {
    const quoted = buildQuotedBody(
      "확인했습니다.",
      original({
        to: [{ name: "나", address: "me@naver.com" }, { address: "a@x.com" }],
        cc: [{ name: "Kim, Minsu", address: "kim@x.com" }],
      }),
    );
    expect(quoted).toBe(
      [
        "확인했습니다.",
        "",
        "-----Original Message-----",
        "From: 김부장 <boss@corp.com>",
        "To: 나 <me@naver.com>, a@x.com",
        "Cc: Kim, Minsu <kim@x.com>",
        "Date: Mon, 16 Nov 2026 09:30:00 +0900",
        "Subject: 보고서 요청",
        "",
        "보고서 보내 주세요.",
      ].join("\n"),
    );
  });

  it("원본 Cc가 없으면 Cc 줄을 뺀다", () => {
    const quoted = buildQuotedBody("확인했습니다.", original());
    expect(quoted).not.toContain("Cc:");
    expect(quoted).toContain("To: me@naver.com\nDate: Mon, 16 Nov 2026 09:30:00 +0900\n");
  });
});
