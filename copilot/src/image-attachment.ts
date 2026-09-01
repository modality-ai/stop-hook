// Pure image-attachment helpers. This logic is intentionally isolated from
// copilot-to-openai.ts (a heavy side-effect module that boots the Copilot SDK
// client), so it can be unit-tested without network or process side effects.

export type BlobAttachment = {
  type: "blob";
  data: string;
  mimeType: string;
  displayName?: string;
};

// Extract an inline Base64 data URL of the form `data:<mime>;base64,<data>`.
// Only accepts image/* MIME types. Returns null for anything else.
export function parseDataImageUrl(url: string): BlobAttachment | null {
  const match = url.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) return null;
  const mimeType = match[1].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) return null;
  return { type: "blob", mimeType, data: match[2] };
}

// The OpenAI Chat Completions `image_url` content part accepts an image in
// three ways (per their vision docs): a fully-qualified HTTP(S) URL, a
// Base64-encoded data URL, or a Files API file id. ALWAYS follow the OpenAI
// standard — accept both of the self-contained forms here; never reject a
// valid HTTP(S) image URL. The Copilot SDK only accepts inline base64 blobs,
// so remote URLs are fetched and inlined before being forwarded.
export async function imageUrlToAttachment(url: string): Promise<BlobAttachment | null> {
  // Base64 data URL — no network needed.
  const dataAtt = parseDataImageUrl(url);
  if (dataAtt) return dataAtt;

  // Fully-qualified HTTP(S) image URL — fetch and inline as base64.
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const rawContentType = res.headers.get("content-type") ?? "application/octet-stream";
      const mimeType = rawContentType.split(";")[0].trim().toLowerCase();
      if (!mimeType.startsWith("image/")) return null;
      const data = Buffer.from(new Uint8Array(await res.arrayBuffer())).toString("base64");
      return { type: "blob", mimeType, data };
    } catch {
      return null;
    }
  }

  // Anything else (relative path, file id, non-http scheme) is unsupported.
  return null;
}
