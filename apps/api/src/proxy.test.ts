import { describe, expect, it, vi } from "vitest";
import {
  resolveOutboundProxy,
  startOutboundProxyWatcher,
  type OutboundProxyConfig,
} from "./proxy.js";

describe("outbound proxy resolution", () => {
  it("prefers an explicit HTTPS proxy", () => {
    expect(
      resolveOutboundProxy(
        { HTTPS_PROXY: "http://127.0.0.1:9000" },
        "127.0.0.1:8800",
      ),
    ).toEqual({
      source: "environment",
      url: "http://127.0.0.1:9000/",
    });
  });

  it("uses the Windows system proxy when no environment proxy exists", () => {
    expect(resolveOutboundProxy({}, "127.0.0.1:8800")).toEqual({
      source: "windows-system",
      url: "http://127.0.0.1:8800/",
    });
  });
});

describe("outbound proxy watcher", () => {
  const proxy = (url: string): OutboundProxyConfig => ({
    source: "windows-system",
    url,
  });

  it("后台程序早于代理客户端启动时，代理起来后自动切过去", () => {
    // 这正是真实故障：调度器开机自启，此刻系统代理还没写入注册表，解析结果是直连。
    let resolved: OutboundProxyConfig | null = null;
    const apply = vi.fn(() => null);
    const watcher = startOutboundProxyWatcher({
      initial: null,
      resolve: () => resolved,
      apply,
    });

    // 代理还没起来：不应该有任何切换。
    expect(watcher.refresh()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(watcher.current()).toBeNull();

    // 代理起来了。
    resolved = proxy("http://127.0.0.1:10808/");
    expect(watcher.refresh()).toBe(true);
    expect(apply).toHaveBeenCalledWith(proxy("http://127.0.0.1:10808/"));
    expect(watcher.current()).toEqual(proxy("http://127.0.0.1:10808/"));

    watcher.stop();
  });

  it("解析结果不变时不重建连接池", () => {
    const apply = vi.fn(() => null);
    const watcher = startOutboundProxyWatcher({
      initial: proxy("http://127.0.0.1:10808/"),
      resolve: () => proxy("http://127.0.0.1:10808/"),
      apply,
    });

    expect(watcher.refresh()).toBe(false);
    expect(watcher.refresh()).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("代理被关闭后复位成直连", () => {
    let resolved: OutboundProxyConfig | null = proxy("http://127.0.0.1:10808/");
    const apply = vi.fn(() => null);
    const onChange = vi.fn();
    const watcher = startOutboundProxyWatcher({
      initial: resolved,
      resolve: () => resolved,
      apply,
      onChange,
    });

    resolved = null;
    expect(watcher.refresh()).toBe(true);
    // 必须显式复位，否则会继续用已经失效的代理连接池。
    expect(apply).toHaveBeenCalledWith(null);
    expect(onChange).toHaveBeenCalledWith(null, proxy("http://127.0.0.1:10808/"));

    watcher.stop();
  });

  it("解析抛错时保持现状，等下一轮重试", () => {
    const apply = vi.fn(() => null);
    const watcher = startOutboundProxyWatcher({
      initial: proxy("http://127.0.0.1:10808/"),
      resolve: () => { throw new Error("reg.exe timed out"); },
      apply,
    });

    expect(watcher.refresh()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(watcher.current()).toEqual(proxy("http://127.0.0.1:10808/"));

    watcher.stop();
  });

  it("按间隔自动重新解析，不需要外部触发", () => {
    vi.useFakeTimers();
    try {
      let resolved: OutboundProxyConfig | null = null;
      const apply = vi.fn(() => null);
      const watcher = startOutboundProxyWatcher({
        intervalMs: 1_000,
        initial: null,
        resolve: () => resolved,
        apply,
      });

      resolved = proxy("http://127.0.0.1:10808/");
      vi.advanceTimersByTime(1_000);
      expect(apply).toHaveBeenCalledWith(proxy("http://127.0.0.1:10808/"));

      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
