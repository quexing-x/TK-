export type WritableTaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled";

export interface WriteTaskLifecycle<TTask, TSuccess> {
  claim(
    taskId: string,
    executorId: string,
    expectedStatus: "pending" | "failed",
    actor: WriteTaskActor,
  ): TTask | null;
  succeed(taskId: string, executorId: string, result: TSuccess): TTask;
  fail(taskId: string, executorId: string, message: string): TTask;
  unknown(taskId: string, executorId: string, message: string): TTask;
}

/**
 * Small shared lifecycle for provider writes. Storage adapters retain their
 * domain tables, while claim and terminal-state semantics stay identical.
 */
export class WriteTaskKernel<TTask, TSuccess> {
  constructor(private readonly lifecycle: WriteTaskLifecycle<TTask, TSuccess>) {}

  claim(
    taskId: string,
    executorId: string,
    expectedStatus: "pending" | "failed",
    actor: WriteTaskActor,
  ): TTask | null {
    return this.lifecycle.claim(taskId, executorId, expectedStatus, actor);
  }

  succeed(taskId: string, executorId: string, result: TSuccess): TTask {
    return this.lifecycle.succeed(taskId, executorId, result);
  }

  fail(taskId: string, executorId: string, message: string): TTask {
    return this.lifecycle.fail(taskId, executorId, message);
  }

  unknown(taskId: string, executorId: string, message: string): TTask {
    return this.lifecycle.unknown(taskId, executorId, message);
  }
}

export class ConfirmedWriteFailureError extends Error {
  override readonly name = "ConfirmedWriteFailureError";
}

export class UnknownWriteStateError extends Error {
  override readonly name = "UnknownWriteStateError";
}

export async function withLeaseHeartbeat<T>(
  work: () => Promise<T>,
  renew: () => boolean,
  intervalMs: number,
): Promise<T> {
  const timer = setInterval(() => {
    try {
      renew();
    } catch {
      // Renewal is best-effort while the provider call is in flight. The
      // terminal write still verifies executor ownership before committing.
    }
  }, intervalMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
import type { WriteTaskActor } from "@tk-auto/core";
