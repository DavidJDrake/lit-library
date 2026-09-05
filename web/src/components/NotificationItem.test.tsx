import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../notifications/api";
import NotificationItem from "./NotificationItem";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const pending: Notification = { id: "2026-09-05T11:00:00.000Z#a", type: "suggestion_pending", payload: { suggestionId: "s1", name: "Cosmic Horror", bookId: "b1", suggestedBy: "zach@example.com", status: "pending" }, read: false, createdAt: "2026-09-05T11:00:00.000Z" };
const titleOf = (id: string) => (id === "b1" ? "Black Hound of Death" : undefined);

describe("NotificationItem", () => {
  it("renders text, relative time, unread marker, and a link when there is one", () => {
    const added: Notification = { ...pending, id: "x", type: "category_created", payload: { name: "Essays", createdBy: "jay@example.com", source: "admin" }, read: true };
    render(<ul><NotificationItem n={added} isAdmin={false} titleOf={titleOf} nowMs={NOW} /></ul>);
    expect(screen.getByRole("link", { name: 'New category "Essays"' })).toHaveAttribute("href", "/?category=Essays");
    expect(screen.getByText("1 h ago")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).not.toHaveClass("unread");
  });
  it("shows admin actions only for pending suggestions and calls onResolve", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ul><NotificationItem n={pending} isAdmin titleOf={titleOf} onResolve={onResolve} nowMs={NOW} /></ul>);
    expect(screen.getByText('zach suggested "Cosmic Horror" for Black Hound of Death')).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveClass("unread");
    await userEvent.click(screen.getByRole("button", { name: "Accept Cosmic Horror" }));
    expect(onResolve).toHaveBeenCalledWith("s1", "accept");
    rerender(<ul><NotificationItem n={pending} isAdmin={false} titleOf={titleOf} onResolve={onResolve} nowMs={NOW} /></ul>);
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
    rerender(<ul><NotificationItem n={{ ...pending, payload: { ...pending.payload, status: "accepted", resolvedBy: "jay@example.com" } }} isAdmin titleOf={titleOf} onResolve={onResolve} nowMs={NOW} /></ul>);
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
    expect(screen.getByText("accepted by jay")).toBeInTheDocument();
  });
  it("shows an inline error when onResolve rejects", async () => {
    render(<ul><NotificationItem n={pending} isAdmin titleOf={titleOf} onResolve={vi.fn().mockRejectedValue(new Error("Admin only"))} nowMs={NOW} /></ul>);
    await userEvent.click(screen.getByRole("button", { name: "Reject Cosmic Horror" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Admin only"));
    expect(screen.getByRole("button", { name: "Reject Cosmic Horror" })).toBeEnabled();
  });
});
