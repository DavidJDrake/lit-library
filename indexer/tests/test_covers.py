import io

from PIL import Image

from ebook_indexer.covers import thumbnail_webp
from tests.conftest import jpeg_bytes


def test_resizes_to_400_wide_webp():
    out = thumbnail_webp(jpeg_bytes(size=(1200, 1600)))
    img = Image.open(io.BytesIO(out))
    assert img.format == "WEBP"
    assert img.width == 400 and img.height == 533


def test_never_upscales_small_images():
    out = thumbnail_webp(jpeg_bytes(size=(200, 300)))
    img = Image.open(io.BytesIO(out))
    assert img.width == 200


def test_garbage_bytes_return_none():
    assert thumbnail_webp(b"not an image") is None


def test_encode_failure_returns_none_instead_of_raising(monkeypatch):
    data = jpeg_bytes(size=(200, 300))

    def boom(self, *args, **kwargs):
        raise OSError("encoder error")

    monkeypatch.setattr(Image.Image, "save", boom)
    assert thumbnail_webp(data) is None
