import { useEffect, useRef, useState } from "react";
import { formatSize } from "../catalog/search";
import type { Book } from "../catalog/types";
import SuggestForm from "./SuggestForm";

interface Props {
  book: Book | null;
  onClose: () => void;
  onDownload: (book: Book, format: string) => Promise<void>;
  categories: string[];
  onChangeCategory: (book: Book, category: string) => Promise<void>;
  onSuggest: (name: string, bookId: string) => Promise<void>;
}

export const SUGGEST_OPTION = "__suggest__";

export default function BookDetail({ book, onClose, onDownload, categories, onChangeCategory, onSuggest }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    setBusy(false);
    setSuggesting(false);
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

  async function changeCategory(value: string) {
    if (value === SUGGEST_OPTION) { setSuggesting(true); return; }
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
        </div>
      </div>
    </dialog>
  );
}
