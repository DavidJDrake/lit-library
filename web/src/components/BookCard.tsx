import type { Book } from "../catalog/types";

interface Props { book: Book; onOpen: (book: Book) => void }

export default function BookCard({ book, onOpen }: Props) {
  return (
    <button className="card" onClick={() => onOpen(book)}>
      <div className="cover">
        {book.coverUrl ? <img src={book.coverUrl} alt="" loading="lazy" /> : <span>{book.title}</span>}
      </div>
      <div className="meta">
        <p className="title">{book.title}</p>
        {book.authors.length > 0 && <p className="authors">{book.authors.slice(0, 2).join(", ")}</p>}
        <div className="badges">
          {book.formats.map((f) => <span key={f.type} className="badge">{f.type}</span>)}
        </div>
      </div>
    </button>
  );
}
