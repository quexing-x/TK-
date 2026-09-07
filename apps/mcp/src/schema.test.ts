import { describe, expect, it } from "vitest";
import { nullableNumber } from "./schema.js";

describe("可空数值参数", () => {
  // 这是这个 helper 存在的全部理由：实测 agent through MCP 传过来的可空数值是
  // 字符串，纯 z.number() 会判失败，出价永远吃不到用户给的值。
  it("接受数字字符串", () => {
    expect(nullableNumber().parse("7")).toBe(7);
    expect(nullableNumber().parse("7.5")).toBe(7.5);
  });

  it("接受数字本身", () => {
    expect(nullableNumber().parse(7)).toBe(7);
  });

  // 最要紧的一条：Number(null) 是 0，所以 z.coerce.number().nullable() 会把
  // 「不设置出价」悄悄变成「出价 0」。这两件事对投放是天差地别。
  it("null 保持 null，绝不变成 0", () => {
    expect(nullableNumber().parse(null)).toBeNull();
    expect(nullableNumber({ positive: true }).parse(null)).toBeNull();
  });

  it("不传时默认 null", () => {
    expect(nullableNumber().parse(undefined)).toBeNull();
  });

  it("positive 模式拒绝 0 和负数", () => {
    expect(() => nullableNumber({ positive: true }).parse("0")).toThrow();
    expect(() => nullableNumber({ positive: true }).parse(-1)).toThrow();
  });

  // 出价允许 0（不出价），预算不允许——两者的边界不一样。
  it("非 positive 模式允许 0，拒绝负数", () => {
    expect(nullableNumber().parse("0")).toBe(0);
    expect(() => nullableNumber().parse(-1)).toThrow();
  });

  it("拒绝非数值字符串", () => {
    expect(() => nullableNumber().parse("abc")).toThrow();
  });
});
