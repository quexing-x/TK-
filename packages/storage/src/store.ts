import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AccountConfigSchema,
  type AccountConfig,
  type AccountSettingsUpdate,
  type AutomationSwitchKey,
  type AutomationSwitches,
  type AutomationAction,
  type AutomationCandidate,
  type AutomationDecisionRecord,
  type AutomationDecisionStatus,
  type AutomationRunRecord,
  type AutomationTrigger,
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
} from "@tk-auto/core";

type SqlRow = Record<string, unknown>;

export interface StoredProviderConnection extends ProviderConnection {
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
          id, display_name, enabled, provider_kind, credential_ref,
          timezone, polling_interval_minutes, max_actions_per_run,
          execution_mode, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        accountId,
        "演示广告账户",
        1,
        "cookie",
        null,
        "Asia/Shanghai",
        15,
        10,
        "manual-approval",
        now,
      );

    this.writeSwitches(accountId, createDefaultAutomationSwitches(), false);
    for (const threshold of defaultThresholds) {
      this.insertThreshold(accountId, threshold, false);
    }
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
          display_name = ?, enabled = ?, provider_kind = ?, timezone = ?,
          polling_interval_minutes = ?, max_actions_per_run = ?,
          execution_mode = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        settings.displayName,
        toSqlBoolean(settings.enabled),
        settings.providerKind,
        settings.timezone,
        settings.pollingIntervalMinutes,
        settings.maxActionsPerRun,
        settings.executionMode,
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
      }
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

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cookie', 'official-api')),
        credential_ref TEXT,
        timezone TEXT NOT NULL,
        polling_interval_minutes INTEGER NOT NULL,
        max_actions_per_run INTEGER NOT NULL DEFAULT 10,
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
    `);

    this.ensureColumn(
      "accounts",
      "max_actions_per_run",
      "INTEGER NOT NULL DEFAULT 10",
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

function mapAccount(row: SqlRow): AccountConfig {
  return AccountConfigSchema.parse({
    id: row.id,
    displayName: row.display_name,
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
