import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AutomationService } from "../apps/api/src/automation-service.js";
import {
  ProviderRegistry,
  type AdsProvider,
  type ProviderContext,
  type ProviderHealth,
  type ProviderSyncOutput,
} from "../packages/providers/src/index.ts";
import { InMemoryCredentialVault } from "../packages/credentials/src/vault.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";
import type { ProviderCapability, ProviderEntity } from "../packages/core/src/index.ts";

type Options = {
  phase: 1 | 2;
  users: number;
  tasks: number;
  durationSeconds: number;
  intervalSeconds: number;
  sampleSeconds: number;
  outputRoot: string;
  smoke: boolean;
};

type Task = {
  id: string;
  accountId: string;
  nextDueAt: number;
  scheduled: number;
  completed: number;
  failed: number;
  driftMs: number[];
  queued: boolean;
  running: boolean;
};

type Sample = {
  timestamp: string;
  elapsedSeconds: number;
  cpuProcessPercent: number;
  cpuSystemPercent: number | null;
  memoryRssBytes: number;
  memoryHeapUsedBytes: number;
  queueDepth: number;
  runningTasks: number;
  completedRequests: number;
  failedRequests: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  retryCount: number;
  timeoutCount: number;
  dbLockCount: number;
  duplicateTasks: number;
  lostTasks: number;
  dbBytes: number;
  walBytes: number;
};

const execFileAsync = promisify(execFile);
const label = "单机综合承载能力";

class FakeProvider implements AdsProvider {
  readonly kind = "official-api" as const;
  readonly displayName = "Fake Provider (local only)";
  readonly capabilityVersion = "fake-provider-performance-v1";
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    "read-campaigns", "read-ad-groups", "read-ads", "read-reports", "change-status",
  ]);
  calls = 0;

  async checkHealth(_context: ProviderContext): Promise<ProviderHealth> {
    await delay(3);
    return { ok: true, status: "ready", message: "Fake Provider local health check" };
  }

  async syncReadOnly(_context: ProviderContext): Promise<ProviderSyncOutput> {
    this.calls += 1;
    await delay(3 + (this.calls % 7));
    const entities: ProviderEntity[] = [
      entity("campaign", "fake-campaign"),
      entity("ad-group", "fake-ad-group"),
      entity("ad", "fake-ad"),
    ];
    return {
      entities,
      result: {
        fetchedAt: new Date().toISOString(),
        quality: {
          status: "healthy",
          paginationComplete: true,
          requiredMetricsComplete: true,
          contractValid: true,
          providerContractVersion: this.capabilityVersion,
          coverage: { startDate: "2026-07-20", endDate: "2026-07-20", timezone: "Asia/Shanghai" },
          missingMetrics: [],
          partialFailures: [],
          lastHealthyAt: null,
        },
        warnings: [],
        counts: { campaign: 1, "ad-group": 1, ad: 1 },
      },
    };
  }

  async changeStatus(): Promise<never[]> {
    throw new Error("Fake performance test is read-only; remote writes are disabled");
  }
}

function entity(entityType: ProviderEntity["entityType"], externalId: string): ProviderEntity {
  return {
    entityType,
    externalId,
    payload: {
      name: externalId,
      primary_status: "ENABLE",
      spend: 0,
      cpc: 0,
      cost_per_conversion: 0,
      conversions: 0,
      clicks: 0,
      carts: 0,
      impressions: 0,
    },
  };
}

function parseArgs(argv: string[]): Options {
  const value = (name: string, fallback: number) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? Number(argv[index + 1]) : fallback;
  };
  const phaseValue = value("phase", 1);
  if (phaseValue !== 1 && phaseValue !== 2) throw new Error("Only phase 1 or phase 2 is supported");
  const defaults = phaseValue === 2
    ? { users: 50, tasks: 500, durationSeconds: 1_800 }
    : { users: 10, tasks: 50, durationSeconds: 600 };
  return {
    phase: phaseValue,
    users: value("users", defaults.users),
    tasks: value("tasks", defaults.tasks),
    durationSeconds: value("duration-seconds", defaults.durationSeconds),
    intervalSeconds: value("interval-seconds", 60),
    sampleSeconds: value("sample-seconds", 5),
    outputRoot: resolve(argv.includes("--output") ? argv[argv.indexOf("--output") + 1] : "data/performance"),
    smoke: argv.includes("--smoke"),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function systemCpuPercent(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[math]::Round((Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples[0].CookedValue,2)",
    ], { windowsHide: true, timeout: 3_000 });
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function csvRow(sample: Sample): string {
  return Object.values(sample).map((value) => String(value ?? "")).join(",");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const expected = options.phase === 2
    ? { users: 50, tasks: 500, durationSeconds: 1_800 }
    : { users: 10, tasks: 50, durationSeconds: 600 };
  if (options.users !== expected.users || options.tasks !== expected.tasks || (!options.smoke && options.durationSeconds !== expected.durationSeconds)) {
    throw new Error(`Phase ${options.phase} requires ${expected.users} users, ${expected.tasks} tasks, ${expected.durationSeconds} seconds`);
  }
  if (!Number.isInteger(options.users) || !Number.isInteger(options.tasks) || options.tasks % options.users !== 0) {
    throw new Error("tasks must be an integer multiple of users");
  }

  const phase = `phase-${options.phase}`;
  const runId = `${phase}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = join(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  const dbPath = join(outputDir, "test.sqlite");
  const walPath = `${dbPath}-wal`;
  const csvPath = join(outputDir, "metrics.csv");
  const summaryPath = join(outputDir, "summary.json");
  const failuresPath = join(outputDir, "failures.jsonl");
  const logPath = join(outputDir, "runner.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const logLine = (message: string) => {
    if (fileSize(logPath) < 2_000_000) log.write(`${new Date().toISOString()} ${message}\n`);
  };
  const store = new AutomationStore(dbPath, { appVersion: `performance-${phase}` });
  store.updateSystemRuntimeState({ enabled: true });
  store.updateGlobalAutomationSettings({ pollingIntervalMinutes: 1, maxActionsPerRun: 15 });
  const vault = new InMemoryCredentialVault();
  const fake = new FakeProvider();
  const providers = new ProviderRegistry([fake]);
  const service = new AutomationService(store, vault, providers);
  const accountIds: string[] = [];
  const credential = await vault.create(JSON.stringify({ kind: "official-api", accessToken: "fake-local-token" }));
  for (let i = 0; i < options.users; i += 1) {
    const account = store.createAccount({ displayName: `Perf User ${i + 1}`, accountType: "standard", enabled: true, providerKind: "official-api" });
    accountIds.push(account.id);
    store.saveProviderConnectionSettings(account.id, { kind: "official-api", advertiserId: `fake-${i + 1}` });
    store.setProviderCredentialReference(account.id, "official-api", credential);
    store.updateProviderAuthorization(account.id, "official-api", {
      status: "active", capabilityVersion: fake.capabilityVersion,
      capabilities: [...fake.capabilities],
    });
    store.updateProviderStatus(account.id, "official-api", "ready", "Fake Provider local setup");
  }

  const tasks: Task[] = Array.from({ length: options.tasks }, (_, index) => ({
    id: `poll-${index + 1}`,
    accountId: accountIds[index % accountIds.length],
    nextDueAt: Date.now(), scheduled: 0, completed: 0, failed: 0, driftMs: [], queued: false, running: false,
  }));
  const queue: Task[] = [];
  const samples: Sample[] = [];
  const latencyMs: number[] = [];
  const failures: Array<Record<string, unknown>> = [];
  const accountLocks = new Map<string, Promise<void>>();
  let completedRequests = 0;
  let failedRequests = 0;
  let retryCount = 0;
  let timeoutCount = 0;
  let dbLockCount = 0;
  let duplicateTasks = 0;
  let runningWorkers = 0;
  let peakRss = 0;
  let peakCpu = 0;
  let lastCpu = process.cpuUsage();
  let lastCpuAt = process.hrtime.bigint();
  const startedAt = Date.now();
  const deadline = startedAt + options.durationSeconds * 1000;
  const header = Object.keys({
    timestamp: "", elapsedSeconds: "", cpuProcessPercent: "", cpuSystemPercent: "", memoryRssBytes: "", memoryHeapUsedBytes: "",
    queueDepth: "", runningTasks: "", completedRequests: "", failedRequests: "", p50Ms: "", p95Ms: "", p99Ms: "", retryCount: "", timeoutCount: "", dbLockCount: "", duplicateTasks: "", lostTasks: "", dbBytes: "", walBytes: "",
  }).join(",");
  await writeFile(csvPath, `${header}\n`);

  const runTask = async (task: Task): Promise<void> => {
    const scheduledAt = task.nextDueAt;
    task.scheduled += 1;
    task.queued = false;
    task.running = true;
    runningWorkers += 1;
    const started = Date.now();
    task.driftMs.push(Math.max(0, started - scheduledAt));
    const prior = accountLocks.get(task.accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    accountLocks.set(task.accountId, prior.then(() => current));
    try {
      await prior;
      await service.runAccount(task.accountId, "scheduler");
      task.completed += 1;
      completedRequests += 1;
    } catch (cause) {
      task.failed += 1;
      failedRequests += 1;
      if (cause instanceof Error && /busy|locked/i.test(cause.message)) dbLockCount += 1;
      const failure = { timestamp: new Date().toISOString(), taskId: task.id, accountId: task.accountId, message: cause instanceof Error ? cause.message : String(cause) };
      failures.push(failure);
      await appendFile(failuresPath, `${JSON.stringify(failure)}\n`);
      logLine(`failure ${JSON.stringify(failure)}`);
    } finally {
      release();
      if (accountLocks.get(task.accountId) === current) accountLocks.delete(task.accountId);
      task.running = false;
      runningWorkers -= 1;
      latencyMs.push(Date.now() - started);
      task.nextDueAt = scheduledAt + options.intervalSeconds * 1000;
    }
  };

  const pump = () => {
    while (runningWorkers < options.users && queue.length > 0) {
      const task = queue.shift()!;
      void runTask(task);
    }
  };
  const enqueueDue = () => {
    const now = Date.now();
    if (now >= deadline) return;
    for (const task of tasks) {
      if (task.nextDueAt <= now && !task.queued && !task.running) {
        task.queued = true;
        queue.push(task);
      }
    }
    pump();
  };
  const sample = async () => {
    const nowHr = process.hrtime.bigint();
    const elapsedCpu = process.cpuUsage(lastCpu);
    const elapsedMs = Number(nowHr - lastCpuAt) / 1_000_000;
    lastCpu = process.cpuUsage();
    lastCpuAt = nowHr;
    const cpuProcessPercent = Math.min(100, ((elapsedCpu.user + elapsedCpu.system) / 1000 / elapsedMs) * 100);
    const memory = process.memoryUsage();
    const cpuSystem = await systemCpuPercent();
    const db = fileSize(dbPath);
    const wal = fileSize(walPath);
    const lostTasks = tasks.filter((task) => task.scheduled > task.completed + task.failed).length + queue.length;
    const item: Sample = {
      timestamp: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      cpuProcessPercent: Number(cpuProcessPercent.toFixed(2)), cpuSystemPercent: cpuSystem,
      memoryRssBytes: memory.rss, memoryHeapUsedBytes: memory.heapUsed, queueDepth: queue.length,
      runningTasks: runningWorkers, completedRequests, failedRequests,
      p50Ms: percentile(latencyMs, 0.5), p95Ms: percentile(latencyMs, 0.95), p99Ms: percentile(latencyMs, 0.99),
      retryCount, timeoutCount, dbLockCount, duplicateTasks, lostTasks, dbBytes: db, walBytes: wal,
    };
    samples.push(item);
    peakRss = Math.max(peakRss, memory.rss);
    peakCpu = Math.max(peakCpu, cpuSystem ?? cpuProcessPercent);
    await appendFile(csvPath, `${csvRow(item)}\n`);
  };

  logLine(`start label=${label} phase=${phase} users=${options.users} tasks=${options.tasks} durationSeconds=${options.durationSeconds} provider=FakeProvider database=${dbPath}`);
  const scheduler = setInterval(enqueueDue, 250);
  const sampler = setInterval(() => { void sample(); }, options.sampleSeconds * 1000);
  enqueueDue();
  while (Date.now() < deadline) await delay(1_000);
  clearInterval(scheduler);
  clearInterval(sampler);
  while (runningWorkers > 0) await delay(50);
  await sample();
  const allDrift = tasks.flatMap((task) => task.driftMs);
  const lostTasks = tasks.reduce((sum, task) => sum + Math.max(0, task.scheduled - task.completed - task.failed), 0);
  const inWindowSamples = samples.filter((item) => item.elapsedSeconds <= options.durationSeconds);
  const queueRecovered = inWindowSamples.length < 2 || inWindowSamples.slice(-2).every((item) => item.queueDepth === 0);
  const errorRate = (completedRequests + failedRequests) === 0 ? 0 : failedRequests / (completedRequests + failedRequests);
  const memoryTail = samples.slice(-Math.max(2, Math.floor(samples.length / 5))).map((item) => item.memoryRssBytes);
  const memoryGrowing = memoryTail.length >= 6
    && memoryTail.every((value, index) => index === 0 || value >= memoryTail[index - 1])
    && memoryTail[memoryTail.length - 1] > memoryTail[0] * 1.1;
  const stoppedBy = [
    ...(duplicateTasks > 0 ? ["duplicate remote operation/task"] : []),
    ...(lostTasks > 0 ? ["lost task"] : []),
    ...(errorRate > 0.02 ? ["error rate > 2%"] : []),
    ...(peakCpu > 90 ? ["CPU > 90%"] : []),
    ...(memoryGrowing ? ["memory continuously growing"] : []),
    ...(!queueRecovered ? ["queue did not recover for two cycles"] : []),
  ];
  const summary = {
    label, phase, status: stoppedBy.length === 0 ? "PASS" : "STOPPED",
    stoppedBy, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000), users: options.users, pollingTasks: options.tasks,
    provider: "Fake Provider (local only)", realTikTokCalls: 0, database: dbPath,
    requests: completedRequests + failedRequests, successRate: completedRequests + failedRequests === 0 ? 0 : completedRequests / (completedRequests + failedRequests),
    errorRate, p50Ms: percentile(latencyMs, 0.5), p95Ms: percentile(latencyMs, 0.95), p99Ms: percentile(latencyMs, 0.99),
    cpuPeakPercent: peakCpu, memoryPeakBytes: peakRss, queuePeak: Math.max(0, ...samples.map((item) => item.queueDepth)),
    pollingDriftP95Ms: percentile(allDrift, 0.95), retryCount, timeoutCount, dbLockCount, duplicateTasks, lostTasks,
    queueResult: queueRecovered ? "recovered" : "not-recovered", databaseBytes: fileSize(dbPath), walBytes: fileSize(walPath),
    fakeProviderCalls: fake.calls, sampleCount: samples.length,
    reportFiles: { summary: summaryPath, metrics: csvPath, failures: failuresPath, runnerLog: logPath, database: dbPath },
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  logLine(`finish status=${summary.status} requests=${summary.requests} errorRate=${summary.errorRate} p95=${summary.p95Ms} cpuPeak=${summary.cpuPeakPercent} memoryPeak=${summary.memoryPeakBytes} duplicateTasks=${duplicateTasks} lostTasks=${lostTasks}`);
  log.end();
  store.close();
  console.log(JSON.stringify(summary));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
