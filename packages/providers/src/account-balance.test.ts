import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedCookieRequest } from "@tk-auto/core";
import { CookieAdsProvider } from "./cookie-provider.js";
import type { ProviderContext } from "./types.js";

/**
 * 余额读取的契约测试。
 *
 * 夹具直接取自 2026-09-15 的真机 HAR（广告账户「余杭茵未-24HP」，adv_id
 * 7677476995111698439），字段名与嵌套层级照抄响应，不做简化——这个接口的坑
 * 全在层级上：总额在 adv_full_balance.sum_total_balance，而 pa_full_balance
 * 下面另有一套同名字段，取错那一个会显示成另一个数（真机上一个是 298.35、
 * 另一个是 84356.11）。
 */

const ADVERTISER_ID = "7677476995111698439";
const PA_ID = "7667921595301970696";

/** 真机 query_payment_account 的响应（保留余额链路用到的字段）。 */
const PAYMENT_ACCOUNT_RESPONSE = {
  code: 0,
  msg: "operate success",
  data: {
    pa_info: {
      pa_id: PA_ID,
      name: "Portfolio for PingMe Limited-75yino",
      pa_currency_list: ["USD"],
    },
    currency_format: { code: "USD", precision: 2 },
    adv_info_vo: { id: ADVERTISER_ID, name: "余杭茵未-24HP", currency: "USD", timezone: "Asia/Singapore" },
  },
};

/** 真机 query_payment_summary 的响应（数字照抄，含极易混淆的 pa_full_balance）。 */
const PAYMENT_SUMMARY_RESPONSE = {
  code: 0,
  msg: "成功",
  data: {
    mixed_amount: {
      adv_dashboard_amount_v2: { amount: "298.35", currency: { precision: 2, currency: "USD" } },
    },
    pa_full_balance: {
      // 陷阱：这里的 sum_credit_balance 是 84356.11，与 adv_full_balance 下的
      // 同名字段不是一回事。取错就会把「作品集总额度」当成「本账户余额」。
      sum_credit_balance: { abs_amount: "84356.11", valid_amount: "84356.11", currency: { precision: 2, currency: "USD" } },
      sum_cash_balance: { abs_amount: "0.00", valid_amount: "0.00", currency: { precision: 2, currency: "USD" } },
    },
    adv_full_balance: {
      sum_total_balance: { abs_amount: "298.35", valid_amount: "298.35", currency: { precision: 2, currency: "USD" } },
      sum_cash_balance: { abs_amount: "0.00", valid_amount: "0.00", currency: { precision: 2, currency: "USD" } },
      sum_credit_balance: { abs_amount: "298.35", valid_amount: "298.35", currency: { precision: 2, currency: "USD" } },
    },
  },
};

function balanceContext(overrides: {
  requestTemplates?: CapturedCookieRequest[];
} = {}): ProviderContext {
  return {
    accountId: "test-account",
    timezone: "Asia/Shanghai",
    settings: {
      kind: "cookie",
      advertiserId: ADVERTISER_ID,
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    },
    credential: {
      kind: "cookie",
      cookie: "sessionid=test-cookie",
      csrfHeaderName: "x-csrftoken",
      csrfToken: "test-csrf",
      requestTemplates: overrides.requestTemplates ?? [{
        target: "ad-group",
        url: `https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=${ADVERTISER_ID}`,
        method: "POST",
        body: "{}",
        contentType: "application/json",
      }],
    },
  } as ProviderContext;
}

/** 按 URL 分派的 fetch 替身，并记录每次请求，便于断言派生是否正确。 */
function stubPaymentFetch(options: {
  account?: unknown;
  summary?: unknown;
  accountStatus?: number;
} = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = undefined;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { /* 非 JSON 请求体 */ }
    calls.push({ url, body });
    if (url.includes("query_payment_account")) {
      const status = options.accountStatus ?? 200;
      if (status !== 200) return new Response("{}", { status, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(options.account ?? PAYMENT_ACCOUNT_RESPONSE), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(options.summary ?? PAYMENT_SUMMARY_RESPONSE), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("账户余额", () => {
  it("两步取余额：先按 adv_id 查 pa_id，再按 adv_id + pa_id 取金额", async () => {
    const calls = stubPaymentFetch();

    const balance = await new CookieAdsProvider().readBalance(balanceContext());

    expect(balance).toMatchObject({
      totalAmount: "298.35",
      cashAmount: "0.00",
      creditAmount: "298.35",
      currency: "USD",
      precision: 2,
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/pa/api/spider/query_payment_account",
      "/pa/api/common/query/payment/query_payment_summary",
    ]);
    expect(calls[0]?.body).toMatchObject({ Context: { adv_id: ADVERTISER_ID }, module_list: [0, 3] });
    expect(calls[1]?.body).toMatchObject({ adv_id: ADVERTISER_ID, pa_id: PA_ID, currency: "USD" });
  });

  it("取 adv_full_balance.sum_total_balance，而不是 pa_full_balance 下的同名字段", async () => {
    // 真机上 pa_full_balance.sum_credit_balance 是 84356.11（作品集总额度），
    // 而本账户余额是 298.35。这两个字段同名同形状，取错在界面上看不出异常。
    stubPaymentFetch();

    const balance = await new CookieAdsProvider().readBalance(balanceContext());

    expect(balance?.totalAmount).toBe("298.35");
    expect(balance?.totalAmount).not.toBe("84356.11");
  });

  it("请求从会话 cURL 派生：Cookie、CSRF、aadvid 全部继承", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      const url = String(_input);
      const payload = url.includes("query_payment_account")
        ? PAYMENT_ACCOUNT_RESPONSE
        : PAYMENT_SUMMARY_RESPONSE;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await new CookieAdsProvider().readBalance(balanceContext());

    expect(headers.cookie).toBe("sessionid=test-cookie");
    expect(headers["x-csrftoken"]).toBe("test-csrf");
  });

  it("金额保持接口返回的十进制字符串，不经过 number 转换", async () => {
    stubPaymentFetch({
      summary: {
        code: 0,
        data: {
          adv_full_balance: {
            sum_total_balance: { abs_amount: "1234567.89", currency: { precision: 2, currency: "USD" } },
            sum_cash_balance: { abs_amount: "0.00" },
            sum_credit_balance: { abs_amount: "1234567.89" },
          },
        },
      },
    });

    const balance = await new CookieAdsProvider().readBalance(balanceContext());

    // 大额金额若中途转成 number 再格式化，容易出现 1234567.8900000001 这类尾差。
    expect(balance?.totalAmount).toBe("1234567.89");
  });
});

describe("账户余额：读不到时不能让别的东西失败", () => {
  it("没有会话 cURL 时返回 undefined，不抛异常", async () => {
    stubPaymentFetch();

    const balance = await new CookieAdsProvider().readBalance(
      balanceContext({ requestTemplates: [] }),
    );

    expect(balance).toBeUndefined();
  });

  it("支付接口报错时返回 undefined，而不是把异常抛给调用方", async () => {
    stubPaymentFetch({ accountStatus: 500 });

    await expect(new CookieAdsProvider().readBalance(balanceContext())).resolves.toBeUndefined();
  });

  it("没有 pa_id 时不再发第二个请求，直接返回 undefined", async () => {
    const calls = stubPaymentFetch({ account: { code: 0, data: { pa_info: {} } } });

    const balance = await new CookieAdsProvider().readBalance(balanceContext());

    expect(balance).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("响应缺少总余额字段时返回 undefined，而不是给出 0", async () => {
    // 报 0 是危险的：余额为 0 会触发充值告警，而真相是「没读到」。两者必须区分。
    stubPaymentFetch({
      summary: { code: 0, data: { adv_full_balance: { sum_cash_balance: { abs_amount: "0.00" } } } },
    });

    const balance = await new CookieAdsProvider().readBalance(balanceContext());

    expect(balance).toBeUndefined();
  });

  it("支付接口返回业务错误码时不抛异常，返回 undefined", async () => {
    // 真机上「该账户没有支付账户」走的是 code != 0，而不是 HTTP 错误。
    stubPaymentFetch({ account: { code: 40001, msg: "no payment account" } });

    await expect(new CookieAdsProvider().readBalance(balanceContext())).resolves.toBeUndefined();
  });
});

describe("账户余额：能力声明", () => {
  it("有会话 cURL 就声明 read-account-balance", () => {
    const provider = new CookieAdsProvider();
    const context = balanceContext();

    expect(provider.resolveCapabilities(context).has("read-account-balance")).toBe(true);
  });

  it("没有会话 cURL 时不声明，界面据此显示不可用而不是给个必然失败的按钮", () => {
    const provider = new CookieAdsProvider();
    const context = balanceContext({ requestTemplates: [] });

    expect(provider.resolveCapabilities(context).has("read-account-balance")).toBe(false);
  });

  it("能力契约版本已升到 v6：不升版本号会让存量账户永远拿不到新能力", () => {
    // 这是 2026-08-25 提额规则踩过的坑：authorizedCapabilities 是上次检测时记下的
    // 集合，版本不升则 contractCurrent 仍为 true、界面不提示重新检测，新能力对存量
    // 账户永久不可用。加能力必须同时改版本号，这里钉死它。
    expect(new CookieAdsProvider().capabilityVersion).toBe("cookie-capabilities-v6-2026-09");
  });
});
