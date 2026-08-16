import { describe, expect, it } from "vitest";
import {
  MetaAccessProfileInputSchema,
  MetaAccessSecretBundleInputSchema,
  MetaAccountBindingSchema,
} from "./meta-access-profile.js";

describe("Meta access profile contract", () => {
  it("keeps Business Portfolio optional while validating account bindings", () => {
    expect(MetaAccessProfileInputSchema.parse({
      name: "主 Meta App",
      appId: "1570051734766701",
      businessId: "",
      graphApiVersion: "v26.0",
    })).toMatchObject({ businessId: null });

    expect(MetaAccountBindingSchema.parse({
      profileId: "019ff602-985a-7d21-a51e-4e8cb2186bbc",
      adAccountId: "act_1587327066068704",
      pageId: "",
    })).toMatchObject({ pageId: null });
  });

  it("requires App Secret and access token to rotate as one secret bundle", () => {
    expect(MetaAccessSecretBundleInputSchema.parse({
      appSecret: "secret-value",
      accessToken: "access-token-value-at-least-twenty",
    })).toMatchObject({ appSecret: "secret-value" });
    expect(() => MetaAccessSecretBundleInputSchema.parse({
      appSecret: "short",
      accessToken: "short",
    })).toThrow();
  });

  it("rejects malformed app, business, and account identifiers", () => {
    expect(() => MetaAccessProfileInputSchema.parse({
      name: "bad",
      appId: "app_123",
      businessId: "bm_123",
      graphApiVersion: "latest",
    })).toThrow();
    expect(() => MetaAccountBindingSchema.parse({
      profileId: "not-a-uuid",
      adAccountId: "1587",
      pageId: null,
    })).toThrow();
  });
});
