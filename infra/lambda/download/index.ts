import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { Catalog, downloadFilename, findFormat, parseRequest } from "./download";

export const URL_TTL_SECONDS = 900;
const CATALOG_TTL_MS = 60_000;

export interface DownloadLog {
  email: string; sk: string; bookId: string; format: string; title: string; timestamp: string;
}

export interface Deps {
  loadCatalog: () => Promise<Catalog>;
  presign: (key: string, filename: string) => Promise<string>;
  logDownload: (item: DownloadLog) => Promise<void>;
  now: () => Date;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const req = parseRequest(event.body);
  if (!req) return json(400, { error: "Body must be JSON {bookId, format}" });

  const email = String(event.requestContext.authorizer.jwt.claims.email ?? "");
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
    const url = await deps.presign(hit.format.s3Key, filename);
    return json(200, { url, expiresIn: URL_TTL_SECONDS, filename });
  } catch {
    return json(502, { error: "Download unavailable" });
  }
}

// ---- production wiring (never exercised by tests) ----
let s3: S3Client | undefined;
let ddb: DynamoDBDocumentClient | undefined;
let catalogCache: { catalog: Catalog; at: number } | undefined;

async function loadCatalogFromS3(): Promise<Catalog> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog;
  s3 ??= new S3Client({});
  const out = await s3.send(new GetObjectCommand({ Bucket: process.env.SITE_BUCKET, Key: "catalog.json" }));
  const catalog = JSON.parse(await out.Body!.transformToString()) as Catalog;
  catalogCache = { catalog, at: Date.now() };
  return catalog;
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
    ddb ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
    await ddb.send(new PutCommand({ TableName: process.env.DOWNLOADS_TABLE, Item: item }));
  },
  now: () => new Date(),
};

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => handle(event, productionDeps);
