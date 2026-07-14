import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AccountConfigSchema,
  GlobalAutomationSettingsSchema,
  type AccountConfig,
  type AccountSettingsUpdate,
  type AccountCreateInput,
  type GlobalAutomationSettings,
  type GlobalAutomationSettingsInput,
  type AutomationSwitchKey,
  type AutomationSwitches,
  type AutomationAction,
  type AutomationCandidate,
  type AutomationDecisionRecord,
  type AutomationDecisionStatus,
  type AutomationRunRecord,
  type AutomationTrigger,
  type AdOperationRecord,
  type EntityMetricSnapshotRecord,
  type MetricBatchRecord,
  type IgnoredEntityRecord,
  type ManagedEntityRecord,
  normalizeProviderEntity,
  ThresholdConfigSchema,
  type ThresholdConfig,
  type ThresholdInput,
  ProviderConnectionSchema,
  type ProviderConnection,
  type ProviderConnectionSettings,
  type ProviderEntity,
  type ProviderKind,
  type ReadOnlySyncResult,
  automationSwitchDefinitions,
  createDefaultAutomationSwitches,
  defaultThresholds,
  defaultRuleConfiguration,
  RULE_LOOKBACK_HOURS,
  RuleConfigurationInputSchema,
  RuleConfigurationSchema,
  type RuleConfiguration,
  type RuleConfigurationInput,
  METRIC_RETENTION_DAYS,
  SystemRuntimeStateSchema,
  type SystemRuntimeState,
  type SystemRuntimeUpdate,
  AutomationFeatureSettingsInputSchema,
  AutomationFeatureSettingsSchema,
  defaultAutomationFeatureSettings,
  type AutomationFeatureSettings,
  type AutomationFeatureSettingsInput,
  OneTimeScheduleInputSchema,
  OvernightScheduleInputSchema,
  ScheduledEntityActionRecordSchema,
  type OneTimeScheduleInput,
  type OvernightScheduleInput,
  type ScheduledEntityActionRecord,
  MultiAccountLaunchPlanInputSchema,
  MultiAccountLaunchPlanRecordSchema,
  type MultiAccountLaunchPlanInput,
  type MultiAccountLaunchPlanRecord,
  LocalUserRecordSchema,
  type LocalUserRecord,
  type LocalUserRole,
  NotificationChannelKindSchema,
  NotificationChannelSettingsSchema,
  NotificationDeliveryRecordSchema,
  PollAccountResultSchema,
  PollCycleRecordSchema,
  type NotificationChannelKind,
  type NotificationChannelRecord,
  type NotificationChannelSettings,
  type NotificationConnectionStatus,
  type NotificationDeliveryRecord,
  type PollAccountResult,
  type PollCycleRecord,
} from "@tk-auto/core";

type SqlRow = Record<string, unknown>;

export interface StoredProviderConnection extends ProviderConnection {
  credentialRef: string | null;
}

export interface StoredLocalUser extends LocalUserRecord {
  passwordHash: string;
  passwordSalt: string;
}

export interface StoredAuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface StoredNotificationChannel extends NotificationChannelRecord {
  credentialRef: string | null;
}

export class AutomationStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  seed(): void {
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM accounts")
      .get() as SqlRow;

    if (Number(countRow.count) > 0) {
      return;
    }

    const accountId = "demo-account";
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO accounts (
          id, display_name, account_type, enabled, provider_kind, credential_ref,
          timezone, polling_interval_minutes, max_actions_per_run,
          execution_mode, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        accountId,
        "演示广告账户",
        "standard",
        1,
        "cookie",
        null,
        "Asia/Shanghai",
        5,
        15,
        "automatic",
        now,
      );

    this.writeSwitches(accountId, createDefaultAutomationSwitches(), false);
    this.ensureGlobalDefaults();
    this.writeAudit("system", accountId, "account.seeded", {
      source: "default-seed",
    });
  }

  listAccounts(): AccountConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts ORDER BY display_name")
      .all() as SqlRow[];
    return rows.map(mapAccount);
  }

  createAccount(input: AccountCreateInput): AccountConfig {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO accounts (
          id, display_name, account_type, enabled, provider_kind,
          credential_ref, timezone, polling_interval_minutes,
          max_actions_per_run, execution_mode, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.displayName,
        input.accountType,
        toSqlBoolean(input.enabled),
        input.providerKind,
        "Asia/Shanghai",
        5,
        15,
        "automatic",
        now,
      );
    this.writeSwitches(id, createDefaultAutomationSwitches(), false);
    this.writeAudit("local-user", id, "account.created", {
      displayName: input.displayName,
      accountType: input.accountType,
    });
    return this.getAccount(id) as AccountConfig;
  }

  getAccount(accountId: string): AccountConfig | null {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(accountId) as SqlRow | undefined;
    return row ? mapAccount(row) : null;
  }

  updateAccountSettings(
    accountId: string,
    settings: AccountSettingsUpdate,
  ): AccountConfig | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE accounts SET
          display_name = ?, account_type = ?, enabled = ?, provider_kind = ?,
          execution_mode = 'automatic', updated_at = ?
        WHERE id = ?`,
      )
      .run(
        settings.displayName,
        settings.accountType,
        toSqlBoolean(settings.enabled),
        settings.providerKind,
        now,
        accountId,
      );

    if (result.changes === 0) {
      return null;
    }

    this.writeAudit("local-user", accountId, "account.settings.updated", {
      ...settings,
    });
    return this.getAccount(accountId);
  }

  getGlobalAutomationSettings(): GlobalAutomationSettings {
    this.ensureGlobalDefaults();
    const row = this.db
      .prepare("SELECT * FROM global_automation_settings WHERE id = 1")
      .get() as SqlRow;
    return GlobalAutomationSettingsSchema.parse({
      pollingIntervalMinutes: Number(row.polling_interval_minutes),
      maxActionsPerRun: Number(row.max_actions_per_run),
      updatedAt: row.updated_at,
    });
  }

  updateGlobalAutomationSettings(
    input: GlobalAutomationSettingsInput,
  ): GlobalAutomationSettings {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE global_automation_settings SET
          polling_interval_minutes = ?, max_actions_per_run = ?, updated_at = ?
        WHERE id = 1`,
      )
      .run(input.pollingIntervalMinutes, input.maxActionsPerRun, now);
    this.writeSystemAudit("global.automation-settings.updated", input);
    return this.getGlobalAutomationSettings();
  }

  listNotificationChannels(): NotificationChannelRecord[] {
    return NotificationChannelKindSchema.options.map((kind) => {
      const stored = this.getNotificationChannel(kind);
      return stored
        ? toPublicNotificationChannel(stored)
        : emptyNotificationChannel(kind);
    });
  }

  getNotificationChannel(
    kind: NotificationChannelKind,
  ): StoredNotificationChannel | null {
    const row = this.db
      .prepare("SELECT * FROM notification_channels WHERE channel_kind = ?")
      .get(kind) as SqlRow | undefined;
    return row ? mapStoredNotificationChannel(row) : null;
  }

  saveNotificationChannelSettings(
    input: NotificationChannelSettings,
  ): NotificationChannelRecord {
    const settings = NotificationChannelSettingsSchema.parse(input);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO notification_channels (
          channel_kind, settings_json, credential_ref, status, last_message,
          last_tested_at, updated_at
        ) VALUES (?, ?, NULL, 'not-configured', NULL, NULL, ?)
        ON CONFLICT(channel_kind) DO UPDATE SET
          settings_json = excluded.settings_json,
          status = CASE WHEN notification_channels.credential_ref IS NULL
            THEN 'not-configured' ELSE 'untested' END,
          last_message = NULL,
          last_tested_at = NULL,
          updated_at = excluded.updated_at`,
      )
      .run(settings.kind, JSON.stringify(settings), now);
    this.writeSystemAudit("notification.settings.updated", {
      channelKind: settings.kind,
      enabled: settings.enabled,
    });
    return toPublicNotificationChannel(
      this.getNotificationChannel(settings.kind) as StoredNotificationChannel,
    );
  }

  setNotificationCredentialReference(
    kind: NotificationChannelKind,
    credentialRef: string,
  ): NotificationChannelRecord {
    const result = this.db
      .prepare(
        `UPDATE notification_channels SET
          credential_ref = ?, status = 'untested', last_message = NULL,
          last_tested_at = NULL, updated_at = ?
        WHERE channel_kind = ?`,
      )
      .run(credentialRef, new Date().toISOString(), kind);
    if (result.changes === 0) {
      throw new Error("请先保存通知渠道参数，再保存凭据。");
    }
    this.writeSystemAudit("notification.credential.updated", {
      channelKind: kind,
    });
    return toPublicNotificationChannel(
      this.getNotificationChannel(kind) as StoredNotificationChannel,
    );
  }

  clearNotificationCredential(kind: NotificationChannelKind): string | null {
    const previous = this.getNotificationChannel(kind);
    if (!previous) return null;
    this.db
      .prepare(
        `UPDATE notification_channels SET
          credential_ref = NULL, status = 'not-configured',
          last_message = NULL, last_tested_at = NULL, updated_at = ?
        WHERE channel_kind = ?`,
      )
      .run(new Date().toISOString(), kind);
    this.writeSystemAudit("notification.credential.deleted", {
      channelKind: kind,
    });
    return previous.credentialRef;
  }

  updateNotificationChannelStatus(
    kind: NotificationChannelKind,
    status: NotificationConnectionStatus,
    message: string,
  ): NotificationChannelRecord {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE notification_channels SET
          status = ?, last_message = ?, last_tested_at = ?, updated_at = ?
        WHERE channel_kind = ?`,
      )
      .run(status, message.slice(0, 1000), now, now, kind);
    if (result.changes === 0) throw new Error("通知渠道尚未配置。");
    return toPublicNotificationChannel(
      this.getNotificationChannel(kind) as StoredNotificationChannel,
    );
  }

  createPollCycle(): PollCycleRecord {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const retentionCutoff = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    this.db
      .prepare("DELETE FROM poll_cycles WHERE started_at < ?")
      .run(retentionCutoff);
    this.db
      .prepare(
        `INSERT INTO poll_cycles (id, status, started_at, finished_at)
         VALUES (?, 'running', ?, NULL)`,
      )
      .run(id, startedAt);
    return this.getPollCycle(id) as PollCycleRecord;
  }

  savePollAccountResult(cycleId: string, input: PollAccountResult): void {
    const result = PollAccountResultSchema.parse(input);
    this.db
      .prepare(
        `INSERT INTO poll_cycle_accounts (
          cycle_id, account_id, account_name, run_id, result_status,
          enabled_count, disabled_count, failure_count, message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id, account_id) DO UPDATE SET
          account_name = excluded.account_name,
          run_id = excluded.run_id,
          result_status = excluded.result_status,
          enabled_count = excluded.enabled_count,
          disabled_count = excluded.disabled_count,
          failure_count = excluded.failure_count,
          message = excluded.message`,
      )
      .run(
        cycleId,
        result.accountId,
        result.accountName,
        result.runId,
        result.status,
        result.enabledCount,
        result.disabledCount,
        result.failureCount,
        result.message,
      );
  }

  finishPollCycle(cycleId: string): PollCycleRecord {
    const result = this.db
      .prepare(
        `UPDATE poll_cycles SET status = 'completed', finished_at = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), cycleId);
    if (result.changes === 0) throw new Error("轮询批次不存在。");
    return this.getPollCycle(cycleId) as PollCycleRecord;
  }

  getPollCycle(cycleId: string): PollCycleRecord | null {
    const row = this.db
      .prepare("SELECT * FROM poll_cycles WHERE id = ?")
      .get(cycleId) as SqlRow | undefined;
    if (!row) return null;
    const accounts = this.db
      .prepare(
        `SELECT * FROM poll_cycle_accounts WHERE cycle_id = ?
         ORDER BY account_name`,
      )
      .all(cycleId) as SqlRow[];
    return PollCycleRecordSchema.parse({
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? null,
      accounts: accounts.map(mapPollAccountResult),
    });
  }

  listPollCycles(limit = 20): PollCycleRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM poll_cycles ORDER BY started_at DESC LIMIT ?")
      .all(limit) as SqlRow[];
    return rows
      .map((row) => this.getPollCycle(String(row.id)))
      .filter((cycle): cycle is PollCycleRecord => Boolean(cycle));
  }

  summarizeAutomationRun(
    runId: string,
  ): Pick<
    PollAccountResult,
    "enabledCount" | "disabledCount" | "failureCount"
  > {
    const rows = this.db
      .prepare(
        `SELECT action, status, COUNT(*) AS count
         FROM automation_decisions WHERE run_id = ?
         GROUP BY action, status`,
      )
      .all(runId) as SqlRow[];
    let enabledCount = 0;
    let disabledCount = 0;
    let failureCount = 0;
    for (const row of rows) {
      const count = Number(row.count);
      if (row.status === "succeeded" && row.action === "enable") {
        enabledCount += count;
      }
      if (row.status === "succeeded" && row.action === "disable") {
        disabledCount += count;
      }
      if (row.status === "failed") failureCount += count;
    }
    return { enabledCount, disabledCount, failureCount };
  }

  enqueueNotificationDeliveries(cycleId: string): NotificationDeliveryRecord[] {
    const now = new Date().toISOString();
    for (const channel of this.listNotificationChannels()) {
      if (
        !channel.settings?.enabled ||
        !channel.hasCredential ||
        channel.status !== "ready"
      ) {
        continue;
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_deliveries (
            id, cycle_id, channel_kind, status, attempt_count, last_error,
            next_attempt_at, created_at, updated_at, sent_at
          ) VALUES (?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL)`,
        )
        .run(randomUUID(), cycleId, channel.kind, now, now);
    }
    return this.listNotificationDeliveries(100).filter(
      (delivery) => delivery.cycleId === cycleId,
    );
  }

  listDueNotificationDeliveries(limit = 20): NotificationDeliveryRecord[] {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_deliveries
         WHERE attempt_count < 3 AND (
           status = 'queued'
           OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (status = 'sending' AND updated_at <= ?)
         )
         ORDER BY created_at LIMIT ?`,
      )
      .all(now, stale, limit) as SqlRow[];
    return rows.map(mapNotificationDelivery);
  }

  markNotificationDeliverySending(id: string): NotificationDeliveryRecord {
    const result = this.db
      .prepare(
        `UPDATE notification_deliveries SET
          status = 'sending', attempt_count = attempt_count + 1,
          updated_at = ?, next_attempt_at = NULL
        WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes === 0) throw new Error("通知发送记录不存在。");
    return this.getNotificationDelivery(id) as NotificationDeliveryRecord;
  }

  markNotificationDeliverySent(id: string): NotificationDeliveryRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE notification_deliveries SET
          status = 'sent', last_error = NULL, next_attempt_at = NULL,
          updated_at = ?, sent_at = ? WHERE id = ?`,
      )
      .run(now, now, id);
    return this.getNotificationDelivery(id) as NotificationDeliveryRecord;
  }

  markNotificationDeliveryFailed(
    id: string,
    message: string,
  ): NotificationDeliveryRecord {
    const existing = this.getNotificationDelivery(id);
    if (!existing) throw new Error("通知发送记录不存在。");
    const delayMinutes = Math.min(
      30,
      2 ** Math.max(0, existing.attemptCount - 1),
    );
    const nextAttemptAt = new Date(
      Date.now() + delayMinutes * 60_000,
    ).toISOString();
    this.db
      .prepare(
        `UPDATE notification_deliveries SET
          status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        message.slice(0, 1000),
        nextAttemptAt,
        new Date().toISOString(),
        id,
      );
    return this.getNotificationDelivery(id) as NotificationDeliveryRecord;
  }

  listNotificationDeliveries(limit = 50): NotificationDeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_deliveries
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as SqlRow[];
    return rows.map(mapNotificationDelivery);
  }

  private getNotificationDelivery(
    id: string,
  ): NotificationDeliveryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM notification_deliveries WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapNotificationDelivery(row) : null;
  }

  getRuleConfiguration(): RuleConfiguration {
    this.ensureGlobalDefaults();
    const row = this.db
      .prepare("SELECT * FROM global_rule_configuration WHERE id = 1")
      .get() as SqlRow;
    return RuleConfigurationSchema.parse({
      lookbackHours: RULE_LOOKBACK_HOURS,
      layers: JSON.parse(String(row.layers_json)),
      rules: JSON.parse(String(row.rules_json)),
      updatedAt: row.updated_at,
    });
  }

  updateRuleConfiguration(
    input: RuleConfigurationInput,
  ): RuleConfiguration {
    const configuration = RuleConfigurationInputSchema.parse(input);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE global_rule_configuration
         SET layers_json = ?, rules_json = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        JSON.stringify(configuration.layers),
        JSON.stringify(configuration.rules),
        now,
      );
    this.writeSystemAudit("global.rules.updated", configuration);
    return this.getRuleConfiguration();
  }

  getSystemRuntimeState(): SystemRuntimeState {
    this.ensureGlobalDefaults();
    const row = this.db
      .prepare("SELECT * FROM global_runtime_state WHERE id = 1")
      .get() as SqlRow;
    return SystemRuntimeStateSchema.parse({
      enabled: fromSqlBoolean(row.enabled),
      updatedAt: row.updated_at,
    });
  }

  updateSystemRuntimeState(input: SystemRuntimeUpdate): SystemRuntimeState {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE global_runtime_state SET enabled = ?, updated_at = ? WHERE id = 1",
      )
      .run(toSqlBoolean(input.enabled), now);
    this.writeSystemAudit("global.runtime.updated", input);
    return this.getSystemRuntimeState();
  }

  getAutomationFeatureSettings(): AutomationFeatureSettings {
    this.ensureGlobalDefaults();
    const row = this.db
      .prepare("SELECT * FROM automation_feature_settings WHERE id = 1")
      .get() as SqlRow;
    return AutomationFeatureSettingsSchema.parse({
      ...JSON.parse(String(row.settings_json)),
      updatedAt: row.updated_at,
    });
  }

  updateAutomationFeatureSettings(
    input: AutomationFeatureSettingsInput,
  ): AutomationFeatureSettings {
    const settings = AutomationFeatureSettingsInputSchema.parse(input);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE automation_feature_settings
         SET settings_json = ?, updated_at = ? WHERE id = 1`,
      )
      .run(JSON.stringify(settings), now);
    this.writeSystemAudit("global.feature-settings.updated", settings);
    return this.getAutomationFeatureSettings();
  }

  countLocalUsers(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM local_users")
      .get() as SqlRow;
    return Number(row.count);
  }

  listLocalUsers(): LocalUserRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM local_users ORDER BY created_at ASC")
      .all() as SqlRow[];
    return rows.map(mapLocalUser);
  }

  getStoredLocalUserByUsername(username: string): StoredLocalUser | null {
    const row = this.db
      .prepare("SELECT * FROM local_users WHERE username = ?")
      .get(username) as SqlRow | undefined;
    return row ? mapStoredLocalUser(row) : null;
  }

  getStoredLocalUser(userId: string): StoredLocalUser | null {
    const row = this.db
      .prepare("SELECT * FROM local_users WHERE id = ?")
      .get(userId) as SqlRow | undefined;
    return row ? mapStoredLocalUser(row) : null;
  }

  createLocalUser(input: {
    username: string;
    displayName: string;
    role: LocalUserRole;
    passwordHash: string;
    passwordSalt: string;
  }): LocalUserRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO local_users (
          id, username, display_name, role, enabled, password_hash,
          password_salt, last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.username,
        input.displayName,
        input.role,
        input.passwordHash,
        input.passwordSalt,
        now,
        now,
      );
    this.writeSystemAudit("local-user.created", {
      id,
      username: input.username,
      role: input.role,
    });
    return mapLocalUser(
      this.db.prepare("SELECT * FROM local_users WHERE id = ?").get(id) as SqlRow,
    );
  }

  updateLocalUser(
    userId: string,
    input: { displayName: string; role: LocalUserRole; enabled: boolean },
  ): LocalUserRecord | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE local_users SET display_name = ?, role = ?, enabled = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(
        input.displayName,
        input.role,
        toSqlBoolean(input.enabled),
        now,
        userId,
      );
    if (result.changes === 0) return null;
    if (!input.enabled) {
      this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    }
    this.writeSystemAudit("local-user.updated", { userId, ...input });
    return mapLocalUser(
      this.db.prepare("SELECT * FROM local_users WHERE id = ?").get(userId) as SqlRow,
    );
  }

  updateLocalUserPassword(
    userId: string,
    passwordHash: string,
    passwordSalt: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE local_users SET password_hash = ?, password_salt = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(passwordHash, passwordSalt, new Date().toISOString(), userId);
    if (result.changes > 0) {
      this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
      this.writeSystemAudit("local-user.password.updated", { userId });
    }
    return result.changes > 0;
  }

  recordLocalUserLogin(userId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE local_users SET last_login_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, userId);
  }

  createAuthSession(input: StoredAuthSession): void {
    this.cleanupExpiredAuthSessions();
    this.db
      .prepare(
        `INSERT INTO auth_sessions (
          id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.tokenHash,
        input.csrfToken,
        input.expiresAt,
        input.createdAt,
        input.lastSeenAt,
      );
  }

  getAuthSession(tokenHash: string): StoredAuthSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM auth_sessions
         WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(tokenHash, new Date().toISOString()) as SqlRow | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?")
      .run(new Date().toISOString(), String(row.id));
    return mapAuthSession(row);
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  cleanupExpiredAuthSessions(): void {
    this.db
      .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
      .run(new Date().toISOString());
  }

  listProviderConnections(accountId: string): ProviderConnection[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM provider_connections WHERE account_id = ? ORDER BY provider_kind",
      )
      .all(accountId) as SqlRow[];
    return rows.map((row) => mapProviderConnection(row));
  }

  getProviderConnection(
    accountId: string,
    kind: ProviderKind,
  ): StoredProviderConnection | null {
    const row = this.db
      .prepare(
        "SELECT * FROM provider_connections WHERE account_id = ? AND provider_kind = ?",
      )
      .get(accountId, kind) as SqlRow | undefined;
    return row ? mapStoredProviderConnection(row) : null;
  }

  saveProviderConnectionSettings(
    accountId: string,
    settings: ProviderConnectionSettings,
  ): ProviderConnection {
    this.assertAccount(accountId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO provider_connections (
          account_id, provider_kind, settings_json, credential_ref, status,
          last_message, last_tested_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'not-configured', NULL, NULL, ?)
        ON CONFLICT(account_id, provider_kind) DO UPDATE SET
          settings_json = excluded.settings_json,
          status = CASE WHEN provider_connections.credential_ref IS NULL
            THEN 'not-configured' ELSE 'untested' END,
          last_message = NULL,
          updated_at = excluded.updated_at`,
      )
      .run(accountId, settings.kind, JSON.stringify(settings), now);
    this.writeAudit("local-user", accountId, "provider.settings.updated", {
      providerKind: settings.kind,
      settings,
    });
    const connection = this.getProviderConnection(accountId, settings.kind);
    if (!connection) throw new Error("Provider connection was not persisted");
    return toPublicProviderConnection(connection);
  }

  setProviderCredentialReference(
    accountId: string,
    kind: ProviderKind,
    credentialRef: string,
  ): ProviderConnection {
    const result = this.db
      .prepare(
        `UPDATE provider_connections SET
          credential_ref = ?, status = 'untested', last_message = NULL,
          last_tested_at = NULL, updated_at = ?
        WHERE account_id = ? AND provider_kind = ?`,
      )
      .run(credentialRef, new Date().toISOString(), accountId, kind);
    if (result.changes === 0) {
      throw new Error("请先保存接入参数，再保存凭据。");
    }
    this.writeAudit("local-user", accountId, "provider.credential.updated", {
      providerKind: kind,
    });
    const connection = this.getProviderConnection(accountId, kind);
    if (!connection) throw new Error("Provider connection was not persisted");
    return toPublicProviderConnection(connection);
  }

  clearProviderCredential(
    accountId: string,
    kind: ProviderKind,
  ): string | null {
    const existing = this.getProviderConnection(accountId, kind);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE provider_connections SET
          credential_ref = NULL, status = 'not-configured', last_message = NULL,
          last_tested_at = NULL, updated_at = ?
        WHERE account_id = ? AND provider_kind = ?`,
      )
      .run(new Date().toISOString(), accountId, kind);
    this.writeAudit("local-user", accountId, "provider.credential.deleted", {
      providerKind: kind,
    });
    return existing.credentialRef;
  }

  updateProviderStatus(
    accountId: string,
    kind: ProviderKind,
    status: "ready" | "failed",
    message: string,
  ): ProviderConnection {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE provider_connections SET
          status = ?, last_message = ?, last_tested_at = ?, updated_at = ?
        WHERE account_id = ? AND provider_kind = ?`,
      )
      .run(status, message, now, now, accountId, kind);
    const connection = this.getProviderConnection(accountId, kind);
    if (!connection) throw new Error("Provider connection not found");
    return toPublicProviderConnection(connection);
  }

  saveReadOnlySync(
    accountId: string,
    kind: ProviderKind,
    entities: ProviderEntity[],
    result: ReadOnlySyncResult,
  ): void {
    const remove = this.db.prepare(
      "DELETE FROM provider_entities WHERE account_id = ? AND provider_kind = ?",
    );
    const insert = this.db.prepare(
      `INSERT INTO provider_entities (
        account_id, provider_kind, entity_type, external_id, payload_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertSnapshot = this.db.prepare(
      `INSERT INTO entity_metric_snapshots (
        id, account_id, provider_kind, entity_type, external_id, entity_name,
        operational_status, metrics_json, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      remove.run(accountId, kind);
      for (const entity of entities) {
        insert.run(
          accountId,
          kind,
          entity.entityType,
          entity.externalId,
          JSON.stringify(entity.payload),
          result.finishedAt,
        );
        const normalized = normalizeProviderEntity(entity);
        insertSnapshot.run(
          randomUUID(),
          accountId,
          kind,
          entity.entityType,
          entity.externalId,
          normalized.name,
          normalized.status,
          JSON.stringify(normalized.metrics),
          result.finishedAt,
        );
      }
      this.db
        .prepare(
          "DELETE FROM entity_metric_snapshots WHERE account_id = ? AND captured_at < ?",
        )
        .run(
          accountId,
          new Date(
            Date.now() - METRIC_RETENTION_DAYS * 24 * 60 * 60_000,
          ).toISOString(),
        );
      this.db
        .prepare(
          `INSERT INTO sync_runs (
            id, account_id, provider_kind, started_at, finished_at,
            counts_json, warnings_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          accountId,
          kind,
          result.startedAt,
          result.finishedAt,
          JSON.stringify(result.counts),
          JSON.stringify(result.warnings),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.writeAudit("local-user", accountId, "provider.read-sync.completed", {
      providerKind: kind,
      counts: result.counts,
      warnings: result.warnings,
    });
  }

  listProviderEntities(
    accountId: string,
    kind: ProviderKind,
  ): ProviderEntity[] {
    const rows = this.db
      .prepare(
        `SELECT entity_type, external_id, payload_json
         FROM provider_entities
         WHERE account_id = ? AND provider_kind = ?
         ORDER BY entity_type, external_id`,
      )
      .all(accountId, kind) as SqlRow[];
    return rows.map((row) => ({
      entityType: row.entity_type as ProviderEntity["entityType"],
      externalId: String(row.external_id),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  listManagedEntities(
    accountId: string,
    kind: ProviderKind,
  ): ManagedEntityRecord[] {
    const ignored = new Set(
      this.listIgnoredEntities(accountId, kind).map(
        (item) => `${item.entityType}:${item.externalId}`,
      ),
    );
    const rows = this.db
      .prepare(
        `SELECT entity_type, external_id, payload_json, synced_at
         FROM provider_entities
         WHERE account_id = ? AND provider_kind = ?
         ORDER BY entity_type, external_id`,
      )
      .all(accountId, kind) as SqlRow[];
    return rows.map((row) => {
      const snapshot = normalizeProviderEntity({
        entityType: row.entity_type as ProviderEntity["entityType"],
        externalId: String(row.external_id),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      });
      return {
        ...snapshot,
        ignored: ignored.has(`${snapshot.entityType}:${snapshot.externalId}`),
        syncedAt: String(row.synced_at),
      };
    });
  }

  listIgnoredEntities(
    accountId: string,
    kind: ProviderKind,
  ): IgnoredEntityRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ignored_entities
         WHERE account_id = ? AND provider_kind = ?
         ORDER BY created_at DESC`,
      )
      .all(accountId, kind) as SqlRow[];
    return rows.map((row) => ({
      accountId: String(row.account_id),
      providerKind: row.provider_kind as IgnoredEntityRecord["providerKind"],
      entityType: row.entity_type as IgnoredEntityRecord["entityType"],
      externalId: String(row.external_id),
      reason: String(row.reason),
      createdAt: String(row.created_at),
    }));
  }

  setEntityIgnored(
    accountId: string,
    kind: ProviderKind,
    entityType: ProviderEntity["entityType"],
    externalId: string,
    reason: string,
  ): IgnoredEntityRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ignored_entities (
          account_id, provider_kind, entity_type, external_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, provider_kind, entity_type, external_id)
        DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(accountId, kind, entityType, externalId, reason, now);
    this.recordAdOperation({
      accountId,
      providerKind: kind,
      entityType,
      externalId,
      entityName: this.findEntityName(accountId, kind, entityType, externalId),
      action: "ignore",
      source: "manual",
      status: "succeeded",
      message: reason,
    });
    return this.listIgnoredEntities(accountId, kind).find(
      (item) => item.entityType === entityType && item.externalId === externalId,
    ) as IgnoredEntityRecord;
  }

  removeEntityIgnored(
    accountId: string,
    kind: ProviderKind,
    entityType: ProviderEntity["entityType"],
    externalId: string,
  ): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM ignored_entities
         WHERE account_id = ? AND provider_kind = ? AND entity_type = ?
           AND external_id = ?`,
      )
      .run(accountId, kind, entityType, externalId);
    if (result.changes > 0) {
      this.recordAdOperation({
        accountId,
        providerKind: kind,
        entityType,
        externalId,
        entityName: this.findEntityName(accountId, kind, entityType, externalId),
        action: "unignore",
        source: "manual",
        status: "succeeded",
        message: null,
      });
    }
    return result.changes > 0;
  }

  isEntityIgnored(
    accountId: string,
    kind: ProviderKind,
    entityType: ProviderEntity["entityType"],
    externalId: string,
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM ignored_entities
           WHERE account_id = ? AND provider_kind = ? AND entity_type = ?
             AND external_id = ? LIMIT 1`,
        )
        .get(accountId, kind, entityType, externalId),
    );
  }

  recordAdOperation(
    input: Omit<AdOperationRecord, "id" | "createdAt">,
  ): AdOperationRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ad_operations (
          id, account_id, provider_kind, entity_type, external_id, entity_name,
          action, source, status, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.accountId,
        input.providerKind,
        input.entityType,
        input.externalId,
        input.entityName,
        input.action,
        input.source,
        input.status,
        input.message,
        createdAt,
      );
    const row = this.db
      .prepare("SELECT * FROM ad_operations WHERE id = ?")
      .get(id) as SqlRow;
    return mapAdOperation(row);
  }

  listAdOperations(accountId: string, limit = 100): AdOperationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ad_operations WHERE account_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(accountId, limit) as SqlRow[];
    return rows.map(mapAdOperation);
  }

  queueAppeal(
    accountId: string,
    kind: ProviderKind,
    externalId: string,
    reason: string,
  ): AdOperationRecord {
    return this.recordAdOperation({
      accountId,
      providerKind: kind,
      entityType: "ad",
      externalId,
      entityName: this.findEntityName(accountId, kind, "ad", externalId),
      action: "appeal",
      source: "manual",
      status: "pending",
      message: reason,
    });
  }

  createOneTimeSchedule(
    accountId: string,
    input: OneTimeScheduleInput,
  ): ScheduledEntityActionRecord {
    const schedule = OneTimeScheduleInputSchema.parse(input);
    return this.insertScheduledAction(accountId, {
      externalId: schedule.externalId,
      action: schedule.action,
      nextRunAt: schedule.runAt,
      scheduleType: "once",
      repeatDaily: false,
      groupId: null,
    });
  }

  createOvernightSchedule(
    accountId: string,
    input: OvernightScheduleInput,
  ): ScheduledEntityActionRecord[] {
    const schedule = OvernightScheduleInputSchema.parse(input);
    this.cancelOvernightSchedulesForEntity(accountId, schedule.externalId);
    const groupId = randomUUID();
    return [
      this.insertScheduledAction(accountId, {
        externalId: schedule.externalId,
        action: "disable",
        nextRunAt: schedule.disableAt,
        scheduleType: "overnight",
        repeatDaily: true,
        groupId,
      }),
      this.insertScheduledAction(accountId, {
        externalId: schedule.externalId,
        action: "enable",
        nextRunAt: schedule.enableAt,
        scheduleType: "overnight",
        repeatDaily: true,
        groupId,
      }),
    ];
  }

  listScheduledActions(
    accountId: string,
    limit = 200,
  ): ScheduledEntityActionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_entity_actions
         WHERE account_id = ?
         ORDER BY CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END,
                  next_run_at ASC, created_at DESC
         LIMIT ?`,
      )
      .all(accountId, limit) as SqlRow[];
    return rows.map(mapScheduledEntityAction);
  }

  listDueScheduledActions(
    accountId: string,
    asOf = new Date().toISOString(),
    limit = 20,
  ): ScheduledEntityActionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_entity_actions
         WHERE account_id = ? AND status = 'scheduled' AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT ?`,
      )
      .all(accountId, asOf, limit) as SqlRow[];
    return rows.map(mapScheduledEntityAction);
  }

  cancelScheduledAction(accountId: string, scheduleId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE scheduled_entity_actions
         SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND account_id = ? AND status = 'scheduled'`,
      )
      .run(now, scheduleId, accountId);
    if (result.changes > 0) {
      this.writeAudit("local-user", accountId, "schedule.cancelled", {
        scheduleId,
      });
    }
    return result.changes > 0;
  }

  cancelOvernightSchedule(accountId: string, groupId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE scheduled_entity_actions
         SET status = 'cancelled', updated_at = ?
         WHERE account_id = ? AND group_id = ? AND status = 'scheduled'`,
      )
      .run(now, accountId, groupId);
    if (result.changes > 0) {
      this.writeAudit("local-user", accountId, "overnight-schedule.cancelled", {
        groupId,
      });
    }
    return result.changes > 0;
  }

  completeScheduledAction(
    scheduleId: string,
    result: "succeeded" | "failed",
    message: string,
    completedAt = new Date().toISOString(),
  ): ScheduledEntityActionRecord {
    const row = this.db
      .prepare("SELECT * FROM scheduled_entity_actions WHERE id = ?")
      .get(scheduleId) as SqlRow | undefined;
    if (!row) throw new Error("Scheduled action not found");
    const current = mapScheduledEntityAction(row);
    const nextRunAt = current.repeatDaily
      ? advanceDailyRun(current.nextRunAt, completedAt)
      : current.nextRunAt;
    const status = current.repeatDaily
      ? "scheduled"
      : result === "succeeded"
        ? "completed"
        : "failed";
    this.db
      .prepare(
        `UPDATE scheduled_entity_actions SET
          next_run_at = ?, status = ?, last_result = ?, last_message = ?,
          last_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        nextRunAt,
        status,
        result,
        message,
        completedAt,
        completedAt,
        scheduleId,
      );
    const updated = this.db
      .prepare("SELECT * FROM scheduled_entity_actions WHERE id = ?")
      .get(scheduleId) as SqlRow;
    return mapScheduledEntityAction(updated);
  }

  listMultiAccountLaunchPlans(
    limit = 100,
  ): MultiAccountLaunchPlanRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM multi_account_launch_plans ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as SqlRow[];
    return rows.map(mapMultiAccountLaunchPlan);
  }

  createMultiAccountLaunchPlan(
    input: MultiAccountLaunchPlanInput,
  ): MultiAccountLaunchPlanRecord {
    const plan = MultiAccountLaunchPlanInputSchema.parse(input);
    const sourceAccount = this.getAccount(plan.sourceAccountId);
    if (!sourceAccount) throw new Error("源广告账户不存在。");
    const sourceAd = this.listManagedEntities(
      plan.sourceAccountId,
      sourceAccount.providerKind,
    ).find(
      (entity) =>
        entity.entityType === "ad" && entity.externalId === plan.sourceAdId,
    );
    if (!sourceAd) throw new Error("源广告不存在，请先同步源账户数据。");
    const targetAccountIds = [
      ...new Set(
        plan.targetAccountIds.filter((accountId) => accountId !== plan.sourceAccountId),
      ),
    ];
    if (targetAccountIds.length === 0) {
      throw new Error("至少选择一个不同于源账户的目标账户。");
    }
    for (const accountId of targetAccountIds) {
      if (!this.getAccount(accountId)) throw new Error("目标广告账户不存在。");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const taskCount = Math.max(plan.launchRows?.length ?? 0, 1);
    const message =
      `已保存 ${taskCount} 条投放配置；真实复制执行器需要目标账户的创建接口或复制 cURL，当前不会写入 TikTok。`;
    this.db
      .prepare(
        `INSERT INTO multi_account_launch_plans (
          id, source_account_id, source_ad_id, source_ad_name,
          target_account_ids_json, naming_template, start_paused,
          launch_rows_json, status, message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?)`,
      )
      .run(
        id,
        plan.sourceAccountId,
        plan.sourceAdId,
        sourceAd.name,
        JSON.stringify(targetAccountIds),
        plan.namingTemplate,
        toSqlBoolean(plan.startPaused),
        JSON.stringify(plan.launchRows ?? []),
        message,
        now,
        now,
      );
    this.writeAudit("local-user", plan.sourceAccountId, "launch-plan.created", {
      id,
      targetAccountIds,
      startPaused: plan.startPaused,
      taskCount,
    });
    return this.listMultiAccountLaunchPlans().find(
      (item) => item.id === id,
    ) as MultiAccountLaunchPlanRecord;
  }

  cancelMultiAccountLaunchPlan(planId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE multi_account_launch_plans
         SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status IN ('draft', 'blocked')`,
      )
      .run(now, planId);
    return result.changes > 0;
  }

  listMetricSnapshots(
    accountId: string,
    kind: ProviderKind,
    since: string,
    entityType?: ProviderEntity["entityType"],
    limit = 5000,
    until = new Date().toISOString(),
  ): EntityMetricSnapshotRecord[] {
    const rows = entityType
      ? (this.db
          .prepare(
            `SELECT * FROM entity_metric_snapshots
             WHERE account_id = ? AND provider_kind = ? AND captured_at >= ?
               AND captured_at <= ? AND entity_type = ?
             ORDER BY captured_at DESC LIMIT ?`,
           )
          .all(accountId, kind, since, until, entityType, limit) as SqlRow[])
      : (this.db
          .prepare(
            `SELECT * FROM entity_metric_snapshots
             WHERE account_id = ? AND provider_kind = ? AND captured_at >= ?
               AND captured_at <= ?
             ORDER BY captured_at DESC LIMIT ?`,
           )
          .all(accountId, kind, since, until, limit) as SqlRow[]);
    return rows.map((row) => ({
      id: String(row.id),
      accountId: String(row.account_id),
      providerKind:
        row.provider_kind as EntityMetricSnapshotRecord["providerKind"],
      entityType: row.entity_type as EntityMetricSnapshotRecord["entityType"],
      externalId: String(row.external_id),
      entityName: String(row.entity_name),
      status: row.operational_status as EntityMetricSnapshotRecord["status"],
      metrics: JSON.parse(
        String(row.metrics_json),
      ) as EntityMetricSnapshotRecord["metrics"],
      capturedAt: String(row.captured_at),
    }));
  }

  listMetricBatches(
    accountId: string,
    kind: ProviderKind,
    since: string,
    entityType?: ProviderEntity["entityType"],
    until = new Date().toISOString(),
  ): MetricBatchRecord[] {
    const rows = entityType
      ? this.db.prepare(
          `SELECT captured_at,
             COUNT(*) AS entity_count,
             SUM(COALESCE(CAST(json_extract(metrics_json, '$.spend') AS REAL), 0)) AS spend,
             SUM(COALESCE(CAST(json_extract(metrics_json, '$.clicks') AS REAL), 0)) AS clicks,
             SUM(COALESCE(CAST(json_extract(metrics_json, '$.conversions') AS REAL), 0)) AS conversions
           FROM entity_metric_snapshots
           WHERE account_id = ? AND provider_kind = ? AND captured_at >= ?
             AND captured_at <= ? AND entity_type = ?
           GROUP BY captured_at ORDER BY captured_at DESC`,
        ).all(accountId, kind, since, until, entityType) as SqlRow[]
      : this.db.prepare(
          `SELECT captured_at,
             COUNT(*) AS entity_count,
             SUM(COALESCE(CAST(json_extract(metrics_json, '$.spend') AS REAL), 0)) AS spend,
             SUM(COALESCE(CAST(json_extract(metrics_json, '$.clicks') AS REAL), 0)) AS clicks,
             SUM(COALESCE(CAST(json_extract(metrics_json, '$.conversions') AS REAL), 0)) AS conversions
           FROM entity_metric_snapshots
           WHERE account_id = ? AND provider_kind = ? AND captured_at >= ?
             AND captured_at <= ?
           GROUP BY captured_at ORDER BY captured_at DESC`,
        ).all(accountId, kind, since, until) as SqlRow[];
    return rows.map((row) => ({
      capturedAt: String(row.captured_at),
      count: Number(row.entity_count),
      spend: Number(row.spend),
      clicks: Number(row.clicks),
      conversions: Number(row.conversions),
    }));
  }

  private insertScheduledAction(
    accountId: string,
    input: {
      externalId: string;
      action: "enable" | "disable";
      nextRunAt: string;
      scheduleType: "once" | "overnight";
      repeatDaily: boolean;
      groupId: string | null;
    },
  ): ScheduledEntityActionRecord {
    const account = this.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    const entity = this.listManagedEntities(
      accountId,
      account.providerKind,
    ).find(
      (item) =>
        item.entityType === "ad-group" && item.externalId === input.externalId,
    );
    if (!entity) throw new Error("广告组不存在，请先同步账户数据。");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO scheduled_entity_actions (
          id, group_id, account_id, provider_kind, entity_type, external_id,
          entity_name, action, schedule_type, repeat_daily, next_run_at,
          status, last_result, last_message, last_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ad-group', ?, ?, ?, ?, ?, ?, 'scheduled',
                  NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.groupId,
        accountId,
        account.providerKind,
        input.externalId,
        entity.name,
        input.action,
        input.scheduleType,
        toSqlBoolean(input.repeatDaily),
        input.nextRunAt,
        now,
        now,
      );
    this.writeAudit("local-user", accountId, "schedule.created", {
      id,
      groupId: input.groupId,
      action: input.action,
      scheduleType: input.scheduleType,
      nextRunAt: input.nextRunAt,
    });
    const row = this.db
      .prepare("SELECT * FROM scheduled_entity_actions WHERE id = ?")
      .get(id) as SqlRow;
    return mapScheduledEntityAction(row);
  }

  private cancelOvernightSchedulesForEntity(
    accountId: string,
    externalId: string,
  ): void {
    this.db
      .prepare(
        `UPDATE scheduled_entity_actions
         SET status = 'cancelled', updated_at = ?
         WHERE account_id = ? AND entity_type = 'ad-group'
           AND external_id = ? AND schedule_type = 'overnight'
           AND status = 'scheduled'`,
      )
      .run(new Date().toISOString(), accountId, externalId);
  }

  private findEntityName(
    accountId: string,
    kind: ProviderKind,
    entityType: ProviderEntity["entityType"],
    externalId: string,
  ): string {
    return (
      this.listManagedEntities(accountId, kind).find(
        (item) =>
          item.entityType === entityType && item.externalId === externalId,
      )?.name ?? externalId
    );
  }

  createAutomationRun(
    accountId: string,
    kind: ProviderKind,
    trigger: AutomationTrigger,
    executionMode: AccountConfig["executionMode"],
  ): AutomationRunRecord {
    this.assertAccount(accountId);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO automation_runs (
          id, account_id, provider_kind, trigger, execution_mode, status,
          started_at, finished_at, candidate_count, action_count,
          success_count, failure_count, error_message
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, 0, 0, 0, 0, NULL)`,
      )
      .run(id, accountId, kind, trigger, executionMode, startedAt);
    return this.getAutomationRun(id) as AutomationRunRecord;
  }

  finishAutomationRun(
    runId: string,
    result: {
      status: "completed" | "failed";
      candidateCount: number;
      actionCount: number;
      successCount: number;
      failureCount: number;
      errorMessage?: string | null;
    },
  ): AutomationRunRecord {
    this.db
      .prepare(
        `UPDATE automation_runs SET
          status = ?, finished_at = ?, candidate_count = ?, action_count = ?,
          success_count = ?, failure_count = ?, error_message = ?
        WHERE id = ?`,
      )
      .run(
        result.status,
        new Date().toISOString(),
        result.candidateCount,
        result.actionCount,
        result.successCount,
        result.failureCount,
        result.errorMessage ?? null,
        runId,
      );
    const run = this.getAutomationRun(runId);
    if (!run) throw new Error("Automation run not found");
    return run;
  }

  saveAutomationDecision(
    run: AutomationRunRecord,
    candidate: AutomationCandidate,
    status: AutomationDecisionStatus,
    errorMessage: string | null = null,
  ): AutomationDecisionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO automation_decisions (
          id, run_id, account_id, provider_kind, threshold_id, threshold_code,
          entity_type, external_id, entity_name, action, metric, metric_value,
          operator, threshold_value, reason, status, error_message, created_at,
          executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        run.id,
        run.accountId,
        run.providerKind,
        candidate.thresholdId,
        candidate.thresholdCode,
        candidate.entity.entityType,
        candidate.entity.externalId,
        candidate.entity.name,
        candidate.action,
        candidate.metric,
        candidate.metricValue,
        candidate.operator,
        candidate.thresholdValue,
        candidate.reason,
        status,
        errorMessage,
        now,
      );
    return this.getAutomationDecision(id) as AutomationDecisionRecord;
  }

  updateAutomationDecision(
    decisionId: string,
    status: AutomationDecisionStatus,
    errorMessage: string | null = null,
  ): AutomationDecisionRecord {
    const executedAt = ["succeeded", "failed", "skipped"].includes(status)
      ? new Date().toISOString()
      : null;
    this.db
      .prepare(
        `UPDATE automation_decisions
         SET status = ?, error_message = ?, executed_at = ?
         WHERE id = ?`,
      )
      .run(status, errorMessage, executedAt, decisionId);
    const decision = this.getAutomationDecision(decisionId);
    if (!decision) throw new Error("Automation decision not found");
    return decision;
  }

  getAutomationDecision(decisionId: string): AutomationDecisionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM automation_decisions WHERE id = ?")
      .get(decisionId) as SqlRow | undefined;
    return row ? mapAutomationDecision(row) : null;
  }

  listAutomationRuns(accountId: string, limit = 20): AutomationRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automation_runs WHERE account_id = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(accountId, limit) as SqlRow[];
    return rows.map(mapAutomationRun);
  }

  listAutomationDecisions(
    accountId: string,
    limit = 100,
  ): AutomationDecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automation_decisions WHERE account_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(accountId, limit) as SqlRow[];
    return rows.map(mapAutomationDecision);
  }

  isDecisionInCooldown(
    accountId: string,
    thresholdId: string,
    entityType: ProviderEntity["entityType"],
    externalId: string,
    action: AutomationAction,
    cooldownMinutes: number,
  ): boolean {
    if (cooldownMinutes <= 0) return false;
    const since = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 FROM automation_decisions
         WHERE account_id = ? AND threshold_id = ? AND entity_type = ?
           AND external_id = ? AND action = ? AND status = 'succeeded'
           AND executed_at >= ? LIMIT 1`,
      )
      .get(accountId, thresholdId, entityType, externalId, action, since);
    return Boolean(row);
  }

  wasDisabledByAutomation(
    accountId: string,
    entityType: ProviderEntity["entityType"],
    externalId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM automation_decisions
         WHERE account_id = ? AND entity_type = ? AND external_id = ?
           AND action = 'disable' AND status = 'succeeded' LIMIT 1`,
      )
      .get(accountId, entityType, externalId);
    return Boolean(row);
  }

  hasPendingDecision(
    accountId: string,
    thresholdId: string,
    entityType: ProviderEntity["entityType"],
    externalId: string,
    action: AutomationAction,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM automation_decisions
         WHERE account_id = ? AND threshold_id = ? AND entity_type = ?
           AND external_id = ? AND action = ? AND status = 'pending' LIMIT 1`,
      )
      .get(accountId, thresholdId, entityType, externalId, action);
    return Boolean(row);
  }

  private getAutomationRun(runId: string): AutomationRunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM automation_runs WHERE id = ?")
      .get(runId) as SqlRow | undefined;
    return row ? mapAutomationRun(row) : null;
  }

  getAutomationSwitches(accountId: string): AutomationSwitches {
    const switches = createDefaultAutomationSwitches();
    const rows = this.db
      .prepare(
        "SELECT switch_key, enabled FROM automation_switches WHERE account_id = ?",
      )
      .all(accountId) as SqlRow[];

    for (const row of rows) {
      switches[row.switch_key as AutomationSwitchKey] = fromSqlBoolean(
        row.enabled,
      );
    }
    return switches;
  }

  updateAutomationSwitches(
    accountId: string,
    switches: AutomationSwitches,
  ): AutomationSwitches {
    this.assertAccount(accountId);
    this.writeSwitches(accountId, switches, true);
    return this.getAutomationSwitches(accountId);
  }

  listThresholds(accountId: string): ThresholdConfig[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM thresholds WHERE account_id = ? ORDER BY stage, code",
      )
      .all(accountId) as SqlRow[];
    return rows.map(mapThreshold);
  }

  listGlobalThresholds(): ThresholdConfig[] {
    this.ensureGlobalDefaults();
    const rows = this.db
      .prepare("SELECT * FROM global_thresholds ORDER BY stage, code")
      .all() as SqlRow[];
    return rows.map(mapGlobalThreshold);
  }

  createGlobalThreshold(input: ThresholdInput): ThresholdConfig {
    const threshold = this.insertGlobalThreshold(input, true);
    return threshold;
  }

  updateGlobalThreshold(
    thresholdId: string,
    input: ThresholdInput,
  ): ThresholdConfig | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE global_thresholds SET
          code = ?, label = ?, metric = ?, operator = ?, value = ?, unit = ?,
          stage = ?, enabled = ?, entity_type = ?, action = ?,
          automation_enabled = ?, minimum_spend = ?, cooldown_minutes = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        input.code,
        input.label,
        input.metric,
        input.operator,
        input.value,
        input.unit,
        input.stage,
        toSqlBoolean(input.enabled),
        input.entityType,
        input.action,
        toSqlBoolean(input.automationEnabled),
        input.minimumSpend,
        input.cooldownMinutes,
        now,
        thresholdId,
      );
    if (result.changes === 0) return null;
    this.writeSystemAudit("global.threshold.updated", { thresholdId, ...input });
    return this.getGlobalThreshold(thresholdId);
  }

  deleteGlobalThreshold(thresholdId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM global_thresholds WHERE id = ?")
      .run(thresholdId);
    if (result.changes > 0) {
      this.writeSystemAudit("global.threshold.deleted", { thresholdId });
      return true;
    }
    return false;
  }

  createThreshold(
    accountId: string,
    input: ThresholdInput,
  ): ThresholdConfig {
    this.assertAccount(accountId);
    const threshold = this.insertThreshold(accountId, input, true);
    return threshold;
  }

  updateThreshold(
    accountId: string,
    thresholdId: string,
    input: ThresholdInput,
  ): ThresholdConfig | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE thresholds SET
          code = ?, label = ?, metric = ?, operator = ?, value = ?, unit = ?,
          stage = ?, enabled = ?, entity_type = ?, action = ?,
          automation_enabled = ?, minimum_spend = ?, cooldown_minutes = ?,
          updated_at = ?
        WHERE id = ? AND account_id = ?`,
      )
      .run(
        input.code,
        input.label,
        input.metric,
        input.operator,
        input.value,
        input.unit,
        input.stage,
        toSqlBoolean(input.enabled),
        input.entityType,
        input.action,
        toSqlBoolean(input.automationEnabled),
        input.minimumSpend,
        input.cooldownMinutes,
        now,
        thresholdId,
        accountId,
      );

    if (result.changes === 0) {
      return null;
    }

    this.writeAudit("local-user", accountId, "threshold.updated", {
      thresholdId,
      ...input,
    });
    return this.getThreshold(accountId, thresholdId);
  }

  deleteThreshold(accountId: string, thresholdId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM thresholds WHERE id = ? AND account_id = ?")
      .run(thresholdId, accountId);

    if (result.changes > 0) {
      this.writeAudit("local-user", accountId, "threshold.deleted", {
        thresholdId,
      });
      return true;
    }
    return false;
  }

  private getThreshold(
    accountId: string,
    thresholdId: string,
  ): ThresholdConfig | null {
    const row = this.db
      .prepare("SELECT * FROM thresholds WHERE id = ? AND account_id = ?")
      .get(thresholdId, accountId) as SqlRow | undefined;
    return row ? mapThreshold(row) : null;
  }

  private insertThreshold(
    accountId: string,
    input: ThresholdInput,
    audit: boolean,
  ): ThresholdConfig {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO thresholds (
          id, account_id, code, label, metric, operator, value, unit,
          stage, enabled, entity_type, action, automation_enabled,
          minimum_spend, cooldown_minutes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        accountId,
        input.code,
        input.label,
        input.metric,
        input.operator,
        input.value,
        input.unit,
        input.stage,
        toSqlBoolean(input.enabled),
        input.entityType,
        input.action,
        toSqlBoolean(input.automationEnabled),
        input.minimumSpend,
        input.cooldownMinutes,
        now,
      );

    if (audit) {
      this.writeAudit("local-user", accountId, "threshold.created", {
        thresholdId: id,
        ...input,
      });
    }

    const result = this.getThreshold(accountId, id);
    if (!result) {
      throw new Error("Threshold was not persisted");
    }
    return result;
  }

  private getGlobalThreshold(thresholdId: string): ThresholdConfig | null {
    const row = this.db
      .prepare("SELECT * FROM global_thresholds WHERE id = ?")
      .get(thresholdId) as SqlRow | undefined;
    return row ? mapGlobalThreshold(row) : null;
  }

  private insertGlobalThreshold(
    input: ThresholdInput,
    audit: boolean,
  ): ThresholdConfig {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO global_thresholds (
          id, code, label, metric, operator, value, unit, stage, enabled,
          entity_type, action, automation_enabled, minimum_spend,
          cooldown_minutes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.code,
        input.label,
        input.metric,
        input.operator,
        input.value,
        input.unit,
        input.stage,
        toSqlBoolean(input.enabled),
        input.entityType,
        input.action,
        toSqlBoolean(input.automationEnabled),
        input.minimumSpend,
        input.cooldownMinutes,
        now,
      );
    if (audit) this.writeSystemAudit("global.threshold.created", { id, ...input });
    const result = this.getGlobalThreshold(id);
    if (!result) throw new Error("Global threshold was not persisted");
    return result;
  }

  private writeSwitches(
    accountId: string,
    switches: AutomationSwitches,
    audit: boolean,
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO automation_switches (account_id, switch_key, enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, switch_key) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const definition of automationSwitchDefinitions) {
        upsert.run(
          accountId,
          definition.key,
          toSqlBoolean(switches[definition.key]),
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (audit) {
      this.writeAudit("local-user", accountId, "switches.updated", switches);
    }
  }

  private assertAccount(accountId: string): void {
    if (!this.getAccount(accountId)) {
      throw new Error(`Account not found: ${accountId}`);
    }
  }

  private writeAudit(
    actor: string,
    accountId: string,
    action: string,
    payload: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (
          id, actor, account_id, action, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        actor,
        accountId,
        action,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  private writeSystemAudit(action: string, payload: unknown): void {
    this.writeAudit("local-user", "global", action, payload);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'standard',
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cookie', 'official-api')),
        credential_ref TEXT,
        timezone TEXT NOT NULL,
        polling_interval_minutes INTEGER NOT NULL,
        max_actions_per_run INTEGER NOT NULL DEFAULT 15,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('observe', 'manual-approval', 'automatic')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_switches (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        switch_key TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, switch_key)
      );

      CREATE TABLE IF NOT EXISTS thresholds (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        value REAL NOT NULL CHECK (value >= 0),
        unit TEXT NOT NULL,
        stage TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        entity_type TEXT NOT NULL DEFAULT 'ad-group',
        action TEXT NOT NULL DEFAULT 'disable',
        automation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automation_enabled IN (0, 1)),
        minimum_spend REAL NOT NULL DEFAULT 0,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, code)
      );

      CREATE TABLE IF NOT EXISTS global_automation_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        polling_interval_minutes INTEGER NOT NULL,
        max_actions_per_run INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS global_rule_configuration (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        layers_json TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS global_runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_feature_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('developer', 'admin', 'operator', 'viewer')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS auth_sessions_lookup
      ON auth_sessions (token_hash, expires_at);

      CREATE TABLE IF NOT EXISTS global_thresholds (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        value REAL NOT NULL CHECK (value >= 0),
        unit TEXT NOT NULL,
        stage TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        entity_type TEXT NOT NULL,
        action TEXT NOT NULL,
        automation_enabled INTEGER NOT NULL CHECK (automation_enabled IN (0, 1)),
        minimum_spend REAL NOT NULL DEFAULT 0,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_key TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        account_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_connections (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cookie', 'official-api')),
        settings_json TEXT NOT NULL,
        credential_ref TEXT,
        status TEXT NOT NULL CHECK (status IN ('not-configured', 'untested', 'ready', 'failed')),
        last_message TEXT,
        last_tested_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_kind)
      );

      CREATE TABLE IF NOT EXISTS provider_entities (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('campaign', 'ad-group', 'ad')),
        external_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_kind, entity_type, external_id)
      );

      CREATE TABLE IF NOT EXISTS ignored_entities (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_kind, entity_type, external_id)
      );

      CREATE TABLE IF NOT EXISTS ad_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        action TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_entity_actions (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type = 'ad-group'),
        external_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('enable', 'disable')),
        schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'overnight')),
        repeat_daily INTEGER NOT NULL CHECK (repeat_daily IN (0, 1)),
        next_run_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'failed', 'cancelled')),
        last_result TEXT CHECK (last_result IS NULL OR last_result IN ('succeeded', 'failed')),
        last_message TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scheduled_entity_actions_due
      ON scheduled_entity_actions (account_id, status, next_run_at);

      CREATE TABLE IF NOT EXISTS multi_account_launch_plans (
        id TEXT PRIMARY KEY,
        source_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source_ad_id TEXT NOT NULL,
        source_ad_name TEXT NOT NULL,
        target_account_ids_json TEXT NOT NULL,
        naming_template TEXT NOT NULL,
        start_paused INTEGER NOT NULL CHECK (start_paused IN (0, 1)),
        launch_rows_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('draft', 'blocked', 'cancelled', 'completed')),
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entity_metric_snapshots (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        operational_status TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS entity_metric_snapshots_lookup
      ON entity_metric_snapshots (
        account_id, provider_kind, entity_type, captured_at
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        action_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS automation_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        threshold_id TEXT NOT NULL,
        threshold_code TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        action TEXT NOT NULL,
        metric TEXT NOT NULL,
        metric_value REAL NOT NULL,
        operator TEXT NOT NULL,
        threshold_value REAL NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        executed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS automation_decisions_lookup
      ON automation_decisions (
        account_id, entity_type, external_id, action, status, executed_at
      );

      CREATE TABLE IF NOT EXISTS notification_channels (
        channel_kind TEXT PRIMARY KEY CHECK (channel_kind IN ('email', 'wecom', 'feishu')),
        settings_json TEXT NOT NULL,
        credential_ref TEXT,
        status TEXT NOT NULL CHECK (status IN ('not-configured', 'untested', 'ready', 'failed')),
        last_message TEXT,
        last_tested_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS poll_cycles (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS poll_cycle_accounts (
        cycle_id TEXT NOT NULL REFERENCES poll_cycles(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        run_id TEXT,
        result_status TEXT NOT NULL CHECK (result_status IN ('changed', 'no-action', 'failed', 'skipped')),
        enabled_count INTEGER NOT NULL DEFAULT 0,
        disabled_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        PRIMARY KEY (cycle_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES poll_cycles(id) ON DELETE CASCADE,
        channel_kind TEXT NOT NULL CHECK (channel_kind IN ('email', 'wecom', 'feishu')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE (cycle_id, channel_kind)
      );

      CREATE INDEX IF NOT EXISTS notification_deliveries_due
      ON notification_deliveries (status, next_attempt_at, created_at);
    `);

    this.ensureColumn(
      "accounts",
      "account_type",
      "TEXT NOT NULL DEFAULT 'standard'",
    );
    this.ensureColumn(
      "accounts",
      "max_actions_per_run",
      "INTEGER NOT NULL DEFAULT 15",
    );
    this.ensureColumn(
      "thresholds",
      "entity_type",
      "TEXT NOT NULL DEFAULT 'ad-group'",
    );
    this.ensureColumn(
      "thresholds",
      "action",
      "TEXT NOT NULL DEFAULT 'disable'",
    );
    this.ensureColumn(
      "thresholds",
      "automation_enabled",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "thresholds",
      "minimum_spend",
      "REAL NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "thresholds",
      "cooldown_minutes",
      "INTEGER NOT NULL DEFAULT 60",
    );
    this.ensureColumn(
      "multi_account_launch_plans",
      "launch_rows_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    this.applyMigration("enable-all-status-levels-v1", () => {
      this.db
        .prepare(
          `UPDATE automation_switches SET enabled = 1, updated_at = ?
           WHERE switch_key IN (
             'manageCampaignStatus', 'manageAdGroupStatus', 'manageAdStatus'
           )`,
        )
        .run(new Date().toISOString());
    });
    this.applyMigration("default-automatic-execution-v1", () => {
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE accounts SET execution_mode = 'automatic', updated_at = ?")
        .run(now);
      this.db
        .prepare(
          `UPDATE automation_decisions
           SET status = 'skipped',
               error_message = COALESCE(error_message, '已切换为默认自动执行，旧人工确认任务已取消。')
           WHERE status = 'pending'`,
        )
        .run();
    });
    this.ensureGlobalDefaults();
  }

  private applyMigration(key: string, migrate: () => void): void {
    const applied = this.db
      .prepare("SELECT 1 FROM schema_migrations WHERE migration_key = ?")
      .get(key);
    if (applied) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      migrate();
      this.db
        .prepare(
          "INSERT INTO schema_migrations (migration_key, applied_at) VALUES (?, ?)",
        )
        .run(key, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  private ensureGlobalDefaults(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO global_automation_settings (
          id, polling_interval_minutes, max_actions_per_run, updated_at
        ) VALUES (1, 5, 15, ?)`,
      )
      .run(now);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO global_rule_configuration (
          id, layers_json, rules_json, updated_at
        ) VALUES (1, ?, ?, ?)`,
      )
      .run(
        JSON.stringify(defaultRuleConfiguration.layers),
        JSON.stringify(defaultRuleConfiguration.rules),
        now,
      );

    this.db
      .prepare(
        `INSERT OR IGNORE INTO global_runtime_state (id, enabled, updated_at)
         VALUES (1, 1, ?)`,
      )
      .run(now);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO automation_feature_settings (
          id, settings_json, updated_at
        ) VALUES (1, ?, ?)`,
      )
      .run(JSON.stringify(defaultAutomationFeatureSettings), now);

    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM global_thresholds")
      .get() as SqlRow;
    if (Number(count.count) > 0) return;

    const legacyRows = this.db
      .prepare("SELECT * FROM thresholds ORDER BY updated_at DESC")
      .all() as SqlRow[];
    const seen = new Set<string>();
    for (const row of legacyRows) {
      const code = String(row.code);
      if (seen.has(code)) continue;
      seen.add(code);
      this.insertGlobalThreshold(
        {
          code,
          label: String(row.label),
          metric: row.metric as ThresholdInput["metric"],
          operator: row.operator as ThresholdInput["operator"],
          value: Number(row.value),
          unit: String(row.unit),
          stage: row.stage as ThresholdInput["stage"],
          enabled: fromSqlBoolean(row.enabled),
          entityType: row.entity_type as ThresholdInput["entityType"],
          action: row.action as ThresholdInput["action"],
          automationEnabled: fromSqlBoolean(row.automation_enabled),
          minimumSpend: Number(row.minimum_spend),
          cooldownMinutes: Number(row.cooldown_minutes),
        },
        false,
      );
    }
    if (seen.size === 0) {
      for (const threshold of defaultThresholds) {
        this.insertGlobalThreshold(threshold, false);
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) {
      throw new Error("Unsafe schema identifier");
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function emptyNotificationChannel(
  kind: NotificationChannelKind,
): NotificationChannelRecord {
  return {
    kind,
    settings: null,
    hasCredential: false,
    status: "not-configured",
    lastMessage: null,
    lastTestedAt: null,
    updatedAt: null,
  };
}

function mapStoredNotificationChannel(
  row: SqlRow,
): StoredNotificationChannel {
  const credentialRef =
    typeof row.credential_ref === "string" ? row.credential_ref : null;
  return {
    kind: NotificationChannelKindSchema.parse(row.channel_kind),
    settings: NotificationChannelSettingsSchema.parse(
      JSON.parse(String(row.settings_json)),
    ),
    hasCredential: Boolean(credentialRef),
    credentialRef,
    status: row.status as NotificationConnectionStatus,
    lastMessage:
      typeof row.last_message === "string" ? row.last_message : null,
    lastTestedAt:
      typeof row.last_tested_at === "string" ? row.last_tested_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function toPublicNotificationChannel(
  stored: StoredNotificationChannel,
): NotificationChannelRecord {
  const { credentialRef: _credentialRef, ...record } = stored;
  return record;
}

function mapPollAccountResult(row: SqlRow): PollAccountResult {
  return PollAccountResultSchema.parse({
    accountId: row.account_id,
    accountName: row.account_name,
    runId: row.run_id ?? null,
    status: row.result_status,
    enabledCount: Number(row.enabled_count),
    disabledCount: Number(row.disabled_count),
    failureCount: Number(row.failure_count),
    message: row.message ?? null,
  });
}

function mapNotificationDelivery(row: SqlRow): NotificationDeliveryRecord {
  return NotificationDeliveryRecordSchema.parse({
    id: row.id,
    cycleId: row.cycle_id,
    channelKind: row.channel_kind,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error ?? null,
    nextAttemptAt: row.next_attempt_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? null,
  });
}

function mapAccount(row: SqlRow): AccountConfig {
  return AccountConfigSchema.parse({
    id: row.id,
    displayName: row.display_name,
    accountType: row.account_type,
    enabled: fromSqlBoolean(row.enabled),
    providerKind: row.provider_kind,
    credentialRef: row.credential_ref ?? null,
    timezone: row.timezone,
    pollingIntervalMinutes: Number(row.polling_interval_minutes),
    maxActionsPerRun: Number(row.max_actions_per_run),
    executionMode: row.execution_mode,
    updatedAt: row.updated_at,
  });
}

function mapThreshold(row: SqlRow): ThresholdConfig {
  return ThresholdConfigSchema.parse({
    id: row.id,
    accountId: row.account_id,
    code: row.code,
    label: row.label,
    metric: row.metric,
    operator: row.operator,
    value: Number(row.value),
    unit: row.unit,
    stage: row.stage,
    enabled: fromSqlBoolean(row.enabled),
    entityType: row.entity_type,
    action: row.action,
    automationEnabled: fromSqlBoolean(row.automation_enabled),
    minimumSpend: Number(row.minimum_spend),
    cooldownMinutes: Number(row.cooldown_minutes),
    updatedAt: row.updated_at,
  });
}

function mapGlobalThreshold(row: SqlRow): ThresholdConfig {
  return ThresholdConfigSchema.parse({
    id: row.id,
    accountId: "global",
    code: row.code,
    label: row.label,
    metric: row.metric,
    operator: row.operator,
    value: Number(row.value),
    unit: row.unit,
    stage: row.stage,
    enabled: fromSqlBoolean(row.enabled),
    entityType: row.entity_type,
    action: row.action,
    automationEnabled: fromSqlBoolean(row.automation_enabled),
    minimumSpend: Number(row.minimum_spend),
    cooldownMinutes: Number(row.cooldown_minutes),
    updatedAt: row.updated_at,
  });
}

function mapAutomationRun(row: SqlRow): AutomationRunRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    providerKind: row.provider_kind as AutomationRunRecord["providerKind"],
    trigger: row.trigger as AutomationRunRecord["trigger"],
    executionMode: row.execution_mode as AutomationRunRecord["executionMode"],
    status: row.status as AutomationRunRecord["status"],
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    candidateCount: Number(row.candidate_count),
    actionCount: Number(row.action_count),
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    errorMessage:
      typeof row.error_message === "string" ? row.error_message : null,
  };
}

function mapAutomationDecision(row: SqlRow): AutomationDecisionRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    accountId: String(row.account_id),
    providerKind:
      row.provider_kind as AutomationDecisionRecord["providerKind"],
    thresholdId: String(row.threshold_id),
    thresholdCode: String(row.threshold_code),
    entityType: row.entity_type as AutomationDecisionRecord["entityType"],
    externalId: String(row.external_id),
    entityName: String(row.entity_name),
    action: row.action as AutomationDecisionRecord["action"],
    metric: row.metric as AutomationDecisionRecord["metric"],
    metricValue: Number(row.metric_value),
    operator: row.operator as AutomationDecisionRecord["operator"],
    thresholdValue: Number(row.threshold_value),
    reason: String(row.reason),
    status: row.status as AutomationDecisionRecord["status"],
    errorMessage:
      typeof row.error_message === "string" ? row.error_message : null,
    createdAt: String(row.created_at),
    executedAt: typeof row.executed_at === "string" ? row.executed_at : null,
  };
}

function mapAdOperation(row: SqlRow): AdOperationRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    providerKind: row.provider_kind as AdOperationRecord["providerKind"],
    entityType: row.entity_type as AdOperationRecord["entityType"],
    externalId: String(row.external_id),
    entityName: String(row.entity_name),
    action: row.action as AdOperationRecord["action"],
    source: row.source as AdOperationRecord["source"],
    status: row.status as AdOperationRecord["status"],
    message: typeof row.message === "string" ? row.message : null,
    createdAt: String(row.created_at),
  };
}

function mapLocalUser(row: SqlRow): LocalUserRecord {
  return LocalUserRecordSchema.parse({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    enabled: fromSqlBoolean(row.enabled),
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapStoredLocalUser(row: SqlRow): StoredLocalUser {
  return {
    ...mapLocalUser(row),
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
  };
}

function mapAuthSession(row: SqlRow): StoredAuthSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    csrfToken: String(row.csrf_token),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function mapScheduledEntityAction(row: SqlRow): ScheduledEntityActionRecord {
  return ScheduledEntityActionRecordSchema.parse({
    id: row.id,
    groupId: row.group_id ?? null,
    accountId: row.account_id,
    providerKind: row.provider_kind,
    entityType: row.entity_type,
    externalId: row.external_id,
    entityName: row.entity_name,
    action: row.action,
    scheduleType: row.schedule_type,
    repeatDaily: fromSqlBoolean(row.repeat_daily),
    nextRunAt: row.next_run_at,
    status: row.status,
    lastResult: row.last_result ?? null,
    lastMessage: row.last_message ?? null,
    lastRunAt: row.last_run_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapMultiAccountLaunchPlan(row: SqlRow): MultiAccountLaunchPlanRecord {
  return MultiAccountLaunchPlanRecordSchema.parse({
    id: row.id,
    sourceAccountId: row.source_account_id,
    sourceAdId: row.source_ad_id,
    sourceAdName: row.source_ad_name,
    targetAccountIds: JSON.parse(String(row.target_account_ids_json)),
    namingTemplate: row.naming_template,
    startPaused: fromSqlBoolean(row.start_paused),
    launchRows: JSON.parse(String(row.launch_rows_json ?? "[]")),
    status: row.status,
    message: row.message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapProviderConnection(row: SqlRow): ProviderConnection {
  return ProviderConnectionSchema.parse({
    accountId: row.account_id,
    kind: row.provider_kind,
    settings: JSON.parse(String(row.settings_json)),
    hasCredential: typeof row.credential_ref === "string",
    status: row.status,
    lastMessage: row.last_message ?? null,
    lastTestedAt: row.last_tested_at ?? null,
    updatedAt: row.updated_at,
  });
}

function mapStoredProviderConnection(row: SqlRow): StoredProviderConnection {
  return {
    ...mapProviderConnection(row),
    credentialRef:
      typeof row.credential_ref === "string" ? row.credential_ref : null,
  };
}

function toPublicProviderConnection(
  connection: StoredProviderConnection,
): ProviderConnection {
  const { credentialRef: _credentialRef, ...publicConnection } = connection;
  return publicConnection;
}

function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqlBoolean(value: unknown): boolean {
  return Number(value) === 1;
}

function advanceDailyRun(current: string, completedAt: string): string {
  let next = new Date(current).getTime();
  const completed = new Date(completedAt).getTime();
  do {
    next += 24 * 60 * 60_000;
  } while (next <= completed);
  return new Date(next).toISOString();
}
