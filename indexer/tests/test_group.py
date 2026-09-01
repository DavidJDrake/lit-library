from pathlib import Path

from ebook_indexer.group import book_id, group_files, normalize_name
from ebook_indexer.models import ScannedFile


def sf(rel: str, fmt: str) -> ScannedFile:
    return ScannedFile(
        path=Path("/lib") / rel, rel_path=rel,
        bundle=rel.split("/", 1)[0], format=fmt, size=1,
    )


def test_normalize_name_strips_extension_case_and_punctuation():
    assert normalize_name("Attacking_Network-Protocols.epub") == "attackingnetworkprotocols"
    assert normalize_name("book (2nd ed.).pdf") == "book2nded"


def test_book_id_is_stable_and_short():
    a = book_id("Bundle", "sametitle")
    assert a == book_id("Bundle", "sametitle")
    assert a != book_id("Other Bundle", "sametitle")
    assert len(a) == 16 and all(c in "0123456789abcdef" for c in a)


def test_group_files_pairs_epub_and_pdf_within_bundle():
    files = [
        sf("B1/PDF/network_protocols.pdf", "pdf"),
        sf("B1/EPUB/Network_Protocols.epub", "epub"),
        sf("B1/EPUB/other_book.epub", "epub"),
        sf("B2/EPUB/network_protocols.epub", "epub"),  # same name, different bundle
    ]
    groups = group_files(files)
    assert len(groups) == 3
    paired = groups[book_id("B1", "networkprotocols")]
    assert [f.format for f in paired] == ["epub", "pdf"]  # epub sorted first
