import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BookCategory, Category, ReadingStatus, ReadingStatusRow, Store, Suggestion } from "./index";

// Per-reader rows share the library table with everything else, keyed by pk = USER#<email>
// (lowercased, matching the Kindle settings row at the same pk) so one query returns both —
// see queryPrefix below, which scopes to the STATUS# rows only rather than the whole partition.
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;
const STATUS_PREFIX = "STATUS#";

type Item = Record<string, unknown>;

function isNamed(e: unknown, name: string): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === name;
}

// TransactionCanceledException fires for a transaction conflict, throttling, or a
// validation problem, not only a failed ConditionExpression: only its CancellationReasons
// entries say which. Treat it as "a condition genuinely failed" only when one of them is
// ConditionalCheckFailed; anything else (including no reasons at all) must propagate as a
// real failure rather than being reported as an ordinary 409-shaped outcome.
function isConditionFailure(e: unknown): boolean {
  if (!isNamed(e, "TransactionCanceledException")) return false;
  const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code === "ConditionalCheckFailed");
}

function toCategory(i: Item): Category {
  return { name: String(i.sk), nameLower: String(i.nameLower), createdBy: String(i.createdBy), createdAt: String(i.createdAt), source: i.source as Category["source"] };
}
function toBook(i: Item): BookCategory {
  return { bookId: String(i.sk), category: String(i.category), changedBy: String(i.changedBy), changedAt: String(i.changedAt) };
}
function toSuggestion(i: Item): Suggestion {
  return {
    id: String(i.sk), name: String(i.name), nameLower: String(i.nameLower),
    ...(typeof i.bookId === "string" ? { bookId: i.bookId } : {}),
    suggestedBy: String(i.suggestedBy), createdAt: String(i.createdAt), status: i.status as Suggestion["status"],
    ...(typeof i.resolvedBy === "string" ? { resolvedBy: i.resolvedBy } : {}),
    ...(typeof i.resolvedAt === "string" ? { resolvedAt: i.resolvedAt } : {}),
  };
}

export class DynamoStore implements Store {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  private async queryAll(pk: string): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Item | undefined;
    do {
      const out = await this.ddb.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      items.push(...((out.Items ?? []) as Item[]));
      ExclusiveStartKey = out.LastEvaluatedKey as Item | undefined;
    } while (ExclusiveStartKey);
    return items;
  }

  // Scoped by begins_with(sk, ...) rather than a whole-partition queryAll: the same pk also
  // holds the reader's Kindle SETTINGS row, and this must return only their status rows.
  private async queryPrefix(pk: string, skPrefix: string): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Item | undefined;
    do {
      const out = await this.ddb.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": skPrefix },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      items.push(...((out.Items ?? []) as Item[]));
      ExclusiveStartKey = out.LastEvaluatedKey as Item | undefined;
    } while (ExclusiveStartKey);
    return items;
  }

  async listCategories() { return (await this.queryAll("CATEGORY")).map(toCategory); }
  async listBookCategories() { return (await this.queryAll("BOOK")).map(toBook); }
  async listPendingSuggestions() {
    return (await this.queryAll("SUGGESTION")).map(toSuggestion).filter((s) => s.status === "pending");
  }

  async getSuggestion(id: string) {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: "SUGGESTION", sk: id } }));
    return out.Item ? toSuggestion(out.Item as Item) : undefined;
  }

  private categoryItem(c: Category): Item {
    return { pk: "CATEGORY", sk: c.name, nameLower: c.nameLower, createdBy: c.createdBy, createdAt: c.createdAt, source: c.source };
  }
  private bookItem(b: BookCategory): Item {
    return { pk: "BOOK", sk: b.bookId, category: b.category, changedBy: b.changedBy, changedAt: b.changedAt };
  }

  async putCategory(c: Category) {
    try {
      await this.ddb.send(new PutCommand({ TableName: this.table, Item: this.categoryItem(c), ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (e) {
      if (isNamed(e, "ConditionalCheckFailedException")) return false;
      throw e;
    }
  }

  async putBookCategory(b: BookCategory) {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: this.bookItem(b) }));
  }

  // A reader's own reading-status rows only — never another reader's, since the pk is
  // derived from their own (lowercased) email.
  async listReadingStatuses(email: string): Promise<ReadingStatusRow[]> {
    const items = await this.queryPrefix(pkOf(email), STATUS_PREFIX);
    return items.map((i) => ({
      bookId: String(i.sk).slice(STATUS_PREFIX.length),
      status: i.status as ReadingStatus,
      updatedAt: String(i.updatedAt),
    }));
  }

  async putReadingStatus(email: string, bookId: string, status: ReadingStatus, updatedAt: string): Promise<void> {
    await this.ddb.send(new PutCommand({
      TableName: this.table, Item: { pk: pkOf(email), sk: `${STATUS_PREFIX}${bookId}`, status, updatedAt },
    }));
  }

  // Clearing a status deletes the row rather than storing an empty value.
  async deleteReadingStatus(email: string, bookId: string): Promise<void> {
    await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: `${STATUS_PREFIX}${bookId}` } }));
  }

  private nameReservationItem(nameLower: string): Item {
    return { pk: "SUGGESTION_NAME", sk: nameLower };
  }

  // Reserves the lowercased name alongside the suggestion put so two identical
  // suggestions submitted together cannot both persist as pending.
  async putSuggestion(s: Suggestion) {
    const { id, ...rest } = s;
    const TransactItems = [
      { Put: { TableName: this.table, Item: { pk: "SUGGESTION", sk: id, ...rest } } },
      { Put: { TableName: this.table, Item: this.nameReservationItem(s.nameLower), ConditionExpression: "attribute_not_exists(pk)" } },
    ];
    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async acceptSuggestion(id: string, category: Category, book: BookCategory | undefined, resolvedBy: string, resolvedAt: string) {
    const TransactItems = [
      { Put: { TableName: this.table, Item: this.categoryItem(category), ConditionExpression: "attribute_not_exists(pk)" } },
      ...(book ? [{ Put: { TableName: this.table, Item: this.bookItem(book) } }] : []),
      { Update: {
        TableName: this.table, Key: { pk: "SUGGESTION", sk: id },
        UpdateExpression: "SET #status = :accepted, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":accepted": "accepted", ":pending": "pending", ":by": resolvedBy, ":at": resolvedAt },
      } },
      // The category item now owns this name; release the reservation.
      { Delete: { TableName: this.table, Key: { pk: "SUGGESTION_NAME", sk: category.nameLower } } },
    ];
    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async rejectSuggestion(id: string, nameLower: string, resolvedBy: string, resolvedAt: string) {
    const TransactItems = [
      { Update: {
        TableName: this.table, Key: { pk: "SUGGESTION", sk: id },
        UpdateExpression: "SET #status = :rejected, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":rejected": "rejected", ":pending": "pending", ":by": resolvedBy, ":at": resolvedAt },
      } },
      // A rejected name is free to be suggested again; release the reservation.
      { Delete: { TableName: this.table, Key: { pk: "SUGGESTION_NAME", sk: nameLower } } },
    ];
    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }
}
