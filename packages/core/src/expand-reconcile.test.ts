import { describe, expect, it } from "vitest";
import { reconcileExpandTask } from "./expand-reconcile.js";

const published = (name: string) => ({ name, adStatus: "ad_audit" });
const draft = (name: string) => ({ name, adStatus: "ad_create" });

describe("拿快照对账「结果未知」的扩组记录", () => {
  it("组名在快照里且已提交审核 → 确认建成", () => {
    expect(reconcileExpandTask(["A-0826-060000-1"], [published("A-0826-060000-1")]))
      .toBe("confirmed");
  });

  // 这条是整个判据的要害。2026-08-25 那批 4 条未知记录，名字在快照里全都找得到，
  // 但其中 1 条只是草稿——只按名字判就会把它误判成成功、清掉红条，而它恰恰是唯一
  // 真正需要人处理的那条。
  it("只建了草稿 → 不算建成，红条必须留着", () => {
    expect(reconcileExpandTask(["A-0826-060000-1"], [draft("A-0826-060000-1")]))
      .toBe("draft-only");
  });

  it("快照里没有 → 不下结论，继续等", () => {
    expect(reconcileExpandTask(["A-0826-060000-1"], [])).toBe("not-found");
    expect(reconcileExpandTask(["A-0826-060000-1"], [published("别的组")])).toBe("not-found");
  });

  // 一条记录可能对应多个组。部分建成也是没建全，清掉记录等于把剩下那些永久藏起来。
  it("多个组只出现一部分 → 不下结论", () => {
    expect(reconcileExpandTask(
      ["A-1", "A-2"],
      [published("A-1")],
    )).toBe("not-found");
  });

  it("多个组里只要有一个是草稿，整条都不算成功", () => {
    expect(reconcileExpandTask(
      ["A-1", "A-2"],
      [published("A-1"), draft("A-2")],
    )).toBe("draft-only");
  });

  it("多个组全部建成才算确认", () => {
    expect(reconcileExpandTask(
      ["A-1", "A-2"],
      [published("A-1"), published("A-2")],
    )).toBe("confirmed");
  });

  // 已经投起来 / 已关停的组同样算建成——它们早就过了草稿阶段。
  it("其他非草稿状态一律算建成", () => {
    for (const status of ["ad_delivery_ok", "ad_disable", "ad_delete", "campaign_disable"]) {
      expect(reconcileExpandTask(["A-1"], [{ name: "A-1", adStatus: status }]))
        .toBe("confirmed");
    }
  });

  it("组名两侧空白不影响匹配", () => {
    expect(reconcileExpandTask([" A-1 "], [{ name: "A-1", adStatus: "ad_audit" }]))
      .toBe("confirmed");
  });

  it("没有记录组名时不下结论", () => {
    expect(reconcileExpandTask([], [published("A-1")])).toBe("not-found");
  });
});

/**
 * 这一组是 2026-08-26 从生产数据里挖出来的真 bug：sketch 草稿根本不出现在广告组列表里
 * （实测 1066 个广告组里 ad_status='ad_create' 一个都没有，而后台有 9 条草稿），所以光看
 * 快照，`draft-only` 这条结论对 sketch 类草稿永远做不出来。
 */
describe("sketch 草稿（不在广告组列表里的那种）", () => {
  it("名字在草稿列表里 → draft-only，哪怕快照里一个都找不到", () => {
    expect(reconcileExpandTask(["A-1"], [], ["A-1"])).toBe("draft-only");
  });

  // 要害：重试过的扩组会留下一个同名的正式组 + 一个同名草稿。只看快照会判 confirmed
  // 把红条清掉，草稿则永久留在后台没人认领——生产上 9 条草稿里有 3 条正处于这个状态。
  it("同名正式组已存在，但草稿也还在 → 仍然是 draft-only", () => {
    expect(reconcileExpandTask(["A-1"], [published("A-1")], ["A-1"])).toBe("draft-only");
    expect(reconcileExpandTask(["A-1"], [{ name: "A-1", adStatus: "ad_delete" }], ["A-1"]))
      .toBe("draft-only");
  });

  it("多个组里只要有一个还是草稿，整条都不算成功", () => {
    expect(reconcileExpandTask(["A-1", "A-2"], [published("A-1"), published("A-2")], ["A-2"]))
      .toBe("draft-only");
  });

  it("草稿列表里没有就回到原来的判法", () => {
    expect(reconcileExpandTask(["A-1"], [published("A-1")], ["别的草稿"])).toBe("confirmed");
    expect(reconcileExpandTask(["A-1"], [], ["别的草稿"])).toBe("not-found");
  });

  it("组名两侧空白不影响匹配", () => {
    expect(reconcileExpandTask([" A-1 "], [published("A-1")], [" A-1 "])).toBe("draft-only");
  });
});
