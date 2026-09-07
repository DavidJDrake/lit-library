import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BookCategory, Category, Store, Suggestion } from "./index";

type Item = Record<string, unknown>;

function isNamed(e: unknown, name: string): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === name;
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
      if (isNamed(e, "TransactionCanceledException")) return false;
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
      if (isNamed(e, "TransactionCanceledException")) return false;
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
      if (isNamed(e, "TransactionCanceledException")) return false;
      throw e;
    }
  }
}
