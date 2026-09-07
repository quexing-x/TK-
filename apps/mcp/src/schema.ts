import { z } from "zod";

/**
 * 可空数值参数：接受数字、数字字符串，或 null。
 *
 * 必须 coerce。MCP 走 JSON-RPC，调用方按工具 schema 决定怎么序列化参数，实测
 * agent 传过来的可空数值会是字符串 `"7"`——纯 `z.number()` 直接判失败，`bid`
 * 这类参数就永远只能吃默认值 null，出价根本传不进来，而错误信息只会说
 * 「Expected number, received string」，看不出是这一层的问题。
 *
 * 不能写成 `z.coerce.number().nullable()`：`Number(null)` 是 0，那样 null 会被
 * 悄悄转成 0——对出价和预算来说，0 和「不设置」是两件完全不同的事。用 union 让
 * null 先短路匹配。
 */
export function nullableNumber(options: { positive?: boolean } = {}) {
  const base = options.positive
    ? z.coerce.number().positive()
    : z.coerce.number().nonnegative();
  return z.union([z.null(), base]).default(null);
}
