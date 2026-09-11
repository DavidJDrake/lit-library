import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { logEvent } from "../shared/log";
import { Catalog, downloadFilename, findFormat, parseRequest } from "./download";
import { buildOpdsFeed, OPDS_MEDIA_TYPE } from "./opds-feed";
import { DynamoOpdsTokenStore, type OpdsTokenResolver } from "./opds-store";
import { matchRoute } from "./routes";
import { callerEmail } from "../shared/caller";

export const URL_TTL_SECONDS = 900;
const CATALOG_TTL_MS = 60_000;
const OPDS_FEED_TITLE = "Lit Library";

export interface DownloadLog {
  email: string; sk: string; bookId: string; format: string; title: string; timestamp: string;
}

export interface Deps {
  loadCatalog: () => Promise<Catalog>;
  presign: (key: string, filename: string) => Promise<string>;
  logDownload: (item: DownloadLog) => Promise<void>;
  now: () => Date;
  /** Resolves an OPDS token to its reader's email; read-only (see opds-store.ts). */
  opds: OpdsTokenResolver;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Every unauthenticated failure — missing, unknown, malformed, or revoked token — answers
// identically: a bare 401 with no message. Nothing here ever hints whether the token was
// merely wrong versus which book or format was requested.
const unauthorized = (): APIGatewayProxyResultV2 => json(401, { error: "unauthorized" });

async function handleDownload(event: APIGatewayProxyEventV2, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const req = parseRequest(event.body);
  if (!req) return json(400, { error: "Body must be JSON {bookId, format}" });

  // Same-shape access as before this file grew OPDS routes: this route still requires
  // the real Cognito JWT authorizer, which is what actually populates this claim.
  const claims = (event.requestContext as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer?.jwt?.claims ?? {};
  const email = callerEmail(claims);
  if (!email) return json(401, { error: "Token has no email claim (send the ID token)" });

  let catalog: Catalog;
  try {
    catalog = await deps.loadCatalog();
  } catch {
    return json(502, { error: "Catalog unavailable" });
  }

  const hit = findFormat(catalog, req);
  if (!hit) return json(404, { error: "Unknown book or format" });

  const filename = downloadFilename(hit.book.title, hit.format.type, hit.book.id);
  const timestamp = deps.now().toISOString();
  try {
    await deps.logDownload({
      email, sk: `${timestamp}#${req.bookId}`, bookId: req.bookId,
      format: req.format, title: hit.book.title, timestamp,
    });
    logEvent("download.issued", { email, bookId: req.bookId, format: req.format }, deps.now);
    const url = await deps.presign(hit.format.s3Key, filename);
    return json(200, { url, expiresIn: URL_TTL_SECONDS, filename });
  } catch {
    return json(502, { error: "Download unavailable" });
  }
}

function tokenOf(event: APIGatewayProxyEventV2): string | undefined {
  const t = event.queryStringParameters?.token;
  return typeof t === "string" && t ? t : undefined;
}

const opdsFeedPath = "/api/opds";
const opdsAcquirePath = (bookId: string, format: string) =>
  `/api/opds/download/${encodeURIComponent(bookId)}/${encodeURIComponent(format)}`;
const withToken = (path: string, token: string) => `${path}?token=${encodeURIComponent(token)}`;

async function handleFeed(event: APIGatewayProxyEventV2, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const token = tokenOf(event);
  const email = token ? await deps.opds.resolveToken(token) : undefined;
  if (!email || !token) return unauthorized();

  let catalog: Catalog;
  try {
    catalog = await deps.loadCatalog();
  } catch {
    return json(502, { error: "Catalog unavailable" });
  }

  const feed = buildOpdsFeed(catalog, OPDS_FEED_TITLE, {
    self: withToken(opdsFeedPath, token),
    acquisitionOf: (bookId, format) => withToken(opdsAcquirePath(bookId, format), token),
  });
  return { statusCode: 200, headers: { "content-type": OPDS_MEDIA_TYPE }, body: JSON.stringify(feed) };
}

async function handleAcquire(bookId: string, format: string, event: APIGatewayProxyEventV2, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const token = tokenOf(event);
  const email = token ? await deps.opds.resolveToken(token) : undefined;
  if (!email) return unauthorized();

  let catalog: Catalog;
  try {
    catalog = await deps.loadCatalog();
  } catch {
    return json(502, { error: "Catalog unavailable" });
  }

  const hit = findFormat(catalog, { bookId, format });
  if (!hit) return json(404, { error: "Unknown book or format" });

  const filename = downloadFilename(hit.book.title, hit.format.type, hit.book.id);
  const timestamp = deps.now().toISOString();
  try {
    // Same DownloadLog shape the website's own download route writes (see backlog #27
    // on the existing inconsistency there) — a book fetched through a reader app counts
    // as downloaded and shows on the card exactly like one fetched from the site.
    await deps.logDownload({
      email, sk: `${timestamp}#${bookId}`, bookId, format, title: hit.book.title, timestamp,
    });
    logEvent("download.issued", { email, bookId, format, via: "opds" }, deps.now);
    const url = await deps.presign(hit.format.s3Key, filename);
    return { statusCode: 302, headers: { location: url } };
  } catch {
    return json(502, { error: "Download unavailable" });
  }
}

export async function handle(event: APIGatewayProxyEventV2, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const route = matchRoute(event.requestContext.http.method, event.rawPath);
  if (!route) return json(404, { error: "Not found" });
  switch (route.kind) {
    case "download": return handleDownload(event, deps);
    case "feed": return handleFeed(event, deps);
    case "acquire": return handleAcquire(route.bookId, route.format, event, deps);
  }
}

// ---- production wiring (never exercised by tests) ----
let s3: S3Client | undefined;
let ddb: DynamoDBDocumentClient | undefined;
let opdsStore: DynamoOpdsTokenStore | undefined;
let catalogCache: { catalog: Catalog; at: number } | undefined;

async function loadCatalogFromS3(): Promise<Catalog> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog;
  s3 ??= new S3Client({});
  const out = await s3.send(new GetObjectCommand({ Bucket: process.env.SITE_BUCKET, Key: "catalog.json" }));
  const catalog = JSON.parse(await out.Body!.transformToString()) as Catalog;
  catalogCache = { catalog, at: Date.now() };
  return catalog;
}

function getDdb(): DynamoDBDocumentClient {
  ddb ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return ddb;
}

const productionDeps: Deps = {
  loadCatalog: loadCatalogFromS3,
  presign: (key, filename) => {
    s3 ??= new S3Client({});
    return getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.BOOKS_BUCKET, Key: key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: URL_TTL_SECONDS },
    );
  },
  logDownload: async (item) => {
    await getDdb().send(new PutCommand({ TableName: process.env.DOWNLOADS_TABLE, Item: item }));
  },
  now: () => new Date(),
  opds: {
    resolveToken: (token) => {
      opdsStore ??= new DynamoOpdsTokenStore(getDdb(), process.env.LIBRARY_TABLE ?? "");
      return opdsStore.resolveToken(token);
    },
  },
};

export const handler = (event: APIGatewayProxyEventV2) => handle(event, productionDeps);
