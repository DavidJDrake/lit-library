import type { CatalogBook, CatalogFormat } from "../download/download";

export const KINDLE_MAX_BYTES = 28 * 1024 * 1024; // SES raw limit is 40 MB; base64 adds ~37%
export const KINDLE_ADDRESS_RE = /^[A-Za-z0-9._+-]+@kindle\.com$/i;
export const CONTENT_TYPES: Record<"epub" | "pdf", string> = { epub: "application/epub+zip", pdf: "application/pdf" };
const ORDER: Array<"epub" | "pdf"> = ["epub", "pdf"];

/** "" → null (clear the setting); a valid address → lowercased; anything else → undefined. */
export function parseKindleAddress(raw: unknown): string | null | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s === "") return null;
  return KINDLE_ADDRESS_RE.test(s) ? s.toLowerCase() : undefined;
}

export function chooseFormat(book: CatalogBook, requested?: string): CatalogFormat | undefined {
  if (requested !== undefined) {
    return ORDER.includes(requested as "epub" | "pdf") ? book.formats.find((f) => f.type === requested) : undefined;
  }
  for (const t of ORDER) {
    const f = book.formats.find((x) => x.type === t);
    if (f) return f;
  }
  return undefined;
}

export interface MimeInput { from: string; to: string; subject: string; filename: string; contentType: string; body: Uint8Array; date?: Date }

function wrap76(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join("\r\n");
}
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/"/g, "");

export function buildMime(m: MimeInput): string {
  const date = m.date ?? new Date();
  const boundary = `----=_lit_${date.getTime().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const filename = headerSafe(m.filename);
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${headerSafe(m.subject)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    "Sent from your private library.",
    "",
    `--${boundary}`,
    `Content-Type: ${m.contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(m.body).toString("base64")),
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

export function classifySesError(e: unknown): "not_enabled" | "failed" {
  const err = e as { name?: string; message?: string };
  return err?.name === "MessageRejected" && /not verified/i.test(err.message ?? "") ? "not_enabled" : "failed";
}
