import sys
from pathlib import Path

# The dev venv is an editable install (`pip install -e`), which records an
# ABSOLUTE path to the main checkout's indexer/src in a .pth file. That means
# pytest run from a worktree would otherwise import `ebook_indexer` from
# main's src/, not this checkout's - tests would appear to pass while
# silently exercising the wrong code. Put this checkout's own src/ first on
# sys.path (resolved relative to this file, not the venv) so it always wins,
# regardless of which checkout's venv happens to run the suite. Do this
# before any other import, in case one of them pulls in ebook_indexer.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import io
import zipfile

import pymupdf
import pytest
from PIL import Image

CONTAINER_XML = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""

OPF_TEMPLATE = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>{title}</dc:title>
    {creators}
    <dc:description>{description}</dc:description>
    {subjects}
    <dc:publisher>{publisher}</dc:publisher>
    <dc:date>{date}</dc:date>
    <dc:identifier opf:scheme="ISBN">{isbn}</dc:identifier>
    {cover_meta}
  </metadata>
  <manifest>
    {cover_item}
    <item id="chap1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="chap1"/></spine>
</package>"""


def jpeg_bytes(color=(200, 30, 30), size=(600, 800)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def make_epub(tmp_path):
    def _make(
        dest: Path | None = None,
        title="Attacking Network Protocols",
        authors=("James Forshaw",),
        description="A deep dive into network protocol security.",
        subjects=("Computers", "Security"),
        publisher="No Starch Press",
        date="2021-05-01",
        isbn="9781593277505",
        with_cover=True,
    ) -> Path:
        dest = dest or tmp_path / "book.epub"
        creators = "".join(f"<dc:creator>{a}</dc:creator>" for a in authors)
        subj = "".join(f"<dc:subject>{s}</dc:subject>" for s in subjects)
        opf = OPF_TEMPLATE.format(
            title=title, creators=creators, description=description,
            subjects=subj, publisher=publisher, date=date, isbn=isbn,
            cover_meta='<meta name="cover" content="cover-img"/>' if with_cover else "",
            cover_item='<item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>'
            if with_cover else "",
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("mimetype", "application/epub+zip")
            zf.writestr("META-INF/container.xml", CONTAINER_XML)
            zf.writestr("OEBPS/content.opf", opf)
            zf.writestr("OEBPS/chap1.xhtml", "<html><body>hi</body></html>")
            if with_cover:
                zf.writestr("OEBPS/cover.jpg", jpeg_bytes())
        return dest

    return _make


@pytest.fixture
def make_pdf(tmp_path):
    def _make(dest: Path | None = None, title="Test PDF Book",
              author="Jane Doe, John Roe") -> Path:
        dest = dest or tmp_path / "book.pdf"
        dest.parent.mkdir(parents=True, exist_ok=True)
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Hello")
        doc.set_metadata({"title": title, "author": author})
        doc.save(str(dest))
        doc.close()
        return dest

    return _make
