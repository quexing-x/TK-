/**
 * 展开 Error.cause 链上的底层原因。
 *
 * undici 的网络失败一律只留一句 `fetch failed`，真正的原因（ECONNREFUSED /
 * ENOTFOUND / 证书错误等）藏在 cause 里。不展开的话，用户和排障都只能看到一句
 * 没有任何指向性的话。
 *
 * 只取错误码；没有错误码时才退回到 message，并截断长度——避免把上游返回的长文本
 * 原样写进审计记录。
 */
export function describeErrorCause(error: Error): string {
  const parts: string[] = [];
  let current: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    const text = (code ?? current.message ?? "").trim().slice(0, 120);
    if (text && !parts.includes(text)) parts.push(text);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
}

/**
 * 附加了 describeErrorCause 展开结果的错误消息；没有更多细节时原样返回。
 */
export function withCauseDetail(message: string, cause: unknown): string {
  if (!(cause instanceof Error)) return message;
  const detail = describeErrorCause(cause);
  return detail ? `${message}（${detail}）` : message;
}

/**
 * 是否是我们自己的 AbortSignal.timeout 触发的超时。
 *
 * 这类失败和"对端拒绝服务"不是一回事：请求多半已经发出去、对端也在处理，只是
 * 我们设的预算到了就撒手。判据是顶层 error.name === "TimeoutError"（DOMException），
 * 而不是 cause 链上的错误码——超时错误根本没有 errno。
 */
export function isRequestTimeoutError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "TimeoutError";
}

/**
 * 错误码集合，凭经验实测钉死（node --version 24，undici 内置 fetch）：
 *
 *   ECONNREFUSED  —— 目标端口拒绝连接：TCP 三次握手在第一步就被拒绝，
 *                     请求字节从未离开本机。
 *   ENOTFOUND     —— DNS 解析失败：连目标 IP 都没拿到，同样什么都没发出去。
 *   EHOSTUNREACH / ENETUNREACH —— 路由层面不可达，同样发生在建立连接之前。
 *
 * 关键点：这几种错误发生在“连接建立”这一步之前，可以从数学上证明本次请求
 * 100% 没有被对端服务器收到，因此重放同一个请求不存在产生重复写入的风险，
 * 不管这是任务里的第几个请求。
 *
 * 反例（刻意不包含在内，因为都无法证明请求没发出去）：
 *   ECONNRESET —— 连接是在“已建立”之后被对端或中间设备重置的，请求体
 *                 可能已经发出、甚至可能已经被处理。
 *   AbortSignal.timeout 触发的超时 —— 顶层 error.name 是 "TimeoutError"，
 *                 不是 "fetch failed"；连接可能已经建立、请求可能已经发出，
 *                 只是我们自己等不到响应就放弃了。
 */
const DEFINITELY_UNSENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // undici 的连接阶段超时：TCP 握手本身还没完成就放弃，同样没有发出请求。
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * 判断一次网络失败是否可以在数学上证明「请求从未发出」，因而可以安全地原样
 * 重试而不会产生重复写入。
 *
 * 只看 cause 链上第一层的错误码——这是 fetch/undici 实际放置错误码的位置
 * （顶层 TypeError 本身没有 .code，见 describeErrorCause 的实测记录）。
 */
export function isDefinitelyUnsentNetworkError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const code = (cause as NodeJS.ErrnoException).code
    ?? ((cause as { cause?: unknown }).cause instanceof Error
      ? ((cause as { cause?: NodeJS.ErrnoException }).cause as NodeJS.ErrnoException).code
      : undefined);
  return typeof code === "string" && DEFINITELY_UNSENT_ERROR_CODES.has(code);
}
