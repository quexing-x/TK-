import { describe, expect, it } from "vitest";
import {
  buildExpandConfirmMessage,
  describeExpandConflicts,
  type ExpandConflict,
} from "./ExpandGroupsPanel";

const base: ExpandConflict = {
  accountId: "account-1",
  sourceAdGroupId: "adgroup-1",
  sourceAdGroupName: "蓝牙音响",
  inProgress: null,
  expandedToday: null,
  existingNames: [],
};

describe("扩组重复提交的确认文案", () => {
  it("进行中与待人工确认分别说清楚，后者要点明需要人工核实", () => {
    const [running] = describeExpandConflicts([{
      ...base,
      inProgress: { kind: "running", since: "2026-08-22T02:00:00.000Z" },
    }]);
    expect(running).toContain("蓝牙音响");
    expect(running).toContain("仍在执行中");

    const [pending] = describeExpandConflicts([{
      ...base,
      inProgress: { kind: "pending-confirmation", since: "2026-08-22T02:00:00.000Z" },
    }]);
    expect(pending).toContain("待人工确认");
  });

  it("今天扩过几次、共几个组都要给出来，只说「重复」等于没说", () => {
    const [line] = describeExpandConflicts([{
      ...base,
      expandedToday: { batches: 2, groups: 3, names: ["蓝牙音响-0822-101500-1"] },
    }]);
    expect(line).toContain("今天已扩过 2 次");
    expect(line).toContain("共 3 个组");
  });

  it("已有组名最多列三个，其余折成计数，避免弹窗被几十个名字撑爆", () => {
    const [line] = describeExpandConflicts([{
      ...base,
      existingNames: ["组-1", "组-2", "组-3", "组-4", "组-5"],
    }]);
    expect(line).toContain("组-1、组-2、组-3");
    expect(line).not.toContain("组-4");
    expect(line).toContain("等 5 个");
  });

  it("多个原因合并进同一行，用户一眼看到这个源组的全部情况", () => {
    const [line] = describeExpandConflicts([{
      ...base,
      inProgress: { kind: "running", since: "2026-08-22T02:00:00.000Z" },
      expandedToday: { batches: 1, groups: 2, names: [] },
      existingNames: ["组-1"],
    }]);
    expect(line).toContain("仍在执行中");
    expect(line).toContain("今天已扩过 1 次");
    expect(line).toContain("已有同日组名");
  });

  it("没有冲突时返回空数组：无谓的弹窗会把真提示训练成无脑点确认", () => {
    expect(describeExpandConflicts([])).toEqual([]);
  });

  it("确认文案要说清这一次还要建多少个，立即投放另外点明", () => {
    const message = buildExpandConfirmMessage({
      conflictLines: ["· 蓝牙音响：今天已扩过 1 次、共 2 个组"],
      sourceCount: 3,
      countPerSource: 2,
      immediate: true,
    });
    expect(message).toContain("1 个源组已经有进行中或今天扩过的记录");
    expect(message).toContain("· 蓝牙音响：今天已扩过 1 次、共 2 个组");
    expect(message).toContain("为 3 个源组各创建 2 个新组（共 6 个）");
    expect(message).toContain("立即开始投放");
    // 逐条列出必须靠换行，弹窗样式已配 white-space: pre-line。
    expect(message.split("\n").length).toBeGreaterThan(3);
  });

  it("定时投放不提「立即开始投放」，免得把人吓住", () => {
    const message = buildExpandConfirmMessage({
      conflictLines: ["· 蓝牙音响：今天已扩过 1 次、共 2 个组"],
      sourceCount: 1,
      countPerSource: 1,
      immediate: false,
    });
    expect(message).not.toContain("立即开始投放");
  });
});

describe("确认弹窗的长度控制", () => {
  it("冲突很多时只列前 8 条，其余折成计数——否则弹窗会把按钮顶出屏幕", () => {
    const lines = Array.from({ length: 20 }, (_unused, index) => `· 源组${index + 1}：今天已扩过 1 次、共 1 个组`);
    const message = buildExpandConfirmMessage({
      conflictLines: lines, sourceCount: 20, countPerSource: 1, immediate: false,
    });

    expect(message).toContain("20 个源组已经有进行中或今天扩过的记录");
    expect(message).toContain("· 源组8：");
    expect(message).not.toContain("· 源组9：");
    expect(message).toContain("另有 12 个源组同样有记录");
    // 行数受控：标题 + 8 条 + 折叠行 + 空行 + 结论
    expect(message.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("不超过上限时不显示折叠行", () => {
    const message = buildExpandConfirmMessage({
      conflictLines: ["· 源组1：今天已扩过 1 次、共 1 个组"],
      sourceCount: 1, countPerSource: 1, immediate: false,
    });
    expect(message).not.toContain("另有");
  });
});
