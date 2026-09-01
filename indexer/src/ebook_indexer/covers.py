import io

from PIL import Image


def thumbnail_webp(image_bytes: bytes, width: int = 400) -> bytes | None:
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = img.convert("RGB")
        if img.width > width:
            height = round(img.height * width / img.width)
            img = img.resize((width, height), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=80)
        return buf.getvalue()
    except Exception:
        return None
