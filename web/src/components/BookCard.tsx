import type { Book } from "../catalog/types";

interface Props { book: Book; onOpen: (book: Book) => void }

const STATUS_LABELS: Record<string, string> = { "want to read": "Want to read", reading: "Reading", finished: "Finished" };

export default function BookCard({ book, onOpen }: Props) {
  return (
    <button className="card" onClick={() => onOpen(book)}>
      <span className="cover">
        {book.coverUrl ? <img src={book.coverUrl} alt="" loading="lazy" /> : <span>{book.title}</span>}
        {/* Overlaid on the cover, out of normal flow, so a set status never changes the
            card's height — the grid's virtualization measures one card's height and assumes
            every row matches it. */}
        {book.readingStatus && <span className="status-chip" data-status={book.readingStatus}>{STATUS_LABELS[book.readingStatus]}</span>}
        {book.downloaded && <span className="downloaded-chip" title="Downloaded — detected automatically from your download history">Downloaded</span>}
      </span>
      <span className="meta">
        <span className="title">{book.title}</span>
        <span className="authors">{book.authors.slice(0, 2).join(", ")}</span>
        <span className="badges">
          {book.formats.map((f) => <span key={f.type} className="badge">{f.type}</span>)}
        </span>
      </span>
    </button>
  );
}
