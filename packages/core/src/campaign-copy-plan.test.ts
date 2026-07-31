import { describe, expect, it } from "vitest";
import { planCampaignCopy } from "./campaign-copy-plan.js";

const at = new Date("2026-07-30T12:00:00.000Z");
const names = new Map([
  ["src-A", "组A"],
  ["src-B", "组B"],
  ["src-C", "组C"],
]);

function plan(input: {
  campaignCopies: number;
  groupsPerCampaign: number;
  sourceAdGroupIds: string[];
  existingCampaignNames?: string[];
}) {
  return planCampaignCopy({
    sourceCampaignName: "源系列",
    sourceAdGroupNames: names,
    at,
    timeZone: "UTC",
    ...input,
  });
}

describe("planCampaignCopy", () => {
  it("拆分：1 系列 2 组 → 2 系列各 1 组", () => {
    const result = plan({ campaignCopies: 2, groupsPerCampaign: 1, sourceAdGroupIds: ["src-A", "src-B"] });

    expect(result.totalGroups).toBe(2);
    expect(result.campaigns).toHaveLength(2);
    expect(result.campaigns[0]?.campaignName).toBe("源系列-0730-1");
    expect(result.campaigns[1]?.campaignName).toBe("源系列-0730-2");
    // 每个源组各自落到一个独立系列里——这才是 CBO 下真正的放量。
    expect(result.campaigns[0]?.groups.map((group) => group.sourceAdGroupId)).toEqual(["src-A"]);
    expect(result.campaigns[1]?.groups.map((group) => group.sourceAdGroupId)).toEqual(["src-B"]);
  });

  it("整体克隆：每个副本包含全部源组", () => {
    const result = plan({ campaignCopies: 3, groupsPerCampaign: 2, sourceAdGroupIds: ["src-A", "src-B"] });

    expect(result.totalGroups).toBe(6);
    for (const campaign of result.campaigns) {
      expect(campaign.groups.map((group) => group.sourceAdGroupId)).toEqual(["src-A", "src-B"]);
    }
  });

  it("单组放量：一个源组铺满 N 个系列", () => {
    const result = plan({ campaignCopies: 5, groupsPerCampaign: 1, sourceAdGroupIds: ["src-A"] });

    expect(result.campaigns).toHaveLength(5);
    expect(result.campaigns.every((campaign) =>
      campaign.groups.length === 1 && campaign.groups[0]?.sourceAdGroupId === "src-A")).toBe(true);
  });

  it("源组数与槽位数不整除时按顺序轮转", () => {
    const result = plan({ campaignCopies: 3, groupsPerCampaign: 2, sourceAdGroupIds: ["src-A", "src-B", "src-C"] });

    expect(result.campaigns.map((campaign) => campaign.groups.map((group) => group.sourceAdGroupId)))
      .toEqual([
        ["src-A", "src-B"],
        ["src-C", "src-A"],
        ["src-B", "src-C"],
      ]);
  });

  it("所有生成的名称在批内互不重复", () => {
    const result = plan({ campaignCopies: 3, groupsPerCampaign: 2, sourceAdGroupIds: ["src-A", "src-B"] });

    const campaignNames = result.campaigns.map((campaign) => campaign.campaignName);
    expect(new Set(campaignNames).size).toBe(campaignNames.length);

    const groupNames = result.campaigns.flatMap((campaign) => campaign.groups.map((group) => group.name));
    expect(new Set(groupNames).size).toBe(groupNames.length);
  });

  it("系列名序号从账户现状往后接", () => {
    const result = plan({
      campaignCopies: 2,
      groupsPerCampaign: 1,
      sourceAdGroupIds: ["src-A"],
      existingCampaignNames: ["源系列-0730-1", "源系列-0730-2"],
    });

    expect(result.campaigns.map((campaign) => campaign.campaignName))
      .toEqual(["源系列-0730-3", "源系列-0730-4"]);
  });

  it("组名带来源可追溯", () => {
    const result = plan({ campaignCopies: 2, groupsPerCampaign: 1, sourceAdGroupIds: ["src-A", "src-B"] });

    expect(result.campaigns[0]?.groups[0]?.name).toBe("组A-0730-1");
    expect(result.campaigns[1]?.groups[0]?.name).toBe("组B-0730-1");
  });

  it("超过单次 100 组上限时拒绝", () => {
    expect(() => plan({ campaignCopies: 20, groupsPerCampaign: 6, sourceAdGroupIds: ["src-A"] }))
      .toThrow(/最多创建 100 个广告组/);
  });

  it("至少要勾选一个源广告组", () => {
    expect(() => plan({ campaignCopies: 1, groupsPerCampaign: 1, sourceAdGroupIds: [] })).toThrow();
  });
});
