import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { downloadFilename, type Catalog } from "../download/download";
import type { DownloadLog } from "../download/index";
import { logEvent } from "../shared/log";
import { publicList, validateDevices, type DeviceList } from "./devices";
import { buildMime, chooseFormat, classifySesError, CONTENT_TYPES, KINDLE_MAX_BYTES } from "./lib";
import { callerEmail } from "../shared/caller";

/** A read of the settings row, plus the opaque version a client sends back on a write. */
export interface StoredDevices extends DeviceList { version: string | null }
export type SetDevicesResult = { ok: true; version: string | null } | { ok: false; reason: "stale" };

export interface KindleStore {
  getDevices(email: string): Promise<StoredDevices>;
  /**
   * An empty list deletes the settings row. `expectedVersion` is the version the caller
   * last read: `undefined` writes unconditionally (an older client), `null` requires that
   * no row exists, and a string requires the row to still carry that `updatedAt`.
   */
  setDevices(email: string, list: DeviceList, updatedAt: string, expectedVersion?: string | null): Promise<SetDevicesResult>;
}
export interface Sender { send(raw: string, tags: Record<string, string>): Promise<{ messageId: string }> }
export interface Deps {
  store: KindleStore;
  loadCatalog: () => Promise<Catalog>;
  loadObject: (s3Key: string) => Promise<Uint8Array>;
  sender: Sender;
  logSend: (row: DownloadLog) => Promise<void>;
  now: () => Date;
  senderAddress: string;
}

export const NOT_ENABLED_MESSAGE = "Kindle delivery isn't enabled for everyone yet";
export const STALE_MESSAGE = "Your devices changed in another tab — reload and try again";
export const TOO_LARGE_MESSAGE = "Too large for Kindle delivery — download instead";

// SES email-tag values allow only [A-Za-z0-9_-]; an email address does not fit, so hex-encode it.
export const tagValue = (email: string): string => Buffer.from(email, "utf8").toString("hex");

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
/**
 * A `version` the client read back from us, or no expectation at all. Anything that is
 * neither a non-empty string nor an explicit null — including the absent field an older
 * client sends through the deploy window — writes unconditionally, as it does today.
 */
function expectedVersion(body: Record<string, unknown>): string | null | undefined {
  if (typeof body.version === "string" && body.version) return body.version;
  return body.version === null ? null : undefined;
}
function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try { const v: unknown = JSON.parse(body); return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

async function sendBook(email: string, body: Record<string, unknown>, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const bookId = body.bookId;
  if (typeof bookId !== "string" || !bookId) return json(400, { error: "bad_request", message: "Body must be JSON {bookId, format?}" });
  const requested = typeof body.format === "string" ? body.format.toLowerCase() : undefined;

  const { devices, defaultDeviceId } = await deps.store.getDevices(email);
  if (devices.length === 0) return json(409, { error: "no_address" });
  const requestedDeviceId = typeof body.deviceId === "string" && body.deviceId ? body.deviceId : undefined;
  const device = requestedDeviceId
    ? devices.find((d) => d.id === requestedDeviceId)
    : devices.find((d) => d.id === defaultDeviceId) ?? devices[0];
  if (!device) return json(400, { error: "unknown_device", message: "That device is no longer saved — reload and try again" });

  let catalog: Catalog;
  try {
    catalog = await deps.loadCatalog();
  } catch (e) {
    console.error("kindle catalog load failed:", e);
    logEvent("kindle.send_failed", { email, bookId, deviceId: device.id, code: "failed", stage: "catalog", reason: (e as Error).message }, deps.now);
    return json(502, { error: "failed", message: "Could not read the book from storage" });
  }
  const book = catalog.books.find((b) => b.id === bookId);
  if (!book) return json(404, { error: "unknown_book" });
  const format = chooseFormat(book, requested);
  if (!format) return json(400, { error: "unsupported" });
  if (format.size > KINDLE_MAX_BYTES) {
    logEvent("kindle.oversize", { email, bookId, format: format.type, bytes: format.size }, deps.now);
    return json(413, { error: "too_large", message: TOO_LARGE_MESSAGE, bytes: format.size, limit: KINDLE_MAX_BYTES });
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.loadObject(format.s3Key);
  } catch (e) {
    console.error("kindle object load failed:", e);
    logEvent("kindle.send_failed", { email, bookId, deviceId: device.id, code: "failed", stage: "object", reason: (e as Error).message }, deps.now);
    return json(502, { error: "failed", message: "Could not read the book from storage" });
  }
  if (bytes.byteLength > KINDLE_MAX_BYTES) {
    logEvent("kindle.oversize", { email, bookId, format: format.type, bytes: bytes.byteLength }, deps.now);
    return json(413, { error: "too_large", message: TOO_LARGE_MESSAGE, bytes: bytes.byteLength, limit: KINDLE_MAX_BYTES });
  }
  const type = format.type as "epub" | "pdf";
  const raw = buildMime({
    from: deps.senderAddress, to: device.address, subject: book.title,
    filename: downloadFilename(book.title, type, book.id), contentType: CONTENT_TYPES[type], body: bytes, date: deps.now(),
  });
  let messageId: string;
  try {
    ({ messageId } = await deps.sender.send(raw, { recipient: tagValue(email), bookId, deviceId: device.id }));
  } catch (e) {
    const code = classifySesError(e);
    console.error("kindle send failed:", e);
    logEvent("kindle.send_failed", { email, bookId, format: type, deviceId: device.id, code, reason: (e as Error).message }, deps.now);
    return json(502, { error: code, message: code === "not_enabled" ? NOT_ENABLED_MESSAGE : "Could not send the book right now" });
  }
  const timestamp = deps.now().toISOString();
  try {
    await deps.logSend({ email, sk: `${timestamp}#${bookId}`, bookId, format: `kindle:${type}`, title: book.title, timestamp });
  } catch (e) {
    console.error("kindle log row failed:", e);
    logEvent("kindle.send_failed", { email, bookId, format: type, deviceId: device.id, code: "log", reason: (e as Error).message }, deps.now);
  }
  logEvent("kindle.sent", { email, bookId, format: type, deviceId: device.id, bytes: bytes.byteLength, sesMessageId: messageId }, deps.now);
  return json(202, { sentTo: device.address, format: type, deviceId: device.id, deviceLabel: device.label });
}

export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const email = callerEmail(claims);
  if (!email) return json(401, { error: "unauthorized", message: "Token has no email claim (send the ID token)" });
  try {
    if (method === "GET" && path === "/api/kindle/devices") {
      const stored = await deps.store.getDevices(email);
      return json(200, { ...publicList(stored), version: stored.version });
    }
    if (method === "PUT" && path === "/api/kindle/devices") {
      const body = parseBody(event.body);
      if (!Array.isArray(body.devices)) {
        return json(400, { error: "bad_request", message: "Body must be JSON {devices, defaultDeviceId?}" });
      }
      const existing = await deps.store.getDevices(email);
      const result = validateDevices(body.devices, body.defaultDeviceId, existing, deps.now().toISOString());
      if (!result.ok) return json(400, { error: result.error, message: result.message });
      const written = await deps.store.setDevices(email, result.list, deps.now().toISOString(), expectedVersion(body));
      // Another tab wrote between this client's read and its save. Dropping a device is
      // how a legitimate removal is expressed, so the write has to be refused outright.
      if (!written.ok) return json(409, { error: "stale", message: STALE_MESSAGE });
      return json(200, { ...publicList(result.list), version: written.version });
    }
    if (method === "POST" && path === "/api/kindle/send") {
      return await sendBook(email, parseBody(event.body), deps);
    }
    return json(404, { error: "not_found" });
  } catch (e) {
    console.error("kindle handler failed:", e);
    return json(500, { error: "internal", message: "Internal error" });
  }
}

// ---- production wiring (never exercised by tests) ----
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoKindleStore } from "./store";

const CATALOG_TTL_MS = 60_000;
let productionDeps: Deps | undefined;
let catalogCache: { catalog: Catalog; at: number } | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  if (!productionDeps) {
    const s3 = new S3Client({});
    const ses = new SESv2Client({ maxAttempts: 2 });
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const env = (k: string) => process.env[k] ?? "";
    productionDeps = {
      store: new DynamoKindleStore(ddb, env("LIBRARY_TABLE")),
      loadCatalog: async () => {
        if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog;
        const out = await s3.send(new GetObjectCommand({ Bucket: env("SITE_BUCKET"), Key: "catalog.json" }));
        const catalog = JSON.parse(await out.Body!.transformToString()) as Catalog;
        catalogCache = { catalog, at: Date.now() };
        return catalog;
      },
      loadObject: async (key) => {
        const out = await s3.send(new GetObjectCommand({ Bucket: env("BOOKS_BUCKET"), Key: key }));
        return out.Body!.transformToByteArray();
      },
      sender: {
        send: async (raw, tags) => {
          const out = await ses.send(new SendEmailCommand({
            FromEmailAddress: env("KINDLE_SENDER"),
            Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
            ConfigurationSetName: env("KINDLE_CONFIG_SET"),
            EmailTags: Object.entries(tags).map(([Name, Value]) => ({ Name, Value })),
          }));
          return { messageId: out.MessageId ?? "" };
        },
      },
      logSend: async (row) => { await ddb.send(new PutCommand({ TableName: env("DOWNLOADS_TABLE"), Item: row })); },
      now: () => new Date(),
      senderAddress: env("KINDLE_SENDER"),
    };
  }
  return handle(event, productionDeps);
};
