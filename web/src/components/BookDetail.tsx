import { useEffect, useRef, useState } from "react";
import { formatSize } from "../catalog/search";
import type { Book } from "../catalog/types";

interface Props {
  book: Book | null;
  onClose: () => void;
  onDownload: (book: Book, format: string) => Promise<void>;
}

export default function BookDetail({ book, onClose, onDownload }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
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
          <p className="meta">{book.category} · {book.bundle}</p>
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
