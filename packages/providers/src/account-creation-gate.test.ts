import { describe, expect, it } from "vitest";
import { AccountCreationGate, type AccountWriteKind } from "./cookie-provider.js";

/**
 * 新建和扩组能并发起来，全靠这把闸门放对了行。它是这次改动里唯一真正难的地方——判错
 * 一次的代价不是慢，是两条创建同时动一个账户的草稿，失败后在 TikTok 后台留下收不掉的
 * 残留。
 *
 * 所以这里不测「跑通了没有」，只测四条不变量，并且用打散的交错顺序去撞：
 * 1. 独占方持有期间，账户上不能有任何别的持有者；
 * 2. 同一类写里，同一个系列不能重叠；
 * 3. 不同类的写（新建 vs 扩组）任何时候都不能重叠；
 * 4. 谁都不能被永远饿死。
 */
describe("AccountCreationGate", () => {
  type Holder = "exclusive" | AccountWriteKind;

  /** 记录每次进出，事后按区间判有没有重叠。 */
  class Tracker {
    readonly spans: Array<{ holder: Holder; scope: string; start: number; end: number }> = [];
    private clock = 0;
    tick(): number {
      this.clock += 1;
      return this.clock;
    }
  }

  const hold = async (
    gate: AccountCreationGate,
    tracker: Tracker,
    holder: Holder,
    scope: string,
    turns: number,
  ): Promise<void> => {
    const release = holder === "exclusive"
      ? await gate.acquireExclusive()
      : await gate.acquireShared(holder, scope);
    const start = tracker.tick();
    // 在持有期间让出若干轮微任务，给别的持有者制造插进来的机会。
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
    const end = tracker.tick();
    tracker.spans.push({ holder, scope, start, end });
    release();
  };

  const overlaps = (
    left: { start: number; end: number },
    right: { start: number; end: number },
  ): boolean => left.start < right.end && right.start < left.end;

  it("独占期间没有别人；同类同系列不重叠；两类写整体错开", async () => {
    const gate = new AccountCreationGate();
    const tracker = new Tracker();
    // 交错着下单：新建、扩组、独占混在一起，持有时长各不相同。
    const plan: Array<[Holder, string, number]> = [
      ["create", "c1", 5],
      ["create", "c2", 2],
      ["expand", "c1", 3],
      ["exclusive", "-", 4],
      ["create", "c3", 1],
      ["expand", "c2", 6],
      ["create", "c1", 2],
      ["exclusive", "-", 1],
      ["expand", "c3", 3],
      ["create", "c4", 2],
      ["expand", "c1", 2],
    ];
    await Promise.all(plan.map(([holder, scope, turns]) => hold(gate, tracker, holder, scope, turns)));

    expect(tracker.spans).toHaveLength(plan.length);
    for (const span of tracker.spans) {
      for (const other of tracker.spans) {
        if (span === other || !overlaps(span, other)) continue;
        // 独占方与任何人重叠都是错的。
        expect(span.holder).not.toBe("exclusive");
        expect(other.holder).not.toBe("exclusive");
        // 两类写之间任何时候都不能重叠。
        expect(span.holder).toBe(other.holder);
        // 同一类里，同一个系列也不能重叠。
        expect(span.scope).not.toBe(other.scope);
      }
    }
  });

  it("同类不同系列确实并发（否则这个改动等于没做）", async () => {
    const gate = new AccountCreationGate();
    const tracker = new Tracker();
    // 真实形状：一批创建的 10 条泳道是同时起跑的，中间没有别的类型插进来。
    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        hold(gate, tracker, "create", `c${index}`, 3)),
    );
    let peak = 0;
    const events = tracker.spans.flatMap((s) => [[s.start, 1], [s.end, -1]] as const);
    let cur = 0;
    for (const [, delta] of [...events].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      cur += delta;
      peak = Math.max(peak, cur);
    }
    expect(peak).toBe(10);
  });

  it("独占方不会被源源不断的共享方饿死", async () => {
    const gate = new AccountCreationGate();
    const tracker = new Tracker();
    // 第一条新建先真正拿到闸门，独占方只能排在它后面。
    const releaseFirst = await gate.acquireShared("create", "c1");
    const firstStart = tracker.tick();
    const exclusive = hold(gate, tracker, "exclusive", "-", 1);
    // 独占方还在排队时，又来了 8 条挂在别的系列上的新建。
    const later = Array.from(
      { length: 8 },
      (_unused, index) => hold(gate, tracker, "create", `c${index + 2}`, 2),
    );
    await Promise.resolve();
    const firstEnd = tracker.tick();
    tracker.spans.push({ holder: "create", scope: "c1", start: firstStart, end: firstEnd });
    releaseFirst();
    await Promise.all([exclusive, ...later]);

    const exclusiveSpan = tracker.spans.find((span) => span.holder === "exclusive")!;
    // 独占方接在第一条之后，而不是被后到的 8 条一路挤到队尾。
    expect(exclusiveSpan.start).toBeGreaterThan(firstEnd);
    const after = tracker.spans.filter((span) => span.holder !== "exclusive" && span.start > exclusiveSpan.end);
    expect(after).toHaveLength(8);
  });

  it("另一类共享方在跑时要让路，且让路期间不挡独占方归零", async () => {
    const gate = new AccountCreationGate();
    const tracker = new Tracker();
    const releaseExpand = await gate.acquireShared("expand", "c1");
    const expandStart = tracker.tick();
    // 扩组在跑时，新建必须等——哪怕挂的是完全不同的系列。
    const creation = hold(gate, tracker, "create", "c9", 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.spans.filter((s) => s.holder === "create")).toHaveLength(0);
    const expandEnd = tracker.tick();
    tracker.spans.push({ holder: "expand", scope: "c1", start: expandStart, end: expandEnd });
    releaseExpand();
    await creation;

    const createSpan = tracker.spans.find((s) => s.holder === "create")!;
    expect(createSpan.start).toBeGreaterThan(expandEnd);
  });

  it("重复调用 release 不会把别人的名额一起放掉", async () => {
    const gate = new AccountCreationGate();
    const release = await gate.acquireShared("create", "c1");
    release();
    release();
    // 计数若被减成负数，独占方就再也等不到 sharedActive 归零。
    const exclusive = await gate.acquireExclusive();
    exclusive();
    const again = await gate.acquireShared("expand", "c1");
    again();
    expect(true).toBe(true);
  });
});
