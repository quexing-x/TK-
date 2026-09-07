/**
 * 落地页的归因参数：导入表里只填域名，创建时由软件统一补上这一串。
 *
 * 放在创建这一层而不是导入那一层，是因为投手要的是「以后改规则立即对所有新建生效」。
 * 写进导入表就等于把当时的规则冻进了每一行历史计划里。
 */

/**
 * `__CAMPAIGN_ID__` / `__CAMPAIGN_NAME__` 是 TikTok 的投放期宏，由 TikTok 在跳转时替换成
 * 真实的系列 ID 和名称。
 *
 * **绝不能对它们做 URL 编码。** 编码后下划线虽然不变，但任何把 URL 拆开再用
 * `URLSearchParams` 重新序列化的写法都会顺手改动其它部分（空格变 +、已编码的字符被二次
 * 编码），TikTok 拿到的宏就不再是它认得的字面量。所以这里全程按字符串拼接，不解析、不重组。
 */
export const LANDING_PAGE_TRACKING_PARAMS =
  "utm_source=tiktok&utm_medium=paid&utm_id=__CAMPAIGN_ID__&utm_campaign=__CAMPAIGN_NAME__";

/**
 * 把归因参数拼到落地页后面。
 *
 * 幂等：已经带了 `utm_source` 的 URL 原样返回。投手手工填了全串、或同一行被重试第二次时，
 * 重复拼会让 GA 那边收到两个 utm_source——TikTok 不报错，取哪个值是未定义的。
 */
export function appendTrackingParams(url: string | null | undefined): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return "";
  if (/[?&]utm_source=/i.test(trimmed)) return trimmed;

  // 锚点必须留在最末尾。`a.com/p#tab` 拼成 `a.com/p#tab?utm_source=...` 的话，整串参数
  // 都落进 fragment 里——浏览器根本不会把它发给服务端，归因静默丢失。
  const hashAt = trimmed.indexOf("#");
  const base = hashAt === -1 ? trimmed : trimmed.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : trimmed.slice(hashAt);

  let separator: string;
  if (!base.includes("?")) separator = "?";
  // `a.com/p?` 和 `a.com/p?x=1&` 这种末尾已经有分隔符的，再补一个会拼出空参数。
  else if (base.endsWith("?") || base.endsWith("&")) separator = "";
  else separator = "&";

  return `${base}${separator}${LANDING_PAGE_TRACKING_PARAMS}${hash}`;
}
