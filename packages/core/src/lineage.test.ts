import { describe, expect, it } from "vitest";
import {
  brandRootName,
  buildLineageReport,
  checkNames,
  collectReservedNames,
  hasGeneratedNameSuffix,
  type LineageCopyTaskInput,
  type LineageEntityInput,
  type LineageExpandTaskInput,
} from "./lineage.js";

const campaign = (
  externalId: string,
  name: string,
  over: Partial<LineageEntityInput> = {},
): LineageEntityInput => ({
  entityType: "campaign",
  externalId,
  name,
  status: "enabled",
  parentCampaignId: null,
  createdAt: "2026-08-05T10:00:00.000Z",
  ...over,
});

const adGroup = (
  externalId: string,
  name: string,
  over: Partial<LineageEntityInput> = {},
): LineageEntityInput => ({
  entityType: "ad-group",
  externalId,
  name,
  status: "enabled",
  parentCampaignId: "c1",
  createdAt: "2026-08-05T10:00:00.000Z",
  ...over,
});

const expandTask = (
  over: Partial<LineageExpandTaskInput> = {},
): LineageExpandTaskInput => ({
  taskKey: "expand-1",
  sourceAdGroupId: "g-origin",
  sourceCampaignId: "c1",
  generatedIds: [],
  generatedNames: [],
  status: "succeeded",
  uncertain: false,
  updatedAt: "2026-08-12T09:15:30.000Z",
  ...over,
});

const copyTask = (
  over: Partial<LineageCopyTaskInput> = {},
): LineageCopyTaskInput => ({
  taskKey: "copy-1",
  sourceCampaignId: "c-origin",
  campaignName: "八寶茶",
  generatedCampaignId: null,
  generatedAdGroupIds: [],
  generatedAdGroupNames: [],
  status: "succeeded",
  uncertain: false,
  updatedAt: "2026-08-05T14:30:52.000Z",
  ...over,
});

describe("品根名", () => {
  it("剥掉扩组与复制生成的后缀", () => {
    expect(brandRootName("八寶茶-0805-143052")).toBe("八寶茶");
    expect(brandRootName("八寶茶-0812-091530-1")).toBe("八寶茶");
    expect(brandRootName("八寶茶")).toBe("八寶茶");
  });

  it("不做品名模糊归并：根名不同就是不同品", () => {
    // 这三条在真实账户里同时存在，靠名字猜品会把它们错并成一个。
    expect(brandRootName("DM003142八寶人蔘枸杞茶")).toBe("DM003142八寶人蔘枸杞茶");
    expect(brandRootName("八寶人蔘枸杞茶")).toBe("八寶人蔘枸杞茶");
    expect(brandRootName("八寶茶")).toBe("八寶茶");
  });

  it("认得出名字带没带自动后缀", () => {
    expect(hasGeneratedNameSuffix("八寶茶-0805-143052")).toBe(true);
    expect(hasGeneratedNameSuffix("八寶茶")).toBe(false);
    // 用户手工起的带横线名字不该被当成自动后缀。
    expect(hasGeneratedNameSuffix("夏季促销-主推款")).toBe(false);
  });
});

describe("谱系判定", () => {
  it("名字剥不出后缀又没有任务记录的是原组", () => {
    const report = buildLineageReport({ entities: [adGroup("g1", "八寶茶")] });
    const node = report.brands[0]?.adGroups[0];
    expect(node?.origin).toBe("original");
    expect(node?.confidence).toBe("inferred");
    expect(node?.sourceId).toBeNull();
  });

  it("ID 出现在扩组产物里就是确证的扩组产物", () => {
    const report = buildLineageReport({
      entities: [adGroup("g-origin", "八寶茶"), adGroup("g2", "八寶茶-0812-091530-1")],
      expandTasks: [expandTask({ generatedIds: ["g2"], generatedNames: ["八寶茶-0812-091530-1"] })],
    });
    const node = report.brands[0]?.adGroups.find((item) => item.externalId === "g2");
    expect(node?.origin).toBe("expanded");
    expect(node?.confidence).toBe("confirmed");
    expect(node?.matchedBy).toBe("id");
    expect(node?.sourceId).toBe("g-origin");
    expect(node?.sourceName).toBe("八寶茶");
    expect(node?.taskKey).toBe("expand-1");
  });

  it("产物 ID 缺失时按名字认，并标明是靠名字对上的", () => {
    // 发布失败/结果未知的任务只写下了名字。名字带秒级时间戳、账户内唯一，对上就是它。
    const report = buildLineageReport({
      entities: [adGroup("g-origin", "八寶茶"), adGroup("g2", "八寶茶-0812-091530-1")],
      expandTasks: [expandTask({ generatedIds: [], generatedNames: ["八寶茶-0812-091530-1"] })],
    });
    const node = report.brands[0]?.adGroups.find((item) => item.externalId === "g2");
    expect(node?.origin).toBe("expanded");
    expect(node?.confidence).toBe("confirmed");
    expect(node?.matchedBy).toBe("name");
    expect(node?.sourceId).toBe("g-origin");
  });

  it("名字像生成的但查不到任务记录时只敢说推断", () => {
    // 操作历史只保留 30 天，更早的记录已被清理：知道它是生成的，不知道从谁生成。
    const report = buildLineageReport({
      entities: [adGroup("g2", "八寶茶-0612-091530-1")],
    });
    const node = report.brands[0]?.adGroups[0];
    expect(node?.origin).toBe("generated-unknown-source");
    expect(node?.confidence).toBe("inferred");
    expect(node?.sourceId).toBeNull();
    expect(node?.ancestorIds).toEqual([]);
  });

  it("系列复制同时认下新系列和它下面的广告组", () => {
    const report = buildLineageReport({
      entities: [
        campaign("c-origin", "八寶茶"),
        campaign("c2", "八寶茶-0805-143052"),
        adGroup("g2", "八寶茶-0805-143052-1", { parentCampaignId: "c2" }),
      ],
      copyTasks: [copyTask({
        generatedCampaignId: "c2",
        generatedAdGroupIds: ["g2"],
        generatedAdGroupNames: ["八寶茶-0805-143052-1"],
      })],
    });
    const brand = report.brands.find((item) => item.rootName === "八寶茶");
    expect(brand?.campaigns.find((item) => item.externalId === "c2")?.origin).toBe("copied");
    expect(brand?.adGroups.find((item) => item.externalId === "g2")?.origin).toBe("copied");
  });

  it("多轮重扩串成一条祖先链", () => {
    const report = buildLineageReport({
      entities: [
        adGroup("g1", "八寶茶"),
        adGroup("g2", "八寶茶-0805-143052-1"),
        adGroup("g3", "八寶茶-0812-091530-1"),
      ],
      expandTasks: [
        expandTask({ taskKey: "e2", sourceAdGroupId: "g2", generatedIds: ["g3"] }),
        expandTask({ taskKey: "e1", sourceAdGroupId: "g1", generatedIds: ["g2"] }),
      ],
    });
    const brand = report.brands.find((item) => item.rootName === "八寶茶");
    const third = brand?.adGroups.find((item) => item.externalId === "g3");
    expect(third?.sourceId).toBe("g2");
    expect(third?.ancestorIds).toEqual(["g2", "g1"]);
    // 原组排在最前面：读的人第一眼要看到源头。
    expect(brand?.adGroups[0]?.externalId).toBe("g1");
  });

  it("同一个品的多轮重扩归到同一根名下", () => {
    const report = buildLineageReport({
      entities: [
        adGroup("g1", "八寶茶"),
        adGroup("g2", "八寶茶-0805-143052-1"),
        adGroup("g3", "八寶茶-0812-091530-1"),
        adGroup("g4", "隨身wifi"),
      ],
    });
    expect(report.brands.map((brand) => brand.rootName)).toEqual(["八寶茶", "隨身wifi"]);
    expect(report.brands[0]?.adGroups).toHaveLength(3);
  });

  it("源指向自己的脏匹配不算数，也不会转成环", () => {
    const report = buildLineageReport({
      entities: [adGroup("g1", "八寶茶-0805-143052-1")],
      expandTasks: [expandTask({
        sourceAdGroupId: "g1",
        generatedNames: ["八寶茶-0805-143052-1"],
      })],
    });
    const node = report.brands[0]?.adGroups[0];
    expect(node?.origin).toBe("generated-unknown-source");
    expect(node?.sourceId).toBeNull();
  });

  it("互指的环不会让回溯挂住", () => {
    const report = buildLineageReport({
      entities: [adGroup("g1", "A-0805-143052-1"), adGroup("g2", "A-0812-091530-1")],
      expandTasks: [
        expandTask({ taskKey: "e1", sourceAdGroupId: "g2", generatedIds: ["g1"] }),
        expandTask({ taskKey: "e2", sourceAdGroupId: "g1", generatedIds: ["g2"] }),
      ],
    });
    const first = report.brands[0]?.adGroups.find((item) => item.externalId === "g1");
    expect(first?.ancestorIds).toEqual(["g2", "g1"]);
  });

  it("源已被删时沿用任务里记下的源名", () => {
    const report = buildLineageReport({
      entities: [campaign("c2", "八寶茶-0805-143052")],
      copyTasks: [copyTask({ campaignName: "八寶茶原始", generatedCampaignId: "c2" })],
    });
    expect(report.brands[0]?.campaigns[0]?.sourceName).toBe("八寶茶原始");
  });
});

describe("脏数据与重名", () => {
  it("诊断、空名和名为 0 的系列不参与归并", () => {
    const report = buildLineageReport({
      entities: [
        campaign("c1", "诊断0823E-选25到34"),
        campaign("c2", "0"),
        campaign("c3", "八寶茶"),
      ],
    });
    expect(report.brands.map((brand) => brand.rootName)).toEqual(["八寶茶"]);
    expect(report.nonOperational.map((node) => node.externalId).sort()).toEqual(["c1", "c2"]);
  });

  it("列出账户内的同名系列", () => {
    const report = buildLineageReport({
      entities: [campaign("c1", "八寶茶"), campaign("c2", "八寶茶"), campaign("c3", "隨身wifi")],
    });
    expect(report.duplicateCampaignNames).toEqual([
      { name: "八寶茶", parentCampaignId: null, externalIds: ["c1", "c2"] },
    ]);
  });

  it("广告组重名按所属系列分别判定", () => {
    const report = buildLineageReport({
      entities: [
        adGroup("g1", "主推组", { parentCampaignId: "c1" }),
        adGroup("g2", "主推组", { parentCampaignId: "c1" }),
        // 另一条系列下的同名组不构成冲突。
        adGroup("g3", "主推组", { parentCampaignId: "c2" }),
      ],
    });
    expect(report.duplicateAdGroupNames).toEqual([
      { name: "主推组", parentCampaignId: "c1", externalIds: ["g1", "g2"] },
    ]);
  });

  it("结果未知的任务单独列出来", () => {
    const report = buildLineageReport({
      entities: [],
      expandTasks: [expandTask({
        uncertain: true,
        generatedNames: ["八寶茶-0812-091530-1"],
      })],
    });
    expect(report.uncertainTasks).toEqual([{
      taskKey: "expand-1",
      kind: "expand",
      sourceId: "g-origin",
      generatedNames: ["八寶茶-0812-091530-1"],
      updatedAt: "2026-08-12T09:15:30.000Z",
    }]);
  });
});

describe("名称占用", () => {
  it("已占用的名字包含快照之外、只在任务记录里的产物名", () => {
    // 刚建好、还没被同步捕获的对象在快照里查不到，但名字已经在线上占住了。
    const reserved = collectReservedNames({
      entities: [adGroup("g1", "八寶茶")],
      expandTasks: [expandTask({ generatedNames: ["八寶茶-0812-091530-1"] })],
    });
    expect([...reserved.adGroupNames].sort()).toEqual(["八寶茶", "八寶茶-0812-091530-1"]);
  });

  it("结果未知的任务占的名字同样不能再用", () => {
    const reserved = collectReservedNames({
      entities: [],
      copyTasks: [copyTask({
        uncertain: true,
        generatedAdGroupNames: ["八寶茶-0805-143052-1"],
      })],
    });
    expect(reserved.adGroupNames.has("八寶茶-0805-143052-1")).toBe(true);
  });

  it("逐个报告可用、账户已占用和批内自撞", () => {
    const input = { entities: [campaign("c1", "八寶茶")] };
    expect(checkNames(input, [
      { name: "八寶茶", entityType: "campaign" },
      { name: "隨身wifi", entityType: "campaign" },
      { name: "隨身wifi", entityType: "campaign" },
    ])).toEqual([
      { name: "八寶茶", entityType: "campaign", availability: "taken-in-account", conflictingIds: ["c1"] },
      { name: "隨身wifi", entityType: "campaign", availability: "available", conflictingIds: [] },
      { name: "隨身wifi", entityType: "campaign", availability: "duplicate-in-batch", conflictingIds: [] },
    ]);
  });

  it("系列名与广告组名各自独立判定", () => {
    const input = { entities: [campaign("c1", "八寶茶")] };
    const [result] = checkNames(input, [{ name: "八寶茶", entityType: "ad-group" }]);
    expect(result?.availability).toBe("available");
  });
});
