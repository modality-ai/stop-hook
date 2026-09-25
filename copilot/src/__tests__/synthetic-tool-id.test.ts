import { describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { isTrustedSyntheticToolId } from "../synthetic-tool-id";

const SECRET = "test-secret";
const sign = (baseId: string, secret = SECRET) =>
  `${baseId}_${createHmac("sha256", secret).update(baseId).digest("hex").slice(0, 16)}`;

describe("isTrustedSyntheticToolId", () => {
  test("rejects non-synthetic ids regardless of secret", () => {
    expect(isTrustedSyntheticToolId("toolu_abc123", undefined)).toBe(false);
    expect(isTrustedSyntheticToolId("toolu_abc123", SECRET)).toBe(false);
  });

  test("trusts prefix alone when no secret is configured", () => {
    expect(isTrustedSyntheticToolId("toolu_herodeploy_xyz", undefined)).toBe(true);
  });

  test("accepts a correctly signed id", () => {
    for (const kind of ["herodeploy", "toolsearch", "warmup"]) {
      expect(isTrustedSyntheticToolId(sign(`toolu_${kind}_m1abc`), SECRET)).toBe(true);
    }
  });

  test("rejects unsigned, forged, or wrong-secret ids when secret is set", () => {
    expect(isTrustedSyntheticToolId("toolu_herodeploy_m1abc", SECRET)).toBe(false);
    expect(isTrustedSyntheticToolId("toolu_herodeploy_m1abc_0000000000000000", SECRET)).toBe(false);
    expect(isTrustedSyntheticToolId(sign("toolu_herodeploy_m1abc", "other"), SECRET)).toBe(false);
  });

  test("rejects a signature whose base id lost the synthetic prefix", () => {
    expect(isTrustedSyntheticToolId(sign("toolu_herodeploy"), SECRET)).toBe(false);
  });

  test("rejects a non-hex signature without throwing", () => {
    expect(isTrustedSyntheticToolId("toolu_herodeploy_m1abc_😀😀😀😀😀😀😀😀", SECRET)).toBe(false);
  });

  test("treats an empty secret as unconfigured", () => {
    expect(isTrustedSyntheticToolId("toolu_herodeploy_xyz", "")).toBe(true);
  });

  test("rejects an uppercase-hex signature", () => {
    const signed = sign("toolu_herodeploy_m1abc");
    const upper = signed.replace(/_([0-9a-f]{16})$/, (_, sig) => `_${sig.toUpperCase()}`);
    expect(isTrustedSyntheticToolId(upper, SECRET)).toBe(false);
  });

  test("rejects a signature truncated to fewer than 16 hex chars", () => {
    expect(isTrustedSyntheticToolId(sign("toolu_herodeploy_m1abc").slice(0, -1), SECRET)).toBe(false);
  });

  test("rejects a synthetic prefix that is not at the start of the id", () => {
    expect(isTrustedSyntheticToolId("x_toolu_herodeploy_m1abc", undefined)).toBe(false);
  });

  test("reads the secret from SYNTHETIC_TOOL_ID_SECRET by default", () => {
    const previous = process.env.SYNTHETIC_TOOL_ID_SECRET;
    process.env.SYNTHETIC_TOOL_ID_SECRET = SECRET;
    try {
      expect(isTrustedSyntheticToolId("toolu_herodeploy_m1abc")).toBe(false);
      expect(isTrustedSyntheticToolId(sign("toolu_herodeploy_m1abc"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SYNTHETIC_TOOL_ID_SECRET;
      else process.env.SYNTHETIC_TOOL_ID_SECRET = previous;
    }
  });
});
