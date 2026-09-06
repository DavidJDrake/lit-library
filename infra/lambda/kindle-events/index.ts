import type { SNSEvent } from "aws-lambda";
import type { NotifyFn } from "../notifications/fanout";
import { logEvent } from "../shared/log";

export interface Deps { notify: NotifyFn; alert: (subject: string, message: string) => Promise<void>; now: () => Date }

const KINDS = new Set(["Bounce", "Complaint", "Reject"]);

interface SesEvent {
  eventType?: string;
  mail?: { messageId?: string; tags?: Record<string, string[]>; destination?: string[] };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: Array<{ diagnosticCode?: string }> };
  complaint?: { complaintFeedbackType?: string };
  reject?: { reason?: string };
}

function reasonOf(ev: SesEvent): string {
  switch (ev.eventType) {
    case "Bounce": {
      const diag = ev.bounce?.bouncedRecipients?.find((r) => r.diagnosticCode)?.diagnosticCode;
      return `${ev.bounce?.bounceType ?? "?"}/${ev.bounce?.bounceSubType ?? "?"}${diag ? `: ${diag}` : ""}`;
    }
    case "Complaint": return `complaint:${ev.complaint?.complaintFeedbackType ?? "unknown"}`;
    default: return `reject:${ev.reject?.reason ?? "unknown"}`;
  }
}
const localPart = (email: string) => email.split("@")[0];

export async function handle(event: SNSEvent, deps: Deps): Promise<{ processed: number; ignored: number }> {
  let processed = 0, ignored = 0;
  for (const record of event.Records ?? []) {
    let ev: SesEvent;
    try { ev = JSON.parse(record.Sns.Message) as SesEvent; } catch { ignored += 1; continue; }
    const kind = ev.eventType ?? "";
    const recipientHex = ev.mail?.tags?.recipient?.[0];
    if (!KINDS.has(kind) || !recipientHex) { ignored += 1; continue; }
    const recipient = Buffer.from(recipientHex, "hex").toString("utf8");
    const bookId = ev.mail?.tags?.bookId?.[0] ?? "";
    const sesMessageId = ev.mail?.messageId ?? "";
    const reason = reasonOf(ev);
    try {
      await deps.notify("kindle_bounce", { bookId, kind, reason }, [recipient], { id: sesMessageId });
      logEvent("kindle.bounce", { recipient, bookId, kind, reason, sesMessageId }, deps.now);
      await deps.alert(`Kindle delivery ${kind}: ${localPart(recipient)}`,
        `Kindle delivery ${kind} for ${recipient}\nBook: ${bookId}\nReason: ${reason}\nSES message id: ${sesMessageId}\nTime: ${deps.now().toISOString()}`);
      processed += 1;
    } catch (e) {
      console.error("kindle-events record failed:", sesMessageId, e);
      ignored += 1;
    }
  }
  return { processed, ignored };
}

// ---- production wiring (never exercised by tests) ----
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { CognitoDirectory, DynamoNotificationWriter, notify } from "../notifications/fanout";

let productionDeps: Deps | undefined;

export const handler = (event: SNSEvent) => {
  if (!productionDeps) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const sns = new SNSClient({});
    const notifyDeps = {
      directory: new CognitoDirectory(new CognitoIdentityProviderClient({ maxAttempts: 2 }), process.env.USER_POOL_ID ?? ""),
      writer: new DynamoNotificationWriter(ddb, process.env.NOTIFICATIONS_TABLE ?? ""),
      now: () => new Date(), newId: () => randomUUID(),
    };
    productionDeps = {
      notify: (type, payload, recipients, opts) => notify(type, payload, recipients, notifyDeps, opts),
      alert: async (Subject, Message) => { await sns.send(new PublishCommand({ TopicArn: process.env.ALERTS_TOPIC_ARN, Subject, Message })); },
      now: () => new Date(),
    };
  }
  return handle(event, productionDeps);
};
