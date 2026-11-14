"""Turn uploaded files into model input: images as (downscaled) images, text files inline.

Used by the router and by every CU agent's decide step, so an attachment like "fill this form with
the data in this CSV" or "make it look like this screenshot" reaches the model as content, not a name.
"""

import os
import subprocess

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tiff", ".bmp"}
TEXT_BUDGET = 6000  # characters across all text attachments
MAX_IMAGES = 3
MAX_TEXT_FILE = 1_000_000


def _small_image(path):
    """A <=1280 px JPEG copy beside the upload, made once; the original if sips fails."""
    out = path + ".ca1280.jpg"
    if not os.path.exists(out):
        r = subprocess.run(
            ["sips", "-Z", "1280", "-s", "format", "jpeg", path, "--out", out], capture_output=True, timeout=30
        )
        if r.returncode != 0 or not os.path.exists(out):
            return path if path.lower().endswith((".png", ".jpg", ".jpeg")) else None
    return out


def _text(path):
    if os.path.getsize(path) > MAX_TEXT_FILE:
        return None
    raw = open(path, "rb").read()
    if b"\0" in raw[:4096]:
        return None  # binary
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def describe(paths):
    """{"images": [paths for the model], "text": str to append to the prompt, "files": [names]}."""
    images, chunks, names, budget = [], [], [], TEXT_BUDGET
    for p in paths:
        if not os.path.isfile(p):
            continue
        name = os.path.basename(p)
        names.append(name)
        if os.path.splitext(p)[1].lower() in IMAGE_EXT:
            small = _small_image(p) if len(images) < MAX_IMAGES else None
            if small:
                images.append(small)
            chunks.append("=== %s (image%s) ===" % (name, ", attached" if small else ", not sent: image limit"))
            continue
        body = _text(p)
        if body is None:
            # ponytail: PDFs and other binaries go by name; send PDFs as OpenRouter file parts when needed
            chunks.append("=== %s (binary, %d bytes, contents not read) ===" % (name, os.path.getsize(p)))
            continue
        cut = body[: max(0, budget)]
        budget -= len(cut)
        chunks.append("=== %s ===\n%s%s" % (name, cut, "\n[... cut]" if len(cut) < len(body) else ""))
    text = ("Attached by the user:\n" + "\n".join(chunks)) if chunks else ""
    return {"images": images, "text": text, "files": names}


if __name__ == "__main__":
    import tempfile

    d = tempfile.mkdtemp()
    open(os.path.join(d, "notes.txt"), "w").write("Order 42: 3 apples")
    open(os.path.join(d, "blob.bin"), "wb").write(b"\0\1\2" * 10)
    import struct
    import zlib

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = os.path.join(d, "shot.png")  # a 40x40 grey PNG, written with the stdlib (no screen capture)
    raw = b"".join(b"\0" + b"\x80\x80\x80" * 40 for _ in range(40))
    ihdr = struct.pack(">IIBBBBB", 40, 40, 8, 2, 0, 0, 0)
    with open(png, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    r = describe([os.path.join(d, n) for n in ("notes.txt", "blob.bin", "shot.png")])
    assert "Order 42: 3 apples" in r["text"] and "blob.bin (binary" in r["text"], r["text"]
    assert r["files"] == ["notes.txt", "blob.bin", "shot.png"]
    assert r["images"] and r["images"][0].endswith(".ca1280.jpg"), r
    print("attach selftest OK", r["images"])
