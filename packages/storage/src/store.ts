import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationRunner } from "./migration-runner.js";
import {
  createConsistentSnapshot,
  createRawPreMigrationBackup,
  hasPendingDatabaseRestore,
  inspectDatabaseBackup,
  promoteToConsistentSnapshot,
  restoreDatabaseFiles,
  stageDatabaseRestore,
} from "./database-maintenance.js";
import {
  AccountConfigSchema,
  GlobalAutomationSettingsSchema,
  type AccountConfig,
  type AccountSettingsUpdate,
  type AccountCreateInput,
  type GlobalAutomationSettings,
  type GlobalAutomationSettingsInput,
  LOW_RISK_AUTOMATION_POLICY_VERSION,
  LowRiskAutomationPolicyInputSchema,
  LowRiskAutomationPolicySchema,
  ProviderWriteCircuitSchema,
  type LowRiskAutomationPolicy,
  type LowRiskAutomationPolicyInput,
  type ProviderWriteCircuit,
  type AutomationSwitchKey,
  type AutomationSwitches,
  type AutomationAction,
  type AutomationCandidate,
  type AutomationDecisionRecord,
  type AutomationDecisionStatus,
  type AutomationApprovalRecord,
  type AutomationApprovalStatus,
  type AutomationRunRecord,
  type AutomationTrigger,
  type AdOperationRecord,
  type AdOperationAttemptRecord,
  type WriteTaskActor,
  type WriteTaskKind,
  type WriteTaskStatus,
  type WriteTaskSummaryRecord,
  StatusManualVerificationInputSchema,
  type StatusManualVerificationInput,
  type StatusManualVerificationRecord,
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
  type ProviderCapability,
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
  automaticName,
  MultiAccountLaunchPlanInputSchema,
  MultiAccountLaunchPlanRecordSchema,
  type MultiAccountLaunchPlanInput,
  type MultiAccountLaunchPlanRecord,
  LaunchCopyPreviewInputSchema,
  LaunchCopyPreviewRecordSchema,
  type LaunchCopyPreviewInput,
  type LaunchCopyPreviewRecord,
  type LaunchSourceSnapshot,
  type LaunchTargetAssetMapping,
  LaunchPlanItemRecordSchema,
  type LaunchPlanItemRecord,
  type LaunchPlanItemStatus,
  LaunchPlanItemAttemptRecordSchema,
  type LaunchPlanItemAttemptRecord,
  LaunchManualVerificationInputSchema,
  LaunchManualVerificationRecordSchema,
  type LaunchManualVerificationInput,
  type LaunchManualVerificationRecord,
  LaunchCreationProgressSchema,
  type LaunchCreationProgress,
  LaunchPresetInputSchema,
  LaunchPresetRecordSchema,
  type LaunchPresetInput,
  type LaunchPresetRecord,
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
  AuditLogRecordSchema,
  type AuditLogFilter,
  type AuditLogRecord,
  DatabaseBackupRecordSchema,
  type DatabaseBackupKind,
  type DatabaseBackupRecord,
} from "@tk-auto/core";

const SYNC_STALE_AFTER_MS = 15 * 60_000;

type SqlRow = Record<string, unknown>;

export interface AutomationStoreOptions {
  appVersion?: string;
}

export interface AuditContext {
  actor: WriteTaskActor;
  requestId: string | null;
  correlationId: string;
}

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
  private readonly migrationRunner: MigrationRunner;
  private readonly databasePath: string;
  private readonly appVersion: string;
  private readonly auditContext = new AsyncLocalStorage<AuditContext>();

  constructor(databasePath: string, options: AutomationStoreOptions = {}) {
    this.databasePath = databasePath;
    this.appVersion = options.appVersion ?? "development";
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    const backupPath = createRawPreMigrationBackup(databasePath);
    let backupReadyForRestore = false;
    let openedDatabase: DatabaseSync | null = null;
    try {
      openedDatabase = new DatabaseSync(databasePath);
      this.db = openedDatabase;
      this.migrationRunner = new MigrationRunner(this.db);
      this.db.exec("PRAGMA foreign_keys = ON");
      const sourceSchemaVersion = this.readSchemaVersion();
      if (backupPath) {
        promoteToConsistentSnapshot(this.db, backupPath);
        backupReadyForRestore = true;
      }
      this.db.exec("PRAGMA journal_mode = WAL");
      this.migrate();
      if (backupPath && backupReadyForRestore) {
        this.recordDatabaseBackup(
          "pre-migration",
          backupPath,
          sourceSchemaVersion,
          inspectDatabaseBackup(backupPath),
        );
        this.pruneDatabaseBackups();
      }
    } catch (cause) {
      try {
        openedDatabase?.close();
      } catch {
        // Preserve the original migration/opening error.
      }
      if (backupPath && backupReadyForRestore) {
        try {
          restoreDatabaseFiles(databasePath, backupPath);
        } catch {
          // Keep the backup path in the surfaced error for manual recovery.
        }
      }
      const detail = cause instanceof Error ? cause.message : "未知数据库错误";
      const backupDetail = backupPath ? `；迁移前备份：${backupPath}` : "";
      throw new Error(`数据库迁移失败，服务未启动${backupDetail}。${detail}`, {
        cause,
      });
    }
  }

  close(): void {
    this.db.close();
  }

  enterAuditContext(context: AuditContext): void {
    this.auditContext.enterWith(context);
  }

  getSchemaVersion(): string {
    return this.readSchemaVersion();
  }

  listAuditLogs(filter: AuditLogFilter): AuditLogRecord[] {
    const where: string[] = [];
    const parameters: Array<string | number | null> = [];
    if (filter.accountId) {
      where.push("account_id = ?");
      parameters.push(filter.accountId);
    }
    if (filter.actorId) {
      where.push("actor_id = ?");
      parameters.push(filter.actorId);
    }
    if (filter.action) {
      where.push("action LIKE ?");
      parameters.push(`%${filter.action}%`);
    }
    if (filter.correlationId) {
      where.push("correlation_id = ?");
      parameters.push(filter.correlationId);
    }
    if (filter.from) {
      where.push("created_at >= ?");
      parameters.push(filter.from);
    }
    if (filter.to) {
      where.push("created_at <= ?");
      parameters.push(filter.to);
    }
    parameters.push(filter.limit);
    const rows = this.db.prepare(
      `SELECT * FROM audit_logs
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...parameters) as SqlRow[];
    return rows.map((row) => AuditLogRecordSchema.parse({
      id: String(row.id),
      actor: {
        id: String(row.actor_id),
        name: String(row.actor_name),
        kind: row.actor_kind === "system" ? "system" : "user",
      },
      accountId: String(row.account_id),
      action: String(row.action),
      payload: JSON.parse(String(row.payload_json)),
      correlationId: String(row.correlation_id),
      requestId: row.request_id ? String(row.request_id) : null,
      createdAt: String(row.created_at),
    }));
  }

  listDatabaseBackups(): DatabaseBackupRecord[] {
    return (this.db.prepare(
      "SELECT * FROM database_backups ORDER BY created_at DESC, id DESC",
    ).all() as SqlRow[]).map(mapDatabaseBackup);
  }

  createDatabaseBackup(
    kind: Extract<DatabaseBackupKind, "manual" | "pre-upgrade">,
  ): DatabaseBackupRecord {
    if (this.databasePath === ":memory:") {
      throw new Error("内存数据库不支持持久化备份。");
    }
    const backupPath = `${this.databasePath}.${kind}-${fileTimestamp()}.bak`;
    const inspection = createConsistentSnapshot(this.db, backupPath);
    const record = this.recordDatabaseBackup(
      kind,
      backupPath,
      this.readSchemaVersion(),
      inspection,
    );
    this.writeSystemAudit(`database-backup.${kind}.created`, {
      backupId: record.id,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
    });
    this.pruneDatabaseBackups();
    return record;
  }

  registerRestoreRollbackBackup(filePath: string): DatabaseBackupRecord | null {
    if (!existsSync(filePath)) return null;
    const rollbackPrefix = `${basename(this.databasePath)}.restore-rollback-`;
    const rollbackPaths = readdirSync(dirname(this.databasePath))
      .filter((name) => name.startsWith(rollbackPrefix) && name.endsWith(".bak"))
      .map((name) => join(dirname(this.databasePath), name));
    let registeredCurrent = false;
    for (const rollbackPath of rollbackPaths) {
      const existing = this.db.prepare(
        "SELECT id FROM database_backups WHERE file_path = ?",
      ).get(rollbackPath) as SqlRow | undefined;
      if (existing) continue;
      this.recordDatabaseBackup(
        "restore-rollback",
        rollbackPath,
        this.readSchemaVersion(),
        inspectDatabaseBackup(rollbackPath),
        statSync(rollbackPath).mtime.toISOString(),
      );
      if (rollbackPath === filePath) registeredCurrent = true;
    }
    const record = this.listDatabaseBackups().find((backup) =>
      backup.fileName === basename(filePath),
    );
    if (!record) return null;
    if (registeredCurrent) {
      this.writeSystemAudit("database-backup.restore-rollback.created", {
        backupId: record.id,
        sha256: record.sha256,
        sizeBytes: record.sizeBytes,
      });
    }
    this.pruneDatabaseBackups();
    return this.listDatabaseBackups().find((backup) => backup.id === record.id) ?? null;
  }

  verifyDatabaseBackup(backupId: string): DatabaseBackupRecord {
    const row = this.getDatabaseBackupRow(backupId);
    if (!row) throw new Error("数据库备份不存在。");
    const inspection = inspectDatabaseBackup(String(row.file_path));
    const matchesRecordedFile = inspection.sizeBytes === Number(row.size_bytes)
      && inspection.sha256 === String(row.sha256);
    const valid = inspection.valid && matchesRecordedFile;
    const errorMessage = valid
      ? null
      : inspection.errorMessage
        ?? "备份文件与创建时记录的大小或 SHA-256 不一致。";
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE database_backups
       SET status = ?, error_message = ?, verified_at = ?
       WHERE id = ?`,
    ).run(
      valid ? "verified" : "invalid",
      errorMessage,
      now,
      backupId,
    );
    this.writeSystemAudit("database-backup.verified", {
      backupId,
      valid,
      errorMessage,
    });
    return this.listDatabaseBackups().find((backup) => backup.id === backupId)!;
  }

  requestDatabaseRestore(backupId: string): DatabaseBackupRecord {
    const verified = this.verifyDatabaseBackup(backupId);
    if (verified.status !== "verified") {
      throw new Error(verified.errorMessage ?? "备份校验失败，禁止恢复。");
    }
    const row = this.getDatabaseBackupRow(backupId)!;
    stageDatabaseRestore(this.databasePath, String(row.file_path), verified.sha256);
    this.writeSystemAudit("database-restore.requested", {
      backupId,
      restartRequired: true,
    });
    return verified;
  }

  hasPendingDatabaseRestore(): boolean {
    return hasPendingDatabaseRestore(this.databasePath);
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
        "manual-approval",
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
        "manual-approval",
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
          execution_mode = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        settings.displayName,
        settings.accountType,
        toSqlBoolean(settings.enabled),
        settings.providerKind,
        settings.executionMode,
        now,
        accountId,
      );

    if (result.changes === 0) {
      return null;
    }
    if (settings.executionMode !== "automatic") {
      this.db.prepare(
        `UPDATE account_low_risk_automation_policies
         SET enabled = 0, updated_at = ? WHERE account_id = ?`,
      ).run(now, accountId);
    }

    this.writeAudit("local-user", accountId, "account.settings.updated", {
      ...settings,
    });
    return this.getAccount(accountId);
  }

  setAccountExecutionMode(
    accountId: string,
    executionMode: AccountConfig["executionMode"],
    reason: string,
  ): AccountConfig | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE accounts SET execution_mode = ?, updated_at = ? WHERE id = ?")
      .run(executionMode, now, accountId);
    if (result.changes === 0) return null;
    if (executionMode !== "automatic") {
      this.db.prepare(
        `UPDATE account_low_risk_automation_policies
         SET enabled = 0, updated_at = ? WHERE account_id = ?`,
      ).run(now, accountId);
    }
    this.writeAudit("system", accountId, "account.execution-mode.changed", {
      executionMode,
      reason,
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

  getLowRiskAutomationPolicy(accountId: string): LowRiskAutomationPolicy {
    this.assertAccount(accountId);
    const row = this.db.prepare(
      "SELECT * FROM account_low_risk_automation_policies WHERE account_id = ?",
    ).get(accountId) as SqlRow | undefined;
    if (!row) {
      return LowRiskAutomationPolicySchema.parse({
        accountId,
        enabled: false,
        policyVersion: LOW_RISK_AUTOMATION_POLICY_VERSION,
        dailyActionLimit: 5,
        updatedAt: this.getAccount(accountId)?.updatedAt ?? new Date(0).toISOString(),
      });
    }
    return mapLowRiskAutomationPolicy(row);
  }

  updateLowRiskAutomationPolicy(
    accountId: string,
    input: LowRiskAutomationPolicyInput,
  ): LowRiskAutomationPolicy {
    this.assertAccount(accountId);
    const policy = LowRiskAutomationPolicyInputSchema.parse(input);
    const account = this.getAccount(accountId);
    if (policy.enabled && account?.executionMode !== "automatic") {
      throw new Error("启用低风险自动化前，账户必须明确切换为 automatic 模式。");
    }
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO account_low_risk_automation_policies (
         account_id, enabled, policy_version, daily_action_limit, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         enabled = excluded.enabled,
         policy_version = excluded.policy_version,
         daily_action_limit = excluded.daily_action_limit,
         updated_at = excluded.updated_at`,
    ).run(
      accountId,
      toSqlBoolean(policy.enabled),
      LOW_RISK_AUTOMATION_POLICY_VERSION,
      policy.dailyActionLimit,
      now,
    );
    this.writeAudit("local-user", accountId, "low-risk-automation.policy.updated", policy);
    return this.getLowRiskAutomationPolicy(accountId);
  }

  reserveAutomaticAction(input: {
    accountId: string;
    actionKey: string;
    localDate: string;
    dailyLimit: number;
  }): "claimed" | "duplicate" | "limit-reached" {
    this.assertAccount(input.accountId);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(
        "SELECT 1 FROM automatic_action_claims WHERE action_key = ?",
      ).get(input.actionKey);
      if (existing) {
        this.db.exec("COMMIT");
        return "duplicate";
      }
      const usage = this.db.prepare(
        `SELECT COUNT(*) AS count FROM automatic_action_claims
         WHERE account_id = ? AND local_date = ?`,
      ).get(input.accountId, input.localDate) as SqlRow;
      if (Number(usage.count) >= input.dailyLimit) {
        this.db.exec("COMMIT");
        return "limit-reached";
      }
      this.db.prepare(
        `INSERT INTO automatic_action_claims (
           action_key, account_id, local_date, created_at
         ) VALUES (?, ?, ?, ?)`,
      ).run(input.actionKey, input.accountId, input.localDate, now);
      this.db.exec("COMMIT");
      return "claimed";
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  countAutomaticActions(accountId: string, localDate: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM automatic_action_claims
       WHERE account_id = ? AND local_date = ?`,
    ).get(accountId, localDate) as SqlRow;
    return Number(row.count);
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

  recordProviderWriteFailure(
    accountId: string,
    providerKind: ProviderKind,
    message: string,
  ): number {
    const now = new Date().toISOString();
    const row = this.db.prepare(
      `INSERT INTO provider_write_circuits (
         account_id, provider_kind, consecutive_failures, last_error, opened_at, updated_at
       ) VALUES (?, ?, 1, ?, NULL, ?)
       ON CONFLICT(account_id, provider_kind) DO UPDATE SET
         consecutive_failures = consecutive_failures + 1,
         last_error = excluded.last_error,
         opened_at = CASE WHEN consecutive_failures + 1 >= 3 THEN excluded.updated_at ELSE opened_at END,
         updated_at = excluded.updated_at
       RETURNING consecutive_failures`,
    ).get(accountId, providerKind, message.slice(0, 1000), now) as SqlRow;
    return Number(row.consecutive_failures);
  }

  resetProviderWriteFailures(accountId: string, providerKind: ProviderKind): void {
    this.db.prepare(
      `DELETE FROM provider_write_circuits WHERE account_id = ? AND provider_kind = ?`,
    ).run(accountId, providerKind);
  }

  getProviderWriteCircuit(
    accountId: string,
    providerKind: ProviderKind,
  ): ProviderWriteCircuit | null {
    const row = this.db.prepare(
      `SELECT * FROM provider_write_circuits
       WHERE account_id = ? AND provider_kind = ?`,
    ).get(accountId, providerKind) as SqlRow | undefined;
    return row ? mapProviderWriteCircuit(row) : null;
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
          authorization_status, capability_version, authorized_capabilities_json, authorized_at,
          authorization_expires_at, last_message, last_tested_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'not-configured', 'not-authorized',
          'legacy-unversioned', '[]', NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(account_id, provider_kind) DO UPDATE SET
          settings_json = excluded.settings_json,
          status = CASE WHEN provider_connections.credential_ref IS NULL
            THEN 'not-configured' ELSE 'untested' END,
          authorization_status = 'not-authorized',
          capability_version = 'legacy-unversioned',
          authorized_capabilities_json = '[]',
          authorized_at = NULL,
          authorization_expires_at = NULL,
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
          authorization_status = 'not-authorized',
          capability_version = 'legacy-unversioned', authorized_capabilities_json = '[]', authorized_at = NULL,
          authorization_expires_at = NULL, last_tested_at = NULL, updated_at = ?
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
          authorization_status = 'not-authorized',
          capability_version = 'legacy-unversioned', authorized_capabilities_json = '[]', authorized_at = NULL,
          authorization_expires_at = NULL, last_tested_at = NULL, updated_at = ?
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

  updateProviderAuthorization(
    accountId: string,
    kind: ProviderKind,
    input: {
      status: "active" | "expired" | "revoked" | "failed";
      capabilityVersion: string;
      capabilities: ProviderCapability[];
      expiresAt?: string | null;
    },
  ): ProviderConnection {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE provider_connections SET
        authorization_status = ?, capability_version = ?,
        authorized_capabilities_json = ?,
        authorized_at = CASE WHEN ? = 'active' THEN COALESCE(authorized_at, ?) ELSE authorized_at END,
        authorization_expires_at = ?, updated_at = ?
       WHERE account_id = ? AND provider_kind = ?`,
    ).run(
      input.status,
      input.capabilityVersion,
      JSON.stringify(input.status === "active" ? input.capabilities : []),
      input.status,
      now,
      input.expiresAt ?? null,
      now,
      accountId,
      kind,
    );
    if (result.changes === 0) throw new Error("Provider connection not found");
    this.writeAudit("system", accountId, "provider.authorization.updated", {
      providerKind: kind,
      status: input.status,
      capabilityVersion: input.capabilityVersion,
      capabilities: input.status === "active" ? input.capabilities : [],
      expiresAt: input.expiresAt ?? null,
    });
    const connection = this.getProviderConnection(accountId, kind);
    if (!connection) throw new Error("Provider connection not found");
    return toPublicProviderConnection(connection);
  }

  completeProviderHealthCheckIfCurrent(
    accountId: string,
    kind: ProviderKind,
    expected: StoredProviderConnection,
    input: {
      connectionStatus: "ready" | "failed";
      message: string;
      authorizationStatus: "active" | "failed";
      capabilityVersion: string;
      capabilities: ProviderCapability[];
      expiresAt?: string | null;
    },
  ): ProviderConnection | null {
    const now = new Date().toISOString();
    const capabilities = input.authorizationStatus === "active"
      ? input.capabilities
      : [];
    const result = this.db.prepare(
      `UPDATE provider_connections SET
        status = ?, last_message = ?, last_tested_at = ?,
        authorization_status = ?, capability_version = ?,
        authorized_capabilities_json = ?,
        authorized_at = CASE WHEN ? = 'active' THEN COALESCE(authorized_at, ?) ELSE authorized_at END,
        authorization_expires_at = ?, updated_at = ?
       WHERE account_id = ? AND provider_kind = ?
         AND credential_ref IS ?
         AND settings_json = ?
         AND status = ?
         AND authorization_status = ?
         AND capability_version = ?
         AND authorized_capabilities_json = ?
         AND authorized_at IS ?
         AND authorization_expires_at IS ?
         AND updated_at = ?`,
    ).run(
      input.connectionStatus,
      input.message,
      now,
      input.authorizationStatus,
      input.capabilityVersion,
      JSON.stringify(capabilities),
      input.authorizationStatus,
      now,
      input.expiresAt ?? null,
      now,
      accountId,
      kind,
      expected.credentialRef,
      JSON.stringify(expected.settings),
      expected.status,
      expected.authorizationStatus,
      expected.capabilityVersion,
      JSON.stringify(expected.authorizedCapabilities),
      expected.authorizedAt,
      expected.authorizationExpiresAt,
      expected.updatedAt,
    );
    if (result.changes === 0) return null;
    this.writeAudit("system", accountId, "provider.health-check.completed", {
      providerKind: kind,
      status: input.connectionStatus,
      authorizationStatus: input.authorizationStatus,
      capabilityVersion: input.capabilityVersion,
      capabilities,
      expiresAt: input.expiresAt ?? null,
    });
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
    const previousHealthy = this.db
      .prepare(
        `SELECT finished_at FROM sync_runs
         WHERE account_id = ? AND provider_kind = ?
           AND json_extract(quality_json, '$.status') = 'healthy'
         ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(accountId, kind) as SqlRow | undefined;
    const quality = {
      ...result.quality,
      lastHealthyAt:
        result.quality.status === "healthy"
          ? result.finishedAt
          : previousHealthy
            ? String(previousHealthy.finished_at)
            : null,
    };
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
        operational_status, metrics_json, captured_at, sync_quality_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (quality.status === "healthy") {
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
            "healthy",
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
      }
      this.db
        .prepare(
          `INSERT INTO sync_runs (
            id, account_id, provider_kind, started_at, finished_at,
            counts_json, warnings_json, quality_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          accountId,
          kind,
          result.startedAt,
          result.finishedAt,
          JSON.stringify(result.counts),
          JSON.stringify(result.warnings),
          JSON.stringify(quality),
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

  getLatestReadOnlySync(
    accountId: string,
    kind: ProviderKind,
  ): ReadOnlySyncResult | null {
    const row = this.db
      .prepare(
        `SELECT started_at, finished_at, counts_json, warnings_json, quality_json
         FROM sync_runs
         WHERE account_id = ? AND provider_kind = ?
         ORDER BY finished_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(accountId, kind) as SqlRow | undefined;
    if (!row) return null;
    const quality = JSON.parse(String(row.quality_json)) as ReadOnlySyncResult["quality"];
    const isStale =
      quality.status === "healthy" &&
      Date.now() - new Date(String(row.finished_at)).getTime() > SYNC_STALE_AFTER_MS;
    return {
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      counts: JSON.parse(String(row.counts_json)) as ReadOnlySyncResult["counts"],
      warnings: JSON.parse(String(row.warnings_json)) as string[],
      quality: isStale ? { ...quality, status: "stale" } : quality,
    };
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
    input: Pick<
      AdOperationRecord,
      "accountId" | "providerKind" | "entityType" | "externalId" |
      "entityName" | "action" | "source" | "status" | "message"
    >,
  ): AdOperationRecord {
    const id = randomUUID();
    const operationId = randomUUID();
    const correlationId = randomUUID();
    const createdAt = new Date().toISOString();
    const completedAt = ["succeeded", "failed", "unknown", "cancelled"].includes(input.status)
      ? createdAt
      : null;
    this.db
      .prepare(
        `INSERT INTO ad_operations (
          id, account_id, provider_kind, entity_type, external_id, entity_name,
          action, source, status, phase, operation_id, attempt_id,
          correlation_id, attempt_count, actor_id, actor_name, actor_kind,
          claimed_by, claimed_at, message, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'validation', ?, NULL, ?, 0,
                  'legacy-local-user', '本地用户', 'user', NULL, NULL, ?, ?, ?, ?)`,
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
        operationId,
        correlationId,
        input.message,
        createdAt,
        createdAt,
        completedAt,
      );
    const row = this.db
      .prepare("SELECT * FROM ad_operations WHERE id = ?")
      .get(id) as SqlRow;
    return mapAdOperation(row);
  }

  createStatusWriteTask(
    input: Pick<
      AdOperationRecord,
      "accountId" | "providerKind" | "entityType" | "externalId" |
      "entityName" | "action" | "source"
    >,
    actor: WriteTaskActor,
    correlationId = randomUUID(),
  ): AdOperationRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO ad_operations (
        id, account_id, provider_kind, entity_type, external_id, entity_name,
        action, source, status, phase, operation_id, attempt_id,
        correlation_id, attempt_count, actor_id, actor_name, actor_kind,
        claimed_by, claimed_at, message, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'validation', ?, NULL, ?, 0,
                ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
    ).run(
      id,
      input.accountId,
      input.providerKind,
      input.entityType,
      input.externalId,
      input.entityName,
      input.action,
      input.source,
      randomUUID(),
      correlationId,
      actor.id,
      actor.name,
      actor.kind,
      now,
      now,
    );
    this.writeAudit(actor.name, input.accountId, "write-task.created", {
      taskType: "status",
      taskId: id,
      correlationId,
      entityType: input.entityType,
      externalId: input.externalId,
      action: input.action,
      source: input.source,
    });
    return this.getAdOperation(id);
  }

  claimStatusWriteTask(
    taskId: string,
    executorId: string,
    expectedStatus: "pending" | "failed" = "pending",
    actor: WriteTaskActor = { id: "local-user", name: "本地用户", kind: "user" },
  ): AdOperationRecord | null {
    const now = new Date().toISOString();
    const attemptId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `UPDATE ad_operations SET status = 'running', phase = 'validation',
         attempt_id = ?, attempt_count = attempt_count + 1,
         claimed_by = ?, claimed_at = ?, message = NULL,
         completed_at = NULL, updated_at = ?
         WHERE id = ? AND status = ? RETURNING *`,
      ).get(attemptId, executorId, now, now, taskId, expectedStatus) as SqlRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(
        `INSERT INTO ad_operation_attempts (
          attempt_id, operation_id, correlation_id, attempt_number,
          actor_id, actor_name, actor_kind,
          phase, status, message, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'validation', 'running', NULL, ?, ?, NULL)`,
      ).run(
        attemptId,
        String(row.operation_id),
        String(row.correlation_id),
        Number(row.attempt_count),
        actor.id,
        actor.name,
        actor.kind,
        now,
        now,
      );
      this.writeAudit(actor.name, String(row.account_id), "write-task.claimed", {
        taskType: "status",
        taskId,
        attemptId,
        executorId,
        correlationId: row.correlation_id,
      });
      this.db.exec("COMMIT");
      return mapAdOperation(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  completeStatusWriteTask(
    taskId: string,
    executorId: string,
    status: "succeeded" | "failed" | "unknown",
    message: string,
    phase: "dispatch" | "readback" | "sync" = "dispatch",
  ): AdOperationRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `UPDATE ad_operations SET status = ?, phase = ?, message = ?,
         completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND claimed_by = ? RETURNING *`,
      ).get(status, phase, message.slice(0, 2000), now, now, taskId, executorId) as SqlRow | undefined;
      if (!row) throw new Error("状态写任务未被当前执行器领取。");
      this.db.prepare(
        `UPDATE ad_operation_attempts SET status = ?, phase = ?, message = ?,
         completed_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'running'`,
      ).run(status, phase, message.slice(0, 2000), now, now, String(row.attempt_id));
      const attemptActor = this.db.prepare(
        "SELECT actor_name FROM ad_operation_attempts WHERE attempt_id = ?",
      ).get(String(row.attempt_id)) as SqlRow | undefined;
      this.writeAudit(String(attemptActor?.actor_name ?? row.actor_name), String(row.account_id), `write-task.${status}`, {
        taskType: "status",
        taskId,
        attemptId: row.attempt_id,
        correlationId: row.correlation_id,
        phase,
        message: message.slice(0, 500),
      });
      this.db.exec("COMMIT");
      return mapAdOperation(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  completeStatusWriteTaskSync(
    taskId: string,
    syncWarning: string | null,
  ): AdOperationRecord {
    const now = new Date().toISOString();
    const row = this.db.prepare(
      `UPDATE ad_operations SET phase = 'sync', sync_warning = ?, updated_at = ?
       WHERE id = ? AND status = 'succeeded' RETURNING *`,
    ).get(syncWarning?.slice(0, 2000) ?? null, now, taskId) as SqlRow | undefined;
    if (!row) throw new Error("已完成的状态写任务不存在。");
    this.db.prepare(
      `UPDATE ad_operation_attempts SET phase = 'sync', updated_at = ?
       WHERE attempt_id = ? AND status = 'succeeded'`,
    ).run(now, String(row.attempt_id));
    const attemptActor = this.db.prepare(
      "SELECT actor_name FROM ad_operation_attempts WHERE attempt_id = ?",
    ).get(String(row.attempt_id)) as SqlRow | undefined;
    this.writeAudit(String(attemptActor?.actor_name ?? row.actor_name), String(row.account_id), "write-task.sync-finished", {
      taskType: "status",
      taskId,
      attemptId: row.attempt_id,
      correlationId: row.correlation_id,
      syncWarning: syncWarning?.slice(0, 500) ?? null,
    });
    return mapAdOperation(row);
  }

  listAdOperationAttempts(operationId: string): AdOperationAttemptRecord[] {
    return (this.db.prepare(
      "SELECT * FROM ad_operation_attempts WHERE operation_id = ? ORDER BY attempt_number",
    ).all(operationId) as SqlRow[]).map(mapAdOperationAttempt);
  }

  recoverInterruptedStatusWriteTasks(staleBefore: string): number {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(
        "SELECT id, attempt_id FROM ad_operations WHERE status = 'running' AND claimed_at <= ?",
      ).all(staleBefore) as SqlRow[];
      const message = "执行进程中断，无法确认 Provider 是否已完成状态写入；禁止自动重试。";
      const updateTask = this.db.prepare(
        `UPDATE ad_operations SET status = 'unknown', message = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      );
      const updateAttempt = this.db.prepare(
        `UPDATE ad_operation_attempts SET status = 'unknown', message = ?, completed_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'running'`,
      );
      for (const row of rows) {
        updateTask.run(message, now, now, String(row.id));
        if (row.attempt_id) updateAttempt.run(message, now, now, String(row.attempt_id));
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  getAdOperation(id: string): AdOperationRecord {
    const row = this.db.prepare("SELECT * FROM ad_operations WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) throw new Error("广告操作记录不存在。");
    return mapAdOperation(row);
  }

  getAdOperationByOperationId(operationId: string): AdOperationRecord {
    const row = this.db.prepare(
      "SELECT * FROM ad_operations WHERE operation_id = ? OR id = ? LIMIT 1",
    ).get(operationId, operationId) as SqlRow | undefined;
    if (!row) throw new Error("广告操作记录不存在。");
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
           AND claimed_by IS NULL
         ORDER BY next_run_at ASC LIMIT ?`,
      )
      .all(accountId, asOf, limit) as SqlRow[];
    return rows.map(mapScheduledEntityAction);
  }

  claimDueScheduledAction(
    scheduleId: string,
    executorId: string,
    asOf = new Date().toISOString(),
  ): ScheduledEntityActionRecord | null {
    const now = new Date().toISOString();
    const row = this.db.prepare(
      `UPDATE scheduled_entity_actions SET claimed_by = ?, claimed_at = ?,
       last_operation_id = NULL, updated_at = ?
       WHERE id = ? AND status = 'scheduled' AND next_run_at <= ?
         AND claimed_by IS NULL
       RETURNING *`,
    ).get(executorId, now, now, scheduleId, asOf) as SqlRow | undefined;
    return row ? mapScheduledEntityAction(row) : null;
  }

  bindScheduledActionOperation(
    scheduleId: string,
    executorId: string,
    operationId: string,
  ): void {
    const result = this.db.prepare(
      `UPDATE scheduled_entity_actions SET last_operation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'scheduled' AND claimed_by = ?`,
    ).run(operationId, new Date().toISOString(), scheduleId, executorId);
    if (result.changes === 0) {
      throw new Error("定时任务未被当前执行器领取，禁止发送状态写入。");
    }
  }

  recoverInterruptedScheduledActions(staleBefore: string): number {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM scheduled_entity_actions
       WHERE status = 'scheduled' AND claimed_by IS NOT NULL AND claimed_at <= ?`,
    ).all(staleBefore) as SqlRow[];
    if (rows.length === 0) return 0;
    let recovered = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const operationId = typeof row.last_operation_id === "string"
          ? row.last_operation_id
          : null;
        if (!operationId) {
          const released = this.db.prepare(
            `UPDATE scheduled_entity_actions SET claimed_by = NULL, claimed_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'scheduled' AND claimed_at <= ?
               AND last_operation_id IS NULL`,
          ).run(now, String(row.id), staleBefore);
          recovered += Number(released.changes);
          continue;
        }
        const operation = this.db.prepare(
          "SELECT * FROM ad_operations WHERE operation_id = ? OR id = ? LIMIT 1",
        ).get(operationId, operationId) as SqlRow | undefined;
        if (
          operation?.status === "running"
          && typeof operation.claimed_at === "string"
          && operation.claimed_at > staleBefore
        ) {
          continue;
        }
        const current = mapScheduledEntityAction(row);
        const succeeded = operation?.status === "succeeded";
        const explicitlyFailed = operation?.status === "failed";
        const mayRepeat = current.repeatDaily && (succeeded || explicitlyFailed);
        const nextRunAt = mayRepeat
          ? advanceDailyRun(current.nextRunAt, now)
          : current.nextRunAt;
        const nextStatus = mayRepeat
          ? "scheduled"
          : succeeded ? "completed" : "failed";
        const message = succeeded
          ? "执行进程在写入成功后中断；已根据持久化写任务恢复定时结果。"
          : operation?.status === "failed"
            ? String(operation.message ?? "定时状态写入明确失败。")
            : "执行进程中断，状态写入结果无法确认；禁止自动重放，请在任务中心人工核验。";
        const updated = this.db.prepare(
          `UPDATE scheduled_entity_actions SET next_run_at = ?, status = ?,
           last_result = ?, last_message = ?, last_run_at = ?,
           claimed_by = NULL, claimed_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'scheduled' AND claimed_at <= ?`,
        ).run(
          nextRunAt,
          nextStatus,
          succeeded ? "succeeded" : "failed",
          message.slice(0, 2000),
          now,
          now,
          String(row.id),
          staleBefore,
        );
        if (updated.changes > 0) {
          recovered += 1;
          this.writeAudit("system", String(row.account_id), "schedule.recovered", {
            scheduleId: row.id,
            operationId,
            operationStatus: operation?.status ?? "missing",
            result: succeeded ? "succeeded" : "unknown-or-failed",
          });
        }
      }
      this.db.exec("COMMIT");
      return recovered;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  cancelScheduledAction(accountId: string, scheduleId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE scheduled_entity_actions
         SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND account_id = ? AND status = 'scheduled'
           AND claimed_by IS NULL`,
      )
      .run(now, scheduleId, accountId);
    if (result.changes > 0) {
      this.writeAudit("local-user", accountId, "schedule.cancelled", {
        scheduleId,
      });
    }
    if (result.changes === 0) {
      const running = this.db.prepare(
        `SELECT 1 FROM scheduled_entity_actions
         WHERE id = ? AND account_id = ? AND status = 'scheduled'
           AND claimed_by IS NOT NULL`,
      ).get(scheduleId, accountId);
      if (running) throw new Error("定时任务正在执行，当前不能取消。");
    }
    return result.changes > 0;
  }

  cancelOvernightSchedule(accountId: string, groupId: string): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = this.db.prepare(
        `SELECT 1 FROM scheduled_entity_actions
         WHERE account_id = ? AND group_id = ? AND status = 'scheduled'
           AND claimed_by IS NOT NULL LIMIT 1`,
      ).get(accountId, groupId);
      if (running) throw new Error("过夜定时任务正在执行，当前不能取消。");
      const result = this.db.prepare(
        `UPDATE scheduled_entity_actions
         SET status = 'cancelled', updated_at = ?
         WHERE account_id = ? AND group_id = ? AND status = 'scheduled'`,
      ).run(now, accountId, groupId);
      if (result.changes > 0) {
        this.writeAudit("local-user", accountId, "overnight-schedule.cancelled", {
          groupId,
        });
      }
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  completeScheduledAction(
    scheduleId: string,
    result: "succeeded" | "failed" | "unknown",
    message: string,
    executorId: string,
    completedAt = new Date().toISOString(),
  ): ScheduledEntityActionRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `SELECT * FROM scheduled_entity_actions
         WHERE id = ? AND status = 'scheduled' AND claimed_by = ?`,
      ).get(scheduleId, executorId) as SqlRow | undefined;
      if (!row) throw new Error("定时任务未被当前执行器领取。");
      const current = mapScheduledEntityAction(row);
      const mayRepeat = current.repeatDaily && result !== "unknown";
      const nextRunAt = mayRepeat
        ? advanceDailyRun(current.nextRunAt, completedAt)
        : current.nextRunAt;
      const status = mayRepeat
        ? "scheduled"
        : result === "succeeded"
          ? "completed"
          : "failed";
      const updated = this.db.prepare(
        `UPDATE scheduled_entity_actions SET
          next_run_at = ?, status = ?, last_result = ?, last_message = ?,
          last_run_at = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'scheduled' AND claimed_by = ? RETURNING *`,
      ).get(
        nextRunAt,
        status,
        result === "unknown" ? "failed" : result,
        message.slice(0, 2000),
        completedAt,
        completedAt,
        scheduleId,
        executorId,
      ) as SqlRow | undefined;
      if (!updated) throw new Error("定时任务执行权已经变化。");
      this.db.exec("COMMIT");
      return mapScheduledEntityAction(updated);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
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

  getMultiAccountLaunchPlan(planId: string): MultiAccountLaunchPlanRecord | null {
    const row = this.db
      .prepare("SELECT * FROM multi_account_launch_plans WHERE id = ?")
      .get(planId) as SqlRow | undefined;
    return row ? mapMultiAccountLaunchPlan(row) : null;
  }

  enqueueLaunchPlan(planId: string, actor: WriteTaskActor): MultiAccountLaunchPlanRecord {
    const plan = this.getMultiAccountLaunchPlan(planId);
    if (!plan) throw new Error("投放计划不存在。");
    if (plan.status === "cancelled" || plan.status === "completed") {
      throw new Error("投放计划已结束，无法加入后台队列。");
    }
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO launch_plan_dispatches (
         plan_id, actor_id, actor_name, actor_kind, requested_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         actor_id = excluded.actor_id,
         actor_name = excluded.actor_name,
         actor_kind = excluded.actor_kind,
         updated_at = excluded.updated_at`,
    ).run(planId, actor.id, actor.name, actor.kind, now, now);
    return plan;
  }

  listQueuedLaunchPlans(limit = 100): Array<{ planId: string; actor: WriteTaskActor }> {
    const rows = this.db.prepare(
      `SELECT dispatch.plan_id, dispatch.actor_id, dispatch.actor_name, dispatch.actor_kind
       FROM launch_plan_dispatches dispatch
       JOIN multi_account_launch_plans plan ON plan.id = dispatch.plan_id
       WHERE plan.status IN ('draft', 'blocked')
         AND EXISTS (
           SELECT 1 FROM launch_plan_items item
           WHERE item.plan_id = dispatch.plan_id AND item.status = 'pending'
         )
       ORDER BY dispatch.requested_at
       LIMIT ?`,
    ).all(limit) as SqlRow[];
    return rows.map((row) => ({
      planId: String(row.plan_id),
      actor: {
        id: String(row.actor_id),
        name: String(row.actor_name),
        kind: row.actor_kind === "system" ? "system" : "user",
      },
    }));
  }

  listWriteTaskSummaries(input: {
    kind?: WriteTaskKind;
    status?: WriteTaskStatus;
    accountId?: string;
    limit?: number;
  } = {}): WriteTaskSummaryRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1_000);
    const statusConditions = ["action IN ('enable', 'disable')"];
    const statusParameters: Array<string | number> = [];
    if (input.accountId) {
      statusConditions.push("account_id = ?");
      statusParameters.push(input.accountId);
    }
    if (input.status) {
      statusConditions.push("status = ?");
      statusParameters.push(input.status);
    }
    statusParameters.push(limit);
    const statusRows = input.kind === "launch"
      ? []
      : this.db.prepare(
          `SELECT * FROM ad_operations
           WHERE ${statusConditions.join(" AND ")}
           ORDER BY created_at DESC LIMIT ?`,
        ).all(...statusParameters) as SqlRow[];
    const launchConditions: string[] = [];
    const launchParameters: Array<string | number> = [];
    if (input.accountId) {
      launchConditions.push("account_id = ?");
      launchParameters.push(input.accountId);
    }
    if (input.status) {
      launchConditions.push("status = ?");
      launchParameters.push(input.status);
    }
    launchParameters.push(limit);
    const launchRows = input.kind === "status"
      ? []
      : this.db.prepare(
          `SELECT * FROM launch_plan_items
           ${launchConditions.length > 0 ? `WHERE ${launchConditions.join(" AND ")}` : ""}
           ORDER BY created_at DESC LIMIT ?`,
        ).all(...launchParameters) as SqlRow[];
    const summaries: WriteTaskSummaryRecord[] = [
      ...statusRows.map((row) => {
        const task = mapAdOperation(row);
        return {
          kind: "status" as const,
          taskId: task.id,
          parentId: null,
          accountId: task.accountId,
          label: task.entityName,
          action: task.action,
          status: task.status,
          phase: task.phase,
          operationId: task.operationId,
          attemptId: task.attemptId,
          correlationId: task.correlationId,
          attemptCount: task.attemptCount,
          actor: task.actor,
          claimedAt: task.claimedAt,
          message: task.message,
          syncWarning: task.syncWarning,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt,
          retryable: task.status === "failed" && task.source !== "automation",
          requiresVerification: task.status === "unknown",
        };
      }),
      ...launchRows.map((row) => {
        const task = mapLaunchPlanItem(row);
        return {
          kind: "launch" as const,
          taskId: task.itemId,
          parentId: task.planId,
          accountId: task.accountId,
          label: task.launchRow.adName,
          action: "create",
          status: task.status,
          phase: (task.phase === "validation"
            ? "validation"
            : task.phase === "readback"
              ? "readback"
              : task.phase === "sync"
                ? "sync"
                : "dispatch") as WriteTaskSummaryRecord["phase"],
          operationId: task.operationId,
          attemptId: task.attemptId,
          correlationId: task.correlationId,
          attemptCount: task.attemptCount,
          actor: task.actor,
          claimedAt: task.claimedAt,
          message: task.errorMessage,
          syncWarning: task.syncWarning,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt,
          retryable: task.status === "failed",
          requiresVerification: task.status === "unknown",
        };
      }),
    ];
    return summaries
      .filter((task) => !input.status || task.status === input.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  renewStatusWriteTaskLease(taskId: string, executorId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE ad_operations SET claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND claimed_by = ?`,
    ).run(now, now, taskId, executorId);
    if (result.changes > 0) {
      this.db.prepare(
        `UPDATE ad_operation_attempts SET updated_at = ?
         WHERE attempt_id = (SELECT attempt_id FROM ad_operations WHERE id = ?)
           AND status = 'running'`,
      ).run(now, taskId);
    }
    return result.changes > 0;
  }

  renewLaunchPlanItemLease(itemId: string, executorId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE launch_plan_items SET claimed_at = ?, updated_at = ?
       WHERE item_id = ? AND status = 'running' AND claimed_by = ?`,
    ).run(now, now, itemId, executorId);
    if (result.changes > 0) {
      this.db.prepare(
        `UPDATE launch_plan_item_attempts SET updated_at = ?
         WHERE attempt_id = (SELECT attempt_id FROM launch_plan_items WHERE item_id = ?)
           AND status = 'running'`,
      ).run(now, itemId);
    }
    return result.changes > 0;
  }

  verifyUnknownStatusWriteTask(
    taskId: string,
    input: StatusManualVerificationInput,
    actor: WriteTaskActor,
  ): StatusManualVerificationRecord {
    const verification = StatusManualVerificationInputSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(
        "SELECT * FROM ad_operations WHERE id = ? AND status = 'unknown'",
      ).get(taskId) as SqlRow | undefined;
      if (!current) throw new Error("只有结果未知的状态写任务可以人工核验。");
      if (current.action !== "enable" && current.action !== "disable") {
        throw new Error("只有广告启停写入任务可以使用状态人工核验。");
      }
      const desiredStatus = current.action === "enable" ? "enabled" : "disabled";
      if (verification.decision === "confirmed-succeeded" && verification.observedStatus !== desiredStatus) {
        throw new Error(`确认成功时，核验状态必须为 ${desiredStatus}。`);
      }
      const nextStatus = verification.decision === "confirmed-succeeded" ? "succeeded" : "failed";
      this.db.prepare(
        `INSERT INTO status_operation_verifications (
          id, task_id, operation_id, actor_id, actor_name, actor_kind,
          decision, observed_status, evidence, note, previous_status, next_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
      ).run(
        id,
        taskId,
        String(current.operation_id),
        actor.id,
        actor.name,
        actor.kind,
        verification.decision,
        verification.observedStatus,
        verification.evidence,
        verification.note,
        nextStatus,
        now,
      );
      this.db.prepare(
        `UPDATE ad_operations SET status = ?, phase = 'readback', message = ?,
         sync_warning = '人工核验结果，尚未完成自动回读。', completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'unknown'`,
      ).run(
        nextStatus,
        verification.decision === "confirmed-succeeded"
          ? "人工核验确认状态写入成功。"
          : "人工核验确认状态写入未成功。",
        now,
        now,
        taskId,
      );
      const linkedApproval = this.db.prepare(
        "SELECT * FROM automation_approvals WHERE status_operation_id = ? AND status = 'unknown'",
      ).get(String(current.operation_id)) as SqlRow | undefined;
      if (linkedApproval) {
        this.db.prepare(
          `UPDATE automation_approvals SET status = ?, after_status = ?, error_message = ?, completed_at = ?
           WHERE id = ? AND status = 'unknown'`,
        ).run(
          nextStatus,
          verification.observedStatus,
          nextStatus === "failed" ? "人工核验确认状态写入未成功。" : null,
          now,
          String(linkedApproval.id),
        );
        this.db.prepare(
          `UPDATE automation_decisions SET status = ?, error_message = ?, executed_at = ? WHERE id = ?`,
        ).run(
          nextStatus,
          nextStatus === "failed" ? "人工核验确认状态写入未成功。" : null,
          now,
          String(linkedApproval.decision_id),
        );
      }
      this.writeAudit(actor.name, String(current.account_id), "status-task.manually-verified", {
        taskId,
        operationId: current.operation_id,
        decision: verification.decision,
        observedStatus: verification.observedStatus,
        evidence: verification.evidence,
        note: verification.note,
      });
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    const row = this.db.prepare(
      "SELECT * FROM status_operation_verifications WHERE id = ?",
    ).get(id) as SqlRow;
    return mapStatusManualVerification(row);
  }

  listStatusWriteTaskVerifications(taskId: string): StatusManualVerificationRecord[] {
    return (this.db.prepare(
      "SELECT * FROM status_operation_verifications WHERE task_id = ? ORDER BY created_at",
    ).all(taskId) as SqlRow[]).map(mapStatusManualVerification);
  }

  listLaunchPlanItems(
    planId: string,
    statuses?: LaunchPlanItemStatus[],
  ): LaunchPlanItemRecord[] {
    const rows = statuses && statuses.length > 0
      ? this.db
          .prepare(
            `SELECT * FROM launch_plan_items
             WHERE plan_id = ? AND status IN (${statuses.map(() => "?").join(", ")})
             ORDER BY account_id, item_index`,
          )
          .all(planId, ...statuses) as SqlRow[]
      : this.db
          .prepare(
            `SELECT * FROM launch_plan_items
             WHERE plan_id = ? ORDER BY account_id, item_index`,
          )
          .all(planId) as SqlRow[];
    return rows.map(mapLaunchPlanItem);
  }

  getLaunchPlanItem(itemId: string): LaunchPlanItemRecord {
    const row = this.db.prepare(
      "SELECT * FROM launch_plan_items WHERE item_id = ?",
    ).get(itemId) as SqlRow | undefined;
    if (!row) throw new Error("创建任务不存在。");
    return mapLaunchPlanItem(row);
  }

  claimLaunchPlanItem(
    itemId: string,
    executorId: string,
    expectedStatus: "pending" | "failed",
    actor: WriteTaskActor = { id: "local-user", name: "本地用户", kind: "user" },
  ): LaunchPlanItemRecord | null {
    const now = new Date().toISOString();
    const attemptId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `UPDATE launch_plan_items
           SET status = 'running', attempt_count = attempt_count + 1,
               attempt_id = ?, phase = 'validation', evidence_json = '{}',
               claimed_by = ?, claimed_at = ?, completed_at = NULL,
               error_message = NULL, sync_warning = NULL, updated_at = ?
           WHERE item_id = ? AND status = ?
           RETURNING *`,
        )
        .get(attemptId, executorId, now, now, itemId, expectedStatus) as SqlRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(
        `INSERT INTO launch_plan_item_attempts (
          attempt_id, item_id, operation_id, correlation_id, attempt_number,
          actor_id, actor_name, actor_kind, phase, status, evidence_json,
          error_message, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validation', 'running', '{}', NULL, ?, ?, NULL)`,
      ).run(
        attemptId,
        itemId,
        String(row.operation_id),
        String(row.correlation_id),
        Number(row.attempt_count),
        actor.id,
        actor.name,
        actor.kind,
        now,
        now,
      );
      this.writeAudit(actor.name, String(row.account_id), "write-task.claimed", {
        taskType: "launch",
        taskId: itemId,
        attemptId,
        executorId,
        correlationId: row.correlation_id,
      });
      this.db.exec("COMMIT");
      return mapLaunchPlanItem(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  updateLaunchPlanItemProgress(
    itemId: string,
    executorId: string,
    input: LaunchCreationProgress,
  ): LaunchPlanItemRecord {
    const progress = LaunchCreationProgressSchema.parse(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const current = this.db.prepare(
      "SELECT * FROM launch_plan_items WHERE item_id = ? AND status = 'running' AND claimed_by = ?",
    ).get(itemId, executorId) as SqlRow | undefined;
    if (!current) throw new Error("创建任务未被当前执行器领取。");
    const existing = JSON.parse(String(current.evidence_json ?? "{}")) as Record<string, unknown>;
    const evidence = { ...existing, ...progress.evidence };
    const now = new Date().toISOString();
    const row = this.db.prepare(
      `UPDATE launch_plan_items SET phase = ?, evidence_json = ?, claimed_at = ?, updated_at = ?
       WHERE item_id = ? AND status = 'running' AND claimed_by = ? RETURNING *`,
    ).get(progress.phase, JSON.stringify(evidence), now, now, itemId, executorId) as SqlRow | undefined;
    if (!row) throw new Error("创建任务未被当前执行器领取。");
    this.db.prepare(
      `UPDATE launch_plan_item_attempts SET phase = ?, evidence_json = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'running'`,
    ).run(progress.phase, JSON.stringify(evidence), now, String(current.attempt_id));
    this.db.exec("COMMIT");
    return mapLaunchPlanItem(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  listLaunchPlanItemAttempts(itemId: string): LaunchPlanItemAttemptRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM launch_plan_item_attempts WHERE item_id = ? ORDER BY attempt_number",
    ).all(itemId) as SqlRow[];
    return rows.map(mapLaunchPlanItemAttempt);
  }

  listLaunchPlanItemVerifications(itemId: string): LaunchManualVerificationRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM launch_plan_item_verifications WHERE item_id = ? ORDER BY created_at",
    ).all(itemId) as SqlRow[];
    return rows.map(mapLaunchManualVerification);
  }

  verifyUnknownLaunchPlanItem(
    itemId: string,
    input: LaunchManualVerificationInput,
    actor: { id: string; name: string },
  ): LaunchManualVerificationRecord {
    const verification = LaunchManualVerificationInputSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const nextStatus = verification.decision === "confirmed-succeeded" ? "succeeded" : "failed";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(
        "SELECT * FROM launch_plan_items WHERE item_id = ? AND status = 'unknown'",
      ).get(itemId) as SqlRow | undefined;
      if (!current) throw new Error("只有创建结果未知的任务可以人工核验。");
      this.db.prepare(
        `INSERT INTO launch_plan_item_verifications (
          id, item_id, actor_id, actor_name, decision, evidence, note,
          campaign_id, adgroup_id, ad_id, previous_status, next_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
      ).run(
        id,
        itemId,
        actor.id,
        actor.name,
        verification.decision,
        verification.evidence,
        verification.note,
        verification.campaignId,
        verification.adGroupId,
        verification.adId,
        nextStatus,
        now,
      );
      if (nextStatus === "succeeded") {
        this.db.prepare(
          `UPDATE launch_plan_items SET status = 'succeeded', phase = 'readback',
           campaign_id = ?, adgroup_id = ?, ad_id = ?, error_message = NULL,
           sync_warning = '人工核验确认成功，尚未完成自动回读。', completed_at = ?, updated_at = ?
           WHERE item_id = ? AND status = 'unknown'`,
        ).run(
          verification.campaignId,
          verification.adGroupId,
          verification.adId,
          now,
          now,
          itemId,
        );
      } else {
        this.db.prepare(
          `UPDATE launch_plan_items SET status = 'failed',
           error_message = '人工核验确认未创建；可由用户显式单项重试。', updated_at = ?
           WHERE item_id = ? AND status = 'unknown'`,
        ).run(now, itemId);
      }
      this.writeAudit(actor.name, String(current.account_id), "launch-item.manually-verified", {
        itemId,
        verificationId: id,
        decision: verification.decision,
        previousStatus: "unknown",
        nextStatus,
        evidence: verification.evidence,
        note: verification.note,
        campaignId: verification.campaignId,
        adGroupId: verification.adGroupId,
        adId: verification.adId,
      });
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    const row = this.db.prepare(
      "SELECT * FROM launch_plan_item_verifications WHERE id = ?",
    ).get(id) as SqlRow;
    return mapLaunchManualVerification(row);
  }

  completeLaunchPlanItemSuccess(
    itemId: string,
    executorId: string,
    ids: { campaignId: string; adGroupId: string; adId: string },
  ): LaunchPlanItemRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const row = this.db
      .prepare(
        `UPDATE launch_plan_items
         SET status = 'succeeded', campaign_id = ?, adgroup_id = ?, ad_id = ?,
             phase = 'readback', error_message = NULL, completed_at = ?, updated_at = ?
         WHERE item_id = ? AND status = 'running' AND claimed_by = ?
         RETURNING *`,
      )
      .get(ids.campaignId, ids.adGroupId, ids.adId, now, now, itemId, executorId) as SqlRow | undefined;
    if (!row) throw new Error("创建任务未被当前执行器领取。");
    this.finishLaunchAttempt(row, "succeeded", null, now);
    const attemptActor = this.db.prepare(
      "SELECT actor_name FROM launch_plan_item_attempts WHERE attempt_id = ?",
    ).get(String(row.attempt_id)) as SqlRow | undefined;
    this.writeAudit(String(attemptActor?.actor_name ?? row.actor_name), String(row.account_id), "write-task.succeeded", {
      taskType: "launch",
      taskId: itemId,
      attemptId: row.attempt_id,
      correlationId: row.correlation_id,
      campaignId: ids.campaignId,
      adGroupId: ids.adGroupId,
      adId: ids.adId,
    });
    this.db.exec("COMMIT");
    return mapLaunchPlanItem(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  completeLaunchPlanItemSync(
    itemId: string,
    syncWarning: string | null,
  ): LaunchPlanItemRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const row = this.db.prepare(
      `UPDATE launch_plan_items SET phase = 'sync', sync_warning = ?, updated_at = ?
       WHERE item_id = ? AND status = 'succeeded' RETURNING *`,
    ).get(syncWarning?.slice(0, 2000) ?? null, now, itemId) as SqlRow | undefined;
    if (!row) throw new Error("已创建任务不存在。");
    this.db.prepare(
      `UPDATE launch_plan_item_attempts SET phase = 'sync', updated_at = ?
       WHERE attempt_id = ? AND status = 'succeeded'`,
    ).run(now, String(row.attempt_id));
    this.db.exec("COMMIT");
    return mapLaunchPlanItem(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  completeLaunchPlanItemFailure(
    itemId: string,
    executorId: string,
    errorMessage: string,
  ): LaunchPlanItemRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const row = this.db
      .prepare(
        `UPDATE launch_plan_items
         SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
         WHERE item_id = ? AND status = 'running' AND claimed_by = ?
         RETURNING *`,
      )
      .get(errorMessage.slice(0, 2000), now, now, itemId, executorId) as SqlRow | undefined;
    if (!row) throw new Error("创建任务未被当前执行器领取。");
    this.finishLaunchAttempt(row, "failed", errorMessage, now);
    const attemptActor = this.db.prepare(
      "SELECT actor_name FROM launch_plan_item_attempts WHERE attempt_id = ?",
    ).get(String(row.attempt_id)) as SqlRow | undefined;
    this.writeAudit(String(attemptActor?.actor_name ?? row.actor_name), String(row.account_id), "write-task.failed", {
      taskType: "launch",
      taskId: itemId,
      attemptId: row.attempt_id,
      correlationId: row.correlation_id,
      message: errorMessage.slice(0, 500),
    });
    this.db.exec("COMMIT");
    return mapLaunchPlanItem(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  completeLaunchPlanItemUnknown(
    itemId: string,
    executorId: string,
    errorMessage: string,
  ): LaunchPlanItemRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const row = this.db
      .prepare(
        `UPDATE launch_plan_items
         SET status = 'unknown', error_message = ?, completed_at = ?, updated_at = ?
         WHERE item_id = ? AND status = 'running' AND claimed_by = ?
         RETURNING *`,
      )
      .get(errorMessage.slice(0, 2000), now, now, itemId, executorId) as SqlRow | undefined;
    if (!row) throw new Error("创建任务未被当前执行器领取。");
    this.finishLaunchAttempt(row, "unknown", errorMessage, now);
    const attemptActor = this.db.prepare(
      "SELECT actor_name FROM launch_plan_item_attempts WHERE attempt_id = ?",
    ).get(String(row.attempt_id)) as SqlRow | undefined;
    this.writeAudit(String(attemptActor?.actor_name ?? row.actor_name), String(row.account_id), "write-task.unknown", {
      taskType: "launch",
      taskId: itemId,
      attemptId: row.attempt_id,
      correlationId: row.correlation_id,
      message: errorMessage.slice(0, 500),
    });
    this.db.exec("COMMIT");
    return mapLaunchPlanItem(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  recoverInterruptedLaunchPlanItems(staleBefore: string): number {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const interrupted = this.db.prepare(
      "SELECT attempt_id FROM launch_plan_items WHERE status = 'running' AND claimed_at <= ?",
    ).all(staleBefore) as SqlRow[];
    const result = this.db
      .prepare(
        `UPDATE launch_plan_items
         SET status = 'unknown',
             error_message = '执行进程中断，无法确认 Provider 是否已完成创建；为避免重复投放，系统不会自动重试。',
             completed_at = ?, updated_at = ?
         WHERE status = 'running' AND claimed_at <= ?`,
      )
      .run(now, now, staleBefore);
    const finishAttempt = this.db.prepare(
      `UPDATE launch_plan_item_attempts SET status = 'unknown',
       error_message = '执行进程中断，无法确认 Provider 是否已完成创建；为避免重复投放，系统不会自动重试。',
       completed_at = ?, updated_at = ? WHERE attempt_id = ? AND status = 'running'`,
    );
    for (const row of interrupted) {
      if (row.attempt_id) finishAttempt.run(now, now, String(row.attempt_id));
    }
    this.db.exec("COMMIT");
    return Number(result.changes);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  private finishLaunchAttempt(
    itemRow: SqlRow,
    status: "succeeded" | "failed" | "unknown",
    errorMessage: string | null,
    completedAt: string,
  ): void {
    if (!itemRow.attempt_id) return;
    this.db.prepare(
      `UPDATE launch_plan_item_attempts
       SET status = ?, phase = ?, evidence_json = ?, error_message = ?, completed_at = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'running'`,
    ).run(
      status,
      String(itemRow.phase),
      String(itemRow.evidence_json),
      errorMessage?.slice(0, 2000) ?? null,
      completedAt,
      completedAt,
      String(itemRow.attempt_id),
    );
  }

  refreshLaunchPlanResult(planId: string): MultiAccountLaunchPlanRecord {
    const plan = this.getMultiAccountLaunchPlan(planId);
    if (!plan) throw new Error("投放计划不存在。");
    const items = this.listLaunchPlanItems(planId);
    if (items.length === 0) return plan;
    const executionResults = plan.targetAccountIds.map((accountId) => {
      const accountItems = items.filter((item) => item.accountId === accountId);
      const failures = accountItems.filter((item) => item.status === "failed");
      const unknown = accountItems.filter((item) => item.status === "unknown");
      const failureMessage = failures.map((item) => item.errorMessage).filter(Boolean).join("；");
      const unknownMessage = unknown.map((item) => item.errorMessage).filter(Boolean).join("；");
      return {
        accountId,
        ok: accountItems.length > 0 && accountItems.every((item) => item.status === "succeeded"),
        message: [
          failureMessage ? `明确失败：${failureMessage}` : "",
          unknownMessage ? `创建结果待确认：${unknownMessage}` : "",
        ].filter(Boolean).join("；").slice(0, 2000) || null,
        createdCount: accountItems.filter((item) => item.status === "succeeded").length,
        failedCount: failures.length,
        unknownCount: unknown.length,
      };
    });
    const completed = items.every((item) => item.status === "succeeded");
    const failedCount = items.filter((item) => item.status === "failed").length;
    const unknownCount = items.filter((item) => item.status === "unknown").length;
    const message = completed
      ? `已完成 ${items.length} 条广告创建任务。`
      : `已完成 ${items.filter((item) => item.status === "succeeded").length}/${items.length} 条；明确失败 ${failedCount} 条，可单独重试；结果未知 ${unknownCount} 条，禁止重试，需人工核验。`;
    this.db
      .prepare(
        `UPDATE multi_account_launch_plans
         SET status = ?, message = ?, execution_results_json = ?, updated_at = ?
         WHERE id = ? AND status <> 'cancelled'`,
      )
      .run(completed ? "completed" : "blocked", message, JSON.stringify(executionResults), new Date().toISOString(), planId);
    return this.getMultiAccountLaunchPlan(planId) as MultiAccountLaunchPlanRecord;
  }

  updateMultiAccountLaunchPlanResult(
    planId: string,
    status: "blocked" | "completed",
    message: string,
    executionResults: MultiAccountLaunchPlanRecord["executionResults"],
  ): MultiAccountLaunchPlanRecord {
    const result = this.db
      .prepare(
        `UPDATE multi_account_launch_plans
         SET status = ?, message = ?, execution_results_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('draft', 'blocked')`,
      )
      .run(status, message.slice(0, 2000), JSON.stringify(executionResults), new Date().toISOString(), planId);
    if (result.changes === 0) throw new Error("投放计划不存在、已取消或已完成。");
    return this.getMultiAccountLaunchPlan(planId) as MultiAccountLaunchPlanRecord;
  }

  listLaunchPresets(): LaunchPresetRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM launch_presets ORDER BY updated_at DESC, name")
      .all() as SqlRow[];
    return rows.map(mapLaunchPreset);
  }

  createLaunchPreset(input: LaunchPresetInput): LaunchPresetRecord {
    const preset = LaunchPresetInputSchema.parse(input);
    if (preset.startAt && preset.endAt && preset.endAt <= preset.startAt) {
      throw new Error("结束时间必须晚于创建时间。");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO launch_presets (
          id, name, region, daily_budget, bid, start_at, end_at, initial_status, creation_config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, preset.name, preset.region, preset.dailyBudget, preset.bid, preset.startAt, preset.endAt, preset.initialStatus, JSON.stringify(preset.creationConfig), now, now);
    return this.listLaunchPresets().find((item) => item.id === id) as LaunchPresetRecord;
  }

  updateLaunchPreset(id: string, input: LaunchPresetInput): LaunchPresetRecord {
    const preset = LaunchPresetInputSchema.parse(input);
    if (preset.startAt && preset.endAt && preset.endAt <= preset.startAt) {
      throw new Error("结束时间必须晚于创建时间。");
    }
    const result = this.db
      .prepare(
        `UPDATE launch_presets SET
          name = ?, region = ?, daily_budget = ?, bid = ?, start_at = ?, end_at = ?, initial_status = ?, creation_config_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(preset.name, preset.region, preset.dailyBudget, preset.bid, preset.startAt, preset.endAt, preset.initialStatus, JSON.stringify(preset.creationConfig), new Date().toISOString(), id);
    if (result.changes === 0) throw new Error("广告预设不存在。");
    return this.listLaunchPresets().find((item) => item.id === id) as LaunchPresetRecord;
  }

  deleteLaunchPreset(id: string): boolean {
    const result = this.db.prepare("DELETE FROM launch_presets WHERE id = ?").run(id);
    return result.changes > 0;
  }

  createLaunchCopyPreview(input: LaunchCopyPreviewInput): LaunchCopyPreviewRecord {
    const request = LaunchCopyPreviewInputSchema.parse(input);
    const targetAccountIds = [...new Set(request.targetAccountIds)];
    if (targetAccountIds.includes(request.sourceAccountId)) {
      throw new Error("复制迁移的目标账户必须不同于源账户。");
    }
    if (targetAccountIds.length * request.launchRows.length > 3) {
      throw new Error("复制迁移当前仅允许预览 1–3 个逐项任务，请减少目标账户或表格行数。");
    }
    const preset = this.listLaunchPresets().find((item) => item.id === request.launchPresetId);
    if (!preset) throw new Error("请选择有效的广告预设。");
    const presetSnapshot = {
      name: preset.name,
      region: preset.region,
      dailyBudget: preset.dailyBudget,
      bid: preset.bid,
      startAt: preset.startAt,
      endAt: preset.endAt,
      initialStatus: preset.initialStatus,
      creationConfig: preset.creationConfig,
    };
    const sourceSnapshot = this.resolveLaunchSourceSnapshot(
      request.sourceAccountId,
      request.sourceAdId,
    );
    const now = new Date();
    const launchRows = applyPresetToLaunchRows(
      request.launchRows,
      preset,
      this.listMultiAccountLaunchPlans(10_000),
      now,
    );
    const blockers: string[] = [];
    const warnings: string[] = [];
    const sourceAccount = this.getAccount(request.sourceAccountId);
    const sourceSync = sourceAccount
      ? this.getLatestReadOnlySync(request.sourceAccountId, sourceAccount.providerKind)
      : null;
    if (!sourceSync || sourceSync.quality.status !== "healthy") {
      blockers.push(`源账户同步数据不是 healthy（当前：${sourceSync?.quality.status ?? "none"}）。`);
    }
    const items: LaunchCopyPreviewRecord["items"] = [];
    for (const accountId of targetAccountIds) {
      const account = this.getAccount(accountId);
      if (!account) {
        blockers.push(`目标账户 ${accountId} 不存在。`);
        continue;
      }
      const connection = this.getProviderConnection(accountId, account.providerKind);
      if (!connection || connection.status !== "ready") {
        blockers.push(`目标账户“${account.displayName}”未通过连接检测。`);
      }
      const sync = this.getLatestReadOnlySync(accountId, account.providerKind);
      if (!sync || sync.quality.status !== "healthy") {
        blockers.push(`目标账户“${account.displayName}”同步数据不是 healthy（当前：${sync?.quality.status ?? "none"}）。`);
      }
      launchRows.forEach((row, itemIndex) => {
        const targetAssetMapping = this.findVerifiedTargetAsset(
          accountId,
          account.providerKind,
          sourceSnapshot.videoCode,
          row.videoCode,
        );
        if (!targetAssetMapping) {
          blockers.push(
            `目标账户“${account.displayName}”的已同步广告中未找到视频代码 ${row.videoCode}；无法证明该账户素材库可用。`,
          );
          return;
        }
        items.push({
          accountId,
          itemIndex,
          sourceSnapshot,
          targetAssetMapping,
          differences: copyDifferences(sourceSnapshot, row),
        });
      });
    }
    if (launchRows.some((row) => row.initialStatus === "enabled")) {
      warnings.push("本次迁移包含创建后立即开启的广告；请在差异预览中再次核对预算和发布时间。");
    }
    const createdAt = now.toISOString();
    const preview = LaunchCopyPreviewRecordSchema.parse({
      id: randomUUID(),
      sourceAccountId: request.sourceAccountId,
      sourceAdId: request.sourceAdId,
      targetAccountIds,
      launchPresetId: request.launchPresetId,
      presetSnapshot,
      presetSnapshotHash: jsonHash(presetSnapshot),
      inputHash: copyPreviewInputHash({ ...request, targetAccountIds }),
      launchRowsHash: jsonHash(launchRows),
      launchRows,
      sourceSnapshot,
      items,
      blockers: [...new Set(blockers)],
      warnings,
      safeToCreate: blockers.length === 0 && items.length === targetAccountIds.length * launchRows.length,
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      createdAt,
    });
    this.db.prepare(
      `INSERT INTO launch_copy_previews (
        id, source_account_id, source_ad_id, input_hash, preview_json,
        safe_to_create, expires_at, consumed_plan_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      preview.id,
      preview.sourceAccountId,
      preview.sourceAdId,
      preview.inputHash,
      JSON.stringify(preview),
      toSqlBoolean(preview.safeToCreate),
      preview.expiresAt,
      preview.createdAt,
    );
    this.writeAudit("local-user", request.sourceAccountId, "launch-copy.previewed", {
      previewId: preview.id,
      targetAccountIds,
      itemCount: preview.items.length,
      safeToCreate: preview.safeToCreate,
      blockerCount: preview.blockers.length,
    });
    return preview;
  }

  getLaunchCopyPreview(previewId: string): LaunchCopyPreviewRecord | null {
    const row = this.db.prepare(
      "SELECT preview_json FROM launch_copy_previews WHERE id = ?",
    ).get(previewId) as SqlRow | undefined;
    if (!row) return null;
    let rawPreview: unknown;
    try {
      rawPreview = JSON.parse(String(row.preview_json));
    } catch {
      return null;
    }
    const parsed = LaunchCopyPreviewRecordSchema.safeParse(rawPreview);
    // Pre-snapshot previews from an older build are intentionally invalidated.
    // Reconstructing them from the current preset would silently change what
    // the user reviewed.
    return parsed.success ? parsed.data : null;
  }

  validateLaunchCopyItem(item: LaunchPlanItemRecord): void {
    if (!item.sourceSnapshot && !item.targetAssetMapping) return;
    if (!item.sourceSnapshot || !item.targetAssetMapping) {
      throw new Error("复制迁移任务缺少冻结的源快照或目标素材映射。");
    }
    const currentSource = this.resolveLaunchSourceSnapshot(
      item.sourceSnapshot.accountId,
      item.sourceSnapshot.adId,
    );
    if (currentSource.structuralHash !== item.sourceSnapshot.structuralHash) {
      throw new Error("源广告结构在预览后已变化，请重新生成差异预览。");
    }
    const targetAccount = this.getAccount(item.accountId);
    if (!targetAccount) throw new Error("目标广告账户不存在。");
    const evidence = this.findVerifiedTargetAsset(
      item.accountId,
      targetAccount.providerKind,
      item.targetAssetMapping.sourceVideoCode,
      item.targetAssetMapping.targetVideoCode,
      item.targetAssetMapping.evidenceAdId,
    );
    if (!evidence) {
      throw new Error("目标账户素材证据在预览后已失效，请重新同步并生成差异预览。");
    }
  }

  private resolveLaunchSourceSnapshot(accountId: string, adId: string): LaunchSourceSnapshot {
    const account = this.getAccount(accountId);
    if (!account) throw new Error("源广告账户不存在。");
    const managed = this.listManagedEntities(accountId, account.providerKind);
    const ad = managed.find((entity) => entity.entityType === "ad" && entity.externalId === adId);
    if (!ad) throw new Error("源广告不存在，请先同步源账户数据。");
    if (!ad.parentCampaignId || !ad.parentAdGroupId) {
      throw new Error("源广告缺少稳定的 Campaign ID 或 Ad Group ID，禁止按名称定位。");
    }
    const campaign = managed.find(
      (entity) => entity.entityType === "campaign" && entity.externalId === ad.parentCampaignId,
    );
    const adGroup = managed.find(
      (entity) => entity.entityType === "ad-group" && entity.externalId === ad.parentAdGroupId,
    );
    if (!campaign || !adGroup) {
      throw new Error("源广告的系列或广告组稳定 ID 未出现在当前同步快照中，禁止按名称回退。");
    }
    const rawAd = this.listProviderEntities(accountId, account.providerKind).find(
      (entity) => entity.entityType === "ad" && entity.externalId === adId,
    );
    const videoCode = rawAd ? firstNestedString(rawAd.payload, launchVideoCodeKeys) : null;
    if (!videoCode) throw new Error("源广告快照中没有可验证的视频代码。");
    const productUrl = rawAd ? firstNestedString(rawAd.payload, launchProductUrlKeys) : null;
    const structural = {
      accountId,
      campaignId: campaign.externalId,
      campaignName: campaign.name,
      adGroupId: adGroup.externalId,
      adGroupName: adGroup.name,
      adId: ad.externalId,
      adName: ad.name,
      videoCode,
      productUrl: productUrl && isHttpUrl(productUrl) ? productUrl : null,
    };
    return {
      ...structural,
      structuralHash: jsonHash(structural),
      syncedAt: ad.syncedAt,
    };
  }

  private findVerifiedTargetAsset(
    accountId: string,
    kind: ProviderKind,
    sourceVideoCode: string,
    targetVideoCode: string,
    requiredEvidenceAdId?: string,
  ): LaunchTargetAssetMapping | null {
    const evidence = this.listProviderEntities(accountId, kind).find(
      (entity) => entity.entityType === "ad"
        && (!requiredEvidenceAdId || entity.externalId === requiredEvidenceAdId)
        && nestedValueMatches(entity.payload, launchVideoCodeKeys, targetVideoCode),
    );
    if (!evidence) return null;
    const syncedAt = this.listManagedEntities(accountId, kind).find(
      (entity) => entity.entityType === "ad" && entity.externalId === evidence.externalId,
    )?.syncedAt;
    if (!syncedAt) return null;
    return {
      accountId,
      sourceVideoCode,
      targetVideoCode,
      evidenceAdId: evidence.externalId,
      evidenceSyncedAt: syncedAt,
    };
  }

  createMultiAccountLaunchPlan(
    input: MultiAccountLaunchPlanInput,
    actor: WriteTaskActor = { id: "local-user", name: "本地用户", kind: "user" },
  ): MultiAccountLaunchPlanRecord {
    const plan = MultiAccountLaunchPlanInputSchema.parse(input);
    const preset = this.listLaunchPresets().find((item) => item.id === plan.launchPresetId);
    if (!preset) throw new Error("请选择有效的广告预设。");
    const sourceAccount = this.getAccount(plan.sourceAccountId);
    if (!sourceAccount) throw new Error("源广告账户不存在。");
    const preview = plan.mode === "copy"
      ? plan.copyPreviewId ? this.getLaunchCopyPreview(plan.copyPreviewId) : null
      : null;
    if (plan.mode === "copy" && !preview) {
      throw new Error("复制迁移必须先生成有效的差异预览。");
    }
    if (preview) {
      if (jsonHash(preview.presetSnapshot) !== preview.presetSnapshotHash) {
        throw new Error("差异预览的预设快照校验失败，请重新生成预览。");
      }
      if (!preview.safeToCreate || preview.blockers.length > 0) {
        throw new Error("差异预览仍有阻断项，不能创建复制迁移计划。");
      }
      const normalizedTargets = [...new Set(plan.targetAccountIds)];
      const inputHash = copyPreviewInputHash({
        sourceAccountId: plan.sourceAccountId,
        sourceAdId: plan.sourceAdId ?? "",
        targetAccountIds: normalizedTargets,
        launchPresetId: plan.launchPresetId,
        launchRows: plan.launchRows,
      });
      if (inputHash !== preview.inputHash) {
        throw new Error("源广告、目标账户、预设或表格内容在预览后已变化，请重新生成预览。");
      }
      const existing = this.db.prepare(
        "SELECT id FROM multi_account_launch_plans WHERE copy_preview_id = ?",
      ).get(preview.id) as SqlRow | undefined;
      if (existing) {
        return this.getMultiAccountLaunchPlan(String(existing.id)) as MultiAccountLaunchPlanRecord;
      }
      if (new Date(preview.expiresAt).getTime() <= Date.now()) {
        throw new Error("差异预览已过期，请重新同步并生成预览。");
      }
    }
    const targetAccountIds = preview
      ? preview.targetAccountIds
      : [...new Set(plan.targetAccountIds)];
    if (targetAccountIds.length === 0) {
      throw new Error("至少选择一个目标账户。");
    }
    for (const accountId of targetAccountIds) {
      if (!this.getAccount(accountId)) throw new Error("目标广告账户不存在。");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const presetSnapshot = preview?.presetSnapshot ?? {
      name: preset.name,
      region: preset.region,
      dailyBudget: preset.dailyBudget,
      bid: preset.bid,
      startAt: preset.startAt,
      endAt: preset.endAt,
      initialStatus: preset.initialStatus,
      creationConfig: preset.creationConfig,
    };
    const launchRows = preview
      ? preview.launchRows
      : applyPresetToLaunchRows(
        plan.launchRows,
        preset,
        this.listMultiAccountLaunchPlans(10_000),
        new Date(now),
      );
    const taskCount = targetAccountIds.length * launchRows.length;
    const message =
      `已保存 ${taskCount} 条${plan.mode === "copy" ? "复制迁移" : "创建"}配置；等待创建执行器发布。`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO multi_account_launch_plans (
            id, copy_preview_id, source_account_id, source_ad_id, source_ad_name,
            target_account_ids_json, naming_template, start_paused, launch_mode, launch_preset_id, preset_name, preset_snapshot_json,
            launch_rows_json, status, message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?)`,
        )
        .run(
          id,
          preview?.id ?? null,
          plan.sourceAccountId,
          plan.sourceAdId ?? "__new__",
          preview?.sourceSnapshot.adName ?? "从零创建",
          JSON.stringify(targetAccountIds),
          "YYMMDD:XXX",
          toSqlBoolean(launchRows.every((row) => row.initialStatus === "disabled")),
          plan.mode,
          plan.launchPresetId,
          presetSnapshot.name,
          JSON.stringify(presetSnapshot),
          JSON.stringify(launchRows),
          message,
          now,
          now,
        );
      const insertItem = this.db.prepare(
        `INSERT INTO launch_plan_items (
          item_id, plan_id, account_id, item_index, launch_row_json,
          template_mode, template_campaign_id, source_snapshot_json,
          target_asset_mapping_json, idempotency_key, status,
          phase, operation_id, attempt_id, correlation_id, evidence_json,
          actor_id, actor_name, actor_kind,
          campaign_id, adgroup_id, ad_id, error_message, sync_warning, attempt_count,
          claimed_by, claimed_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'validation', ?, NULL, ?, '{}', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?)`,
      );
      // Cross-account migration recreates the frozen structure inside the
      // target account. A source-account Campaign ID must never be sent to the
      // target account's campaign_snap/copy endpoint.
      const templateMode = "none";
      for (const accountId of targetAccountIds) {
        launchRows.forEach((row, itemIndex) => {
          const itemId = randomUUID();
          const operationId = randomUUID();
          const correlationId = `${id}:${accountId}:${itemIndex}`;
          const targetAssetMapping = preview?.items.find(
            (item) => item.accountId === accountId && item.itemIndex === itemIndex,
          )?.targetAssetMapping ?? null;
          if (preview && !targetAssetMapping) {
            throw new Error("复制迁移预览缺少目标账户素材映射。");
          }
          const idempotencyKey = jsonHash({
            kind: plan.mode,
            planSeed: preview?.id ?? id,
            accountId,
            itemIndex,
          });
          insertItem.run(
            itemId,
            id,
            accountId,
            itemIndex,
            JSON.stringify(row),
            templateMode,
            null,
            preview ? JSON.stringify(preview.sourceSnapshot) : null,
            targetAssetMapping ? JSON.stringify(targetAssetMapping) : null,
            idempotencyKey,
            operationId,
            correlationId,
            actor.id,
            actor.name,
            actor.kind,
            now,
            now,
          );
          this.writeAudit(actor.name, accountId, "write-task.created", {
            taskType: "launch",
            taskId: itemId,
            planId: id,
            operationId,
            correlationId,
            itemIndex,
          });
        });
      }
      if (preview) {
        const consumed = this.db.prepare(
          `UPDATE launch_copy_previews SET consumed_plan_id = ?
           WHERE id = ? AND consumed_plan_id IS NULL`,
        ).run(id, preview.id);
        if (consumed.changes !== 1) {
          throw new Error("差异预览已被其他计划使用，请刷新计划列表。");
        }
      }
      this.writeAudit(actor.name, plan.sourceAccountId, "launch-plan.created", {
        id,
        targetAccountIds,
        launchPresetId: plan.launchPresetId,
        copyPreviewId: preview?.id ?? null,
        taskCount,
      });
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    return this.listMultiAccountLaunchPlans().find(
      (item) => item.id === id,
    ) as MultiAccountLaunchPlanRecord;
  }

  cancelMultiAccountLaunchPlan(planId: string): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = this.db
        .prepare("SELECT 1 FROM launch_plan_items WHERE plan_id = ? AND status = 'running' LIMIT 1")
        .get(planId);
      if (running) throw new Error("计划仍有正在创建的任务，当前不能取消。");
      const result = this.db
        .prepare(
        `UPDATE multi_account_launch_plans
         SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status IN ('draft', 'blocked')`,
        )
        .run(now, planId);
      if (result.changes > 0) {
        this.db
          .prepare(
            `UPDATE launch_plan_items SET status = 'cancelled', updated_at = ?
             WHERE plan_id = ? AND status IN ('pending', 'failed')`,
          )
          .run(now, planId);
      }
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
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
                AND captured_at <= ? AND entity_type = ? AND sync_quality_status = 'healthy'
             ORDER BY captured_at DESC LIMIT ?`,
           )
          .all(accountId, kind, since, until, entityType, limit) as SqlRow[])
      : (this.db
          .prepare(
            `SELECT * FROM entity_metric_snapshots
             WHERE account_id = ? AND provider_kind = ? AND captured_at >= ?
                AND captured_at <= ? AND sync_quality_status = 'healthy'
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
              AND captured_at <= ? AND entity_type = ? AND sync_quality_status = 'healthy'
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
              AND captured_at <= ? AND sync_quality_status = 'healthy'
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = this.db.prepare(
        `SELECT 1 FROM scheduled_entity_actions
         WHERE account_id = ? AND entity_type = 'ad-group'
           AND external_id = ? AND schedule_type = 'overnight'
           AND status = 'scheduled' AND claimed_by IS NOT NULL LIMIT 1`,
      ).get(accountId, externalId);
      if (running) throw new Error("已有过夜定时任务正在执行，当前不能替换。");
      this.db.prepare(
        `UPDATE scheduled_entity_actions
         SET status = 'cancelled', updated_at = ?
         WHERE account_id = ? AND entity_type = 'ad-group'
           AND external_id = ? AND schedule_type = 'overnight'
           AND status = 'scheduled' AND claimed_by IS NULL`,
      ).run(new Date().toISOString(), accountId, externalId);
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
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
    suggestion: {
      ruleVersion: string;
      rulePredicate: Record<string, unknown>;
      dataQualityStatus: ReadOnlySyncResult["quality"]["status"];
      dataQualityWarnings: string[];
    } = {
      ruleVersion: "legacy-unknown",
      rulePredicate: {},
      dataQualityStatus: "invalid",
      dataQualityWarnings: ["legacy decision without suggestion metadata"],
    },
  ): AutomationDecisionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const metricSnapshotJson = JSON.stringify(candidate.entity.metrics);
    const rulePredicateJson = JSON.stringify(suggestion.rulePredicate);
    const qualityWarningsJson = JSON.stringify(suggestion.dataQualityWarnings);
    const suggestionKey = createHash("sha256")
      .update(JSON.stringify({
        accountId: run.accountId,
        rulePredicate: suggestion.rulePredicate,
        thresholdCode: candidate.thresholdCode,
        entityType: candidate.entity.entityType,
        externalId: candidate.entity.externalId,
        action: candidate.action,
        metric: candidate.metric,
        operator: candidate.operator,
        thresholdValue: candidate.thresholdValue,
        metricSnapshot: candidate.entity.metrics,
        dataQualityStatus: suggestion.dataQualityStatus,
      }))
      .digest("hex");
    this.db
      .prepare(
        `INSERT INTO automation_decisions (
          id, run_id, account_id, provider_kind, threshold_id, threshold_code,
          entity_type, external_id, entity_name, action, metric, metric_value,
          operator, threshold_value, reason, suggestion_key, rule_version, rule_predicate_json,
          metric_snapshot_json, data_quality_status, data_quality_warnings_json,
          status, error_message, created_at, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
        suggestionKey,
        suggestion.ruleVersion,
        rulePredicateJson,
        metricSnapshotJson,
        suggestion.dataQualityStatus,
        qualityWarningsJson,
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
    const executedAt = ["succeeded", "failed", "unknown", "skipped"].includes(status)
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

  getOrCreateAutomationApproval(
    decisionId: string,
    actor: WriteTaskActor,
  ): AutomationApprovalRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const decision = this.db.prepare(
        "SELECT * FROM automation_decisions WHERE id = ?",
      ).get(decisionId) as SqlRow | undefined;
      if (!decision) throw new Error("自动化建议不存在。");
      const existing = this.db.prepare(
        "SELECT * FROM automation_approvals WHERE decision_id = ?",
      ).get(decisionId) as SqlRow | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return mapAutomationApproval(existing);
      }
      if (decision.status !== "preview") {
        throw new Error("只有仍处于预览命中状态的建议可以批准执行。");
      }
      if (!String(decision.suggestion_key ?? "")) {
        throw new Error("旧版建议缺少稳定标识，不能批准执行。");
      }
      this.db.prepare(
        `INSERT OR IGNORE INTO automation_approvals (
          id, decision_id, run_id, account_id, provider_kind, suggestion_key,
          entity_type, external_id, entity_name, action, expected_status,
          before_status, after_status, status, actor_id, actor_name, actor_kind,
          status_operation_id, provider_message, error_message,
          claimed_by, claimed_at, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending',
                  ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
      ).run(
        randomUUID(),
        decisionId,
        String(decision.run_id),
        String(decision.account_id),
        String(decision.provider_kind),
        String(decision.suggestion_key),
        String(decision.entity_type),
        String(decision.external_id),
        String(decision.entity_name),
        String(decision.action),
        String(decision.action) === "enable" ? "disabled" : "enabled",
        actor.id,
        actor.name,
        actor.kind,
        now,
      );
      const row = this.db.prepare(
        "SELECT * FROM automation_approvals WHERE decision_id = ?",
      ).get(decisionId) as SqlRow;
      this.db.exec("COMMIT");
      return mapAutomationApproval(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  claimAutomationApproval(
    approvalId: string,
    executorId: string,
  ): AutomationApprovalRecord | null {
    const now = new Date().toISOString();
    const row = this.db.prepare(
      `UPDATE automation_approvals SET status = 'running', claimed_by = ?,
       claimed_at = ?, error_message = NULL
       WHERE id = ? AND status = 'pending' RETURNING *`,
    ).get(executorId, now, approvalId) as SqlRow | undefined;
    if (!row) return null;
    this.writeAudit(String(row.actor_name), String(row.account_id), "automation.approval-claimed", {
      approvalId,
      decisionId: row.decision_id,
      suggestionKey: row.suggestion_key,
      executorId,
    });
    return mapAutomationApproval(row);
  }

  updateAutomationApprovalPreflight(
    approvalId: string,
    executorId: string,
    beforeStatus: "enabled" | "disabled" | "unknown",
    statusOperationId: string | null = null,
  ): AutomationApprovalRecord {
    const row = this.db.prepare(
      `UPDATE automation_approvals SET before_status = ?,
       status_operation_id = COALESCE(?, status_operation_id)
       WHERE id = ? AND status = 'running' AND claimed_by = ? RETURNING *`,
    ).get(beforeStatus, statusOperationId, approvalId, executorId) as SqlRow | undefined;
    if (!row) throw new Error("审批记录未被当前执行器领取。");
    return mapAutomationApproval(row);
  }

  completeAutomationApproval(
    approvalId: string,
    executorId: string,
    status: Exclude<AutomationApprovalStatus, "pending" | "running">,
    input: {
      afterStatus?: "enabled" | "disabled" | "unknown" | null;
      statusOperationId?: string | null;
      providerMessage?: string | null;
      errorMessage?: string | null;
    } = {},
  ): AutomationApprovalRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `UPDATE automation_approvals SET status = ?, after_status = ?,
         status_operation_id = COALESCE(?, status_operation_id), provider_message = ?,
         error_message = ?, completed_at = ?
         WHERE id = ? AND status = 'running' AND claimed_by = ? RETURNING *`,
      ).get(
        status,
        input.afterStatus ?? null,
        input.statusOperationId ?? null,
        input.providerMessage?.slice(0, 2000) ?? null,
        input.errorMessage?.slice(0, 2000) ?? null,
        now,
        approvalId,
        executorId,
      ) as SqlRow | undefined;
      if (!row) throw new Error("审批记录未被当前执行器领取。");
      this.db.prepare(
        `UPDATE automation_decisions SET status = ?, error_message = ?, executed_at = ?
         WHERE id = ?`,
      ).run(
        status,
        input.errorMessage?.slice(0, 2000) ?? null,
        now,
        String(row.decision_id),
      );
      this.writeAudit(String(row.actor_name), String(row.account_id), `automation.approval-${status}`, {
        approvalId,
        decisionId: row.decision_id,
        suggestionKey: row.suggestion_key,
        statusOperationId: row.status_operation_id,
        providerMessage: row.provider_message,
        errorMessage: row.error_message,
      });
      this.db.exec("COMMIT");
      return mapAutomationApproval(row);
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  getAutomationApprovalByDecision(decisionId: string): AutomationApprovalRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM automation_approvals WHERE decision_id = ?",
    ).get(decisionId) as SqlRow | undefined;
    return row ? mapAutomationApproval(row) : null;
  }

  listAutomationApprovals(accountId: string, limit = 100): AutomationApprovalRecord[] {
    return (this.db.prepare(
      `SELECT * FROM automation_approvals WHERE account_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(accountId, limit) as SqlRow[]).map(mapAutomationApproval);
  }

  countAutomationApprovals(
    runId: string,
    statuses: AutomationApprovalStatus[],
  ): number {
    if (statuses.length === 0) return 0;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM automation_approvals
       WHERE run_id = ? AND status IN (${statuses.map(() => "?").join(", ")})`,
    ).get(runId, ...statuses) as SqlRow;
    return Number(row.count);
  }

  recoverInterruptedAutomationApprovals(staleBefore: string): number {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(
        `SELECT id, decision_id, account_id, actor_name, suggestion_key
         FROM automation_approvals
         WHERE status = 'running' AND claimed_at <= ?`,
      ).all(staleBefore) as SqlRow[];
      const message = "审批执行进程中断，结果无法确认；禁止重复批准。";
      const updateApproval = this.db.prepare(
        `UPDATE automation_approvals SET status = 'unknown', error_message = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      );
      const updateDecision = this.db.prepare(
        `UPDATE automation_decisions SET status = 'unknown', error_message = ?, executed_at = ?
         WHERE id = ?`,
      );
      for (const row of rows) {
        updateApproval.run(message, now, String(row.id));
        updateDecision.run(message, now, String(row.decision_id));
        this.writeAudit(String(row.actor_name), String(row.account_id), "automation.approval-unknown", {
          approvalId: row.id,
          decisionId: row.decision_id,
          suggestionKey: row.suggestion_key,
          reason: "interrupted",
        });
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
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

  hasUnknownDecision(
    accountId: string,
    entityType: ProviderEntity["entityType"],
    externalId: string,
    action: AutomationAction,
  ): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM automation_decisions
       WHERE account_id = ? AND entity_type = ? AND external_id = ?
         AND action = ? AND status = 'unknown' LIMIT 1`,
    ).get(accountId, entityType, externalId, action);
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
    const context = this.auditContext.getStore();
    const fallbackActor: WriteTaskActor = actor === "system"
      ? { id: "system", name: "系统", kind: "system" }
      : {
        id: actor === "local-user" ? "legacy-local-user" : actor,
        name: actor === "local-user" ? "本地用户" : actor,
        kind: "user",
      };
    const resolvedActor = context?.actor ?? fallbackActor;
    const payloadCorrelationId = payload && typeof payload === "object"
      && "correlationId" in payload
      && typeof (payload as { correlationId?: unknown }).correlationId === "string"
      ? (payload as { correlationId: string }).correlationId
      : null;
    const correlationId = payloadCorrelationId
      ?? context?.correlationId
      ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO audit_logs (
          id, actor, actor_id, actor_name, actor_kind, account_id, action,
          payload_json, correlation_id, request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        resolvedActor.name,
        resolvedActor.id,
        resolvedActor.name,
        resolvedActor.kind,
        accountId,
        action,
        JSON.stringify(payload),
        correlationId,
        context?.requestId ?? null,
        new Date().toISOString(),
      );
  }

  private writeSystemAudit(action: string, payload: unknown): void {
    this.writeAudit("system", "global", action, payload);
  }

  private readSchemaVersion(): string {
    try {
      const table = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ).get();
      if (!table) return "legacy-unversioned";
      const keys = (this.db.prepare(
        "SELECT migration_key FROM schema_migrations ORDER BY migration_key",
      ).all() as SqlRow[]).map((row) => String(row.migration_key));
      if (keys.length === 0) return "schema-0";
      return `schema-${keys.length}-${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 12)}`;
    } catch {
      return "schema-unreadable";
    }
  }

  private recordDatabaseBackup(
    kind: DatabaseBackupKind,
    filePath: string,
    schemaVersion: string,
    inspection: ReturnType<typeof inspectDatabaseBackup>,
    createdAtOverride?: string,
  ): DatabaseBackupRecord {
    const id = randomUUID();
    const createdAt = createdAtOverride ?? new Date().toISOString();
    this.db.prepare(
      `INSERT INTO database_backups (
        id, kind, file_path, file_name, size_bytes, sha256, app_version,
        schema_version, status, error_message, created_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      kind,
      filePath,
      basename(filePath),
      inspection.sizeBytes,
      inspection.sha256,
      this.appVersion,
      schemaVersion,
      inspection.valid ? "verified" : "invalid",
      inspection.errorMessage,
      createdAt,
      inspection.valid ? createdAt : null,
    );
    return this.listDatabaseBackups().find((backup) => backup.id === id)!;
  }

  private getDatabaseBackupRow(backupId: string): SqlRow | null {
    return (this.db.prepare(
      "SELECT * FROM database_backups WHERE id = ?",
    ).get(backupId) as SqlRow | undefined) ?? null;
  }

  private pruneDatabaseBackups(): void {
    const rows = this.db.prepare(
      "SELECT id, file_path FROM database_backups ORDER BY created_at DESC, id DESC",
    ).all() as SqlRow[];
    for (const row of rows.slice(5)) {
      rmSync(String(row.file_path), { force: true });
      this.db.prepare("DELETE FROM database_backups WHERE id = ?").run(String(row.id));
    }
    if (this.databasePath === ":memory:") return;
    const backupPrefix = `${basename(this.databasePath)}.`;
    const backupFiles = readdirSync(dirname(this.databasePath))
      .filter((name) => name.startsWith(backupPrefix) && name.endsWith(".bak"))
      .map((name) => join(dirname(this.databasePath), name))
      .sort((left, right) => {
        const timeDifference = statSync(right).mtimeMs - statSync(left).mtimeMs;
        return timeDifference !== 0 ? timeDifference : right.localeCompare(left);
      });
    for (const stalePath of backupFiles.slice(5)) {
      rmSync(stalePath, { force: true });
      this.db.prepare("DELETE FROM database_backups WHERE file_path = ?").run(stalePath);
    }
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

      CREATE TABLE IF NOT EXISTS account_low_risk_automation_policies (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        policy_version TEXT NOT NULL,
        daily_action_limit INTEGER NOT NULL CHECK (daily_action_limit BETWEEN 1 AND 100),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automatic_action_claims (
        action_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS automatic_action_claims_account_date
      ON automatic_action_claims (account_id, local_date, created_at);

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
        actor_id TEXT NOT NULL DEFAULT 'legacy-local-user',
        actor_name TEXT NOT NULL DEFAULT '本地用户',
        actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'system')),
        account_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        correlation_id TEXT NOT NULL DEFAULT '',
        request_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS database_backups (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('pre-migration', 'manual', 'pre-upgrade', 'restore-rollback')),
        file_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        app_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('verified', 'invalid')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        verified_at TEXT
      );

      CREATE TABLE IF NOT EXISTS provider_connections (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cookie', 'official-api')),
        settings_json TEXT NOT NULL,
        credential_ref TEXT,
        status TEXT NOT NULL CHECK (status IN ('not-configured', 'untested', 'ready', 'failed')),
        authorization_status TEXT NOT NULL DEFAULT 'not-authorized'
          CHECK (authorization_status IN ('not-authorized', 'active', 'expired', 'revoked', 'failed')),
        capability_version TEXT NOT NULL DEFAULT 'legacy-unversioned',
        authorized_capabilities_json TEXT NOT NULL DEFAULT '[]',
        authorized_at TEXT,
        authorization_expires_at TEXT,
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
        phase TEXT NOT NULL DEFAULT 'validation',
        operation_id TEXT NOT NULL DEFAULT '',
        attempt_id TEXT,
        correlation_id TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        actor_id TEXT NOT NULL DEFAULT 'legacy-local-user',
        actor_name TEXT NOT NULL DEFAULT '本地用户',
        actor_kind TEXT NOT NULL DEFAULT 'user',
        claimed_by TEXT,
        claimed_at TEXT,
        message TEXT,
        sync_warning TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ad_operation_attempts (
        attempt_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        actor_id TEXT NOT NULL DEFAULT 'legacy-local-user',
        actor_name TEXT NOT NULL DEFAULT '本地用户',
        actor_kind TEXT NOT NULL DEFAULT 'user',
        phase TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (operation_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS status_operation_verifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES ad_operations(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
        decision TEXT NOT NULL CHECK (decision IN ('confirmed-succeeded', 'confirmed-failed')),
        observed_status TEXT NOT NULL CHECK (observed_status IN ('enabled', 'disabled')),
        evidence TEXT NOT NULL,
        note TEXT NOT NULL,
        previous_status TEXT NOT NULL CHECK (previous_status = 'unknown'),
        next_status TEXT NOT NULL CHECK (next_status IN ('succeeded', 'failed')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS status_operation_verifications_task
      ON status_operation_verifications (task_id, created_at);

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
        claimed_by TEXT,
        claimed_at TEXT,
        last_operation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scheduled_entity_actions_due
      ON scheduled_entity_actions (account_id, status, next_run_at);

      CREATE TABLE IF NOT EXISTS launch_copy_previews (
        id TEXT PRIMARY KEY,
        source_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source_ad_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        safe_to_create INTEGER NOT NULL CHECK (safe_to_create IN (0, 1)),
        expires_at TEXT NOT NULL,
        consumed_plan_id TEXT UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS launch_copy_previews_expiry
      ON launch_copy_previews (expires_at, safe_to_create);

      CREATE TABLE IF NOT EXISTS multi_account_launch_plans (
        id TEXT PRIMARY KEY,
        copy_preview_id TEXT UNIQUE,
        source_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source_ad_id TEXT NOT NULL,
        source_ad_name TEXT NOT NULL,
        target_account_ids_json TEXT NOT NULL,
        naming_template TEXT NOT NULL,
        start_paused INTEGER NOT NULL CHECK (start_paused IN (0, 1)),
        launch_mode TEXT NOT NULL DEFAULT 'copy',
        preset_snapshot_json TEXT,
        creation_config_json TEXT NOT NULL DEFAULT '{}',
        launch_rows_json TEXT NOT NULL DEFAULT '[]',
        execution_results_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('draft', 'blocked', 'cancelled', 'completed')),
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- A plan is not executable until an operator explicitly queues it. The
      -- durable dispatch record lets a restarted API process resume pending
      -- items without treating every historical draft as safe to run.
      CREATE TABLE IF NOT EXISTS launch_plan_dispatches (
        plan_id TEXT PRIMARY KEY REFERENCES multi_account_launch_plans(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_write_circuits (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
        last_error TEXT,
        opened_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_kind)
      );

      CREATE TABLE IF NOT EXISTS launch_plan_items (
        item_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES multi_account_launch_plans(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        item_index INTEGER NOT NULL CHECK (item_index >= 0),
        launch_row_json TEXT NOT NULL,
        template_mode TEXT NOT NULL CHECK (template_mode IN ('none', 'copy')),
        template_campaign_id TEXT,
        source_snapshot_json TEXT,
        target_asset_mapping_json TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'unknown', 'cancelled')),
        phase TEXT NOT NULL DEFAULT 'validation' CHECK (phase IN ('validation', 'campaign_draft', 'adgroup_draft', 'creative_draft', 'publishing', 'readback', 'sync')),
        operation_id TEXT NOT NULL DEFAULT '',
        attempt_id TEXT,
        correlation_id TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        actor_id TEXT NOT NULL DEFAULT 'legacy-local-user',
        actor_name TEXT NOT NULL DEFAULT '本地用户',
        actor_kind TEXT NOT NULL DEFAULT 'user',
        campaign_id TEXT,
        adgroup_id TEXT,
        ad_id TEXT,
        error_message TEXT,
        sync_warning TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (plan_id, account_id, item_index)
      );

      CREATE TABLE IF NOT EXISTS launch_plan_item_attempts (
        attempt_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES launch_plan_items(item_id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        actor_id TEXT NOT NULL DEFAULT 'legacy-local-user',
        actor_name TEXT NOT NULL DEFAULT '本地用户',
        actor_kind TEXT NOT NULL DEFAULT 'user',
        phase TEXT NOT NULL CHECK (phase IN ('validation', 'campaign_draft', 'adgroup_draft', 'creative_draft', 'publishing', 'readback', 'sync')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS launch_plan_item_attempts_item
      ON launch_plan_item_attempts (item_id, attempt_number);

      CREATE TABLE IF NOT EXISTS launch_plan_item_verifications (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES launch_plan_items(item_id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('confirmed-succeeded', 'confirmed-not-created')),
        evidence TEXT NOT NULL,
        note TEXT NOT NULL,
        campaign_id TEXT,
        adgroup_id TEXT,
        ad_id TEXT,
        previous_status TEXT NOT NULL CHECK (previous_status = 'unknown'),
        next_status TEXT NOT NULL CHECK (next_status IN ('succeeded', 'failed')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS launch_plan_items_claim
      ON launch_plan_items (plan_id, status, account_id, item_index);

      CREATE TABLE IF NOT EXISTS launch_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT '未设置',
        daily_budget REAL NOT NULL,
        bid REAL,
        start_at TEXT,
        end_at TEXT,
        initial_status TEXT NOT NULL CHECK (initial_status IN ('enabled', 'disabled')),
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
        captured_at TEXT NOT NULL,
        sync_quality_status TEXT NOT NULL DEFAULT 'invalid'
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
        warnings_json TEXT NOT NULL,
        quality_json TEXT NOT NULL DEFAULT '{}'
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
        suggestion_key TEXT NOT NULL DEFAULT '',
        rule_version TEXT NOT NULL DEFAULT 'legacy-unknown',
        rule_predicate_json TEXT NOT NULL DEFAULT '{}',
        metric_snapshot_json TEXT NOT NULL DEFAULT '{}',
        data_quality_status TEXT NOT NULL DEFAULT 'invalid',
        data_quality_warnings_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        executed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS automation_decisions_lookup
      ON automation_decisions (
        account_id, entity_type, external_id, action, status, executed_at
      );

      CREATE TABLE IF NOT EXISTS automation_approvals (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE REFERENCES automation_decisions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL,
        suggestion_key TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('enable', 'disable')),
        expected_status TEXT NOT NULL CHECK (expected_status IN ('enabled', 'disabled')),
        before_status TEXT CHECK (before_status IN ('enabled', 'disabled', 'unknown')),
        after_status TEXT CHECK (after_status IN ('enabled', 'disabled', 'unknown')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'unknown')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
        status_operation_id TEXT,
        provider_message TEXT,
        error_message TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS automation_approvals_run_status
      ON automation_approvals (run_id, status, created_at);

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
      "provider_connections",
      "authorization_status",
      "TEXT NOT NULL DEFAULT 'not-authorized'",
    );
    this.ensureColumn(
      "provider_connections",
      "capability_version",
      "TEXT NOT NULL DEFAULT 'legacy-unversioned'",
    );
    this.ensureColumn(
      "provider_connections",
      "authorized_capabilities_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    this.ensureColumn("provider_connections", "authorized_at", "TEXT");
    this.ensureColumn("provider_connections", "authorization_expires_at", "TEXT");
    this.ensureColumn(
      "audit_logs",
      "actor_id",
      "TEXT NOT NULL DEFAULT 'legacy-local-user'",
    );
    this.ensureColumn(
      "audit_logs",
      "actor_name",
      "TEXT NOT NULL DEFAULT '本地用户'",
    );
    this.ensureColumn(
      "audit_logs",
      "actor_kind",
      "TEXT NOT NULL DEFAULT 'user'",
    );
    this.ensureColumn(
      "audit_logs",
      "correlation_id",
      "TEXT NOT NULL DEFAULT ''",
    );
    this.ensureColumn(
      "audit_logs",
      "request_id",
      "TEXT",
    );
    this.db.exec(`
      UPDATE audit_logs
      SET actor_id = CASE WHEN actor = 'system' THEN 'system' ELSE 'legacy-local-user' END,
          actor_name = CASE WHEN actor = 'system' THEN '系统' ELSE actor END,
          actor_kind = CASE WHEN actor = 'system' THEN 'system' ELSE 'user' END
      WHERE request_id IS NULL
        AND correlation_id = ''
        AND actor_id = 'legacy-local-user';
      UPDATE audit_logs
      SET correlation_id = id
      WHERE correlation_id = '';
      CREATE INDEX IF NOT EXISTS audit_logs_query
      ON audit_logs (created_at DESC, account_id, actor_id, action);
    `);
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
    this.ensureColumn("sync_runs", "quality_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("automation_decisions", "suggestion_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("automation_decisions", "rule_version", "TEXT NOT NULL DEFAULT 'legacy-unknown'");
    this.ensureColumn("automation_decisions", "rule_predicate_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("automation_decisions", "metric_snapshot_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("automation_decisions", "data_quality_status", "TEXT NOT NULL DEFAULT 'invalid'");
    this.ensureColumn("automation_decisions", "data_quality_warnings_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("ad_operations", "phase", "TEXT NOT NULL DEFAULT 'validation'");
    this.ensureColumn("ad_operations", "operation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("ad_operations", "attempt_id", "TEXT");
    this.ensureColumn("ad_operations", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("ad_operations", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("ad_operations", "actor_id", "TEXT NOT NULL DEFAULT 'legacy-local-user'");
    this.ensureColumn("ad_operations", "actor_name", "TEXT NOT NULL DEFAULT '本地用户'");
    this.ensureColumn("ad_operations", "actor_kind", "TEXT NOT NULL DEFAULT 'user'");
    this.ensureColumn("ad_operations", "claimed_by", "TEXT");
    this.ensureColumn("ad_operations", "claimed_at", "TEXT");
    this.ensureColumn("ad_operations", "sync_warning", "TEXT");
    this.ensureColumn("ad_operations", "updated_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("ad_operations", "completed_at", "TEXT");
    this.ensureColumn("ad_operation_attempts", "actor_id", "TEXT NOT NULL DEFAULT 'legacy-local-user'");
    this.ensureColumn("ad_operation_attempts", "actor_name", "TEXT NOT NULL DEFAULT '本地用户'");
    this.ensureColumn("ad_operation_attempts", "actor_kind", "TEXT NOT NULL DEFAULT 'user'");
    this.ensureColumn("scheduled_entity_actions", "claimed_by", "TEXT");
    this.ensureColumn("scheduled_entity_actions", "claimed_at", "TEXT");
    this.ensureColumn("scheduled_entity_actions", "last_operation_id", "TEXT");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS ad_operations_claim ON ad_operations (status, claimed_at, created_at)",
    );
    this.applyMigration("status-write-task-identity-v1", () => {
      const rows = this.db.prepare(
        "SELECT id, created_at FROM ad_operations WHERE operation_id = '' OR correlation_id = '' OR updated_at = ''",
      ).all() as SqlRow[];
      const update = this.db.prepare(
        `UPDATE ad_operations SET operation_id = ?, correlation_id = ?,
         updated_at = CASE WHEN updated_at = '' THEN ? ELSE updated_at END,
         completed_at = CASE
           WHEN status IN ('succeeded', 'failed', 'unknown', 'cancelled') AND completed_at IS NULL THEN ?
           ELSE completed_at END
         WHERE id = ?`,
      );
      for (const row of rows) {
        const createdAt = String(row.created_at);
        update.run(randomUUID(), randomUUID(), createdAt, createdAt, String(row.id));
      }
    });
    this.ensureColumn(
      "entity_metric_snapshots",
      "sync_quality_status",
      "TEXT NOT NULL DEFAULT 'invalid'",
    );
    this.applyMigration("sync-data-quality-v1", () => {
      const legacyQuality = JSON.stringify({
        status: "invalid",
        paginationComplete: false,
        requiredMetricsComplete: false,
        contractValid: false,
        providerContractVersion: "legacy-unknown",
        coverage: { startDate: "", endDate: "", timezone: "UTC" },
        missingMetrics: [
          "spend",
          "cost_per_click",
          "cost_per_conversion",
          "conversions",
          "carts",
        ],
        partialFailures: ["legacy-sync-without-quality-metadata"],
        lastHealthyAt: null,
      });
      this.db
        .prepare("UPDATE sync_runs SET quality_json = ? WHERE quality_json = '{}' OR quality_json = ''")
        .run(legacyQuality);
    });
    this.ensureColumn(
      "multi_account_launch_plans",
      "launch_rows_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    this.ensureColumn("multi_account_launch_plans", "copy_preview_id", "TEXT");
    this.ensureColumn(
      "multi_account_launch_plans",
      "launch_mode",
      "TEXT NOT NULL DEFAULT 'copy'",
    );
    this.ensureColumn(
      "multi_account_launch_plans",
      "preset_snapshot_json",
      "TEXT",
    );
    this.ensureColumn(
      "launch_presets",
      "region",
      "TEXT NOT NULL DEFAULT '未设置'",
    );
    this.ensureColumn(
      "launch_presets",
      "creation_config_json",
      "TEXT NOT NULL DEFAULT '{}'",
    );
    this.ensureColumn(
      "multi_account_launch_plans",
      "launch_preset_id",
      "TEXT NOT NULL DEFAULT 'default-launch-preset'",
    );
    this.ensureColumn(
      "multi_account_launch_plans",
      "execution_results_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    this.ensureColumn(
      "multi_account_launch_plans",
      "preset_name",
      "TEXT NOT NULL DEFAULT '基础预设'",
    );
    this.ensureColumn("launch_plan_items", "phase", "TEXT NOT NULL DEFAULT 'validation'");
    this.ensureColumn("launch_plan_items", "operation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("launch_plan_items", "attempt_id", "TEXT");
    this.ensureColumn("launch_plan_items", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("launch_plan_items", "evidence_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("launch_plan_items", "actor_id", "TEXT NOT NULL DEFAULT 'legacy-local-user'");
    this.ensureColumn("launch_plan_items", "actor_name", "TEXT NOT NULL DEFAULT '本地用户'");
    this.ensureColumn("launch_plan_items", "actor_kind", "TEXT NOT NULL DEFAULT 'user'");
    this.ensureColumn("launch_plan_item_attempts", "actor_id", "TEXT NOT NULL DEFAULT 'legacy-local-user'");
    this.ensureColumn("launch_plan_item_attempts", "actor_name", "TEXT NOT NULL DEFAULT '本地用户'");
    this.ensureColumn("launch_plan_item_attempts", "actor_kind", "TEXT NOT NULL DEFAULT 'user'");
    this.ensureColumn("launch_plan_items", "sync_warning", "TEXT");
    this.ensureColumn("launch_plan_items", "source_snapshot_json", "TEXT");
    this.ensureColumn("launch_plan_items", "target_asset_mapping_json", "TEXT");
    this.ensureColumn("launch_plan_items", "idempotency_key", "TEXT");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS launch_plans_copy_preview ON multi_account_launch_plans (copy_preview_id) WHERE copy_preview_id IS NOT NULL",
    );
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS launch_plan_items_idempotency ON launch_plan_items (idempotency_key) WHERE idempotency_key IS NOT NULL",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS launch_plan_dispatches_requested ON launch_plan_dispatches (requested_at)",
    );
    this.applyMigration("launch-plan-items-v1", () => {
      // Historical plans have no trustworthy row-level execution state. Do
      // not backfill them as pending: that could recreate ads already sent by
      // an older build. They remain readable but must be recreated to run.
      this.db
        .prepare(
          `UPDATE multi_account_launch_plans
           SET status = 'blocked',
               message = '旧版计划没有逐项执行记录；为避免重复创建，请重新导入并创建计划。',
               updated_at = ?
           WHERE NOT EXISTS (
             SELECT 1 FROM launch_plan_items item WHERE item.plan_id = multi_account_launch_plans.id
           ) AND status IN ('draft', 'blocked')`,
        )
        .run(new Date().toISOString());
    });
    this.applyMigration("launch-item-evidence-v1", () => {
      const rows = this.db
        .prepare("SELECT item_id, plan_id, account_id, item_index FROM launch_plan_items WHERE operation_id = '' OR correlation_id = ''")
        .all() as SqlRow[];
      const update = this.db.prepare(
        `UPDATE launch_plan_items
         SET operation_id = ?, correlation_id = ?, phase = COALESCE(NULLIF(phase, ''), 'validation'),
             evidence_json = COALESCE(NULLIF(evidence_json, ''), '{}'), updated_at = ?
         WHERE item_id = ?`,
      );
      const now = new Date().toISOString();
      for (const row of rows) {
        update.run(
          randomUUID(),
          `${String(row.plan_id)}:${String(row.account_id)}:${Number(row.item_index)}`,
          now,
          String(row.item_id),
        );
      }
    });
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
    this.applyMigration("safe-manual-approval-execution-v1", () => {
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE accounts SET execution_mode = 'manual-approval', updated_at = ?")
        .run(now);
      this.db
        .prepare(
          `UPDATE automation_decisions
           SET status = 'skipped',
               error_message = COALESCE(error_message, '安全升级已切换为人工批准模式，旧待执行任务已取消。')
           WHERE status = 'pending'`,
        )
        .run();
    });
    this.ensureGlobalDefaults();
  }

  private applyMigration(key: string, migrate: () => void): void {
    this.migrationRunner.apply(key, migrate);
  }

  private ensureGlobalDefaults(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO launch_presets (
          id, name, region, daily_budget, bid, start_at, end_at, initial_status, created_at, updated_at
        ) VALUES ('default-launch-preset', '基础预设', '未设置', 100, NULL, NULL, NULL, 'enabled', ?, ?)`,
      )
      .run(now, now);
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
    this.migrationRunner.ensureColumn(table, column, definition);
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
    suggestionKey: typeof row.suggestion_key === "string" ? row.suggestion_key : "",
    ruleVersion: typeof row.rule_version === "string" ? row.rule_version : "legacy-unknown",
    rulePredicate: JSON.parse(String(row.rule_predicate_json ?? "{}")) as Record<string, unknown>,
    metricSnapshot: JSON.parse(String(row.metric_snapshot_json ?? "{}")) as AutomationDecisionRecord["metricSnapshot"],
    dataQualityStatus: (typeof row.data_quality_status === "string" ? row.data_quality_status : "invalid") as AutomationDecisionRecord["dataQualityStatus"],
    dataQualityWarnings: JSON.parse(String(row.data_quality_warnings_json ?? "[]")) as string[],
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
    phase: (typeof row.phase === "string" ? row.phase : "validation") as AdOperationRecord["phase"],
    operationId: String(row.operation_id),
    attemptId: typeof row.attempt_id === "string" ? row.attempt_id : null,
    correlationId: String(row.correlation_id),
    attemptCount: Number(row.attempt_count ?? 0),
    actor: {
      id: String(row.actor_id ?? "legacy-local-user"),
      name: String(row.actor_name ?? "本地用户"),
      kind: row.actor_kind === "system" ? "system" : "user",
    },
    claimedBy: typeof row.claimed_by === "string" ? row.claimed_by : null,
    claimedAt: typeof row.claimed_at === "string" ? row.claimed_at : null,
    message: typeof row.message === "string" ? row.message : null,
    syncWarning: typeof row.sync_warning === "string" ? row.sync_warning : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at || row.created_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

function mapLowRiskAutomationPolicy(row: SqlRow): LowRiskAutomationPolicy {
  return LowRiskAutomationPolicySchema.parse({
    accountId: row.account_id,
    enabled: fromSqlBoolean(row.enabled),
    policyVersion: row.policy_version,
    dailyActionLimit: Number(row.daily_action_limit),
    updatedAt: row.updated_at,
  });
}

function mapProviderWriteCircuit(row: SqlRow): ProviderWriteCircuit {
  return ProviderWriteCircuitSchema.parse({
    accountId: row.account_id,
    providerKind: row.provider_kind,
    consecutiveFailures: Number(row.consecutive_failures),
    lastError: row.last_error ?? null,
    openedAt: row.opened_at ?? null,
    updatedAt: row.updated_at,
  });
}

function mapAutomationApproval(row: SqlRow): AutomationApprovalRecord {
  return {
    id: String(row.id),
    decisionId: String(row.decision_id),
    runId: String(row.run_id),
    accountId: String(row.account_id),
    providerKind: row.provider_kind === "official-api" ? "official-api" : "cookie",
    suggestionKey: String(row.suggestion_key),
    entityType: row.entity_type as AutomationApprovalRecord["entityType"],
    externalId: String(row.external_id),
    entityName: String(row.entity_name),
    action: row.action === "enable" ? "enable" : "disable",
    expectedStatus: row.expected_status as AutomationApprovalRecord["expectedStatus"],
    beforeStatus: (row.before_status ?? null) as AutomationApprovalRecord["beforeStatus"],
    afterStatus: (row.after_status ?? null) as AutomationApprovalRecord["afterStatus"],
    status: row.status as AutomationApprovalStatus,
    actor: {
      id: String(row.actor_id),
      name: String(row.actor_name),
      kind: row.actor_kind === "system" ? "system" : "user",
    },
    statusOperationId: typeof row.status_operation_id === "string" ? row.status_operation_id : null,
    providerMessage: typeof row.provider_message === "string" ? row.provider_message : null,
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
    claimedBy: typeof row.claimed_by === "string" ? row.claimed_by : null,
    claimedAt: typeof row.claimed_at === "string" ? row.claimed_at : null,
    createdAt: String(row.created_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

function mapAdOperationAttempt(row: SqlRow): AdOperationAttemptRecord {
  return {
    attemptId: String(row.attempt_id),
    operationId: String(row.operation_id),
    correlationId: String(row.correlation_id),
    attemptNumber: Number(row.attempt_number),
    actor: {
      id: String(row.actor_id ?? "legacy-local-user"),
      name: String(row.actor_name ?? "本地用户"),
      kind: row.actor_kind === "system" ? "system" : "user",
    },
    phase: row.phase as AdOperationAttemptRecord["phase"],
    status: row.status as AdOperationAttemptRecord["status"],
    message: typeof row.message === "string" ? row.message : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

function mapStatusManualVerification(row: SqlRow): StatusManualVerificationRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    operationId: String(row.operation_id),
    actor: {
      id: String(row.actor_id),
      name: String(row.actor_name),
      kind: row.actor_kind === "system" ? "system" : "user",
    },
    decision: row.decision as StatusManualVerificationRecord["decision"],
    observedStatus: row.observed_status as StatusManualVerificationRecord["observedStatus"],
    evidence: String(row.evidence),
    note: String(row.note),
    previousStatus: "unknown",
    nextStatus: row.next_status as StatusManualVerificationRecord["nextStatus"],
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

const launchVideoCodeKeys = new Set([
  "aweme_item_id",
  "video_code",
  "video_id",
  "videoCode",
  "videoId",
]);
const launchProductUrlKeys = new Set([
  "external_url",
  "product_url",
  "landing_page_url",
  "productUrl",
]);

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function mapDatabaseBackup(row: SqlRow): DatabaseBackupRecord {
  return DatabaseBackupRecordSchema.parse({
    id: String(row.id),
    kind: row.kind,
    fileName: String(row.file_name),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    appVersion: String(row.app_version),
    schemaVersion: String(row.schema_version),
    status: row.status,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
    verifiedAt: row.verified_at ? String(row.verified_at) : null,
  });
}

function copyPreviewInputHash(input: {
  sourceAccountId: string;
  sourceAdId: string;
  targetAccountIds: string[];
  launchPresetId: string;
  launchRows: LaunchCopyPreviewInput["launchRows"];
}): string {
  return jsonHash({
    sourceAccountId: input.sourceAccountId,
    sourceAdId: input.sourceAdId,
    targetAccountIds: [...new Set(input.targetAccountIds)].sort(),
    launchPresetId: input.launchPresetId,
    launchRows: input.launchRows,
  });
}

function firstNestedString(value: unknown, keys: ReadonlySet<string>): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstNestedString(item, keys);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key) && typeof child === "string" && child.trim()) return child.trim();
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = firstNestedString(child, keys);
    if (found) return found;
  }
  return null;
}

function nestedValueMatches(
  value: unknown,
  keys: ReadonlySet<string>,
  expected: string,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => nestedValueMatches(item, keys, expected));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (Object.entries(record).some(
    ([key, child]) => keys.has(key) && String(child).trim() === expected,
  )) return true;
  return Object.values(record).some((child) => nestedValueMatches(child, keys, expected));
}

function copyDifferences(
  source: LaunchSourceSnapshot,
  row: LaunchCopyPreviewInput["launchRows"][number],
): LaunchCopyPreviewRecord["items"][number]["differences"] {
  const pairs = [
    ["campaignName", source.campaignName, row.campaignName],
    ["adGroupName", source.adGroupName, row.adGroupName],
    ["adName", source.adName, row.adName],
    ["videoCode", source.videoCode, row.videoCode],
    ["productUrl", source.productUrl, row.productUrl],
  ] as const;
  return pairs.flatMap(([field, sourceValue, targetValue]) =>
    sourceValue === targetValue ? [] : [{ field, sourceValue, targetValue }],
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function mapMultiAccountLaunchPlan(row: SqlRow): MultiAccountLaunchPlanRecord {
  return MultiAccountLaunchPlanRecordSchema.parse({
    id: row.id,
    copyPreviewId: row.copy_preview_id ?? null,
    sourceAccountId: row.source_account_id,
    sourceAdId: row.source_ad_id === "__new__" ? null : row.source_ad_id,
    sourceAdName: row.source_ad_name,
    mode: row.launch_mode ?? "copy",
    targetAccountIds: JSON.parse(String(row.target_account_ids_json)),
    launchPresetId: row.launch_preset_id,
    presetName: row.preset_name,
    presetSnapshot: row.preset_snapshot_json
      ? JSON.parse(String(row.preset_snapshot_json))
      : null,
    launchRows: JSON.parse(String(row.launch_rows_json ?? "[]")),
    executionResults: JSON.parse(String(row.execution_results_json ?? "[]")),
    status: row.status,
    message: row.message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapLaunchPlanItem(row: SqlRow): LaunchPlanItemRecord {
  return LaunchPlanItemRecordSchema.parse({
    itemId: row.item_id,
    planId: row.plan_id,
    accountId: row.account_id,
    itemIndex: Number(row.item_index),
    launchRow: JSON.parse(String(row.launch_row_json)),
    templateMode: row.template_mode,
    templateCampaignId: row.template_campaign_id ?? null,
    sourceSnapshot: row.source_snapshot_json
      ? JSON.parse(String(row.source_snapshot_json))
      : null,
    targetAssetMapping: row.target_asset_mapping_json
      ? JSON.parse(String(row.target_asset_mapping_json))
      : null,
    idempotencyKey: row.idempotency_key || null,
    status: row.status,
    phase: row.phase ?? "validation",
    operationId: row.operation_id,
    attemptId: row.attempt_id ?? null,
    correlationId: row.correlation_id,
    actor: {
      id: row.actor_id,
      name: row.actor_name,
      kind: row.actor_kind,
    },
    evidence: JSON.parse(String(row.evidence_json ?? "{}")),
    campaignId: row.campaign_id ?? null,
    adGroupId: row.adgroup_id ?? null,
    adId: row.ad_id ?? null,
    errorMessage: row.error_message ?? null,
    syncWarning: row.sync_warning ?? null,
    attemptCount: Number(row.attempt_count),
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapLaunchPlanItemAttempt(row: SqlRow): LaunchPlanItemAttemptRecord {
  return LaunchPlanItemAttemptRecordSchema.parse({
    attemptId: row.attempt_id,
    itemId: row.item_id,
    operationId: row.operation_id,
    correlationId: row.correlation_id,
    actor: {
      id: row.actor_id,
      name: row.actor_name,
      kind: row.actor_kind,
    },
    attemptNumber: Number(row.attempt_number),
    phase: row.phase,
    status: row.status,
    evidence: JSON.parse(String(row.evidence_json ?? "{}")),
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  });
}

function mapLaunchManualVerification(row: SqlRow): LaunchManualVerificationRecord {
  return LaunchManualVerificationRecordSchema.parse({
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    decision: row.decision,
    evidence: row.evidence,
    note: row.note,
    campaignId: row.campaign_id ?? null,
    adGroupId: row.adgroup_id ?? null,
    adId: row.ad_id ?? null,
    previousStatus: row.previous_status,
    nextStatus: row.next_status,
    createdAt: row.created_at,
  });
}

/**
 * The browser preview is not an authority for execution settings.  Reapply the
 * saved preset here so requests cannot bypass the selected region, budget,
 * bid, schedule, or initial-paused setting.  The server also allocates names
 * to keep YYMMDD:XXX unique across separately imported plans on the same day.
 */
function applyPresetToLaunchRows(
  rows: MultiAccountLaunchPlanInput["launchRows"],
  preset: LaunchPresetRecord,
  existingPlans: MultiAccountLaunchPlanRecord[],
  now: Date,
) {
  const prefix = automaticName(now, 1).slice(0, 6);
  let nextSerial = 1;
  for (const plan of existingPlans) {
    for (const row of plan.launchRows) {
      const match = new RegExp(`^${prefix}:(\\d+)$`).exec(row.adName);
      if (match) nextSerial = Math.max(nextSerial, Number(match[1]) + 1);
    }
  }
  return rows.map((row, index) => ({
    ...row,
    adName: automaticName(now, nextSerial + index),
    region: preset.region,
    dailyBudget: preset.dailyBudget,
    bid: preset.bid,
    startAt: preset.startAt,
    endAt: preset.endAt,
    initialStatus: preset.initialStatus,
  }));
}

function mapLaunchPreset(row: SqlRow): LaunchPresetRecord {
  return LaunchPresetRecordSchema.parse({
    id: row.id,
    name: row.name,
    region: row.region,
    dailyBudget: Number(row.daily_budget),
    bid: row.bid === null ? null : Number(row.bid),
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    initialStatus: row.initial_status,
    creationConfig: row.creation_config_json
      ? JSON.parse(String(row.creation_config_json))
      : {},
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
    authorizationStatus: row.authorization_status ?? "not-authorized",
    capabilityVersion: row.capability_version ?? "legacy-unversioned",
    authorizedCapabilities: JSON.parse(String(row.authorized_capabilities_json ?? "[]")),
    authorizedAt: row.authorized_at ?? null,
    authorizationExpiresAt: row.authorization_expires_at ?? null,
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
