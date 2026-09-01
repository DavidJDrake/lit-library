import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .models import ExtractedMeta

NS = {
    "cnt": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def extract_epub(path: Path) -> ExtractedMeta:
    meta = ExtractedMeta()
    try:
        with zipfile.ZipFile(path) as zf:
            opf_path = _opf_path(zf)
            root = ET.fromstring(zf.read(opf_path))
            md = root.find("opf:metadata", NS)
            if md is not None:
                meta.title = _text(md.find("dc:title", NS))
                meta.authors = [t for e in md.findall("dc:creator", NS) if (t := _text(e))]
                meta.description = _text(md.find("dc:description", NS))
                meta.subjects = [t for e in md.findall("dc:subject", NS) if (t := _text(e))]
                meta.publisher = _text(md.find("dc:publisher", NS))
                meta.year = _year(_text(md.find("dc:date", NS)))
                meta.isbn = _isbn(md)
            meta.cover = _cover_bytes(zf, root, opf_path)
    except (zipfile.BadZipFile, ET.ParseError, KeyError, OSError):
        pass
    return meta


def _opf_path(zf: zipfile.ZipFile) -> str:
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    rootfile = container.find(".//cnt:rootfile", NS)
    if rootfile is None:
        raise KeyError("no rootfile in container.xml")
    return rootfile.get("full-path", "")


def _text(elem) -> str | None:
    if elem is None or elem.text is None:
        return None
    text = elem.text.strip()
    return text or None


def _year(date_text: str | None) -> int | None:
    if not date_text:
        return None
    m = re.search(r"\b(1[89]\d{2}|20\d{2})\b", date_text)
    return int(m.group(1)) if m else None


def _isbn(md) -> str | None:
    for e in md.findall("dc:identifier", NS):
        digits = re.sub(r"[^0-9X]", "", (e.text or "").upper())
        if len(digits) == 13 and digits.startswith(("978", "979")):
            return digits
        if len(digits) == 10:
            return digits
    return None


def _cover_bytes(zf: zipfile.ZipFile, root, opf_path: str) -> bytes | None:
    manifest = root.find("opf:manifest", NS)
    if manifest is None:
        return None
    items = manifest.findall("opf:item", NS)
    href = None
    for it in items:  # EPUB3: properties="cover-image"
        if "cover-image" in (it.get("properties") or ""):
            href = it.get("href")
            break
    if href is None:  # EPUB2: <meta name="cover" content="<item id>"/>
        md = root.find("opf:metadata", NS)
        cover_id = None
        if md is not None:
            for m in md.findall("opf:meta", NS):
                if m.get("name") == "cover":
                    cover_id = m.get("content")
                    break
        if cover_id:
            for it in items:
                if it.get("id") == cover_id:
                    href = it.get("href")
                    break
    if not href:
        return None
    base = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
    try:
        return zf.read(base + href)
    except KeyError:
        return None
