import { useEffect, useRef, useState } from "react";
import { formatSize } from "../catalog/search";
import { READING_STATUSES, type Book, type Edition, type EditionFormat, type ReadingStatus } from "../catalog/types";
import { editionMarker } from "../catalog/works";
import type { KindleDevice } from "../kindle/api";
import { KINDLE_MAX_BYTES, kindleFormat } from "../kindle/limits";
import KindleDeviceForm from "./KindleDeviceForm";
import SendToKindleButton from "./SendToKindleButton";
import SuggestForm from "./SuggestForm";
import WorkAdminControls from "./WorkAdminControls";

const STATUS_LABELS: Record<ReadingStatus, string> = { "want to read": "Want to read", reading: "Reading", finished: "Finished" };

interface KindleDialogProps {
  devices: KindleDevice[] | undefined;
  defaultDeviceId: string | null;
  loadFailed?: boolean;
  sender: string;
  onSend(copyId: string, format?: "epub" | "pdf", deviceId?: string): Promise<void>;
  onSaveDevice(label: string, address: string): Promise<void>;
}

interface Props {
  book: Book | null;
  onClose: () => void;
  onDownload: (copyId: string, format: string) => Promise<void>;
  categories: string[];
  onChangeCategory: (book: Book, category: string) => Promise<void>;
  onSuggest: (name: string, bookId: string) => Promise<void>;
  onChangeStatus: (book: Book, status: ReadingStatus | null) => Promise<void>;
  kindle?: KindleDialogProps;
  admin?: {
    works: Book[];
    canReset: boolean;
    onMerge(card: Book, target: Book): Promise<void>;
    onSplit(card: Book, editionId: string): Promise<void>;
    onReset(card: Book): Promise<void>;
  };
}

export const SUGGEST_OPTION = "__suggest__";
const NO_STATUS = "";

function editionLabel(e: Edition): string {
  return [
    e.year ? String(e.year) : "Undated",
    editionMarker(e.title),
    e.formats.map((f) => f.type.toUpperCase()).join("/"),
    e.downloaded ? "downloaded" : null,
  ].filter(Boolean).join(" · ");
}

export default function BookDetail({ book, onClose, onDownload, categories, onChangeCategory, onSuggest, onChangeStatus, kindle, admin }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [kindleState, setKindleState] = useState<
    { kind: "idle" } | { kind: "sending" } | { kind: "form"; format: "epub" | "pdf" }
  >({ kind: "idle" });
  const [editionId, setEditionId] = useState<string | null>(null);

  // Keyed on the id, not the object: work cards are rebuilt whenever the overlay changes (a
  // status set anywhere in the library), and that must not reset this dialog's edition choice
  // or close a half-filled Kindle form.
  useEffect(() => {
    setBusy(false);
    setSuggesting(false);
    setKindleState({ kind: "idle" });
    setEditionId(book?.editions?.[0]?.id ?? null);
    const el = ref.current;
    if (!el) return;
    if (book && !el.open) el.showModal();
    if (!book && el.open) el.close();
  }, [book?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!book) return <dialog ref={ref} className="detail" onClose={onClose} />;

  const editions = book.editions ?? [];
  const edition = editions.find((e) => e.id === editionId) ?? editions[0];
  const view = edition
    ? { title: edition.title, authors: edition.authors, publisher: edition.publisher, year: edition.year,
        description: edition.description, coverUrl: edition.coverUrl, formats: edition.formats }
    : { title: book.title, authors: book.authors, publisher: book.publisher, year: book.year,
        description: book.description, coverUrl: book.coverUrl,
        formats: book.formats.map((f): EditionFormat => ({ ...f, copyId: book.id })) };
  const meta = [view.publisher, view.year ? String(view.year) : null].filter(Boolean).join(" · ");
  const bundles = book.bundles ?? [book.bundle];
  const copyIdFor = (format: string) => view.formats.find((f) => f.type === format)?.copyId ?? book.id;

  async function download(format: string) {
    setBusy(true);
    try {
      await onDownload(copyIdFor(format), format);
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
      await kindle.onSend(copyIdFor(format), format, deviceId);
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

  async function changeStatus(value: string) {
    setBusy(true);
    try {
      await onChangeStatus(book!, value === NO_STATUS ? null : (value as ReadingStatus));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="detail" onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <button className="close" aria-label="Close" onClick={onClose}>×</button>
      <div className="detail-body">
        <div className="cover">{view.coverUrl && <img src={view.coverUrl} alt="" />}</div>
        <div>
          <h2>{view.title}</h2>
          {view.authors.length > 0 && <p className="meta">{view.authors.join(", ")}</p>}
          {meta && <p className="meta">{meta}</p>}
          {categories.length === 0 ? (
            <p className="meta">{book.category}</p>
          ) : (
            <p className="meta category-row">
              <select aria-label="Category" value={suggesting ? SUGGEST_OPTION : book.category} disabled={busy}
                onChange={(e) => void changeCategory(e.target.value)}>
                {!categories.includes(book.category) && <option value={book.category}>{book.category}</option>}
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value={SUGGEST_OPTION}>Suggest a new category…</option>
              </select>
            </p>
          )}
          {suggesting && (
            <SuggestForm label="New category name" onSubmit={(name) => onSuggest(name, book!.id)} onCancel={() => setSuggesting(false)} />
          )}
          <p className="meta">In: {bundles.join(", ")}</p>
          {editions.length > 1 && edition && (
            <p className="meta edition-row">
              <select aria-label="Edition" value={edition.id} disabled={busy}
                onChange={(e) => setEditionId(e.target.value)}>
                {editions.map((e) => <option key={e.id} value={e.id}>{editionLabel(e)}</option>)}
              </select>
            </p>
          )}
          <p className="meta status-row">
            <select aria-label="Reading status" value={book.readingStatus ?? NO_STATUS} disabled={busy}
              onChange={(e) => void changeStatus(e.target.value)}>
              <option value={NO_STATUS}>No status</option>
              {READING_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
            {/* Independent of the select above, not a fourth option in it: downloaded can be
                true at the same time as any chosen status (or none), and is never settable
                here — it's read-only, derived from download history. */}
            {book.downloaded && (
              <span className="downloaded-tag" title="Detected automatically from your download history">Downloaded (auto)</span>
            )}
          </p>
          {view.description && <div className="desc">{view.description}</div>}
          <div className="downloads">
            {view.formats.map((f) => (
              <button key={f.type} className="btn" disabled={busy} onClick={() => void download(f.type)}>
                Download {f.type.toUpperCase()} ({formatSize(f.size)})
              </button>
            ))}
          </div>
          {kindle && (() => {
            const kindleBook = { ...book, formats: view.formats };
            const primary = kindleFormat(kindleBook);
            if (!primary) return null;
            const pdf = primary.type === "epub" ? kindleFormat(kindleBook, "pdf") : undefined;
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
                      try { await kindle.onSend(copyIdFor(format), format, undefined); } finally { setKindleState({ kind: "idle" }); }
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
          {admin && (
            <WorkAdminControls card={book} works={admin.works} selectedEditionId={edition?.id ?? null}
              canReset={admin.canReset} busy={busy}
              onMerge={(target) => admin.onMerge(book!, target)}
              onSplit={(id) => admin.onSplit(book!, id)}
              onReset={() => admin.onReset(book!)} />
          )}
        </div>
      </div>
    </dialog>
  );
}
