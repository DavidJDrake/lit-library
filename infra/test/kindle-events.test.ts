import type { SNSEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { handle, type Deps } from "../lambda/kindle-events/index";

const NOW = "2026-09-05T12:00:00.000Z";
const hex = (s: string) => Buffer.from(s).toString("hex");
function sns(...messages: unknown[]): SNSEvent {
  return { Records: messages.map((m) => ({ Sns: { Message: JSON.stringify(m) } })) } as unknown as SNSEvent;
}
const bounce = {
  eventType: "Bounce",
  mail: { messageId: "ses-1", tags: { recipient: [hex("jay@example.com")], bookId: ["b1"] }, destination: ["jay_abc@kindle.com"] },
  bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "jay_abc@kindle.com", diagnosticCode: "smtp; 550 sender not approved" }] },
};
function deps(): Deps & { notify: ReturnType<typeof vi.fn>; alert: ReturnType<typeof vi.fn> } {
  return { notify: vi.fn().mockResolvedValue(1), alert: vi.fn().mockResolvedValue(undefined), now: () => new Date(NOW) };
}

describe("kindle-events", () => {
  it("turns a bounce into a notification keyed by the SES message id, a log event, and an alert", async () => {
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await handle(sns(bounce), d)).toEqual({ processed: 1, ignored: 0 });
    expect(d.notify).toHaveBeenCalledWith("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "Permanent/General: smtp; 550 sender not approved" }, ["jay@example.com"], { id: "ses-1" });
    expect(d.alert).toHaveBeenCalledWith("Kindle delivery Bounce: jay", expect.stringContaining("b1"));
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.bounce", recipient: "jay@example.com", bookId: "b1", kind: "Bounce", sesMessageId: "ses-1" }));
    log.mockRestore();
  });
  it("handles complaints and rejects, and ignores other or untagged events", async () => {
    const d = deps();
    const complaint = { eventType: "Complaint", mail: bounce.mail, complaint: { complaintFeedbackType: "abuse" } };
    const reject = { eventType: "Reject", mail: { ...bounce.mail, messageId: "ses-2" }, reject: { reason: "Bad content" } };
    const delivery = { eventType: "Delivery", mail: bounce.mail };
    const untagged = { eventType: "Bounce", mail: { messageId: "ses-3", tags: {} }, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [] } };
    expect(await handle(sns(complaint, reject, delivery, untagged), d)).toEqual({ processed: 2, ignored: 2 });
    expect(d.notify).toHaveBeenNthCalledWith(1, "kindle_bounce", { bookId: "b1", kind: "Complaint", reason: "complaint:abuse" }, ["jay@example.com"], { id: "ses-1" });
    expect(d.notify).toHaveBeenNthCalledWith(2, "kindle_bounce", { bookId: "b1", kind: "Reject", reason: "reject:Bad content" }, ["jay@example.com"], { id: "ses-2" });
  });
  it("keeps going when one record fails and reports it", async () => {
    const d = deps();
    d.notify.mockRejectedValueOnce(new Error("ddb down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handle(sns(bounce, { ...bounce, mail: { ...bounce.mail, messageId: "ses-9" } }), d)).toEqual({ processed: 1, ignored: 1 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
