from pathlib import Path

from ebook_indexer.scan import scan_library


def make_library(tmp_path: Path) -> Path:
    root = tmp_path / "library"
    epub_dir = root / "Hacking by No Starch Press" / "EPUB"
    pdf_dir = root / "Hacking by No Starch Press" / "PDF"
    epub_dir.mkdir(parents=True)
    pdf_dir.mkdir(parents=True)
    (epub_dir / "attacking_network_protocols.epub").write_bytes(b"x" * 10)
    (epub_dir / "attacking_network_protocols.epub:Zone.Identifier").write_bytes(b"z")
    (pdf_dir / "attacking_network_protocols.pdf").write_bytes(b"y" * 20)
    (root / "Comics Bundle" / "CBZ").mkdir(parents=True)
    (root / "Comics Bundle" / "CBZ" / "issue1.cbz").write_bytes(b"c" * 5)
    (root / "Comics Bundle" / "notes.txt").write_bytes(b"ignore me")
    return root


def test_scan_finds_content_files_and_ignores_junk(tmp_path):
    root = make_library(tmp_path)
    files = scan_library(root)
    rels = [f.rel_path for f in files]
    assert rels == [
        "Comics Bundle/CBZ/issue1.cbz",
        "Hacking by No Starch Press/EPUB/attacking_network_protocols.epub",
        "Hacking by No Starch Press/PDF/attacking_network_protocols.pdf",
    ]


def test_scan_populates_fields(tmp_path):
    root = make_library(tmp_path)
    epub = [f for f in scan_library(root) if f.format == "epub"][0]
    assert epub.bundle == "Hacking by No Starch Press"
    assert epub.size == 10
    assert epub.path.is_absolute()


def test_scan_maps_extensions_case_insensitively(tmp_path):
    root = tmp_path / "lib"
    (root / "B").mkdir(parents=True)
    (root / "B" / "book.PDF").write_bytes(b"p")
    files = scan_library(root)
    assert [f.format for f in files] == ["pdf"]


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")


def test_scan_skips_hidden_top_level_folder(tmp_path):
    # A browser's download folder inside the library must not become a bundle.
    root = tmp_path / "lib"
    _touch(root / "Real Bundle" / "book.epub")
    _touch(root / ".playwright-mcp" / "Sea-Curse.epub")
    assert [f.rel_path for f in scan_library(root)] == ["Real Bundle/book.epub"]


def test_scan_skips_hidden_folder_inside_bundle(tmp_path):
    root = tmp_path / "lib"
    _touch(root / "Bundle" / "EPUB" / "book.epub")
    _touch(root / "Bundle" / ".cache" / "book.epub")
    assert [f.rel_path for f in scan_library(root)] == ["Bundle/EPUB/book.epub"]


def test_scan_skips_hidden_files(tmp_path):
    # macOS AppleDouble files ("._name.epub") carry the extension but no book.
    root = tmp_path / "lib"
    _touch(root / "Bundle" / "book.epub")
    _touch(root / "Bundle" / "._book.epub")
    assert [f.rel_path for f in scan_library(root)] == ["Bundle/book.epub"]


def test_scan_keeps_names_with_dots_inside_them(tmp_path):
    root = tmp_path / "lib"
    _touch(root / "Vol. 2 Bundle" / "book.v2.epub")
    assert [f.rel_path for f in scan_library(root)] == ["Vol. 2 Bundle/book.v2.epub"]


def test_scan_ignores_hidden_folders_above_the_root(tmp_path):
    # Only the path below the library root counts.
    root = tmp_path / ".hidden" / "lib"
    _touch(root / "Bundle" / "book.epub")
    assert [f.rel_path for f in scan_library(root)] == ["Bundle/book.epub"]
