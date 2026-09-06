import type { Book, BookFormat } from "../catalog/types";

export const KINDLE_MAX_BYTES = 28 * 1024 * 1024; // mirrors the Lambda's limit (SES 40 MB raw after base64)
export const KINDLE_ADDRESS_RE = /^[A-Za-z0-9._+-]+@kindle\.com$/i;
export const KINDLE_HELP_URL = "https://www.amazon.com/hz/mycd/myx#/home/settings/payment";
export const MAX_LABEL = 30;

export function kindleFormat(book: Book, requested?: "epub" | "pdf"): BookFormat | undefined {
  if (requested) return book.formats.find((f) => f.type === requested);
  return book.formats.find((f) => f.type === "epub") ?? book.formats.find((f) => f.type === "pdf");
}
