import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateTimeSuffix, type ProviderEntity, type SyncEntityType } from "@tk-auto/core";
import type { SyncDataQualityStatus } from "@tk-auto/core";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type AppealMutation,
  type AdsProvider,
  type DeleteAdGroupMutation,
  type ProviderContext,
  type StatusMutation,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import {
  AutomationScheduler,
  AutomationService,
  isOvernightBlackout,
  suppressedAutomationActions,
  type PollNotificationDispatcher,
} from "./automation-service.js";

function dateKeyInTimeZoneForTest(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function futureShanghaiTime(hour: number, minute = 0): Date {
  const value = new Date(Date.now() + 24 * 60 * 60_000);
  value.setUTCHours((hour + 16) % 24, minute, 0, 0);
  return value;
}

class FakeProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly platform = "tiktok" as const;
  readonly implementationStatus = "available" as const;
  readonly displayName = "Fake Cookie";
  readonly capabilityVersion = "fake-cookie-v1";
  readonly capabilities = new Set(["read-campaigns", "read-ad-groups", "change-status", "appeal-ads", "copy-ads", "delete-ad-groups"] as const);
  readonly mutations: StatusMutation[] = [];
  readonly appeals: AppealMutation[] = [];
  readonly appealOutcomes: boolean[] = [];
  readonly deletions: DeleteAdGroupMutation[] = [];
  deleteFailureKind: "retryable" | "unknown" | null = null;
  shouldFail = false;
  statusFailureKind: "retryable" | "unknown" | null = null;
  throwStatusError = false;
  statusDelayMs = 0;
  adGroupStatus = "enable";
  priorityHighStatus = "enable";
  shouldSyncFail = false;
  ignoreStatusWrites = false;
  failReadbackAfterStatus = false;
  failNextSync = false;
  afterSync: (() => void | Promise<void>) | null = null;
  campaignCreatedAt = new Date().toISOString();
  scheduledStartAt = "2026-07-19T00:00:00.000Z";
  adGroupConversions = 0;
  adGroupCpa: number | null = null;
  adGroupCpc = 1.5;
  adGroupCarts = 0;
  adGroupSpend = 20;
  scenario: "default" | "parent-child" | "campaign-parent-child" | "disabled-parent" | "priority" | "recovery" | "appeal" | "ad-switch" | "material" | "material-closed-parent" = "default";
  qualityStatus: SyncDataQualityStatus = "healthy";
  completeEntityTypes: SyncEntityType[] | undefined = undefined;
  partialFailures: string[] | undefined = undefined;
  materialUnavailableAdIds: string[] | undefined = undefined;
  materialStatus = "enable";
  syncCount = 0;

  async checkHealth(): Promise<{
    ok: boolean;
    status: "ready" | "failed";
    message: string;
  }> {
    return { ok: true, status: "ready" as const, message: "ready" };
  }

  async syncReadOnly() {
    this.syncCount += 1;
    if (this.failNextSync) {
      this.failNextSync = false;
      throw new Error("post-write sync unavailable");
    }
    if (this.shouldSyncFail) throw new Error("sync unavailable");
    const campaign: ProviderEntity = {
      entityType: "campaign",
      externalId: "campaign-1",
      payload: {
        campaign_id: "campaign-1",
        campaign_name: "测试推广系列",
        campaign_status: "enable",
        create_time: this.campaignCreatedAt,
      },
    };
    const defaultGroup: ProviderEntity = {
      entityType: "ad-group",
      externalId: "adgroup-1",
      payload: {
        campaign_id: "campaign-1",
        ad_name: "测试广告组",
        ad_primary_status: this.adGroupStatus,
        create_time: this.campaignCreatedAt,
        start_time: this.scheduledStartAt,
        row_data: {
          campaign_id: "campaign-1",
          stat_cost: String(this.adGroupSpend),
          cpc: String(this.adGroupCpc),
          click_cnt: "10",
          time_attr_convert_cnt: String(this.adGroupConversions),
          ...(this.adGroupCpa === null
            ? {}
            : { time_attr_conversion_cost: String(this.adGroupCpa) }),
          time_attr_on_web_cart: String(this.adGroupCarts),
        },
      },
    };
    const entities: ProviderEntity[] = [campaign, defaultGroup];
    if (this.scenario === "campaign-parent-child") {
      campaign.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "1.5",
        time_attr_convert_cnt: "0",
        time_attr_on_web_cart: "0",
      };
      defaultGroup.payload.ad_primary_status = "disable";
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "0.1",
        time_attr_convert_cnt: "1",
        time_attr_conversion_cost: "1",
        time_attr_on_web_cart: "1",
      };
    }
    if (this.scenario === "recovery") {
      defaultGroup.payload.ad_primary_status = this.adGroupStatus;
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "0.1",
        click_cnt: "10",
        time_attr_convert_cnt: "1",
        time_attr_conversion_cost: "1",
        time_attr_on_web_cart: "1",
      };
    }
    if (this.scenario === "disabled-parent") {
      campaign.payload.campaign_status = "disable";
      defaultGroup.payload.ad_primary_status = "disable";
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "0.1",
        click_cnt: "10",
        time_attr_convert_cnt: "1",
        time_attr_conversion_cost: "1",
        time_attr_on_web_cart: "1",
      };
    }
    // 一条开着的素材，指标差到规则一定想关它。广告组与广告都保持开启，确认规则
    // 动的是素材本身而不是上层。
    if (this.scenario === "material") {
      defaultGroup.payload.ad_primary_status = "enabled";
      // 广告组本身指标健康：否则它同一轮里也会被判关，父子冲突规则会把子级跳过，
      // 就测不到"规则动的是素材"。
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "0.1",
        click_cnt: "200",
        time_attr_convert_cnt: "5",
        time_attr_conversion_cost: "4",
        time_attr_on_web_cart: "5",
      };
      entities.push({
        entityType: "material",
        externalId: "1872777743628513",
        payload: {
          campaign_id: "campaign-1",
          // 素材行里广告组落在 ad_id 上，同步时回填成 adgroup_id。
          ad_id: "adgroup-1",
          adgroup_id: "adgroup-1",
          creative_id: "ad-1",
          main_entity_name: "测试素材",
          material_primary_status: this.materialStatus === "disable" ? "disabled" : "delivery_ok",
          row_data: {
            campaign_id: "campaign-1",
            adgroup_id: "adgroup-1",
            stat_cost: "50",
            cpc: "2",
            click_cnt: "25",
            time_attr_convert_cnt: "0",
            time_attr_on_web_cart: "0",
          },
        },
      });
    }
    // 关停广告组 + 其下一条同样关停、但指标满足开启规则的素材。广告组自身指标
    // 不满足任何开启规则，所以它这一轮不会成为 enable 候选、保持关停；用来验证
    // 不会向一个关停广告组内部的素材发 enable（否则造出「组关着、素材开着」）。
    if (this.scenario === "material-closed-parent") {
      defaultGroup.payload.ad_primary_status = "disable";
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "0",
        cpc: "0",
        click_cnt: "0",
        time_attr_convert_cnt: "0",
        time_attr_on_web_cart: "0",
      };
      entities.push({
        entityType: "material",
        externalId: "1872777743628513",
        payload: {
          campaign_id: "campaign-1",
          ad_id: "adgroup-1",
          adgroup_id: "adgroup-1",
          creative_id: "ad-1",
          main_entity_name: "测试素材",
          // 关停状态：开启方向才有意义。指标命中 HAS_CART_OPEN（消耗≥1、加购≥1）。
          material_primary_status: "disabled",
          row_data: {
            campaign_id: "campaign-1",
            adgroup_id: "adgroup-1",
            stat_cost: "5",
            cpc: "0.2",
            click_cnt: "25",
            time_attr_convert_cnt: "1",
            time_attr_conversion_cost: "5",
            time_attr_on_web_cart: "3",
          },
        },
      });
    }
    // 一个开着的广告，指标差到规则一定想关它——用来验证广告总开关不会被自动关掉。
    if (this.scenario === "ad-switch") {
      defaultGroup.payload.ad_primary_status = this.adGroupStatus;
      entities.push({
        entityType: "ad",
        externalId: "ad-1",
        payload: {
          campaign_id: "campaign-1",
          adgroup_id: "adgroup-1",
          ad_name: "测试广告",
          ad_primary_status: "enabled",
          creative_primary_status: "delivery_ok",
          row_data: {
            campaign_id: "campaign-1",
            adgroup_id: "adgroup-1",
            stat_cost: "50",
            cpc: "2",
            click_cnt: "25",
            time_attr_convert_cnt: "0",
            time_attr_on_web_cart: "0",
          },
        },
      });
    }
    if (this.scenario === "parent-child") {
      entities.push({
        entityType: "ad",
        externalId: "ad-1",
        payload: {
          campaign_id: "campaign-1",
          adgroup_id: "adgroup-1",
          ad_name: "测试子广告",
          ad_primary_status: "disable",
          row_data: {
            campaign_id: "campaign-1",
            adgroup_id: "adgroup-1",
            stat_cost: "5",
            cpc: "0.5",
            time_attr_convert_cnt: "1",
            time_attr_conversion_cost: "5",
            time_attr_on_web_cart: "1",
          },
        },
      });
    }
    if (this.scenario === "appeal") {
      entities.push({
        entityType: "ad",
        externalId: "ad-appeal-1",
        payload: {
          // 真机上广告实体的 ad_id / adgroup_id 装的是**广告组**，creative_id 才是
          // 广告自己。三者写成不同值，申诉报文取错字段才测得出来。
          ad_id: "adgroup-appeal-1",
          adgroup_id: "adgroup-appeal-1",
          creative_id: "creative-appeal-1",
          creative_status: "creative_offline_audit",
        },
      });
    }
    if (this.scenario === "priority") {
      defaultGroup.externalId = "adgroup-low-priority";
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "3",
        cpc: "0.4",
        time_attr_convert_cnt: "0",
        time_attr_on_web_cart: "0",
      };
      entities.push({
        entityType: "ad-group",
        externalId: "adgroup-high-priority",
        payload: {
          campaign_id: "campaign-1",
          ad_name: "高优先级广告组",
          ad_primary_status: this.priorityHighStatus,
          create_time: this.campaignCreatedAt,
          start_time: this.scheduledStartAt,
          row_data: {
            campaign_id: "campaign-1",
            stat_cost: "5",
            cpc: "1",
            click_cnt: "10",
            time_attr_convert_cnt: "1",
            time_attr_conversion_cost: "5",
            time_attr_on_web_cart: "1",
          },
        },
      });
    }
    const now = new Date().toISOString();
    await this.afterSync?.();
    return {
      entities,
      result: {
        startedAt: now,
        finishedAt: now,
        counts: {
          campaign: entities.filter((entity) => entity.entityType === "campaign").length,
          "ad-group": entities.filter((entity) => entity.entityType === "ad-group").length,
          ad: entities.filter((entity) => entity.entityType === "ad").length,
          material: entities.filter((entity) => entity.entityType === "material").length,
        },
        warnings: [],
        quality: {
          status: this.qualityStatus,
          paginationComplete: this.qualityStatus === "healthy",
          requiredMetricsComplete: this.qualityStatus === "healthy",
          contractValid: this.qualityStatus !== "invalid",
          providerContractVersion: "test-v1",
          coverage: {
            startDate: dateKeyInTimeZoneForTest(new Date(now), "Asia/Shanghai"),
            endDate: dateKeyInTimeZoneForTest(new Date(now), "Asia/Shanghai"),
            timezone: "Asia/Shanghai",
          },
          missingMetrics: this.qualityStatus === "healthy" ? [] : ["cost_per_conversion"],
          partialFailures: this.partialFailures
            ?? (this.qualityStatus === "healthy" ? [] : ["test-quality"]),
          // 素材层只覆盖"当天有消耗的广告"，不跟着 healthy 无条件刷新，本轮取全了
          // 才声明——真 Provider 也是这么写的。
          ...(this.completeEntityTypes
            ? { completeEntityTypes: this.completeEntityTypes }
            : entities.some((entity) => entity.entityType === "material")
              ? { completeEntityTypes: ["material" as const] }
              : {}),
          ...(this.materialUnavailableAdIds
            ? { materialUnavailableAdIds: this.materialUnavailableAdIds }
            : {}),
          lastHealthyAt: now,
        },
      },
    };
  }

  async changeStatus(_context: unknown, mutations: StatusMutation[]) {
    if (this.statusDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.statusDelayMs));
    }
    this.mutations.push(...mutations);
    if (this.throwStatusError) throw new Error("connection lost after dispatch");
    for (const mutation of mutations) {
      if (mutation.entityType === "ad-group" && this.statusFailureKind === null && !this.shouldFail && !this.ignoreStatusWrites) {
        const status = mutation.action === "enable" ? "enable" : "disable";
        if (this.scenario === "priority" && mutation.externalId === "adgroup-high-priority") {
          this.priorityHighStatus = status;
        } else {
          this.adGroupStatus = status;
        }
      }
      if (mutation.entityType === "material" && this.statusFailureKind === null && !this.shouldFail && !this.ignoreStatusWrites) {
        this.materialStatus = mutation.action === "enable" ? "enable" : "disable";
      }
    }
    if (this.failReadbackAfterStatus) this.failNextSync = true;
    return mutations.map((mutation) => ({
      ...mutation,
      ok: !this.shouldFail && this.statusFailureKind === null,
      ...((this.shouldFail || this.statusFailureKind) && {
        failureKind: this.statusFailureKind ?? "retryable" as const,
      }),
      message: this.shouldFail || this.statusFailureKind ? "rejected" : "accepted",
    }));
  }

  resolveCapabilities() {
    return this.capabilities;
  }

  async appeal(_context: unknown, mutations: AppealMutation[]) {
    this.appeals.push(...mutations);
    return mutations.map((mutation) => {
      const ok = this.appealOutcomes.shift() ?? true;
      return { ...mutation, ok, message: ok ? "appealed" : "appeal rejected" };
    });
  }

  async deleteAdGroups(_context: unknown, mutations: DeleteAdGroupMutation[]) {
    this.deletions.push(...mutations);
    return mutations.map((mutation) => ({
      ...mutation,
      ok: this.deleteFailureKind === null,
      ...(this.deleteFailureKind && { failureKind: this.deleteFailureKind }),
      message: this.deleteFailureKind ? "delete failed" : "deleted",
    }));
  }
}

class FakeMetaProvider implements AdsProvider {
  readonly kind = "meta-marketing-api" as const;
  readonly platform = "meta" as const;
  readonly implementationStatus = "available" as const;
  readonly displayName = "Fake Meta Marketing API";
  readonly capabilityVersion = "fake-meta-v1";
  readonly capabilities = new Set([
    "read-campaigns",
    "read-ad-groups",
    "read-ads",
    "change-status",
  ] as const);
  readonly mutations: StatusMutation[] = [];
  readonly statusByKey = new Map<string, "ACTIVE" | "PAUSED">([
    ["campaign:meta-campaign-1", "ACTIVE"],
    ["ad-group:meta-adset-1", "ACTIVE"],
    ["ad:meta-ad-1", "ACTIVE"],
  ]);
  shouldSyncFail = false;
  shouldFailStatus = false;
  syncCalls = 0;
  syncBarrier: Promise<void> | null = null;

  resolveCapabilities() {
    return this.capabilities;
  }

  async checkHealth() {
    if (this.shouldSyncFail) throw new Error("Meta fixture health failed");
    return { ok: true, status: "ready" as const, message: "ready" };
  }

  async syncReadOnly() {
    this.syncCalls += 1;
    if (this.syncBarrier) await this.syncBarrier;
    if (this.shouldSyncFail) throw new Error("Meta fixture sync failed");
    const metrics = {
      spend: 20,
      cpc: 1.5,
      conversions: 0,
      carts: 0,
      cost_per_conversion: 0,
    };
    const entities: ProviderEntity[] = [
      {
        entityType: "campaign",
        externalId: "meta-campaign-1",
        payload: {
          name: "Meta Campaign",
          operation_status: this.statusByKey.get("campaign:meta-campaign-1"),
          ...metrics,
        },
      },
      {
        entityType: "ad-group",
        externalId: "meta-adset-1",
        payload: {
          name: "Meta Ad Set",
          campaign_id: "meta-campaign-1",
          operation_status: this.statusByKey.get("ad-group:meta-adset-1"),
          ...metrics,
        },
      },
      {
        entityType: "ad",
        externalId: "meta-ad-1",
        payload: {
          name: "Meta Ad",
          campaign_id: "meta-campaign-1",
          adgroup_id: "meta-adset-1",
          operation_status: this.statusByKey.get("ad:meta-ad-1"),
          ...metrics,
        },
      },
      {
        entityType: "material",
        externalId: "meta-material-never-write",
        payload: {
          name: "Meta material must remain unsupported",
          campaign_id: "meta-campaign-1",
          adgroup_id: "meta-adset-1",
          material_primary_status: "enabled",
          ...metrics,
        },
      },
    ];
    const now = new Date().toISOString();
    return {
      entities,
      result: {
        startedAt: now,
        finishedAt: now,
        counts: { campaign: 1, "ad-group": 1, ad: 1, material: 1 },
        warnings: [],
        quality: {
          status: "healthy" as const,
          paginationComplete: true,
          requiredMetricsComplete: true,
          contractValid: true,
          providerContractVersion: "fake-meta-account-today-v1",
          coverage: {
            startDate: dateKeyInTimeZoneForTest(new Date(now), "Asia/Shanghai"),
            endDate: dateKeyInTimeZoneForTest(new Date(now), "Asia/Shanghai"),
            timezone: "Asia/Shanghai",
          },
          missingMetrics: [],
          partialFailures: [],
          completeEntityTypes: ["campaign", "ad-group", "ad"] as SyncEntityType[],
          lastHealthyAt: now,
        },
      },
    };
  }

  async changeStatus(context: ProviderContext, mutations: StatusMutation[]) {
    const settings = context.settings.kind === "meta-marketing-api"
      ? context.settings
      : null;
    this.mutations.push(...mutations);
    return mutations.map((mutation) => {
      const allowed = mutation.entityType !== "material"
        && Boolean(settings?.allowedStatusEntityTypes?.includes(mutation.entityType));
      const ok = allowed && !this.shouldFailStatus;
      if (ok) {
        this.statusByKey.set(
          `${mutation.entityType}:${mutation.externalId}`,
          mutation.action === "enable" ? "ACTIVE" : "PAUSED",
        );
      }
      return {
        ...mutation,
        ok,
        ...(!ok ? { failureKind: "retryable" as const } : {}),
        message: ok ? "accepted" : "rejected",
      };
    });
  }
}

function alignSyncTo(
  output: Awaited<ReturnType<FakeProvider["syncReadOnly"]>>,
  asOf: Date,
): Awaited<ReturnType<FakeProvider["syncReadOnly"]>> {
  const timestamp = asOf.toISOString();
  const localDate = dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai");
  output.result.startedAt = timestamp;
  output.result.finishedAt = timestamp;
  output.result.quality.coverage = {
    startDate: localDate,
    endDate: localDate,
    timezone: "Asia/Shanghai",
  };
  output.result.quality.lastHealthyAt = timestamp;
  return output;
}

describe("AutomationService", () => {
  let store: AutomationStore;
  let vault: InMemoryCredentialVault;
  let provider: FakeProvider;
  let service: AutomationService;

  beforeEach(async () => {
    store = new AutomationStore(":memory:");
    store.seed();
    vault = new InMemoryCredentialVault();
    provider = new FakeProvider();
    service = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
    );

    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "123",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    });
    const reference = await vault.create(
      JSON.stringify({
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
      }),
    );
    store.setProviderCredentialReference("demo-account", "cookie", reference);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: provider.capabilityVersion,
      capabilities: [
        "read-campaigns",
        "read-ad-groups",
        "change-status",
        "appeal-ads",
        "copy-ads",
        "delete-ad-groups",
      ],
    });
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: account.enabled,
      providerKind: account.providerKind,
    });
    const initialSync = await provider.syncReadOnly();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      initialSync.entities,
      initialSync.result,
    );

  });

  /** 再挂一个和 demo-account 同构的 TikTok 账户，用来观察账户之间的调度行为。 */
  async function setupExtraTikTokAccount(displayName: string) {
    const account = store.createAccount({
      displayName,
      platform: "tiktok",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    store.saveProviderConnectionSettings(account.id, {
      kind: "cookie",
      advertiserId: "123",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    });
    const reference = await vault.create(
      JSON.stringify({
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
      }),
    );
    store.setProviderCredentialReference(account.id, "cookie", reference);
    store.updateProviderStatus(account.id, "cookie", "ready", "ready");
    store.updateProviderAuthorization(account.id, "cookie", {
      status: "active",
      capabilityVersion: provider.capabilityVersion,
      capabilities: ["read-campaigns", "read-ad-groups", "change-status"],
    });
    const sync = await provider.syncReadOnly();
    store.saveReadOnlySync(account.id, "cookie", sync.entities, sync.result);
    return account;
  }

  async function setupMetaAccount(input: {
    enabled: boolean;
    liveMode: "read-only" | "manual-status" | "automation-status";
    allowedStatusEntityTypes?: Array<"campaign" | "ad-group" | "ad">;
  }) {
    const metaProvider = new FakeMetaProvider();
    service = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider, metaProvider]),
    );
    const account = store.createAccount({
      displayName: "Meta 上海测试账户",
      platform: "meta",
      accountType: "standard",
      enabled: input.enabled,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "Meta test profile",
      appId: "100000000000001",
      businessId: null,
      graphApiVersion: "v23.0",
    });
    const secretReference = await vault.create(JSON.stringify({
      appSecret: "fixture-app-secret",
      accessToken: "fixture-access-token-long-enough",
    }));
    store.setMetaAccessProfileSecretReference(profile.id, secretReference);
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000003",
      pageId: null,
      liveMode: input.liveMode,
      allowedStatusEntityTypes: input.allowedStatusEntityTypes
        ?? ["campaign", "ad-group", "ad"],
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: metaProvider.capabilityVersion,
      capabilities: [
        "read-campaigns",
        "read-ad-groups",
        "read-ads",
        "change-status",
      ],
    });
    const sync = await metaProvider.syncReadOnly();
    store.saveReadOnlySync(
      account.id,
      "meta-marketing-api",
      sync.entities,
      sync.result,
    );
    const rules = store.getMetaRuleConfiguration();
    store.updateMetaRuleConfiguration({
      schemaVersion: rules.schemaVersion,
      metricWindow: rules.metricWindow,
      layers: { campaign: true, adGroup: true, ad: true },
      rules: rules.rules.map((rule) => rule.code === "NO_CONV_SPEND_CLOSE"
        ? { ...rule, enabled: true, values: { conversions: 0, spend: 2 } }
        : { ...rule, enabled: false }),
    }, rules.updatedAt);
    return { account, metaProvider };
  }

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  it("previews matching decisions without writing", async () => {
    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")[0]?.status).toBe(
      "preview",
    );
  });

  it("previews Meta rules while both runtime and account automation are off", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: false,
      liveMode: "read-only",
    });

    const run = await service.runAccount(account.id, "preview");

    expect(store.getMetaAutomationRuntime().enabled).toBe(false);
    expect(run).toMatchObject({
      status: "completed",
      candidateCount: 3,
      actionCount: 0,
      successCount: 0,
      failureCount: 0,
    });
    expect(metaProvider.mutations).toEqual([]);
    expect(store.listAutomationDecisions(account.id)).toHaveLength(3);
    expect(store.listAutomationDecisions(account.id).some(
      (decision) => decision.entityType === "material",
    )).toBe(false);
  });

  it("allows manual Meta Campaign, Ad Set and Ad writes but rejects material before provider dispatch", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: false,
      liveMode: "manual-status",
    });

    await expect(service.changeStatusManually(account.id, {
      entityType: "campaign",
      externalId: "meta-campaign-1",
      action: "disable",
    })).resolves.toMatchObject({ ok: true });
    await expect(service.changeStatusManually(account.id, {
      entityType: "ad-group",
      externalId: "meta-adset-1",
      action: "disable",
    })).resolves.toMatchObject({ ok: true });
    await expect(service.changeStatusManually(account.id, {
      entityType: "ad",
      externalId: "meta-ad-1",
      action: "disable",
    })).resolves.toMatchObject({ ok: true });
    await expect(service.changeStatusManually(account.id, {
      entityType: "material",
      externalId: "meta-material-never-write",
      action: "disable",
    })).rejects.toThrow("状态写入已阻止");

    expect(metaProvider.mutations).toEqual([
      { entityType: "campaign", externalId: "meta-campaign-1", action: "disable" },
      { entityType: "ad-group", externalId: "meta-adset-1", action: "disable" },
      { entityType: "ad", externalId: "meta-ad-1", action: "disable" },
    ]);
  });

  it("reconciles an unknown Meta status operation through read-only sync without replaying the write", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: false,
      liveMode: "manual-status",
    });
    const task = store.createStatusWriteTask({
      accountId: account.id,
      providerKind: "meta-marketing-api",
      entityType: "ad",
      externalId: "meta-ad-1",
      entityName: "Meta Ad",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(task.id, "executor-a", "pending");
    store.completeStatusWriteTask(task.id, "executor-a", "unknown", "response lost");
    metaProvider.statusByKey.set("ad:meta-ad-1", "PAUSED");

    await expect(service.reconcileMetaStatusOperation(account.id, task.operationId))
      .resolves.toMatchObject({
        resolution: "succeeded",
        operation: { status: "succeeded", phase: "readback" },
        asset: { entityType: "ad", externalId: "meta-ad-1", status: "disabled" },
      });
    expect(metaProvider.mutations).toEqual([]);
  });

  it("serializes Meta readback reconciliation against writes on the same account", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: false,
      liveMode: "manual-status",
    });
    const task = store.createStatusWriteTask({
      accountId: account.id,
      providerKind: "meta-marketing-api",
      entityType: "ad",
      externalId: "meta-ad-1",
      entityName: "Meta Ad",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(task.id, "executor-a", "pending");
    store.completeStatusWriteTask(task.id, "executor-a", "unknown", "response lost");
    metaProvider.statusByKey.set("ad:meta-ad-1", "PAUSED");
    let releaseSync!: () => void;
    metaProvider.syncBarrier = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    const reconciliation = service.reconcileMetaStatusOperation(account.id, task.operationId);
    await vi.waitFor(() => expect(metaProvider.syncCalls).toBe(2));
    await expect(service.changeStatusManually(account.id, {
      entityType: "ad",
      externalId: "meta-ad-1",
      action: "enable",
    })).rejects.toThrow("已有任务正在执行");
    releaseSync();

    await expect(reconciliation).resolves.toMatchObject({ resolution: "succeeded" });
    expect(metaProvider.mutations).toEqual([]);
  });

  it("does not queue an opposite Meta write while the same entity has a pending operation", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: false,
      liveMode: "manual-status",
    });
    const first = service.enqueueManualStatusChange(account.id, {
      entityType: "ad",
      externalId: "meta-ad-1",
      action: "disable",
    });

    expect(first.status).toBe("pending");
    expect(() => service.enqueueManualStatusChange(account.id, {
      entityType: "ad",
      externalId: "meta-ad-1",
      action: "enable",
    })).toThrow("结果待确认");
    await vi.waitFor(() => expect(store.getAdOperation(first.id).status).toBe("succeeded"));
    expect(metaProvider.mutations).toEqual([
      { entityType: "ad", externalId: "meta-ad-1", action: "disable" },
    ]);
  });

  it("keeps contradicted and incomplete Meta readbacks unknown without replaying writes", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: false,
      liveMode: "manual-status",
    });
    const contradicted = store.createStatusWriteTask({
      accountId: account.id,
      providerKind: "meta-marketing-api",
      entityType: "ad",
      externalId: "meta-ad-1",
      entityName: "Meta Ad",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(contradicted.id, "executor-a", "pending");
    store.completeStatusWriteTask(contradicted.id, "executor-a", "unknown", "response lost");

    await expect(service.reconcileMetaStatusOperation(account.id, contradicted.operationId))
      .resolves.toMatchObject({
        resolution: "unknown",
        operation: { status: "unknown" },
        asset: { status: "enabled" },
      });

    await expect(service.changeStatusManually(account.id, {
      entityType: "ad",
      externalId: "meta-ad-1",
      action: "enable",
    })).rejects.toThrow("结果待确认");

    metaProvider.statusByKey.set("ad:meta-ad-1", "PAUSED");
    await expect(service.reconcileMetaStatusOperation(account.id, contradicted.operationId))
      .resolves.toMatchObject({
        resolution: "succeeded",
        operation: { status: "succeeded", phase: "readback" },
        asset: { status: "disabled" },
      });
    const incomplete = store.createStatusWriteTask({
      accountId: account.id,
      providerKind: "meta-marketing-api",
      entityType: "ad",
      externalId: "meta-ad-1",
      entityName: "Meta Ad",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(incomplete.id, "executor-b", "pending");
    store.completeStatusWriteTask(incomplete.id, "executor-b", "unknown", "response lost");
    metaProvider.statusByKey.delete("ad:meta-ad-1");

    await expect(service.reconcileMetaStatusOperation(account.id, incomplete.operationId))
      .resolves.toMatchObject({
        resolution: "unknown",
        operation: { status: "unknown" },
      });
    expect(metaProvider.mutations).toEqual([]);
  });

  it("requires Meta runtime, account enablement and automation-status before a three-layer automatic run", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: false,
      liveMode: "manual-status",
    });

    await expect(service.runAccount(account.id, "scheduler"))
      .rejects.toThrow("Meta 自动化总开关已关闭");
    const runtime = store.getMetaAutomationRuntime();
    store.updateMetaAutomationRuntime({
      enabled: true,
      pollingIntervalMinutes: runtime.pollingIntervalMinutes,
      maxActionsPerRun: runtime.maxActionsPerRun,
    }, runtime.updatedAt);
    await expect(service.runAccount(account.id, "scheduler"))
      .rejects.toThrow("账户自动化已关闭");

    expect(() => store.updateAccountSettings(account.id, {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    })).toThrow("Automation status");
    const current = store.getProviderConnection(account.id, "meta-marketing-api")!;
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: current.settings.kind === "meta-marketing-api"
        ? current.settings.profileId!
        : "",
      adAccountId: "act_300000000000003",
      pageId: null,
      liveMode: "automation-status",
      allowedStatusEntityTypes: ["campaign", "ad-group", "ad"],
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: metaProvider.capabilityVersion,
      capabilities: [
        "read-campaigns",
        "read-ad-groups",
        "read-ads",
        "change-status",
      ],
    });
    store.updateAccountSettings(account.id, {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    });

    store.updateSystemRuntimeState({ enabled: false });
    await expect(service.runAccount(account.id, "scheduler"))
      .rejects.toThrow("全局自动化已关闭");
    store.updateSystemRuntimeState({ enabled: true });

    const run = await service.runAccount(account.id, "scheduler");

    expect(run).toMatchObject({
      status: "completed",
      candidateCount: 3,
      actionCount: 3,
      successCount: 3,
      failureCount: 0,
    });
    expect(metaProvider.mutations).toEqual([
      { entityType: "campaign", externalId: "meta-campaign-1", action: "disable" },
      { entityType: "ad-group", externalId: "meta-adset-1", action: "disable" },
      { entityType: "ad", externalId: "meta-ad-1", action: "disable" },
    ]);
    expect(store.listScheduledActions(account.id)).toEqual([]);
  });

  it("evaluates an old ad group when it has spend today", async () => {
    provider.campaignCreatedAt = new Date(Date.now() - 72 * 60 * 60_000).toISOString();

    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(1);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      entityType: "ad-group",
      externalId: "adgroup-1",
      status: "preview",
    });
  });

  it("does not evaluate a closed old ad group with residual spend today", async () => {
    provider.campaignCreatedAt = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
    provider.adGroupStatus = "disable";

    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(0);
    expect(store.listAutomationDecisions("demo-account")).toHaveLength(0);
  });

  it("explains which account needs connection verification before a preview", async () => {
    store.updateProviderStatus("demo-account", "cookie", "failed", "expired");

    await expect(service.runAccount("demo-account", "preview")).resolves.toMatchObject({
      status: "failed",
      errorMessage:
        "账户「演示广告账户」当前Cookie 接入状态：Cookie 已失效或连接异常。请到「用户管理」查看接入状态后再运行。",
    });
  });

  it("records a failed connection health check without changing account automation", async () => {
    vi.spyOn(provider, "checkHealth").mockResolvedValue({
      ok: false,
      status: "failed",
      message: "expired",
    });

    await service.checkAccountConnection("demo-account");

    expect(store.getAccount("demo-account")?.enabled).toBe(true);
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
  });

  it("preserves the last verified connection state on a transient health-check timeout", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.spyOn(provider, "checkHealth").mockRejectedValueOnce(timeout);

    await service.checkAccountConnection("demo-account");

    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "ready",
      authorizationStatus: "active",
      lastMessage: expect.stringContaining("timeout"),
    });
  });

  it("still invalidates the connection on an explicit non-transient health failure", async () => {
    vi.spyOn(provider, "checkHealth").mockRejectedValueOnce(
      new Error("TikTok explicitly rejected the credential"),
    );

    await service.checkAccountConnection("demo-account");

    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "failed",
      authorizationStatus: "failed",
    });
  });

  it("reports an unreachable network as a network failure, not an expired credential", async () => {
    // 代理没生效时 undici 只抛一句 `fetch failed`，错误码在 cause 上。之前这里
    // 一律写成「Cookie 已失效」，用户照着提示反复重导 Cookie 也修不好。
    const failure = new Error("TikTok explicitly rejected the credential");
    vi.spyOn(provider, "checkHealth").mockRejectedValueOnce(failure);
    await service.checkAccountConnection("demo-account");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");

    const unreachable = new TypeError("fetch failed");
    (unreachable as { cause?: unknown }).cause = Object.assign(
      new Error("Connect Timeout Error"),
      { code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    vi.spyOn(provider, "checkHealth").mockRejectedValueOnce(unreachable);

    await service.checkAccountConnection("demo-account");

    const connection = store.getProviderConnection("demo-account", "cookie");
    expect(connection?.status).toBe("failed");
    expect(connection?.lastMessage).toContain("网络不可达或代理未生效");
    expect(connection?.lastMessage).toContain("UND_ERR_CONNECT_TIMEOUT");
    expect(connection?.lastMessage).not.toContain("Cookie 已失效");
  });

  it("refreshes a stale provider capability contract after a successful background health check", async () => {
    const authorizationExpiresAt = new Date(Date.now() + 60_000).toISOString();
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: "fake-cookie-v0",
      capabilities: ["read-campaigns"],
      expiresAt: authorizationExpiresAt,
    });

    await service.checkAccountConnection("demo-account");

    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "ready",
      authorizationStatus: "active",
      authorizationExpiresAt,
      capabilityVersion: provider.capabilityVersion,
      authorizedCapabilities: expect.arrayContaining([
        "read-campaigns",
        "read-ad-groups",
        "change-status",
      ]),
    });
    await expect(service.runAccount("demo-account", "preview")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("records provider synchronization failure without changing account automation", async () => {
    provider.shouldSyncFail = true;

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.status).toBe("failed");
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "failed",
      lastMessage: "Cookie 已失效或数据同步异常：sync unavailable",
    });
    expect(provider.mutations).toHaveLength(0);
  });

  it("blocks automatic writes for partial data but keeps suggestions visible", async () => {
    provider.qualityStatus = "partial";

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.candidateCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "skipped",
      dataQualityStatus: "partial",
      dataQualityWarnings: expect.arrayContaining(["test-quality", "缺少指标 cost_per_conversion"]),
    });
    expect(store.listAutomationDecisions("demo-account")[0]?.errorMessage)
      .toContain("数据质量");
  });

  it("continues unaffected parent writes when only material fetches are partial", async () => {
    provider.qualityStatus = "partial";
    provider.completeEntityTypes = ["campaign", "ad-group", "ad"];
    provider.partialFailures = ["material:request-failed"];
    provider.materialUnavailableAdIds = ["ad-missing"];

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.successCount).toBe(1);
    expect(provider.mutations).toMatchObject([
      {
        entityType: "ad-group",
        externalId: "adgroup-1",
        action: "disable",
      },
    ]);
  });

  it("does not block an ad group when material fetch failed for one of its ads", async () => {
    provider.scenario = "ad-switch";
    provider.qualityStatus = "partial";
    provider.completeEntityTypes = ["campaign", "ad-group", "ad"];
    provider.partialFailures = ["material:request-failed"];
    provider.materialUnavailableAdIds = ["ad-1"];

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.candidateCount).toBeGreaterThan(0);
    expect(run.successCount).toBe(1);
    expect(provider.mutations).toMatchObject([
      {
        entityType: "ad-group",
        externalId: "adgroup-1",
        action: "disable",
      },
    ]);
    const groupDecision = store.listAutomationDecisions("demo-account").find(
      (decision) => decision.entityType === "ad-group" && decision.externalId === "adgroup-1",
    );
    expect(groupDecision).toMatchObject({
      status: "succeeded",
      dataQualityStatus: "partial",
    });
  });

  it("writes an unaffected material during partial sync and accepts partial readback", async () => {
    provider.scenario = "material";
    provider.qualityStatus = "partial";
    provider.completeEntityTypes = ["campaign", "ad-group", "ad"];
    provider.partialFailures = ["material:request-failed"];
    provider.materialUnavailableAdIds = ["ad-missing"];

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.successCount).toBe(1);
    expect(provider.mutations).toMatchObject([
      {
        entityType: "material",
        externalId: "1872777743628513",
        action: "disable",
        parentAdGroupId: "adgroup-1",
      },
    ]);
    expect(store.listAutomationDecisions("demo-account").find(
      (decision) => decision.entityType === "material",
    )).toMatchObject({
      status: "succeeded",
      dataQualityStatus: "partial",
    });
  });

  it("skips a material whose source ad material list failed", async () => {
    provider.scenario = "material";
    provider.qualityStatus = "partial";
    provider.completeEntityTypes = ["campaign", "ad-group", "ad"];
    provider.partialFailures = ["material:request-failed"];
    provider.materialUnavailableAdIds = ["ad-1"];

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.candidateCount).toBe(1);
    expect(run.successCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account").find(
      (decision) => decision.entityType === "material",
    )).toMatchObject({
      status: "skipped",
      dataQualityStatus: "partial",
    });
  });

  it("stops rule evaluation when the provider contract is invalid", async () => {
    provider.qualityStatus = "invalid";

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.candidateCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
  });

  it("rechecks stored quality at the manual write boundary", async () => {
    provider.qualityStatus = "partial";
    const partial = await provider.syncReadOnly();
    const partialAt = new Date(Date.now() + 1_000).toISOString();
    partial.result.startedAt = partialAt;
    partial.result.finishedAt = partialAt;
    store.saveReadOnlySync("demo-account", "cookie", partial.entities, partial.result);

    await expect(service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    })).rejects.toThrow("状态写入已阻止");
    expect(provider.mutations).toHaveLength(0);
  });

  it("allows a manual ad-group write when only material fetches are partial", async () => {
    provider.qualityStatus = "partial";
    provider.completeEntityTypes = ["campaign", "ad-group", "ad"];
    provider.partialFailures = ["material:request-failed"];
    provider.materialUnavailableAdIds = ["ad-1"];
    const partial = await provider.syncReadOnly();
    const partialAt = new Date(Date.now() + 1_000).toISOString();
    partial.result.startedAt = partialAt;
    partial.result.finishedAt = partialAt;
    store.saveReadOnlySync("demo-account", "cookie", partial.entities, partial.result);

    const task = service.enqueueManualStatusChange("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    await vi.waitFor(() => expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]));
    expect(store.getAdOperation(task.id).status).toBe("succeeded");
  });

  it("marks the status task unknown when status write readback fails", async () => {
    provider.shouldSyncFail = true;

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "unknown",
      message: "sync unavailable",
    });
  });

  it("allows a manual status write while account automation is disabled", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: false,
      providerKind: account.providerKind,
    });

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result.ok).toBe(true);
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
  });

  it("queues manual status requests without waiting for cookie I/O", async () => {
    provider.statusDelayMs = 30;

    const first = service.enqueueManualStatusChange("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
    const second = service.enqueueManualStatusChange("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "enable",
    });

    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
    await vi.waitFor(() => expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
      { entityType: "ad-group", externalId: "adgroup-1", action: "enable" },
    ]));
    expect(store.getAdOperation(first.id).status).toBe("succeeded");
    expect(store.getAdOperation(second.id).status).toBe("succeeded");
  });

  it("resumes a persisted pending manual status task after service restart", async () => {
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-1",
      entityName: "测试广告组",
      action: "disable",
      source: "manual",
    }, { id: "user-1", name: "tester", kind: "user" });

    new AutomationService(store, vault, new ProviderRegistry([provider]));

    await vi.waitFor(() => expect(store.getAdOperation(task.id).status).toBe("succeeded"));
    expect(provider.mutations).toContainEqual({
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
  });

  it("marks an accepted status write unknown until the readback reaches its target", async () => {
    provider.ignoreStatusWrites = true;

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "unknown",
      message: expect.stringContaining("回读未确认目标状态"),
    });
  });

  it("persists actor, correlation and one successful attempt for a manual status write", async () => {
    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    }, { id: "user-1", name: "验收员", kind: "user" });

    expect(result.ok).toBe(true);
    const [task] = store.listAdOperations("demo-account");
    expect(task).toMatchObject({
      status: "succeeded",
      phase: "sync",
      attemptCount: 1,
      actor: { id: "user-1", name: "验收员", kind: "user" },
    });
    expect(task?.operationId).toBeTruthy();
    expect(task?.correlationId).toBeTruthy();
    expect(store.listAdOperationAttempts(task!.operationId)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        attemptNumber: 1,
        phase: "sync",
        actor: { id: "user-1", name: "验收员", kind: "user" },
      }),
    ]);
  });

  it("keeps a dispatched status write with an uncertain result in unknown", async () => {
    provider.statusFailureKind = "unknown";

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "unknown",
      attemptCount: 1,
    });
  });

  it("keeps an explicit provider rejection retryable as failed", async () => {
    provider.statusFailureKind = "retryable";

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({ status: "failed" });
  });

  it("blocks a status write before dispatch when credentials rotate while context loads", async () => {
    const originalRead = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementationOnce(async (reference) => {
      const staleSecret = await originalRead(reference);
      const replacement = await vault.create(JSON.stringify({
        kind: "cookie",
        cookie: "sessionid=rotated-cookie",
        csrfHeaderName: "x-csrftoken",
      }));
      store.setProviderCredentialReference("demo-account", "cookie", replacement);
      store.updateProviderStatus("demo-account", "cookie", "ready", "rotated and ready");
      store.updateProviderAuthorization("demo-account", "cookie", {
        status: "active",
        capabilityVersion: provider.capabilityVersion,
        capabilities: ["read-campaigns", "read-ad-groups", "change-status"],
      });
      return staleSecret;
    });

    await expect(service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    })).rejects.toThrow("凭据已变更");

    expect(provider.mutations).toHaveLength(0);
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
    });
  });

  it("retries only an explicitly failed status task and preserves its operation identity", async () => {
    provider.statusFailureKind = "retryable";
    await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
    const failed = store.listAdOperations("demo-account")[0]!;
    provider.statusFailureKind = null;

    const result = await service.retryStatusOperation(
      "demo-account",
      failed.operationId,
      { id: "user-2", name: "重试操作员", kind: "user" },
    );

    expect(result.ok).toBe(true);
    expect(store.getAdOperation(failed.id)).toMatchObject({
      operationId: failed.operationId,
      correlationId: failed.correlationId,
      status: "succeeded",
      attemptCount: 2,
    });
    expect(store.listAdOperationAttempts(failed.operationId)[1]?.actor).toEqual({
      id: "user-2",
      name: "重试操作员",
      kind: "user",
    });
  });

  it("never retries a status task whose provider result is unknown", async () => {
    provider.statusFailureKind = "unknown";
    await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
    const unknown = store.listAdOperations("demo-account")[0]!;

    await expect(service.retryStatusOperation("demo-account", unknown.operationId))
      .rejects.toThrow("结果待确认");
    expect(provider.mutations).toHaveLength(1);
  });

  it("directly closes matched ad groups for automatic accounts", async () => {
    const run = await service.runAccount("demo-account", "manual");

    expect(run).toMatchObject({ automatic: true, actionCount: 1, successCount: 1, failureCount: 0 });
    expect(provider.mutations).toEqual([{ entityType: "ad-group", externalId: "adgroup-1", action: "disable" }]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "succeeded",
      dataQualityStatus: "healthy",
      ruleVersion: expect.any(String),
      metricSnapshot: expect.objectContaining({ spend: expect.any(Number) }),
      suggestionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("clears stale open decision reminders after an ad group is closed", async () => {
    await service.runAccount("demo-account", "preview");
    const stale = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;

    await service.runAccount("demo-account", "manual");

    expect(store.getAutomationDecision(stale.id)).toMatchObject({
      status: "skipped",
      errorMessage: "对象状态已更新，已清除过期决策提醒",
    });
    expect(store.listAutomationDecisions("demo-account").find((item) => item.id !== stale.id))
      .toMatchObject({ status: "succeeded" });
  });

  it("records a direct automation write failure", async () => {
    provider.shouldFail = true;

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(1);
    expect(provider.mutations).toHaveLength(1);
    // 写入失败不能把连接打成失效：会话本身是好的，这一轮只读同步就是证据。
    // lastMessage 记的正是那次成功的同步，而不是失败的写入。
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "ready",
      lastMessage: "Cookie 会话可用：只读同步成功。",
    });
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
  });

  it("opens the provider circuit after three write failures without changing account automation", async () => {
    provider.shouldFail = true;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.changeStatusManually("demo-account", {
        entityType: "ad-group",
        externalId: `adgroup-${attempt}`,
        action: "disable",
      });
    }

    expect(store.getAccount("demo-account")?.enabled).toBe(true);
    expect(store.getProviderWriteCircuit("demo-account", "cookie")).toMatchObject({
      consecutiveFailures: 3,
      openedAt: expect.any(String),
    });
  });

  it("does not evaluate campaigns older than 48 hours", async () => {
    provider.campaignCreatedAt = new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString();
    provider.adGroupSpend = 0;

    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listCurrentManagedEntities("demo-account", "cookie").map((entity) => entity.externalId))
      .toEqual(expect.arrayContaining(["campaign-1", "adgroup-1"]));
  });

  it("does not run when the account automation switch is off", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: false,
      providerKind: account.providerKind,
    });

    await expect(service.runAccount("demo-account", "manual")).rejects.toThrow(
      "账户自动化已关闭",
    );
    expect(provider.mutations).toHaveLength(0);

    const preview = await service.runAccount("demo-account", "preview");
    expect(preview.candidateCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
  });

  it("keeps preview read-only but stops writes while the software master switch is off", async () => {
    store.updateSystemRuntimeState({ enabled: false });
    await expect(service.runAccount("demo-account", "preview")).resolves.toMatchObject({
      candidateCount: 1,
    });
    await expect(service.runAccount("demo-account", "manual")).rejects.toThrow(
      "全局自动化已关闭",
    );
    const scheduler = new AutomationScheduler(store, service);
    await scheduler.tick();
    expect(provider.mutations).toHaveLength(0);
    expect(store.listPollCycles()).toHaveLength(0);
  });

  it("executes account automation directly when automation is enabled", async () => {
    const run = await service.runAccount("demo-account", "manual");

    expect(run.candidateCount).toBe(1);
    expect(run.successCount).toBe(1);
    expect(provider.mutations).toHaveLength(1);
    expect(store.listAutomationDecisions("demo-account")[0]?.status).toBe("succeeded");
  });

  it("does not turn a suggestion into a write when the master switch changes", async () => {
    provider.afterSync = () => {
      store.updateSystemRuntimeState({ enabled: false });
    };

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("全局自动化"),
    });
  });

  it("executes a due one-time ad-group schedule and records its source", async () => {
    await service.runAccount("demo-account", "preview");
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await service.runDueScheduledActions("demo-account");

    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(
      store.listScheduledActions("demo-account").find((item) => item.id === schedule.id),
    ).toMatchObject({ status: "completed", lastResult: "succeeded" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      source: "scheduled",
      action: "disable",
    });
  });

  // 2026-08-07：23:45 过夜关掉 4 个组，23:50–23:52 规则把其中几个开了回来，零点
  // 排期又开一次，00:07 规则再关掉——一个组一晚上被开关四次。这 15 分钟本该全关。
  describe("自动启停的静默窗口", () => {
    // demo-account 在 Asia/Shanghai，本地 23:45 = 15:45Z，零点 = 16:00Z。
    const shanghai = "Asia/Shanghai";
    const at = (utc: string) => new Date(utc);

    it("23:45 至零点只禁开启，关闭方向放行", () => {
      expect(suppressedAutomationActions(at("2026-07-20T15:45:00.000Z"), shanghai)).toBe("enable");
      expect(suppressedAutomationActions(at("2026-07-20T15:51:00.000Z"), shanghai)).toBe("enable");
      expect(suppressedAutomationActions(at("2026-07-20T15:59:59.000Z"), shanghai)).toBe("enable");
    });

    it("零点至凌晨 3 点保护过夜组", () => {
      expect(suppressedAutomationActions(at("2026-07-20T16:00:00.000Z"), shanghai)).toBe("overnight-entities");
      expect(suppressedAutomationActions(at("2026-07-20T16:08:00.000Z"), shanghai)).toBe("overnight-entities");
      // 本地 02:59:59，仍在窗口内。
      expect(suppressedAutomationActions(at("2026-07-20T18:59:59.000Z"), shanghai)).toBe("overnight-entities");
    });

    it("窗口之外不做任何压制", () => {
      // 23:44 本地，差一分钟进窗口。
      expect(suppressedAutomationActions(at("2026-07-20T15:44:00.000Z"), shanghai)).toBe("none");
      // 本地 03:00 整，保护期结束，规则恢复。
      expect(suppressedAutomationActions(at("2026-07-20T19:00:00.000Z"), shanghai)).toBe("none");
      expect(suppressedAutomationActions(at("2026-07-20T04:00:00.000Z"), shanghai)).toBe("none");
    });

    // 判据必须跟着账户时区走，不能按服务器本地时间算。
    it("按账户时区判定，不看服务器时区", () => {
      const moment = at("2026-07-20T15:45:00.000Z");
      expect(suppressedAutomationActions(moment, "Asia/Shanghai")).toBe("enable");
      expect(suppressedAutomationActions(moment, "UTC")).toBe("none");
    });

    // enrollNightlyAdGroups 与压制判据必须共用同一个 23:45 边界。
    it("过夜关停窗口与压制窗口的 23:45 边界一致", () => {
      for (const utc of ["2026-07-20T15:44:59.000Z", "2026-07-20T15:45:00.000Z", "2026-07-20T15:59:59.000Z"]) {
        expect(isOvernightBlackout(at(utc), shanghai))
          .toBe(suppressedAutomationActions(at(utc), shanghai) === "enable");
      }
    });
  });

  it("puts converting groups into overnight and closes non-converting groups at 23:45", async () => {
    provider.scenario = "priority";
    await service.runAccount("demo-account", "preview");
    // demo-account is in Asia/Shanghai, so 23:45 local is 15:45 UTC.
    const atNightWindow = "2026-07-20T15:45:00.000Z";

    expect(service.enrollNightlyAdGroups("demo-account", atNightWindow)).toEqual({
      overnight: 1,
      closing: 1,
    });
    await service.runDueScheduledActions("demo-account", atNightWindow);

    expect(provider.mutations).toEqual(expect.arrayContaining([
      { entityType: "ad-group", externalId: "adgroup-low-priority", action: "disable" },
      { entityType: "ad-group", externalId: "adgroup-high-priority", action: "disable" },
    ]));
    expect(store.listScheduledActions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "adgroup-high-priority", scheduleType: "overnight", action: "enable", status: "scheduled" }),
      expect.objectContaining({ externalId: "adgroup-low-priority", scheduleType: "once", action: "disable", status: "completed" }),
    ]));
    expect(service.enrollNightlyAdGroups("demo-account", atNightWindow)).toEqual({
      overnight: 0,
      closing: 0,
    });
  });

  it("submits only offline-audit creatives at 01:00 or 12:00 and never repeats them", async () => {
    provider.scenario = "appeal";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);

    await service.runScheduledAppeals("demo-account", new Date("2026-07-20T17:00:00.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-20T17:00:30.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-21T04:00:00.000Z"));

    expect(provider.appeals).toEqual([{
      externalId: "ad-appeal-1",
      creativeId: "creative-appeal-1",
      // 广告组 ID 必须单独传下去：申诉报文的 ad_id 装的是广告组，不是广告。
      adGroupId: "adgroup-appeal-1",
      reason: "我认为我的视频没有违规。",
    }]);
    expect(store.listAdOperations("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "appeal", source: "automation", status: "succeeded" }),
    ]));
  });

  it("copies qualifying current-day groups before noon once per source and uses the configured count", async () => {
    const autoCopyRunner = vi.fn(async (input: { onBeforeDispatch?: () => void }) => {
      input.onBeforeDispatch?.();
      return [{ ok: true, adGroupIds: ["generated-copy-1", "generated-copy-2"] }];
    });
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    settings.copy.autoCopyBudget = 25;
    settings.copy.autoCopyBid = 4;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 5;
    provider.adGroupCpc = 0.5;
    const qualifying = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", qualifying.entities, qualifying.result);

    const beforeNoon = futureShanghaiTime(10);
    vi.useFakeTimers();
    vi.setSystemTime(beforeNoon);
    const fresh = alignSyncTo(await provider.syncReadOnly(), beforeNoon);
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);
    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);
    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);

    expect(autoCopyRunner).toHaveBeenCalledTimes(1);
    expect(autoCopyRunner).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceAdGroupId: "adgroup-1",
      // 命名不再可配置：统一 {清洗后源名}-{投放日期}-{时间}。
      baseAdGroupName: `测试广告组-${dateTimeSuffix(beforeNoon, "Asia/Shanghai")}`,
      count: 2,
      dailyBudget: 25,
      bid: 4,
      launchImmediately: true,
      sameCampaign: true,
      onBeforeDispatch: expect.any(Function),
    }));
    expect(autoCopyRunner).toHaveBeenCalledTimes(1);

    // 次日：源组依然满足阈值，但同源只复制一次，不再触发；复制出来的
    // generated-copy-1 即使被用户改了名，也靠 ID 排除在候选之外。
    autoCopyRunner.mockClear();
    const nextDay = new Date(beforeNoon.getTime() + 24 * 60 * 60_000);
    vi.setSystemTime(nextDay);
    const nextDaySync = alignSyncTo(await provider.syncReadOnly(), nextDay);
    nextDaySync.entities.push({
      entityType: "ad-group",
      externalId: "generated-copy-1",
      payload: {
        campaign_id: "campaign-1",
        ad_name: "用户已重命名",
        ad_primary_status: "enable",
        row_data: {
          campaign_id: "campaign-1",
          time_attr_convert_cnt: "2",
          time_attr_conversion_cost: "5",
          time_attr_on_web_cart: "2",
          cpc: "0.5",
        },
      },
    });
    store.saveReadOnlySync("demo-account", "cookie", nextDaySync.entities, nextDaySync.result);

    await copyService.runScheduledAutoCopies("demo-account", nextDay);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("同源只复制一次：任务键不含日期，隔多少天都不会再复制同一个源", async () => {
    const autoCopyRunner = vi.fn(async (input: { onBeforeDispatch?: () => void }) => {
      input.onBeforeDispatch?.();
      return [{ ok: true, adGroupIds: ["generated-copy-1"] }];
    });
    const copyService = new AutomationService(
      store, vault, new ProviderRegistry([provider]), autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 5;
    provider.adGroupCpc = 0.5;

    const firstDay = futureShanghaiTime(10);
    vi.useFakeTimers();
    vi.setSystemTime(firstDay);
    const first = alignSyncTo(await provider.syncReadOnly(), firstDay);
    store.saveReadOnlySync("demo-account", "cookie", first.entities, first.result);
    await copyService.runScheduledAutoCopies("demo-account", firstDay);
    expect(autoCopyRunner).toHaveBeenCalledTimes(1);

    // 隔一周后源组仍然满足阈值，但已经复制过了，不再触发。
    autoCopyRunner.mockClear();
    const laterDay = new Date(firstDay.getTime() + 7 * 24 * 60 * 60_000);
    vi.setSystemTime(laterDay);
    const later = alignSyncTo(await provider.syncReadOnly(), laterDay);
    store.saveReadOnlySync("demo-account", "cookie", later.entities, later.result);
    await copyService.runScheduledAutoCopies("demo-account", laterDay);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("does not start new automatic copies at or after 12:00 account time", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 5;
    provider.adGroupCpc = 0.5;
    const atNoon = new Date();
    atNoon.setUTCHours(4, 0, 0, 0); // 12:00 in Asia/Shanghai.
    vi.useFakeTimers();
    vi.setSystemTime(atNoon);
    const fresh = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);

    await copyService.runScheduledAutoCopies("demo-account", atNoon);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("requires conversions, CPA, and CPC to all satisfy the automatic-copy rule", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 10;
    provider.adGroupCpc = 0.5;
    const beforeNoon = new Date();
    beforeNoon.setUTCHours(2, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(beforeNoon);
    const fresh = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);

    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("rejects a healthy automatic-copy snapshot whose coverage is not exactly the account's current day", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 5;
    provider.adGroupCpc = 0.5;
    const beforeNoon = new Date("2026-07-24T02:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(beforeNoon);
    const sync = await provider.syncReadOnly();
    sync.result.quality.coverage = {
      startDate: "2026-07-23",
      endDate: "2026-07-24",
      timezone: "Asia/Shanghai",
    };
    store.saveReadOnlySync("demo-account", "cookie", sync.entities, sync.result);

    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("does not enter deletion selection when healthy metrics cover an unknown or multi-day window", async () => {
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    store.updateAutomationFeatureSettings(settings);
    const atSix = new Date("2026-07-24T22:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(atSix);
    const sync = await provider.syncReadOnly();
    sync.result.quality.coverage = {
      startDate: "2026-07-24",
      endDate: "2026-07-25",
      timezone: "Asia/Shanghai",
    };
    store.saveReadOnlySync("demo-account", "cookie", sync.entities, sync.result);
    const selection = vi.spyOn(store, "listDeletionReadyAdGroups");

    await service.runScheduledDeletions("demo-account", atSix);

    expect(selection).not.toHaveBeenCalled();
    expect(provider.deletions).toEqual([]);
  });

  // 广告层的派生请求在 TikTok 侧慢且不稳，实测一个账户 50% 的轮次会超时。删除只用
  // 广告组和系列的数据，不该被广告层连坐——但广告组层自己不完整时必须照旧拦住。
  it("deletes when only the ad layer failed but refuses when the ad-group layer did", async () => {
    const asOf = futureShanghaiTime(6);
    vi.useFakeTimers();
    vi.setSystemTime(asOf);
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    settings.deletion.gracePeriodHours = 1;
    store.updateAutomationFeatureSettings(settings);

    // 同一系列放两个已关闭的组：每系列保底一组，所以只会删掉其中一个。
    const entities = [
      { entityType: "campaign" as const, externalId: "campaign-1", payload: { campaign_id: "campaign-1", campaign_name: "系列" } },
      ...["keep-1", "drop-1"].map((id) => ({
        entityType: "ad-group" as const,
        externalId: id,
        payload: {
          campaign_id: "campaign-1",
          ad_name: id,
          ad_primary_status: "disable",
          row_data: { campaign_id: "campaign-1", time_attr_convert_cnt: "0", time_attr_on_web_cart: "0" },
        },
      })),
    ];
    const disabledAt = new Date(asOf.getTime() - 2 * 60 * 60_000).toISOString();
    for (const id of ["keep-1", "drop-1"]) {
      const operation = store.recordAdOperation({
        accountId: "demo-account",
        providerKind: "cookie",
        entityType: "ad-group",
        externalId: id,
        entityName: id,
        action: "disable",
        source: "automation",
        status: "succeeded",
        message: "disabled",
      });
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare("UPDATE ad_operations SET completed_at = ? WHERE id = ?")
        .run(disabledAt, operation.id);
    }

    const partialButAdGroupComplete = {
      startedAt: asOf.toISOString(),
      finishedAt: asOf.toISOString(),
      counts: { campaign: 1, "ad-group": 2, ad: 0, material: 0 },
      warnings: [],
      quality: {
        status: "partial" as const,
        paginationComplete: true,
        requiredMetricsComplete: true,
        contractValid: true,
        providerContractVersion: "test-v1",
        missingMetrics: [],
        lastHealthyAt: asOf.toISOString(),
        partialFailures: ["ad:derived-request-failed"],
        completeEntityTypes: ["campaign" as const, "ad-group" as const],
        coverage: {
          startDate: dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai"),
          endDate: dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai"),
          timezone: "Asia/Shanghai",
        },
      },
    };
    store.saveReadOnlySync("demo-account", "cookie", entities, partialButAdGroupComplete);

    await service.runScheduledDeletions("demo-account", asOf);
    expect(provider.deletions).toHaveLength(1);

    // 反过来：广告组层自己没取全时，必须拒绝。
    provider.deletions.length = 0;
    const nextDay = new Date(asOf.getTime() + 24 * 60 * 60_000);
    vi.setSystemTime(nextDay);
    store.saveReadOnlySync("demo-account", "cookie", entities, {
      ...partialButAdGroupComplete,
      startedAt: nextDay.toISOString(),
      finishedAt: nextDay.toISOString(),
      quality: {
        ...partialButAdGroupComplete.quality,
        partialFailures: ["ad-group:derived-request-failed"],
        completeEntityTypes: ["campaign" as const],
        coverage: {
          startDate: dateKeyInTimeZoneForTest(nextDay, "Asia/Shanghai"),
          endDate: dateKeyInTimeZoneForTest(nextDay, "Asia/Shanghai"),
          timezone: "Asia/Shanghai",
        },
      },
    });

    await service.runScheduledDeletions("demo-account", nextDay);
    vi.useRealTimers();
    expect(provider.deletions).toEqual([]);
  });

  it("does not submit an automatic appeal while account automation is disabled", async () => {
    provider.scenario = "appeal";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: false,
      providerKind: account.providerKind,
    });

    await service.runScheduledAppeals("demo-account", new Date("2026-07-20T17:00:00.000Z"));

    expect(provider.appeals).toEqual([]);
    expect(store.listAdOperations("demo-account").filter((item) => item.action === "appeal"))
      .toEqual([]);
  });

  it("uses the configured appeal hours and retries only the configured number of confirmed failures", async () => {
    provider.scenario = "appeal";
    provider.appealOutcomes.push(false, true);
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    const settings = store.getAutomationFeatureSettings();
    settings.appeal.scheduleHours = [8];
    settings.appeal.retryLimit = 1;
    store.updateAutomationFeatureSettings(settings);

    await service.runScheduledAppeals("demo-account", new Date("2026-07-21T00:00:00.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-21T00:01:00.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-22T00:00:00.000Z"));

    expect(provider.appeals).toHaveLength(2);
    expect(store.listAdOperations("demo-account").filter((item) => item.action === "appeal"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({ status: "succeeded" }),
      ]));
  });

  it("deletes only a software-confirmed disabled ad group after the protection period and never retries unknown", async () => {
    const asOf = futureShanghaiTime(6);
    vi.useFakeTimers();
    vi.setSystemTime(asOf);
    provider.adGroupStatus = "disable";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    const disabled = store.recordAdOperation({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-1",
      entityName: "测试广告组",
      action: "disable",
      source: "automation",
      status: "succeeded",
      message: "confirmed disabled",
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    (store as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    }).db.prepare(
      "UPDATE ad_operations SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ).run(twoHoursAgo, twoHoursAgo, twoHoursAgo, disabled.id);
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    settings.deletion.gracePeriodHours = 1;
    store.updateAutomationFeatureSettings(settings);
    const fresh = alignSyncTo(await provider.syncReadOnly(), asOf);
    fresh.entities.push({
      entityType: "ad-group",
      externalId: "adgroup-retained",
      payload: {
        campaign_id: "campaign-1",
        ad_name: "系列保留组",
        ad_primary_status: "enable",
        row_data: {
          campaign_id: "campaign-1",
          time_attr_convert_cnt: "3",
          time_attr_conversion_cost: "3",
          time_attr_on_web_cart: "5",
          cpc: "0.3",
        },
      },
    });
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);
    provider.deleteFailureKind = "unknown";

    expect(store.listDeletionReadyAdGroups(
      "demo-account",
      "cookie",
      new Date(asOf.getTime() - 60 * 60 * 1000).toISOString(),
    )).toEqual([expect.objectContaining({ externalId: "adgroup-1" })]);

    await service.runScheduledDeletions("demo-account", asOf);
    await service.runScheduledDeletions("demo-account", asOf);

    expect(provider.deletions).toEqual([{ externalId: "adgroup-1" }]);
    expect(store.listAdOperations("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "delete", status: "unknown" }),
    ]));
  });

  it("keeps one group per campaign and applies cart plus positive-conversion CPA checks inside the scheduled hour only", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const guardedService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    settings.deletion.gracePeriodHours = 1;
    settings.deletion.maxConversions = 1;
    settings.deletion.maxCarts = 4;
    settings.deletion.minCpa = 9;
    store.updateAutomationFeatureSettings(settings);
    const asOf = futureShanghaiTime(6);
    vi.useFakeTimers();
    vi.setSystemTime(asOf);

    const groups = [
      { id: "delete-carts-4", name: "低质量组", conversions: 0, carts: 4, cpa: null },
      { id: "delete-cpa-10", name: "高 CPA 组", conversions: 1, carts: 2, cpa: 10 },
      { id: "keep-converting", name: "保留组", conversions: 2, carts: 5, cpa: 3 },
    ];
    const finishedAt = asOf.toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [
      { entityType: "campaign", externalId: "campaign-1", payload: { campaign_id: "campaign-1", campaign_name: "系列" } },
      ...groups.map((group) => ({
        entityType: "ad-group" as const,
        externalId: group.id,
        payload: {
          campaign_id: "campaign-1",
          ad_name: group.name,
          ad_primary_status: "disable",
          row_data: {
            campaign_id: "campaign-1",
            time_attr_convert_cnt: String(group.conversions),
            time_attr_on_web_cart: String(group.carts),
            ...(group.cpa === null ? {} : { time_attr_conversion_cost: String(group.cpa) }),
          },
        },
      })),
    ], {
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 1, "ad-group": 3, ad: 0, material: 0 },
      warnings: [],
      quality: {
        status: "healthy",
        paginationComplete: true,
        requiredMetricsComplete: true,
        contractValid: true,
        providerContractVersion: "test-v1",
        coverage: {
          startDate: dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai"),
          endDate: dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai"),
          timezone: "Asia/Shanghai",
        },
        missingMetrics: [],
        partialFailures: [],
        lastHealthyAt: finishedAt,
      },
    });
    const disabledAt = new Date(asOf.getTime() - 2 * 60 * 60_000).toISOString();
    for (const group of groups) {
      const operation = store.recordAdOperation({
        accountId: "demo-account",
        providerKind: "cookie",
        entityType: "ad-group",
        externalId: group.id,
        entityName: group.name,
        action: "disable",
        source: "automation",
        status: "succeeded",
        message: "disabled",
      });
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare("UPDATE ad_operations SET completed_at = ? WHERE id = ?")
        .run(disabledAt, operation.id);
    }

    await guardedService.runScheduledDeletions("demo-account", new Date(asOf.getTime() - 60 * 60_000));
    await guardedService.runScheduledDeletions("demo-account", new Date(asOf.getTime() + 60 * 60_000));
    expect(provider.deletions).toEqual([]);
    // 计划小时内的任意一分钟都要能触发：调度器 30 秒一跳，排在前面的账户真删起来会
    // 占掉整点那一分钟，锁死第 0 分钟等于让后面的账户永远轮不上。
    await guardedService.runScheduledDeletions("demo-account", new Date(asOf.getTime() + 2 * 60_000));
    // 同一本地日的第二次调用必须被每日领取锁挡住。
    await guardedService.runScheduledDeletions("demo-account", new Date(asOf.getTime() + 3 * 60_000));

    expect(provider.deletions).toEqual([
      { externalId: "delete-carts-4" },
      { externalId: "delete-cpa-10" },
    ]);
  });

  it("does not delete from a stale snapshot or an outdated capability authorization", async () => {
    provider.adGroupStatus = "disable";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    const disabled = store.recordAdOperation({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-1",
      entityName: "测试广告组",
      action: "disable",
      source: "automation",
      status: "succeeded",
      message: "confirmed disabled",
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const database = (store as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    }).db;
    database.prepare(
      "UPDATE ad_operations SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ).run(twoHoursAgo, twoHoursAgo, twoHoursAgo, disabled.id);
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    settings.deletion.gracePeriodHours = 1;
    store.updateAutomationFeatureSettings(settings);

    await service.runScheduledDeletions(
      "demo-account",
      new Date(Date.now() + 10 * 60 * 1000),
    );
    expect(provider.deletions).toEqual([]);

    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: "outdated",
      capabilities: ["delete-ad-groups"],
    });
    await service.runScheduledDeletions("demo-account", new Date());
    expect(provider.deletions).toEqual([]);
  });

  it("does not close an enabled ad group scheduled to start the next day", async () => {
    provider.scheduledStartAt = "2026-07-21T00:00:00.000Z";
    const refreshed = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", refreshed.entities, refreshed.result);

    expect(service.enrollNightlyAdGroups("demo-account", "2026-07-20T15:45:00.000Z")).toEqual({
      overnight: 0,
      closing: 0,
    });
    expect(store.listScheduledActions("demo-account")).toEqual([]);
  });

  it("executes a user-created schedule while the account is in automatic mode", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    });
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await service.runDueScheduledActions("demo-account");

    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule.id))
      .toMatchObject({ status: "completed", lastResult: "succeeded" });
  });

  it("does not reschedule a repeating action after an unknown live write result", async () => {
    await service.runAccount("demo-account", "preview");
    const [schedule] = store.createOvernightSchedule("demo-account", {
      externalId: "adgroup-1",
      disableAt: new Date(Date.now() - 1_000).toISOString(),
      enableAt: new Date(Date.now() + 60_000).toISOString(),
    });
    provider.statusFailureKind = "unknown";

    await service.runDueScheduledActions("demo-account");

    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule!.id))
      .toMatchObject({
        status: "failed",
        lastResult: "failed",
        lastMessage: expect.stringContaining("unknown"),
      });
    expect(store.listDueScheduledActions("demo-account")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: schedule!.id })]),
    );
  });

  it("lets only one service instance dispatch the same due schedule", async () => {
    await service.runAccount("demo-account", "preview");
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });
    provider.statusDelayMs = 30;
    const secondService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
    );

    await Promise.all([
      service.runDueScheduledActions("demo-account"),
      secondService.runDueScheduledActions("demo-account"),
    ]);

    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(store.listAdOperations("demo-account").filter((item) => item.source === "scheduled"))
      .toHaveLength(1);
    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule.id))
      .toMatchObject({ status: "completed", lastResult: "succeeded" });
  });

  it("does not run a due schedule while the same account is syncing", async () => {
    await service.runAccount("demo-account", "preview");
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });
    let releaseSync!: () => void;
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => { syncStarted = resolve; });
    provider.afterSync = () => new Promise<void>((resolve) => {
      releaseSync = resolve;
      syncStarted();
    });

    const running = service.runAccount("demo-account", "preview");
    await started;
    await service.runDueScheduledActions("demo-account");

    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule.id)?.status).toBe("scheduled");
    expect(provider.mutations).toHaveLength(0);
    releaseSync();
    await running;
  });

  it("keeps higher-priority direct closures before applying the per-run limit", async () => {
    provider.scenario = "priority";
    store.updateGlobalAutomationSettings({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 1,
    });

    await service.runAccount("demo-account", "manual");

    expect(provider.mutations).toEqual([{ entityType: "ad-group", externalId: "adgroup-high-priority", action: "disable" }]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "adgroup-high-priority", status: "succeeded" }),
      expect.objectContaining({ externalId: "adgroup-low-priority", status: "skipped" }),
    ]));
  });

  it("filters parent-child conflicts before applying the per-run limit", async () => {
    provider.scenario = "parent-child";
    store.updateGlobalAutomationSettings({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 1,
    });

    await service.runAccount("demo-account", "preview");

    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalId: "ad-1",
        action: "enable",
        status: "skipped",
        errorMessage: "父广告组建议关闭，本轮不建议开启子级。",
      }),
      expect.objectContaining({
        externalId: "adgroup-1",
        action: "disable",
        status: "preview",
      }),
    ]));
  });

  it("summarizes one due scheduler cycle and dispatches it once", async () => {
    const cycles: Parameters<PollNotificationDispatcher["enqueueAndDispatch"]>[0][] = [];
    const dispatcher: PollNotificationDispatcher = {
      flushPending: vi.fn(async () => undefined),
      enqueueAndDispatch: vi.fn(async (cycle) => {
        cycles.push(cycle);
      }),
    };
    const scheduler = new AutomationScheduler(store, service, dispatcher);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.tick();
    await scheduler.tick();

    vi.useRealTimers();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.accounts[0]).toMatchObject({
      accountName: "演示广告账户",
      status: "changed",
      enabledCount: 0,
      disabledCount: 1,
    });
  });

  it("keeps Meta on its own scheduler lane without TikTok-only schedules, appeals, deletion or copy", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: true,
      liveMode: "automation-status",
    });
    const demo = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: demo.displayName,
      accountType: demo.accountType,
      enabled: false,
      providerKind: demo.providerKind,
    });
    const runtime = store.getMetaAutomationRuntime();
    store.updateMetaAutomationRuntime({
      enabled: true,
      pollingIntervalMinutes: 1,
      maxActionsPerRun: runtime.maxActionsPerRun,
    }, runtime.updatedAt);
    const nightly = vi.spyOn(service, "enrollNightlyAdGroups");
    const appeals = vi.spyOn(service, "runScheduledAppeals");
    const schedules = vi.spyOn(service, "runDueScheduledActions");
    const deletions = vi.spyOn(service, "runScheduledDeletions");
    const copies = vi.spyOn(service, "runScheduledAutoCopies");
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 10 * 60_000));

    store.updateSystemRuntimeState({ enabled: false });
    await scheduler.tick();
    expect(metaProvider.mutations).toEqual([]);
    store.updateSystemRuntimeState({ enabled: true });

    await scheduler.tick();

    expect(metaProvider.mutations).toHaveLength(3);
    for (const spy of [nightly, appeals, schedules, deletions, copies]) {
      expect(spy.mock.calls.some(([accountId]) => accountId === account.id)).toBe(false);
    }
    expect(store.listScheduledActions(account.id)).toEqual([]);
  });

  it("continues the TikTok scheduler lane when the Meta lane health check fails", async () => {
    const { account, metaProvider } = await setupMetaAccount({
      enabled: true,
      liveMode: "automation-status",
    });
    const runtime = store.getMetaAutomationRuntime();
    store.updateMetaAutomationRuntime({
      enabled: true,
      pollingIntervalMinutes: 1,
      maxActionsPerRun: runtime.maxActionsPerRun,
    }, runtime.updatedAt);
    metaProvider.shouldSyncFail = true;
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.tick();

    expect(store.getProviderConnection(account.id, "meta-marketing-api"))
      .toMatchObject({ status: "failed" });
    expect(store.listAutomationRuns("demo-account")).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "completed" })]),
    );
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(store.listPollCycles()[0]?.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: account.id, status: "failed" }),
      expect.objectContaining({ accountId: "demo-account", status: "changed" }),
    ]));
  });

  // 回归：删除执行器曾经被放在「轮询到期」过滤之后的循环里，只有恰好在计划时刻到期的
  // 那一轮才有机会评估。生产环境 19 天里只命中过 7 次，删除一次都没跑起来。它必须和
  // 自动申诉一样，每一跳都对全部账户评估一次。
  it("evaluates scheduled deletions on every tick even when no account is due for polling", async () => {
    const scheduler = new AutomationScheduler(store, service);
    const deletions = vi.spyOn(service, "runScheduledDeletions");
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));
    // 刚检测过连接 = 本轮不到期，轮询会被跳过。
    await service.checkAccountConnection("demo-account");

    await scheduler.tick();

    vi.useRealTimers();
    expect(store.listPollCycles()).toHaveLength(0);
    expect(deletions).toHaveBeenCalledWith("demo-account");
  });

  // 回归：定时执行器和只读同步原先同在一跳里，共用一把重入锁。轮询长跑期间新的
  // 一跳会被整个丢掉，定时执行器跟着一起丢——而自动申诉只在每个整点的第 0 分钟
  // 有机会（30 秒一跳 = 2 次机会），一轮长跑跨过整点，这一小时的申诉就整个不跑。
  it("轮询还没跑完时，定时执行器照常按时评估", async () => {
    let releasePoll = (): void => {};
    const pollInFlight = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    vi.spyOn(service, "runAccount").mockImplementation(async () => {
      await pollInFlight;
      throw new Error("轮询在测试里被主动放行后结束");
    });
    const appeals = vi.spyOn(service, "runScheduledAppeals");
    const schedules = vi.spyOn(service, "runDueScheduledActions");
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    // 上一轮轮询还卡在同步里，故意不 await。
    const polling = scheduler.runPollCycle();
    await scheduler.runMaintenance();

    expect(appeals).toHaveBeenCalledWith("demo-account");
    expect(schedules).toHaveBeenCalledWith("demo-account");

    releasePoll();
    await polling;
    vi.useRealTimers();
  });

  // 账户之间没有任何数据依赖，串行纯粹是在排队等网络：一轮的耗时原先是所有账户
  // 相加，队尾账户还要额外背上前面所有账户的耗时。
  it("同一批次里的账户并发轮询，而不是一个接一个排队", async () => {
    await setupExtraTikTokAccount("第二个账户");
    await setupExtraTikTokAccount("第三个账户");
    let inFlight = 0;
    let peak = 0;
    provider.afterSync = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
    };
    const scheduler = new AutomationScheduler(store, service);
    // shouldAdvanceTime：既要把时钟推到到期，又要让 afterSync 里的真实延迟走得动。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.runPollCycle();

    vi.useRealTimers();
    expect(peak).toBeGreaterThan(1);
    // 三个账户都进了同一个批次，一个都没漏。
    expect(store.listPollCycles()).toHaveLength(1);
    expect(store.listPollCycles()[0]?.accounts).toHaveLength(3);
  });

  // 并发不能把出口打爆：账户并发 × 层内并发才是真正打到 TikTok 的峰值。
  it("账户并发有上限，不会把所有账户一次性全放出去", async () => {
    for (let index = 0; index < 6; index += 1) {
      await setupExtraTikTokAccount(`批量账户 ${index}`);
    }
    let inFlight = 0;
    let peak = 0;
    provider.afterSync = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
    };
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.runPollCycle();

    vi.useRealTimers();
    expect(store.listPollCycles()[0]?.accounts).toHaveLength(7);
    expect(peak).toBe(3);
  });

  // 并发之后一个账户抛错会直接拒绝掉整批的 promise，其余账户的结果跟着一起丢。
  it("一个账户失败不带走同批次的其他账户", async () => {
    const failing = await setupExtraTikTokAccount("会失败的账户");
    const original = service.runAccount.bind(service);
    vi.spyOn(service, "runAccount").mockImplementation(async (accountId, trigger) => {
      if (accountId === failing.id) throw new Error("这个账户炸了");
      return original(accountId, trigger);
    });
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.runPollCycle();

    vi.useRealTimers();
    const accounts = store.listPollCycles()[0]?.accounts ?? [];
    expect(accounts).toHaveLength(2);
    expect(accounts.find((item) => item.accountId === failing.id)).toMatchObject({
      status: "failed",
      message: "这个账户炸了",
    });
    expect(accounts.find((item) => item.accountId === "demo-account")?.status)
      .not.toBe("failed");
  });

  // 消息推送的契约：每个存在到期账户的批次结束后各渠道发一份账户汇总。并发是
  // 批次**内部**的事，拆成每账户一条会让用户的推送量直接乘以账户数。
  it("并发轮询后仍然是一个批次一份汇总", async () => {
    await setupExtraTikTokAccount("第二个账户");
    const cycles: Parameters<PollNotificationDispatcher["enqueueAndDispatch"]>[0][] = [];
    const dispatcher: PollNotificationDispatcher = {
      flushPending: vi.fn(async () => undefined),
      enqueueAndDispatch: vi.fn(async (cycle) => {
        cycles.push(cycle);
      }),
    };
    const scheduler = new AutomationScheduler(store, service, dispatcher);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.runPollCycle();

    vi.useRealTimers();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.accounts).toHaveLength(2);
  });

  // 同一件事在生产入口上再验一次：start() 必须真的挂出两条互不相干的定时器，
  // 否则前一条测试保证的只是「分开调用时互不阻塞」，而生产上没人会分开调用。
  it("start() 挂出的两条循环互不阻塞：轮询卡住时定时执行器照常跳", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));
    let releasePoll = (): void => {};
    const pollInFlight = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    vi.spyOn(service, "runAccount").mockImplementation(async () => {
      await pollInFlight;
      throw new Error("轮询在测试里被主动放行后结束");
    });
    const appeals = vi.spyOn(service, "runScheduledAppeals");
    const scheduler = new AutomationScheduler(store, service);

    scheduler.start();
    // 首跳（5 秒）把轮询卡住，再走过一个 30 秒的维护间隔。
    await vi.advanceTimersByTimeAsync(40_000);

    // 合成一条循环时，卡住的轮询会让后面每一跳都被重入锁整个丢掉，这里只会有 1 次。
    expect(appeals.mock.calls.length).toBeGreaterThanOrEqual(2);

    scheduler.stop();
    releasePoll();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  // 到期判定原先读连接上的 lastTestedAt，而它是在每个账户轮询**开头**刷新的，
  // 于是这一轮自身的耗时被算进了下一轮的间隔：一轮 6 分钟、间隔 5 分钟，跑完立刻
  // 又到期，轮询退化成「跑完马上再跑」，设置里的间隔形同虚设。
  it("下一次到期从本轮结束起算，一轮跑超过间隔也不会立刻再跑", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));
    // 轮询间隔默认 5 分钟；让这一轮跑 6 分钟。
    provider.afterSync = () => {
      vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    };
    const scheduler = new AutomationScheduler(store, service);

    await scheduler.runPollCycle();
    expect(store.listPollCycles()).toHaveLength(1);

    provider.afterSync = null;
    await scheduler.runPollCycle();

    vi.useRealTimers();
    expect(store.listPollCycles()).toHaveLength(1);
  });

  // 连接检测紧接着就是一次真实的只读同步，同一个会话连查两遍，每账户白白多一次
  // 往返。同步成功本身就是最强的连接检测。
  it("ready 的账户不再为轮询单独探一次连接检测", async () => {
    const health = vi.spyOn(provider, "checkHealth");
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.runPollCycle();

    vi.useRealTimers();
    expect(health).not.toHaveBeenCalled();
    // 但「最近检查」必须由这一轮同步接上，否则界面上的连接状态会一直停在旧时刻。
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "ready",
      lastMessage: "Cookie 会话可用：只读同步成功。",
    });
    expect(store.listPollCycles()[0]?.accounts[0]).toMatchObject({ accountId: "demo-account" });
  });

  // 反过来这一次探测不能省：失效连接靠它自动恢复，省掉就再也回不来了。
  it("连接失效的账户仍然先探一次，探通了继续跑规则", async () => {
    store.updateProviderStatus("demo-account", "cookie", "failed", "Cookie 已失效");
    const health = vi.spyOn(provider, "checkHealth");
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.runPollCycle();

    vi.useRealTimers();
    expect(health).toHaveBeenCalledTimes(1);
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({ status: "ready" });
    expect(store.listPollCycles()[0]?.accounts[0]?.status).not.toBe("failed");
  });

  // 同一条恢复规则，只把时间挪进 23:45–零点，就不该再派发开启。
  it("过夜关停窗口内不派发自动开启，只留一条跳过记录", async () => {
    provider.scenario = "recovery";
    provider.adGroupStatus = "disable";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(23, 50));

    await scheduler.tick();

    vi.useRealTimers();
    // 一个开启请求都没发出去。
    expect(provider.mutations.filter((mutation) => mutation.action === "enable")).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      externalId: "adgroup-1",
      action: "enable",
      status: "skipped",
    });
    expect(store.listAutomationDecisions("demo-account")[0]?.errorMessage)
      .toContain("过夜关停窗口");
  });

  // 素材层打通的端到端验证：规则命中素材 → 真的发出带广告组 ID 的启停请求。
  it("规则按素材判定并关闭素材本身", async () => {
    provider.scenario = "material";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.tick();

    vi.useRealTimers();
    const materialMutations = provider.mutations.filter(
      (mutation) => mutation.entityType === "material",
    );
    expect(materialMutations).toHaveLength(1);
    expect(materialMutations[0]).toMatchObject({
      externalId: "1872777743628513",
      action: "disable",
      // 缺了广告组 ID，procedural_material/update_status 发不出去。
      parentAdGroupId: "adgroup-1",
    });
  });

  // 程序化创意下一个广告组只有 1 个广告、内含多个素材。规则关广告总开关等同于关
  // 整组，还会造出「广告组开着、广告关着」——人工把组开回来也投不出去。2026-08-08
  // 生产上 11 个组处于这个状态，其中 1 个正是规则关的。
  it("规则不关广告总开关，只留一条跳过记录", async () => {
    provider.scenario = "ad-switch";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.tick();

    vi.useRealTimers();
    // 广告层一个关闭请求都没发出去。
    expect(provider.mutations.filter(
      (mutation) => mutation.entityType === "ad" && mutation.action === "disable",
    )).toEqual([]);
    const adDecision = store.listAutomationDecisions("demo-account")
      .find((decision) => decision.externalId === "ad-1" && decision.action === "disable");
    expect(adDecision).toMatchObject({ status: "skipped" });
    expect(adDecision?.errorMessage).toContain("广告总开关保持常开");
  });

  // 开启方向是纠正方向，不能一起拦掉——否则「组开着广告关着」永远修不回来。
  it("规则仍然可以开启广告总开关", async () => {
    provider.scenario = "recovery";
    provider.adGroupStatus = "disable";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.tick();

    vi.useRealTimers();
    expect(provider.mutations.some((mutation) => mutation.action === "enable")).toBe(true);
  });

  // 零点至凌晨 3 点：过夜组刚被排期开回来，当日数据从零开始，规则一判必关。
  // 2026-08-08 00:00:40 开启的「翻譯機_新」，00:07:59 就被「零转化消耗过高」关了。
  it("零点至凌晨 3 点内不调整过夜组", async () => {
    provider.scenario = "recovery";
    provider.adGroupStatus = "disable";
    store.createOvernightSchedule("demo-account", {
      externalId: "adgroup-1",
      disableAt: new Date().toISOString(),
      enableAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(0, 30));

    await scheduler.tick();

    vi.useRealTimers();
    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      externalId: "adgroup-1",
      status: "skipped",
    });
    expect(store.listAutomationDecisions("demo-account")[0]?.errorMessage)
      .toContain("过夜组");
  });

  // 保护只针对过夜组：同一时段里其它组照常受规则调整。
  it("零点至凌晨 3 点内非过夜组照常调整", async () => {
    provider.scenario = "recovery";
    provider.adGroupStatus = "disable";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(0, 30));

    await scheduler.tick();

    vi.useRealTimers();
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "enable" },
    ]);
  });

  it("reports a verified automatic recovery enable in the scheduler summary", async () => {
    provider.scenario = "recovery";
    provider.adGroupStatus = "disable";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await scheduler.tick();

    vi.useRealTimers();
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "enable" },
    ]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      externalId: "adgroup-1",
      action: "enable",
      status: "succeeded",
    });
    expect(store.listPollCycles()[0]?.accounts[0]).toMatchObject({
      status: "changed",
      enabledCount: 1,
      disabledCount: 0,
    });
  });

  it("continues polling when notification delivery is unavailable", async () => {
    const dispatcher: PollNotificationDispatcher = {
      flushPending: vi.fn(async () => {
        throw new Error("notification storage unavailable");
      }),
      enqueueAndDispatch: vi.fn(async () => {
        throw new Error("notification delivery unavailable");
      }),
    };
    const scheduler = new AutomationScheduler(store, service, dispatcher);
    vi.useFakeTimers();
    vi.setSystemTime(futureShanghaiTime(10));

    await expect(scheduler.tick()).resolves.toBeUndefined();

    vi.useRealTimers();
    expect(store.listPollCycles()).toHaveLength(1);
    expect(store.listAutomationRuns("demo-account")).toHaveLength(1);
  });

  it("does not open a child ad when its parent ad group closes in the same run", async () => {
    provider.scenario = "parent-child";

    const run = await service.runAccount("demo-account", "manual");

    expect(run.candidateCount).toBe(2);
    expect(provider.mutations).toEqual([{ entityType: "ad-group", externalId: "adgroup-1", action: "disable" }]);
    expect(
      store
        .listAutomationDecisions("demo-account")
        .find((decision) => decision.externalId === "ad-1"),
    ).toMatchObject({
      status: "skipped",
      errorMessage: "父广告组建议关闭，本轮不建议开启子级。",
    });
  });

  it("skips a child enable suggestion when its parent campaign is suggested to close", async () => {
    provider.scenario = "campaign-parent-child";
    const configuration = store.getRuleConfiguration();
    store.updateRuleConfiguration({
      layers: { ...configuration.layers, campaign: true },
      rules: configuration.rules,
    });

    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(2);
    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "campaign", externalId: "campaign-1", action: "disable", status: "preview" }),
      expect.objectContaining({ entityType: "ad-group", externalId: "adgroup-1", action: "enable", status: "skipped", errorMessage: "父推广系列建议关闭，本轮不建议开启子对象。" }),
    ]));
  });

  it("skips a child enable suggestion when its existing parent campaign is disabled", async () => {
    provider.scenario = "disabled-parent";

    await service.runAccount("demo-account", "preview");

    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: "ad-group",
        externalId: "adgroup-1",
        action: "enable",
        status: "skipped",
        errorMessage: "父推广系列处于关闭状态，不建议开启子对象。",
      }),
    ]));
  });

  it("skips enabling a material whose parent ad group is already closed", async () => {
    provider.scenario = "material-closed-parent";

    // manual 触发在本套件里是真实派发（automatic:true）；守卫失效时会真的发出
    // 一条 material enable。
    await service.runAccount("demo-account", "manual");

    expect(
      provider.mutations.some((mutation) => mutation.entityType === "material"),
    ).toBe(false);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: "material",
        externalId: "1872777743628513",
        action: "enable",
        status: "skipped",
        errorMessage: "父广告组处于关闭状态，不建议开启子级。",
      }),
    ]));
  });

  it("produces the same semantic suggestion key for identical inputs", async () => {
    await service.runAccount("demo-account", "preview");
    const first = store.listAutomationDecisions("demo-account")[0]!;

    await service.runAccount("demo-account", "preview");
    const second = store.listAutomationDecisions("demo-account")[0]!;

    expect(second.suggestionKey).toBe(first.suggestionKey);
    expect(second.ruleVersion).toBe(first.ruleVersion);
    expect(second.rulePredicate).toEqual(first.rulePredicate);
    expect(first.rulePredicate).toMatchObject({
      code: first.thresholdCode,
      enabled: true,
      lookbackHours: 48,
      values: expect.any(Object),
    });
    expect(second.metricSnapshot).toEqual(first.metricSnapshot);
    expect(provider.mutations).toEqual([]);
  });

  it("keeps the suggestion key stable when the same rule configuration is resaved", async () => {
    await service.runAccount("demo-account", "preview");
    const first = store.listAutomationDecisions("demo-account")[0]!;
    const configuration = store.getRuleConfiguration();
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.updateRuleConfiguration({
      layers: configuration.layers,
      rules: configuration.rules,
    });

    await service.runAccount("demo-account", "preview");
    const second = store.listAutomationDecisions("demo-account")[0]!;

    expect(second.suggestionKey).toBe(first.suggestionKey);
  });

  it("changes the suggestion key when the matched rule predicate changes", async () => {
    await service.runAccount("demo-account", "preview");
    const first = store.listAutomationDecisions("demo-account")[0]!;
    expect(first.thresholdCode).toBe("NO_CONV_SPEND_CLOSE");
    const configuration = store.getRuleConfiguration();
    store.updateRuleConfiguration({
      layers: configuration.layers,
      rules: configuration.rules.map((rule) =>
        rule.code === first.thresholdCode
          ? { ...rule, values: { ...rule.values, spend: 3 } }
          : rule,
      ),
    });

    await service.runAccount("demo-account", "preview");
    const second = store.listAutomationDecisions("demo-account")[0]!;

    expect(second.suggestionKey).not.toBe(first.suggestionKey);
  });
});
