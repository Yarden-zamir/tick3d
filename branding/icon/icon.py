# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==12.3.0", "resvg-py==0.5.0"]
# ///
"""Checks the icon candidates, draws the contact sheet, and exports the chosen icon.

Usage:
  uv run branding/icon/icon.py sheet <output.png> [name ...]   checks the candidates (all, or the named ones) and draws one contact sheet
  uv run branding/icon/icon.py export <name>        writes every icon file from candidates/<name>.svg
"""

import io
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import resvg_py
from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CANDIDATES = Path(__file__).parent / "candidates"
# The current icon has no SVG. The sheet shows its PNG files as candidate 0.
CURRENT = ROOT / "public/android-chrome-512x512.png"
CURRENT_MASKABLE = ROOT / "public/maskable-icon-512x512.png"
# Android crops a maskable icon to any shape that contains the circle of 40% radius (80% diameter).
SAFE_RADIUS = 0.4
X_COLOUR = (0xFF, 0x52, 0x77)
O_COLOUR = (0x00, 0xB3, 0xFF)
LIGHT_WALL = (238, 238, 242)
DARK_WALL = (28, 28, 30)
# Deuteranopia, Machado et al. 2009, severity 1.0.
DEUTERANOPIA = (0.367322, 0.860646, -0.227968, 0, 0.280085, 0.672501, 0.047413, 0, -0.011820, 0.042940, 0.968881, 0)


def render_svg(path: Path, size: int) -> Image.Image:
    data = bytes(resvg_py.svg_to_bytes(svg_path=str(path), width=size, height=size))
    image = Image.open(io.BytesIO(data)).convert("RGBA")
    if image.size != (size, size):
        raise SystemExit(f"{path.name} rendered at {image.size}, not {size} × {size}")
    return image


@dataclass(frozen=True)
class Candidate:
    name: str
    plain: Path
    # The image that goes inside the launcher masks. The SVG candidates use one file for both.
    maskable: Path

    def render(self, size: int, maskable: bool = False) -> Image.Image:
        path = self.maskable if maskable else self.plain
        if path.suffix == ".svg":
            return render_svg(path, size)
        return Image.open(path).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)


def candidates() -> list[Candidate]:
    found = [Candidate("0-current", CURRENT, CURRENT_MASKABLE)]
    found += [Candidate(path.stem, path, path) for path in sorted(CANDIDATES.glob("*.svg"), key=lambda path: int(path.stem.split("-")[0]))]
    return found


@dataclass(frozen=True)
class Checks:
    opaque: bool
    # How far the artwork reaches from the centre, as a share of half the icon width. At most 0.8 fits the safe zone.
    reach: float
    # Pixels close to the X and the O colours in the 16 px render. 0 means that the mark is gone at that size.
    # None when the background has that colour, so the count says nothing about the mark.
    x_pixels: int | None
    o_pixels: int | None

    @property
    def safe(self) -> bool:
        return self.reach <= SAFE_RADIUS * 2


def near(pixel: tuple[int, ...], colour: tuple[int, int, int], tolerance: int = 80) -> bool:
    return sum(abs(a - b) for a, b in zip(pixel[:3], colour)) <= tolerance


def check(candidate: Candidate) -> Checks:
    size = 512
    plain = candidate.render(size)
    opaque = plain.getchannel("A").getextrema()[0] == 255
    # Artwork is every pixel that differs from the background colour at the corner.
    masked = candidate.render(size, maskable=True)
    background = Image.new("RGBA", masked.size, masked.getpixel((0, 0)))
    box = ImageChops.difference(masked, background).convert("L").point(lambda v: 255 if v > 24 else 0)
    reach = 0.0
    pixels = box.load()
    centre = size / 2
    for y in range(0, size, 2):
        for x in range(0, size, 2):
            if pixels[x, y]:
                reach = max(reach, ((x - centre) ** 2 + (y - centre) ** 2) ** 0.5 / centre)
    small = list(candidate.render(16).get_flattened_data())
    corner = small[0]
    return Checks(
        opaque=opaque,
        reach=reach,
        x_pixels=None if near(corner, X_COLOUR) else sum(near(p, X_COLOUR) for p in small),
        o_pixels=None if near(corner, O_COLOUR) else sum(near(p, O_COLOUR) for p in small),
    )


def superellipse_mask(size: int, exponent: float) -> Image.Image:
    """exponent 2 is a circle. About 5 is close to the iOS app icon shape."""
    scale = 4
    big = size * scale
    mask = Image.new("L", (big, big), 0)
    half = big / 2
    points = []
    steps = 720
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        points.append((half + half * abs(c) ** (2 / exponent) * (1 if c >= 0 else -1), half + half * abs(s) ** (2 / exponent) * (1 if s >= 0 else -1)))
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def on_wall(icon: Image.Image, mask: Image.Image | None, wall: tuple[int, int, int], pad: int) -> Image.Image:
    tile = Image.new("RGB", (icon.width + 2 * pad, icon.height + 2 * pad), wall)
    alpha = icon.getchannel("A") if mask is None else ImageChops.multiply(icon.getchannel("A"), mask)
    tile.paste(icon.convert("RGB"), (pad, pad), alpha)
    return tile


def safe_zone_overlay(icon: Image.Image) -> Image.Image:
    tile = on_wall(icon, None, LIGHT_WALL, 0)
    draw = ImageDraw.Draw(tile)
    r = icon.width * SAFE_RADIUS
    c = icon.width / 2
    draw.ellipse((c - r, c - r, c + r, c + r), outline=(0, 200, 0), width=2)
    return tile


def sheet(output: Path, names: list[str]) -> None:
    font = ImageFont.load_default(size=18)
    small_font = ImageFont.load_default(size=14)
    rows = [c for c in candidates() if not names or c.name in names]
    missing = set(names) - {c.name for c in rows}
    if missing:
        raise SystemExit(f"No candidates named {sorted(missing)}")
    row_height = 220
    columns = [
        ("512 px", 200),
        ("48 · 32 · 16 px", 130),
        ("16 px, zoomed", 130),
        ("Android, light", 130),
        ("iOS, light", 130),
        ("Android, dark", 130),
        ("iOS, dark", 130),
        ("Safe zone", 130),
        ("Colour-blind", 130),
    ]
    label_width = 230
    width = label_width + sum(w for _, w in columns) + 20
    image = Image.new("RGB", (width, 50 + row_height * len(rows)), "white")
    draw = ImageDraw.Draw(image)
    x = label_width
    for title, w in columns:
        draw.text((x, 15), title, fill="black", font=font)
        x += w
    circle = superellipse_mask(96, 2)
    squircle = superellipse_mask(96, 5)
    report = []
    for row, candidate in enumerate(rows):
        top = 50 + row * row_height
        result = check(candidate)
        report.append((candidate.name, result))
        if row % 2:
            draw.rectangle((0, top, width, top + row_height), fill=(246, 246, 250))
        draw.text((12, top + 12), candidate.name, fill="black", font=font)
        lines = [
            f"opaque: {'yes' if result.opaque else 'NO'}",
            f"safe zone: {'yes' if result.safe else 'NO'} ({result.reach:.2f})",
            f"16 px X pixels: {'n/a' if result.x_pixels is None else result.x_pixels}",
            f"16 px O pixels: {'n/a' if result.o_pixels is None else result.o_pixels}",
        ]
        for i, line in enumerate(lines):
            colour = (200, 0, 0) if "NO" in line or line.endswith(": 0") else (60, 60, 60)
            draw.text((12, top + 44 + i * 22), line, fill=colour, font=small_font)
        x = label_width
        image.paste(on_wall(candidate.render(200), None, LIGHT_WALL, 0), (x, top + 10))
        x += columns[0][1]
        sx = x
        for size in (48, 32, 16):
            image.paste(on_wall(candidate.render(size), None, LIGHT_WALL, 0), (sx, top + 60))
            sx += size + 10
        x += columns[1][1]
        image.paste(on_wall(candidate.render(16), None, LIGHT_WALL, 0).resize((64, 64), Image.Resampling.NEAREST), (x, top + 50))
        x += columns[2][1]
        masked = candidate.render(96, maskable=True)
        for mask, wall in ((circle, LIGHT_WALL), (squircle, LIGHT_WALL), (circle, DARK_WALL), (squircle, DARK_WALL)):
            image.paste(on_wall(masked, mask, wall, 12), (x, top + 40))
            x += 130
        image.paste(safe_zone_overlay(candidate.render(120, maskable=True)), (x, top + 40))
        x += 130
        blind = on_wall(candidate.render(120), None, LIGHT_WALL, 0).convert("RGB", DEUTERANOPIA)
        image.paste(blind, (x, top + 40))
    # A palette of 256 colours keeps the sheet small enough to post.
    image.quantize(256).save(output, optimize=True)
    for name, result in report:
        print(name, result, "safe" if result.safe else "NOT SAFE")


# Every icon file, by path from the repository root, and its size. All are opaque RGB.
EXPORTS = {
    "public/favicon-16x16.png": 16,
    "public/favicon-32x32.png": 32,
    "public/apple-touch-icon.png": 180,
    "public/android-chrome-192x192.png": 192,
    "public/android-chrome-512x512.png": 512,
    "public/maskable-icon-512x512.png": 512,
    "android/store/en-US/images/icon.png": 512,
    "apple/icon.png": 1024,
}


def export(name: str) -> None:
    source = CANDIDATES / f"{name}.svg"
    if not source.is_file():
        raise SystemExit(f"No candidate {source}")
    result = check(Candidate(name, source, source))
    if not (result.opaque and result.safe):
        raise SystemExit(f"{name} fails the checks: {result}")
    for path, size in EXPORTS.items():
        image = render_svg(source, size).convert("RGB")
        image.save(ROOT / path, optimize=True)
    render_svg(source, 48).convert("RGB").save(ROOT / "public/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    for path, size in EXPORTS.items():
        written = Image.open(ROOT / path)
        if written.size != (size, size) or written.mode != "RGB":
            raise SystemExit(f"{path} is {written.size} {written.mode}, not {size} × {size} RGB")
    print(f"Exported {name} to {len(EXPORTS) + 1} files")


def main() -> None:
    match sys.argv[1:]:
        case ["sheet", output, *names]:
            sheet(Path(output), names)
        case ["export", name]:
            export(name)
        case _:
            raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
