import type { Book } from "../catalog/types";

interface Props { book: Book; onOpen: (book: Book) => void }

export default function BookCard({ book, onOpen }: Props) {
  return (
    <button className="card" onClick={() => onOpen(book)}>
      <span className="cover">
        {book.coverUrl ? <img src={book.coverUrl} alt="" loading="lazy" /> : <span>{book.title}</span>}
      </span>
      <span className="meta">
        <span className="title">{book.title}</span>
        {book.authors.length > 0 && <span className="authors">{book.authors.slice(0, 2).join(", ")}</span>}
        <span className="badges">
          {book.formats.map((f) => <span key={f.type} className="badge">{f.type}</span>)}
        </span>
      </span>
    </button>
  );
}
