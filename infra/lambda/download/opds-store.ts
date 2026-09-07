import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { hashOpdsToken, isPlausibleOpdsToken, opdsTokenPk, OPDS_TOKEN_SK } from "../shared/opds-token";

export interface OpdsTokenResolver {
  /** The reader's email for a valid, active token; undefined for anything else. */
  resolveToken(token: string): Promise<string | undefined>;
}

// Read-only by design: a GetItem on the token's hash is the only OPDS-related access
// this Lambda is granted on the library table (see infra/lib/ebook-share-stack.ts).
// It cannot create, list, or delete a token — only the library Lambda, already
// read-write on this table for its own settings rows, does that.
export class DynamoOpdsTokenStore implements OpdsTokenResolver {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async resolveToken(token: string): Promise<string | undefined> {
    if (!isPlausibleOpdsToken(token)) return undefined;
    const hash = hashOpdsToken(token);
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: opdsTokenPk(hash), sk: OPDS_TOKEN_SK } }));
    const email = out.Item?.email;
    return typeof email === "string" && email ? email : undefined;
  }
}
