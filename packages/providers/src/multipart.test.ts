import { describe, expect, it } from "vitest";
import { parseMultipartFields, rewriteMultipartFields } from "./multipart.js";

function multipartBody(fields: Array<[string, string]>, boundary = "----test"): string {
  const parts = fields.map(([name, value]) =>
    [`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, "", value].join("\r\n"),
  );
  return [...parts, `--${boundary}--`].join("\r\n");
}

describe("rewriteMultipartFields", () => {
  it("matched counts every field the transform claimed, even with zero text diff", () => {
    // 这正是 2026-08-01 的真实故障：目标广告组的 ID 恰好等于导入 cURL 时模板里
    // 已经写死的那个 ID，替换后文本和原文本完全一样。字段确实被找到了，只是
    // 没有产生任何文本差异——matched 必须仍然计为 1。
    const body = multipartBody([
      ["ad_list", '["1872212575167490"]'],
      ["operation", "DISABLE"],
    ]);
    const result = rewriteMultipartFields(body, (field) =>
      field.name === "ad_list" ? { value: '["1872212575167490"]' } : undefined,
    );
    expect(result.matched).toBe(1);
    expect(result.changes).toBe(0);
    expect(result.body).toBe(body);
  });

  it("changes stays a pure text-diff counter, independent from matched", () => {
    const body = multipartBody([["ad_list", '["111"]']]);
    const result = rewriteMultipartFields(body, (field) =>
      field.name === "ad_list" ? { value: '["222"]' } : undefined,
    );
    expect(result.matched).toBe(1);
    expect(result.changes).toBe(1);
    expect(result.body).toContain('["222"]');
    expect(result.body).not.toContain('["111"]');
  });

  it("matched is 0 when the transform genuinely finds nothing", () => {
    const body = multipartBody([["operation", "DISABLE"]]);
    const result = rewriteMultipartFields(body, (field) =>
      field.name === "ad_list" ? { value: "irrelevant" } : undefined,
    );
    expect(result.matched).toBe(0);
    expect(result.changes).toBe(0);
  });

  it("a rename to the same name is still matched but produces no change", () => {
    const body = multipartBody([["ad_list", "111"]]);
    const result = rewriteMultipartFields(body, (field) => ({ name: field.name }));
    expect(result.matched).toBe(1);
    expect(result.changes).toBe(0);
  });

  it("preserves unrelated fields and multiple matches independently", () => {
    const body = multipartBody([
      ["ad_list", '["1"]'],
      ["ad_list", '["1"]'],
      ["operation", "DISABLE"],
    ]);
    const result = rewriteMultipartFields(body, (field) =>
      field.name === "ad_list" ? { value: '["9"]' } : undefined,
    );
    expect(result.matched).toBe(2);
    expect(result.changes).toBe(2);
    expect(parseMultipartFields(result.body).filter((f) => f.name === "ad_list")
      .every((f) => f.value === '["9"]')).toBe(true);
  });
});
