import { useEffect, useRef, useState } from "react";
import { formatSize } from "../catalog/search";
import type { Book } from "../catalog/types";
import type { KindleDevice } from "../kindle/api";
import { KINDLE_MAX_BYTES, kindleFormat } from "../kindle/limits";
import KindleDeviceForm from "./KindleDeviceForm";
import SendToKindleButton from "./SendToKindleButton";
import SuggestForm from "./SuggestForm";

interface KindleDialogProps {
  devices: KindleDevice[] | undefined;
  defaultDeviceId: string | null;
  loadFailed?: boolean;
  sender: string;
  onSend(book: Book, format?: "epub" | "pdf", deviceId?: string): Promise<void>;
  onSaveDevice(label: string, address: string): Promise<void>;
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

  async function sendToKindle(format: "epub" | "pdf", deviceId?: string) {
    if (!kindle) return;
    // undefined covers the GET /api/kindle/devices window still in flight; treat it the
    // same as an empty list so a click during that window opens the form instead of 409ing.
    // A load that failed is different: we have no idea what the reader has saved, so let the
    // send go to the server, which is authoritative and answers no_address on its own.
    const noneKnown = kindle.devices ? kindle.devices.length === 0 : !kindle.loadFailed;
    if (noneKnown) { setKindleState({ kind: "form", format }); return; }
    setKindleState({ kind: "sending" });
    try {
      await kindle.onSend(book!, format, deviceId);
      setKindleState({ kind: "idle" });
    } catch (e) {
      setKindleState((e as { code?: string }).code === "no_address" ? { kind: "form", format } : { kind: "idle" });
    }
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
            const devices = kindle.devices ?? [];
            return (
              <div className="kindle">
                {kindleState.kind === "form" ? (
                  <KindleDeviceForm sender={kindle.sender} submitLabel="Save and send"
                    onSubmit={async (label, address) => {
                      const format = kindleState.format;
                      await kindle.onSaveDevice(label, address);
                      setKindleState({ kind: "sending" });
                      try { await kindle.onSend(book!, format, undefined); } finally { setKindleState({ kind: "idle" }); }
                    }}
                    onCancel={() => setKindleState({ kind: "idle" })} />
                ) : (
                  <>
                    <SendToKindleButton devices={devices} defaultDeviceId={kindle.defaultDeviceId}
                      disabled={busy || tooLarge} sending={sending}
                      title={tooLarge ? "Too large for Kindle delivery — download instead" : undefined}
                      onSend={(deviceId) => void sendToKindle(primary.type as "epub" | "pdf", deviceId)} />
                    {pdf && !sending && (
                      <SendToKindleButton devices={devices} defaultDeviceId={kindle.defaultDeviceId} pdf
                        disabled={busy || pdf.size > KINDLE_MAX_BYTES} sending={false}
                        title={pdf.size > KINDLE_MAX_BYTES ? "Too large for Kindle delivery — download instead" : undefined}
                        onSend={(deviceId) => void sendToKindle("pdf", deviceId)} />
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
