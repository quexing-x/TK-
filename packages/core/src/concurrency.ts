/**
 * 有上限的并发映射。
 *
 * 轮询链路上的耗时几乎全在等 HTTP 上：三个层级的列表、素材层按广告逐个查，串行
 * 起来一个账户就是几分钟。但这里不能无脑 Promise.all——同一个 Cookie 会话同时打
 * 出几十个请求，TikTok 那边是会限流的，而限流在本项目里的代价不只是慢：一轮同步
 * 被判 partial，删除和自动复制都要求最近一次同步取全，会连带跳过。
 *
 * 因此统一走这个带上限的池子，并发度由调用方按层级各自决定。
 *
 * 结果**按入参下标返回**，与串行时完全一致。这一点不是锦上添花：素材层的
 * materialUnavailableAdIds、各层的告警文案都会进快照和界面，顺序漂移会让同一份
 * 数据在两轮之间看起来不一样。
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  limit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const effectiveLimit = Math.max(1, Math.min(Math.trunc(limit), items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runLane = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  };

  // 任何一条泳道抛出都要让整体抛出（与串行时 for 循环里直接 throw 的语义一致），
  // 但必须等所有泳道结束再抛：否则先抛出的那个会让其余在途请求变成无人接管的
  // 悬空 Promise，Node 会按未处理拒绝处理掉。
  const lanes = Array.from({ length: effectiveLimit }, () => runLane());
  const settled = await Promise.allSettled(lanes);
  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure && failure.status === "rejected") throw failure.reason;
  return results;
}
