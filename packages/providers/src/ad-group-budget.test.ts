import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider } from "./cookie-provider.js";
import type { ProviderContext } from "./types.js";
import { parseMultipartFields } from "./multipart.js";

/**
 * 报文形状对照 2026-08-25 的真机抓包。这一层测试只钉「我们发出去的长什么样」——
 * 服务端收不收得看真机跑一次，测试替代不了。但形状漂了必然收不了，先把形状焊死。
 */
function budgetContext(): ProviderContext {
  return {
    accountId: "test-account",
    timezone: "Asia/Taipei",
    settings: {
      kind: "cookie",
      advertiserId: "7614027615788711952",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    },
    credential: {
      kind: "cookie",
      cookie: "sessionid=test-cookie",
      csrfHeaderName: "x-csrftoken",
      requestTemplates: [{
        target: "ad-group-status",
        action: "disable",
        // 会话载体：签名参数挂在它身上，派生时必须原样带走。
        url: "https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=7614027615788711952&msToken=MS&X-Bogus=BOGUS&X-Gnarly=GNARLY",
        method: "POST",
        body: "{}",
        contentType: "application/json",
      }],
    },
  } as unknown as ProviderContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("广告组日预算写入", () => {
  const capture = async (context = budgetContext(), budget = 188) => {
    const sent: Array<{ url: string; body: string; contentType: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      sent.push({
        url: String(input),
        body: String(init?.body ?? ""),
        contentType: headers.get("content-type") ?? "",
      });
      return new Response(JSON.stringify({ code: 0, message: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const results = await new CookieAdsProvider().updateAdGroupBudgets!(context, [
      { externalId: "1874375599176849", budget },
    ]);
    return { sent, results };
  };

  it("打到 update_budget，路径段装的是广告组 ID", async () => {
    const { sent, results } = await capture();

    const url = new URL(sent[0]!.url);
    expect(url.pathname).toBe("/api/v3/i18n/overture/ad/1874375599176849/update_budget/");
    expect(url.searchParams.get("aadvid")).toBe("7614027615788711952");
    expect(url.searchParams.get("req_src")).toBe("ad_creation");
    expect(results[0]?.ok).toBe(true);
  });

  // 签名参数不是我们能算出来的，只能沿用会话 cURL 上原有的。丢了就必然被风控拦下。
  it("沿用会话 cURL 上的签名参数", async () => {
    const { sent } = await capture();

    const url = new URL(sent[0]!.url);
    expect(url.searchParams.get("msToken")).toBe("MS");
    expect(url.searchParams.get("X-Bogus")).toBe("BOGUS");
    expect(url.searchParams.get("X-Gnarly")).toBe("GNARLY");
  });

  it("报文是 multipart，字段与抓包一致", async () => {
    const { sent } = await capture();

    expect(sent[0]!.contentType).toContain("multipart/form-data; boundary=");
    const fields = new Map(
      parseMultipartFields(sent[0]!.body).map((field) => [field.name, field.value]),
    );
    expect(fields.get("budget")).toBe("188");
    expect(fields.get("ad_channel")).toBe("1");
  });

  // 抓包里 risk_info 装的是真实浏览器指纹。没有档案就整段不发，绝不伪造一份。
  it("没有创建档案时不发 risk_info", async () => {
    const { sent } = await capture();

    expect(sent[0]!.body).not.toContain("risk_info");
  });

  it("有创建档案时透传其中的 risk_info", async () => {
    const context = budgetContext() as unknown as {
      credential: { creationProfile?: unknown };
    };
    context.credential.creationProfile = {
      version: 1,
      campaignPayload: {},
      adGroupPayload: {},
      creativePayload: {},
      publishPayload: { risk_info: { screen_width: 2560, browser_platform: "Win32" } },
      verifiedAt: null,
    };
    const { sent } = await capture(context as unknown as ProviderContext);

    const fields = new Map(
      parseMultipartFields(sent[0]!.body).map((field) => [field.name, field.value]),
    );
    expect(fields.get("risk_info[screen_width]")).toBe("2560");
    expect(fields.get("risk_info[browser_platform]")).toBe("Win32");
  });

  it("非法预算在构造阶段就拒绝，不发请求", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      sent.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const results = await new CookieAdsProvider().updateAdGroupBudgets!(budgetContext(), [
      { externalId: "1874375599176849", budget: 0 },
    ]);

    expect(sent).toEqual([]);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.failureKind).toBe("retryable");
  });

  // 改没改成不能靠猜：没有明确成功码一律判 unknown，交人工核实。
  it("响应缺少明确成功码时判为结果未知", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: 40001, message: "nope" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const results = await new CookieAdsProvider().updateAdGroupBudgets!(budgetContext(), [
      { externalId: "1874375599176849", budget: 188 },
    ]);

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.failureKind).toBe("unknown");
  });
});
