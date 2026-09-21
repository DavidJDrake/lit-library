import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Book, Edition } from "../catalog/types";
import type { KindleDevice } from "../kindle/api";
import BookDetail from "./BookDetail";

const book: Book = {
  id: "1", title: "Attacking Network Protocols", authors: ["James Forshaw"], description: "Deep dive.",
  category: "Security & Hacking", subjects: [], publisher: "No Starch Press", bundle: "Hacking by No Starch Press", year: 2018,
  formats: [{ type: "epub", size: 12.3 * 1024 * 1024, s3Key: "a" }, { type: "pdf", size: 2 * 1024 * 1024, s3Key: "b" }],
  coverUrl: null, addedAt: "2026-01-01",
};

beforeAll(() => {
  // jsdom does not implement <dialog> methods
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); });
});

describe("BookDetail", () => {
  it("renders metadata and one download button per format with sizes", () => {
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    expect(screen.getByRole("heading", { name: "Attacking Network Protocols" })).toBeInTheDocument();
    expect(screen.getByText(/James Forshaw/)).toBeInTheDocument();
    expect(screen.getByText(/No Starch Press · 2018/)).toBeInTheDocument();
    expect(screen.getByText("Deep dive.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PDF (2.0 MB)" })).toBeInTheDocument();
  });
  it("calls onDownload and disables buttons while in flight", async () => {
    let resolve!: () => void;
    const onDownload = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<BookDetail book={book} onClose={() => {}} onDownload={onDownload} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" }));
    expect(onDownload).toHaveBeenCalledWith("1", "epub");
    expect(screen.getByRole("button", { name: /Download PDF/ })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: /Download PDF/ })).toBeEnabled());
  });
  it("closes via the close button", async () => {
    const onClose = vi.fn();
    render(<BookDetail book={book} onClose={onClose} onDownload={async () => {}} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
  it("resets busy state when book changes", async () => {
    let resolve!: () => void;
    const onDownload = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const bookB: Book = { ...book, id: "2", title: "Another Book" };
    const { rerender } = render(<BookDetail book={book} onClose={() => {}} onDownload={onDownload} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" }));
    expect(screen.getByRole("button", { name: /Download PDF/ })).toBeDisabled();
    rerender(<BookDetail book={bookB} onClose={() => {}} onDownload={onDownload} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    expect(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" })).toBeEnabled();
  });
  const cats = ["Fiction", "Security & Hacking", "TTRPG"];
  it("renders the category as text when no categories are available", () => {
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    expect(screen.queryByRole("combobox", { name: "Category" })).toBeNull();
    expect(screen.getByText("Security & Hacking")).toBeInTheDocument();
    expect(screen.getByText("In: Hacking by No Starch Press")).toBeInTheDocument();
  });
  it("moves the book via the category select", async () => {
    const onChangeCategory = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={onChangeCategory} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    const select = screen.getByRole("combobox", { name: "Category" });
    expect(select).toHaveValue("Security & Hacking");
    await userEvent.selectOptions(select, "TTRPG");
    expect(onChangeCategory).toHaveBeenCalledWith(book, "TTRPG");
  });
  it("shows the suggest form from the last option and submits with the book id", async () => {
    const onSuggest = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={async () => {}} onSuggest={onSuggest} onChangeStatus={async () => {}} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "__suggest__");
    await userEvent.type(screen.getByRole("textbox", { name: "New category name" }), "Cookbooks");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSuggest).toHaveBeenCalledWith("Cookbooks", "1");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New category name" })).toBeNull());
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("Security & Hacking");
  });
  it("closes the suggest form when a real category is picked instead", async () => {
    const onChangeCategory = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={onChangeCategory} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    const select = screen.getByRole("combobox", { name: "Category" });
    await userEvent.selectOptions(select, "__suggest__");
    expect(screen.getByRole("textbox", { name: "New category name" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "TTRPG");
    expect(onChangeCategory).toHaveBeenCalledWith(book, "TTRPG");
    expect(screen.queryByRole("textbox", { name: "New category name" })).toBeNull();
    expect(select).toHaveValue("Security & Hacking");
  });

  // Keeps the old single-address call style: an address (or null) produces the equivalent
  // one-device (or zero-device) list, with the empty label a migrated device would carry —
  // which is also why every assertion below still reads "Send to Kindle".
  const kindle = (address: string | null) => ({
    devices: address == null ? [] : [{ id: "a1", label: "", address }],
    defaultDeviceId: address == null ? null : "a1",
    sender: "library@lit.example.com",
    onSend: vi.fn().mockResolvedValue(undefined),
    onSaveDevice: vi.fn().mockResolvedValue(undefined),
  });
  const base = { onClose: () => {}, onDownload: async () => {}, categories: [], onChangeCategory: async () => {}, onSuggest: async () => {}, onChangeStatus: async () => {} };
  it("renders no Kindle button without the kindle prop or without an eligible format", () => {
    const { rerender } = render(<BookDetail book={book} {...base} />);
    expect(screen.queryByRole("button", { name: "Send to Kindle" })).toBeNull();
    rerender(<BookDetail book={{ ...book, formats: [{ type: "cbz", size: 10, s3Key: "c" }] }} {...base} kindle={kindle("jay_abc@kindle.com")} />);
    expect(screen.queryByRole("button", { name: "Send to Kindle" })).toBeNull();
  });
  it("sends the EPUB, shows Sending…, and offers the PDF as a secondary action", async () => {
    let resolve!: () => void;
    const k = kindle("jay_abc@kindle.com");
    k.onSend = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    expect(k.onSend).toHaveBeenCalledWith("1", "epub", "a1");
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send to Kindle" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Send PDF to Kindle" }));
    expect(k.onSend).toHaveBeenLastCalledWith("1", "pdf", "a1");
  });
  it("disables the button with a tooltip when the file is too large", () => {
    const huge = { ...book, formats: [{ type: "epub", size: 29 * 1024 * 1024, s3Key: "a" }] };
    render(<BookDetail book={huge} {...base} kindle={kindle("jay_abc@kindle.com")} />);
    const btn = screen.getByRole("button", { name: "Send to Kindle" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Too large for Kindle delivery — download instead");
  });
  it("opens the two-field form when no device is saved, then saves and sends", async () => {
    const k = kindle(null);
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Scribe");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "jay_abc@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    await waitFor(() => expect(k.onSend).toHaveBeenCalled());
    expect(k.onSaveDevice).toHaveBeenCalledWith("Scribe", "jay_abc@kindle.com");
    expect((k.onSaveDevice as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((k.onSend as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Your Kindle email" })).toBeNull());
  });
  it("reopens the inline form when the server rejects a send with no_address", async () => {
    const k = kindle("jay_abc@kindle.com");
    k.onSend = vi.fn().mockRejectedValue(Object.assign(new Error("no_address"), { code: "no_address" }));
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    expect(k.onSend).toHaveBeenCalledWith("1", "epub", "a1");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toBeInTheDocument());
  });
  it("returns to idle (not the form) when a send rejects for a reason other than no_address", async () => {
    const k = kindle("jay_abc@kindle.com");
    k.onSend = vi.fn().mockRejectedValue(Object.assign(new Error("Kindle delivery isn't enabled for everyone yet"), { code: "not_enabled" }));
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send to Kindle" })).toBeEnabled());
    expect(screen.queryByRole("textbox", { name: "Your Kindle email" })).toBeNull();
  });
  it("remembers the requested format across the form: PDF stays PDF", async () => {
    const k = kindle(null);
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send PDF to Kindle" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Scribe");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "jay_abc@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    await waitFor(() => expect(k.onSend).toHaveBeenCalledWith("1", "pdf", undefined));
    expect(k.onSaveDevice).toHaveBeenCalledWith("Scribe", "jay_abc@kindle.com");
    expect(k.onSend).not.toHaveBeenCalledWith("1", "epub", undefined);
  });
  it("passes the chosen device through to onSend", async () => {
    const devices: KindleDevice[] = [
      { id: "a1", label: "Scribe", address: "a@kindle.com" },
      { id: "b2", label: "Phone", address: "b@kindle.com" },
    ];
    const onSend = vi.fn().mockResolvedValue(undefined);
    const k = { devices, defaultDeviceId: "a1", sender: "s@x.com", onSend, onSaveDevice: vi.fn().mockResolvedValue(undefined) };
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Choose a device" })[0]);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Phone" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("1", "epub", "b2"));
  });
  it("reopens the form when the server says the device list is empty", async () => {
    const onSend = vi.fn(async () => { throw Object.assign(new Error("no"), { code: "no_address" }); });
    const k = {
      devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1",
      sender: "s@x.com", onSend, onSaveDevice: vi.fn().mockResolvedValue(undefined),
    };
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send to Scribe" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  describe("reading status", () => {
    it("defaults to No status and lists the three settable values, not downloaded", () => {
      render(<BookDetail book={book} {...base} />);
      const select = screen.getByRole("combobox", { name: "Reading status" });
      expect(select).toHaveValue("");
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["No status", "Want to read", "Reading", "Finished"]);
    });
    it("reflects the book's current status", () => {
      render(<BookDetail book={{ ...book, readingStatus: "reading" }} {...base} />);
      expect(screen.getByRole("combobox", { name: "Reading status" })).toHaveValue("reading");
    });
    it("sets a status via the select", async () => {
      const onChangeStatus = vi.fn().mockResolvedValue(undefined);
      render(<BookDetail book={book} {...base} onChangeStatus={onChangeStatus} />);
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Reading status" }), "Finished");
      expect(onChangeStatus).toHaveBeenCalledWith(book, "finished");
    });
    it("clears a status by selecting No status", async () => {
      const onChangeStatus = vi.fn().mockResolvedValue(undefined);
      const finished = { ...book, readingStatus: "finished" as const };
      render(<BookDetail book={finished} {...base} onChangeStatus={onChangeStatus} />);
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Reading status" }), "No status");
      expect(onChangeStatus).toHaveBeenCalledWith(finished, null);
    });
    it("shows downloaded as a plain, non-selectable indicator alongside the status select, not an option within it", () => {
      render(<BookDetail book={{ ...book, downloaded: true }} {...base} />);
      const select = screen.getByRole("combobox", { name: "Reading status" });
      expect(within(select).queryByText(/downloaded/i)).toBeNull();
      expect(screen.getByText(/Downloaded/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Downloaded/ })).toBeNull();
      expect(screen.queryByRole("checkbox", { name: /Downloaded/ })).toBeNull();
    });
    it("shows both facts together for a book that is downloaded and also has a chosen status", () => {
      render(<BookDetail book={{ ...book, readingStatus: "finished", downloaded: true }} {...base} />);
      expect(screen.getByRole("combobox", { name: "Reading status" })).toHaveValue("finished");
      expect(screen.getByText(/Downloaded/)).toBeInTheDocument();
    });
    it("does not show the downloaded indicator when the book has not been downloaded", () => {
      render(<BookDetail book={book} {...base} />);
      expect(screen.queryByText(/Downloaded/)).toBeNull();
    });
  });

  describe("editions", () => {
    const edition = (id: string, over: Partial<Edition> = {}): Edition => ({
      id, title: "Learning DevOps", authors: ["Mikael Krief"], description: `About ${id}`, publisher: "Packt", year: 2019,
      coverUrl: null, subjects: [], category: "Tech & Programming", bundles: ["B"], copyIds: [id], addedAt: "2026-01-01",
      downloaded: false, formats: [{ type: "epub", size: 1024 * 1024, s3Key: `k-${id}`, copyId: id }], ...over,
    });
    const work: Book = {
      ...book, id: "old", title: "Learning DevOps - Second Edition", year: 2022, bundles: ["CICD Mastery", "Devops Bundle"],
      editions: [
        edition("new", { title: "Learning DevOps - Second Edition", year: 2022, description: "About new",
          formats: [{ type: "epub", size: 2 * 1024 * 1024, s3Key: "k-new", copyId: "copy-new" }] }),
        edition("old", { downloaded: true }),
      ],
    };
    const renderWork = (b: Book, onDownload = vi.fn(async () => {})) => render(
      <BookDetail book={b} onClose={() => {}} onDownload={onDownload} categories={[]}
        onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />,
    );

    it("lists editions newest first and switches details and downloads to the chosen edition", async () => {
      const onDownload = vi.fn(async () => {});
      renderWork(work, onDownload);
      const picker = screen.getByRole("combobox", { name: "Edition" });
      expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual([
        "2022 · Second Edition · EPUB", "2019 · EPUB · downloaded",
      ]);
      expect(screen.getByText("About new")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Download EPUB (2.0 MB)" }));
      expect(onDownload).toHaveBeenCalledWith("copy-new", "epub");
      await userEvent.selectOptions(picker, "old");
      expect(screen.getByRole("heading", { name: "Learning DevOps" })).toBeInTheDocument();
      expect(screen.getByText("About old")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Download EPUB (1.0 MB)" }));
      expect(onDownload).toHaveBeenLastCalledWith("old", "epub");
    });

    it("lists every bundle the work appears in", () => {
      renderWork(work);
      expect(screen.getByText("In: CICD Mastery, Devops Bundle")).toBeInTheDocument();
    });

    it("keeps the chosen edition when the same work re-renders as a new object", async () => {
      const { rerender } = renderWork(work);
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Edition" }), "old");
      rerender(<BookDetail book={{ ...work }} onClose={() => {}} onDownload={async () => {}} categories={[]}
        onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
      expect(screen.getByRole("combobox", { name: "Edition" })).toHaveValue("old");
    });

    it("disables the dialog while an admin operation runs, acting on the edition shown", async () => {
      let finish!: () => void;
      const admin = {
        works: [work], canReset: true, onMerge: vi.fn(async () => true),
        onSplit: vi.fn(() => new Promise<void>((r) => { finish = r; })), onReset: vi.fn(async () => {}),
      };
      render(<BookDetail book={work} onClose={() => {}} onDownload={async () => {}} categories={[]}
        onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} admin={admin} />);
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Edition" }), "old");
      await userEvent.click(screen.getByRole("button", { name: "Split this edition into its own card" }));
      expect(admin.onSplit).toHaveBeenCalledWith(work, "old");
      expect(screen.getByRole("button", { name: "Split this edition into its own card" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Reset to automatic grouping" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Merge into…" })).toBeDisabled();
      finish();
      await waitFor(() => expect(screen.getByRole("button", { name: "Reset to automatic grouping" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Reset to automatic grouping" }));
      expect(admin.onReset).toHaveBeenCalledWith(work, "old");
    });

    it("keeps the shown edition when the dialog moves to another card that holds it", async () => {
      const { rerender } = renderWork(work);
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Edition" }), "old");
      const regrouped = { ...work, id: "earlier", editions: [...work.editions!, edition("earlier", { year: 2010 })] };
      rerender(<BookDetail book={regrouped} onClose={() => {}} onDownload={async () => {}} categories={[]}
        onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
      expect(screen.getByRole("combobox", { name: "Edition" })).toHaveValue("old");
    });

    it("shows no edition picker for a book with one edition, and downloads by its own id", async () => {
      const onDownload = vi.fn(async () => {});
      renderWork(book, onDownload);
      expect(screen.queryByRole("combobox", { name: "Edition" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" }));
      expect(onDownload).toHaveBeenCalledWith("1", "epub");
    });
  });
});
