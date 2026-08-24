import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider } from "./cookie-provider.js";
import type { ProviderContext } from "./types.js";

/**
 * 一轮只读同步里的并发行为。
 *
 * 这里量的是「同时在飞的请求数」而不是耗时：耗时断言在 CI 上必然是不稳定的，而
 * 真正要守住的两件事都能用在飞数直接表达——三层不许再串行等，素材层不许拉满。
 */
function context(): ProviderContext {
  return {
    accountId: "test-account",
    timezone: "Asia/Shanghai",
    settings: {
      kind: "cookie",
      advertiserId: "654321",
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
        target: "ad-group",
        url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=654321",
        method: "POST",
        body: "{}",
        contentType: "application/json",
        derived: false,
      }],
    },
  };
}

/** 每行都有消耗，好让它们全部进素材层。 */
const spendingAdRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    campaign_id: "c1",
    ad_id: "g1",
    creative_id: `spending-ad-${index}`,
    stat_cost: "5",
  }));

interface Peaks {
  list: number;
  material: number;
  listCalls: number;
  materialCalls: number;
}

function stubWithConcurrencyProbe(adRows: Record<string, unknown>[]): Peaks {
  const peaks: Peaks = { list: 0, material: 0, listCalls: 0, materialCalls: 0 };
  let listInFlight = 0;
  let materialInFlight = 0;

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const isMaterial = String(input).includes("expand/material/list");
    if (isMaterial) {
      materialInFlight += 1;
      peaks.materialCalls += 1;
      peaks.material = Math.max(peaks.material, materialInFlight);
    } else {
      listInFlight += 1;
      peaks.listCalls += 1;
      peaks.list = Math.max(peaks.list, listInFlight);
    }
    // 真的让出事件循环，否则每个请求都在同一拍里开始又结束，量不到重叠。
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (isMaterial) materialInFlight -= 1;
    else listInFlight -= 1;
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          table: isMaterial ? [] : adRows,
          pagination: { page: 1, page_count: 1 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }));
  return peaks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("只读同步的并发", () => {
  // 三层互不依赖，串行只是白等：生产实测三层合计 89.8 秒，串行时这就是一轮的下限。
  it("系列、广告组、广告三层同时在飞，而不是排队等", async () => {
    const peaks = stubWithConcurrencyProbe([]);

    await new CookieAdsProvider().syncReadOnly(context());

    expect(peaks.listCalls).toBe(3);
    expect(peaks.list).toBe(3);
  });

  // 上限 40 个广告逐个串行是单轮里最大的一块；但拉满并发会把同一个 Cookie 会话
  // 打到限流，而限流会让整轮降级成 partial，删除和自动复制随即跳过。
  it("素材层限并发，既不串行也不拉满", async () => {
    const peaks = stubWithConcurrencyProbe(spendingAdRows(12));

    await new CookieAdsProvider().syncReadOnly(context());

    expect(peaks.materialCalls).toBe(12);
    expect(peaks.material).toBe(5);
  });

  // 并发不能改变结果：素材层每个广告都要查到，一个都不能因为分批而漏掉。
  it("限并发不漏广告：每个有消耗的广告都查到了", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (String(input).includes("expand/material/list")) {
        const commonReq = body.common_req as Record<string, unknown> | undefined;
        const filters = commonReq?.filters as Array<Record<string, unknown>> | undefined;
        const values = filters?.find((item) => item.field === "creative_id")
          ?.in_field_values as string[] | undefined;
        requested.push(String(values?.[0]));
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: { table: String(input).includes("expand/material/list") ? [] : spendingAdRows(9), pagination: { page: 1, page_count: 1 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }));

    await new CookieAdsProvider().syncReadOnly(context());

    expect(requested.sort()).toEqual(
      spendingAdRows(9).map((row) => row.creative_id).sort(),
    );
  });
});
