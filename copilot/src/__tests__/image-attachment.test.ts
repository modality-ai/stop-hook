import { describe, test, expect, mock, afterEach } from "bun:test";

// Import the REAL implementation — some image-attachment tests need network
// access, so remote-URL cases stub globalThis.fetch; data-URL cases touch no
// network at all and exercise the production code directly.
import { parseDataImageUrl, imageUrlToAttachment } from "../image-attachment";

afterEach(() => {
  // Never leak a stubbed fetch into other tests.
  if (globalThis.fetch !== fetch) (globalThis.fetch as any).mockRestore?.();
});

// ─── parseDataImageUrl ───────────────────────────────────────────────────────
describe("parseDataImageUrl", () => {
  test("parses a base64 image data URL", () => {
    const url = "data:image/png;base64,aGVsbG8=";
    expect(parseDataImageUrl(url)).toEqual({
      type: "blob",
      mimeType: "image/png",
      data: "aGVsbG8=",
    });
  });

  test("accepts any image/* mime type", () => {
    const url = "data:image/jpeg;base64,AAAA";
    expect(parseDataImageUrl(url)?.mimeType).toBe("image/jpeg");
  });

  test("accepts data URLs with media type parameters", () => {
    const url = "data:image/svg+xml;charset=utf-8;base64,AAAA";
    expect(parseDataImageUrl(url)).toEqual({
      type: "blob",
      mimeType: "image/svg+xml",
      data: "AAAA",
    });
  });

  test("rejects non-image mime types", () => {
    const url = "data:text/plain;base64,AAAA";
    expect(parseDataImageUrl(url)).toBeNull();
  });

  test("rejects a data URL without base64 encoding", () => {
    const url = "data:image/png,simple";
    expect(parseDataImageUrl(url)).toBeNull();
  });

  test("rejects a URL that is not a data URL at all", () => {
    expect(parseDataImageUrl("https://example.com/cat.png")).toBeNull();
    expect(parseDataImageUrl("")).toBeNull();
  });
});

// ─── imageUrlToAttachment ────────────────────────────────────────────────────
describe("imageUrlToAttachment", () => {
  test("inlines a base64 data URL without touching the network", async () => {
    const url = "data:image/png;base64,aGVsbG8=";
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("should not be called");
    }) as any;

    const att = await imageUrlToAttachment(url);
    expect(att).toEqual({ type: "blob", mimeType: "image/png", data: "aGVsbG8=" });
    expect(fetched).toBe(false);

    globalThis.fetch = originalFetch;
  });

  test("fetches a remote HTTP(S) image URL and inlines it as base64", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => bytes.buffer,
      }) as any) as any;

    const att = await imageUrlToAttachment("https://example.com/cat.png");
    expect(att).toEqual({
      type: "blob",
      mimeType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    });

    globalThis.fetch = originalFetch;
  });

  test("returns null when the remote response is not OK", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: false, status: 404, headers: { get: () => "image/png" } }) as any) as any;

    expect(await imageUrlToAttachment("https://example.com/missing.png")).toBeNull();

    globalThis.fetch = originalFetch;
  });

  test("returns null when the remote content-type is not an image", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        headers: { get: () => "text/html" },
        arrayBuffer: async () => new Uint8Array().buffer,
      }) as any) as any;

    expect(await imageUrlToAttachment("https://example.com/page.html")).toBeNull();

    globalThis.fetch = originalFetch;
  });

  test("returns null when the remote fetch rejects", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;

    expect(await imageUrlToAttachment("https://example.com/cat.png")).toBeNull();

    globalThis.fetch = originalFetch;
  });

  test("rejects unsupported inputs (relative paths, file ids, non-http)", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("should not be called");
    }) as any;

    expect(await imageUrlToAttachment("cat.png")).toBeNull();
    expect(await imageUrlToAttachment("file-abc123")).toBeNull();
    expect(await imageUrlToAttachment("ftp://example.com/cat.png")).toBeNull();
    expect(fetched).toBe(false);

    globalThis.fetch = originalFetch;
  });
});
