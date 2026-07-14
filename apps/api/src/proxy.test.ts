import { describe, expect, it } from "vitest";
import { resolveOutboundProxy } from "./proxy.js";

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
