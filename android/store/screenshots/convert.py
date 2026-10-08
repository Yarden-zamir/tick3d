# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==12.3.0"]
# ///
"""Turns the PNG files of store.spec.ts into the formats of the Play listing and the web manifest.

Usage: uv run android/store/screenshots/convert.py <folder with the PNG files>
Writes android/store/en-US/images/ (JPEG screenshots, feature graphic) and public/screenshots/ (WebP).
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
STORE = ROOT / "android/store/en-US/images"
WEB = ROOT / "public/screenshots"
# The Play listing order. The web manifest (vite.config.ts) shows the first three.
SCENES = ["1-tower", "2-win", "3-online", "4-voice", "5-stats"]
WEB_NAMES = {"1-tower": "tower", "2-win": "win", "3-online": "online"}


def main(source: Path) -> None:
    for number, scene in enumerate(SCENES, start=1):
        image = Image.open(source / f"{scene}.png").convert("RGB")
        if image.size != (1080, 1920):
            raise SystemExit(f"{scene}.png is {image.size}, not 1080 × 1920")
        image.save(STORE / "phoneScreenshots" / f"{number}.jpg", quality=78, optimize=True, progressive=True)
        if scene in WEB_NAMES:
            small = image.resize((540, 960), Image.Resampling.LANCZOS)
            small.save(WEB / f"{WEB_NAMES[scene]}.webp", quality=80, method=6)
    feature = Image.open(source / "feature.png").convert("RGB").resize((1024, 500), Image.Resampling.LANCZOS)
    feature.save(STORE / "featureGraphic.jpg", quality=88, optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
