import { useEffect, useRef, useState } from "react";
import { formatSize } from "../catalog/search";
import type { Book } from "../catalog/types";
import { KINDLE_MAX_BYTES, kindleFormat } from "../kindle/limits";
import KindleAddressForm from "./KindleAddressForm";
import SuggestForm from "./SuggestForm";

interface KindleDialogProps {
  address: string | null | undefined;
  sender: string;
  onSend(book: Book, format?: "epub" | "pdf"): Promise<void>;
  onSaveAddress(address: string): Promise<void>;
}

interface Props {
  book: Book | null;
  onClose: () => void;
  onDownload: (book: Book, format: string) => Promise<void>;
  categories: string[];
  onChangeCategory: (book: Book, category: string) => Promise<void>;
  onSuggest: (name: string, bookId: string) => Promise<void>;
  kindle?: KindleDialogProps;
}

export const SUGGEST_OPTION = "__suggest__";

export default function BookDetail({ book, onClose, onDownload, categories, onChangeCategory, onSuggest, kindle }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [kindleState, setKindleState] = useState<
    { kind: "idle" } | { kind: "sending" } | { kind: "form"; format: "epub" | "pdf" }
  >({ kind: "idle" });

  useEffect(() => {
    setBusy(false);
    setSuggesting(false);
    setKindleState({ kind: "idle" });
    const el = ref.current;
    if (!el) return;
    if (book && !el.open) el.showModal();
    if (!book && el.open) el.close();
  }, [book]);

  if (!book) return <dialog ref={ref} className="detail" onClose={onClose} />;

  const meta = [book.publisher, book.year ? String(book.year) : null].filter(Boolean).join(" · ");

  async function download(format: string) {
    setBusy(true);
    try {
      await onDownload(book!, format);
    } finally {
      setBusy(false);
    }
  }

  async function sendToKindle(format: "epub" | "pdf") {
    if (!kindle) return;
    if (kindle.address === null) { setKindleState({ kind: "form", format }); return; }
    setKindleState({ kind: "sending" });
    try { await kindle.onSend(book!, format); } finally { setKindleState({ kind: "idle" }); }
  }

  async function changeCategory(value: string) {
    if (value === SUGGEST_OPTION) { setSuggesting(true); return; }
    setSuggesting(false);
    setBusy(true);
    try {
      await onChangeCategory(book!, value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="detail" onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <button className="close" aria-label="Close" onClick={onClose}>×</button>
      <div className="detail-body">
        <div className="cover">{book.coverUrl && <img src={book.coverUrl} alt="" />}</div>
        <div>
          <h2>{book.title}</h2>
          {book.authors.length > 0 && <p className="meta">{book.authors.join(", ")}</p>}
          {meta && <p className="meta">{meta}</p>}
          {categories.length === 0 ? (
            <p className="meta">{book.category} · {book.bundle}</p>
          ) : (
            <p className="meta category-row">
              <select aria-label="Category" value={suggesting ? SUGGEST_OPTION : book.category} disabled={busy}
                onChange={(e) => void changeCategory(e.target.value)}>
                {!categories.includes(book.category) && <option value={book.category}>{book.category}</option>}
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value={SUGGEST_OPTION}>Suggest a new category…</option>
              </select>
              {" · "}{book.bundle}
            </p>
          )}
          {suggesting && (
            <SuggestForm label="New category name" onSubmit={(name) => onSuggest(name, book!.id)} onCancel={() => setSuggesting(false)} />
          )}
          {book.description && <div className="desc">{book.description}</div>}
          <div className="downloads">
            {book.formats.map((f) => (
              <button key={f.type} className="btn" disabled={busy} onClick={() => void download(f.type)}>
                Download {f.type.toUpperCase()} ({formatSize(f.size)})
              </button>
            ))}
          </div>
          {kindle && (() => {
            const primary = kindleFormat(book);
            if (!primary) return null;
            const pdf = primary.type === "epub" ? kindleFormat(book, "pdf") : undefined;
            const tooLarge = primary.size > KINDLE_MAX_BYTES;
            const sending = kindleState.kind === "sending";
            return (
              <div className="kindle">
                {kindleState.kind === "form" ? (
                  <KindleAddressForm sender={kindle.sender}
                    onSubmit={async (a) => { const format = kindleState.format; await kindle.onSaveAddress(a); setKindleState({ kind: "sending" }); try { await kindle.onSend(book!, format); } finally { setKindleState({ kind: "idle" }); } }}
                    onCancel={() => setKindleState({ kind: "idle" })} />
                ) : (
                  <>
                    <button className="btn secondary" disabled={busy || sending || tooLarge}
                      title={tooLarge ? "Too large for Kindle delivery — download instead" : undefined}
                      onClick={() => void sendToKindle(primary.type as "epub" | "pdf")}>
                      {sending ? "Sending…" : "Send to Kindle"}
                    </button>
                    {pdf && !sending && (
                      <button type="button" className="more" disabled={busy || pdf.size > KINDLE_MAX_BYTES}
                        title={pdf.size > KINDLE_MAX_BYTES ? "Too large for Kindle delivery — download instead" : undefined}
                        onClick={() => void sendToKindle("pdf")}>Send PDF to Kindle</button>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </dialog>
  );
}
