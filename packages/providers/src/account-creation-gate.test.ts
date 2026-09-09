import { describe, expect, it } from "vitest";
import { AccountCreationGate } from "./cookie-provider.js";

/**
 * 扩组能并发起来，全靠这把闸门放对了行。它是这次改动里唯一真正难的地方——判错一次的
 * 代价不是慢，是两条创建同时动一个账户的草稿，失败后在 TikTok 后台留下收不掉的残留。
 *
 * 所以这里不测「跑通了没有」，只测三条不变量，并且用打散的交错顺序去撞：
 * 1. 独占方持有期间，账户上不能有任何别的持有者；
 * 2. 同一个系列的扩组不能重叠；
 * 3. 谁都不能被永远饿死。
 */
describe("AccountCreationGate", () => {
  /** 记录每次进出，事后按区间判有没有重叠。 */
  class Tracker {
    readonly spans: Array<{ kind: "exclusive" | "shared"; scope: string; start: number; end: number }> = [];
    private clock = 0;
    tick(): number {
      this.clock += 1;
      return this.clock;
    }
  }

  const hold = async (
    gate: AccountCreationGate,
    tracker: Tracker,
    kind: "exclusive" | "shared",
    scope: string,
    turns: number,
  ): Promise<void> => {
    const release = kind === "exclusive"
      ? await gate.acquireExclusive()
      : await gate.acquireShared(scope);
    const start = tracker.tick();
    // 在持有期间让出若干轮微任务，给别的持有者制造插进来的机会。
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
    const end = tracker.tick();
    tracker.spans.push({ kind, scope, start, end });
    release();
  };

  const overlaps = (
    left: { start: number; end: number },
    right: { start: number; end: number },
  ): boolean => left.start < right.end && right.start < left.end;

  it("独占方持有期间账户上没有别人；同系列扩组不重叠", async () => {
    const gate = new AccountCreationGate();
    const tracker = new Tracker();
    // 交错着下单：扩组、独占、扩组……并且让持有时长各不相同。
    const plan: Array<["exclusive" | "shared", string, number]> = [
      ["shared", "c1", 5],
      ["shared", "c2", 2],
      ["shared", "c1", 3],
      ["exclusive", "-", 4],
      ["shared", "c3", 1],
      ["shared", "c2", 6],
      ["shared", "c1", 2],
      ["exclusive", "-", 1],
      ["shared", "c3", 3],
      ["shared", "c4", 2],
    ];
    await Promise.all(plan.map(([kind, scope, turns]) => hold(gate, tracker, kind, scope, turns)));

    expect(tracker.spans).toHaveLength(plan.length);
    for (const span of tracker.spans) {
      for (const other of tracker.spans) {
        if (span === other || !overlaps(span, other)) continue;
        // 独占方与任何人重叠都是错的；同系列的两条扩组重叠也是错的。
        expect(span.kind).toBe("shared");
        expect(other.kind).toBe("shared");
        expect(span.scope).not.toBe(other.scope);
      }
    }
    // 不同系列的扩组确实并发起来了，否则这个改动等于没做。
    const concurrent = tracker.spans.some((span) => tracker.spans.some(
      (other) => other !== span && overlaps(span, other),
    ));
    expect(concurrent).toBe(true);
  });

  it("独占方不会被源源不断的扩组饿死", async () => {
    const gate = new AccountCreationGate();
    const tracker = new Tracker();
    // 第一条扩组先真正拿到闸门，独占方只能排在它后面。
    const releaseFirst = await gate.acquireShared("c1");
    const firstStart = tracker.tick();
    const exclusive = hold(gate, tracker, "exclusive", "-", 1);
    // 独占方还在排队时，又来了 8 条挂在别的系列上的扩组。
    const later = Array.from(
      { length: 8 },
      (_unused, index) => hold(gate, tracker, "shared", `c${index + 2}`, 2),
    );
    await Promise.resolve();
    const firstEnd = tracker.tick();
    tracker.spans.push({ kind: "shared", scope: "c1", start: firstStart, end: firstEnd });
    releaseFirst();
    await Promise.all([exclusive, ...later]);

    const exclusiveSpan = tracker.spans.find((span) => span.kind === "exclusive")!;
    // 独占方接在第一条扩组之后，而不是被后到的 8 条一路挤到队尾。
    expect(exclusiveSpan.start).toBeGreaterThan(firstEnd);
    const after = tracker.spans.filter((span) => span.kind === "shared" && span.start > exclusiveSpan.end);
    expect(after).toHaveLength(8);
  });

  it("重复调用 release 不会把别人的名额一起放掉", async () => {
    const gate = new AccountCreationGate();
    const release = await gate.acquireShared("c1");
    release();
    release();
    // 计数若被减成负数，独占方就再也等不到 sharedActive 归零。
    const exclusive = await gate.acquireExclusive();
    exclusive();
    const again = await gate.acquireShared("c1");
    again();
    expect(true).toBe(true);
  });
});
