import { createHmac, timingSafeEqual } from "crypto";

const PREFIX_RE = /^toolu_(herodeploy|toolsearch|warmup)_/;
const SIGNATURE_RE = /^[0-9a-f]{16}$/;

export function isTrustedSyntheticToolId(
  toolId: string,
  secret: string | undefined = process.env.SYNTHETIC_TOOL_ID_SECRET,
): boolean {
  if (!PREFIX_RE.test(toolId)) return false;
  if (!secret) return true;

  const separatorIndex = toolId.lastIndexOf("_");
  const baseId = toolId.slice(0, separatorIndex);
  const signature = toolId.slice(separatorIndex + 1);

  if (!SIGNATURE_RE.test(signature) || !PREFIX_RE.test(baseId)) return false;

  const expected = createHmac("sha256", secret)
    .update(baseId)
    .digest("hex")
    .slice(0, 16);

  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
