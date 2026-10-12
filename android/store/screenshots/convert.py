# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==12.3.0"]
# ///
"""Turns the PNG files of store.spec.ts and art.spec.ts into the store files, and checks each one.

Usage: uv run android/store/screenshots/convert.py <SHOTS_DIR of the render>
Writes, for each target of targets.json and each scene of scenes.json, <out>/<target>-<n>.jpg
(the captioned shot when the target has caption: true), the Play feature graphic,
the ads in marketing/ads/ and the web manifest shots in public/screenshots/.
Exits with an error on a missing shot, or on a size that the store does not accept.
"""

import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PLAY = ROOT / "android/store/en-US/images"
ADS = ROOT / "marketing/ads"
WEB = ROOT / "public/screenshots"
# The listed scenes in the store order (scenes.json). The web manifest (vite.config.ts) shows the first three.
SCENES = [scene["name"] for scene in json.loads((HERE / "scenes.json").read_text()) if scene["listed"]]
WEB_NAMES = {"1-tower": "tower", "2-win": "win", "3-online": "online"}
AD_SIZES = {"square": (1080, 1080), "portrait": (1080, 1350), "story": (1080, 1920), "link": (1200, 628)}
FEATURE_SIZE = (1024, 500)
# The Apple sizes, portrait, from https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications
# (checked 2026-10-12). Dynamic Island large display (6.9 inch) and medium display (6.3 inch, the required one).
APPLE_SIZES = {(1320, 2868), (1290, 2796), (1260, 2736), (1206, 2622), (1179, 2556)}
APPLE_MAX_PER_SIZE = 10
PLAY_MAX_PER_TYPE = 8
PLAY_MAX_BYTES = 8 * 1024 * 1024


def play_size_error(folder: str, width: int, height: int) -> str | None:
    """The Play rules of https://support.google.com/googleplay/android-developer/answer/9866151 (checked 2026-10-12)."""
    short, long = sorted((width, height))
    low, high = (320, 3840) if folder == "phoneScreenshots" else (1080, 7680)
    if short < low or long > high:
        return f"each side must be {low} to {high} px"
    if long * 9 != short * 16:
        return "the aspect ratio must be 9:16 or 16:9"
    return None


def checked_size(target: dict, width: int, height: int) -> None:
    """Exits when the target's size is not one that its store accepts."""
    name = target["name"]
    if target["platform"] == "ios":
        if (width, height) not in APPLE_SIZES:
            raise SystemExit(f"target {name}: {width} × {height} is not an App Store iPhone size")
        return
    error = play_size_error(Path(target["out"]).name, width, height)
    if error is not None:
        raise SystemExit(f"target {name}: {width} × {height}: {error}")


def opened(path: Path, size: tuple[int, int]) -> Image.Image:
    """The image without alpha. Exits when it is missing or not the given size."""
    if not path.is_file():
        raise SystemExit(f"missing {path}")
    image = Image.open(path)
    if image.size != size:
        raise SystemExit(f"{path} is {image.size[0]} × {image.size[1]}, not {size[0]} × {size[1]}")
    return image.convert("RGB")


def clear(folder: Path) -> None:
    """Removes the old images, so a removed scene or target leaves no file behind."""
    folder.mkdir(parents=True, exist_ok=True)
    for old in [*folder.glob("*.jpg"), *folder.glob("*.png")]:
        old.unlink()


def main(source: Path) -> None:
    if len(SCENES) > min(PLAY_MAX_PER_TYPE, APPLE_MAX_PER_SIZE):
        raise SystemExit(f"{len(SCENES)} scenes: Play takes at most 8 per type, Apple 10 per size")
    targets = json.loads((HERE / "targets.json").read_text())
    for folder in {target["out"] for target in targets}:
        clear(ROOT / folder)
    for target in targets:
        width, height = target["size"]
        checked_size(target, width, height)
        out = ROOT / target["out"]
        for number, scene in enumerate(SCENES, start=1):
            raw = opened(source / target["name"] / f"{scene}.png", (width, height))
            captioned = source / "captioned" / target["name"] / f"{scene}.png"
            image = opened(captioned, (width, height)) if target["caption"] else raw
            file = out / f"{target['name']}-{number}.jpg"
            image.save(file, quality=85, optimize=True, progressive=True)
            if target["platform"] == "android" and file.stat().st_size > PLAY_MAX_BYTES:
                raise SystemExit(f"{file} is over the Play limit of 8 MB")
            if target["name"] == "play-phone" and scene in WEB_NAMES:
                small = raw.resize((540, 960), Image.Resampling.LANCZOS)
                small.save(WEB / f"{WEB_NAMES[scene]}.webp", quality=80, method=6)

    art = source / "art"
    feature = opened(art / "feature.png", FEATURE_SIZE)
    feature.save(PLAY / "featureGraphic.jpg", quality=90, optimize=True)
    clear(ADS)
    for name, size in AD_SIZES.items():
        opened(art / f"{name}.png", size).save(ADS / f"{name}.png", optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
