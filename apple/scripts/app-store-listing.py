# /// script
# requires-python = ">=3.12"
# dependencies = ["pyjwt==2.15.1", "cryptography==50.0.2"]
# ///
"""Syncs the App Store listing in apple/store/ to App Store Connect: the app info text, the version text,
the category, the content rights answer, the age rating answers, the screenshots and the price.

Usage: uv run apple/scripts/app-store-listing.py (the app-store-listing workflow).
Without APPLY=true it only reads App Store Connect and prints the planned changes (a dry run).
Needs ISSUER, KEY_ID and PRIVATE_KEY (see asc.py) and BUNDLE, the bundle id.

It never creates an App Store version and never submits for review: both stay manual steps.
App Privacy is not here: the public API has no endpoint for it (see apple/store/app-store-connect.md).
"""

import hashlib
import json
import os
import sys
import urllib.request
from collections.abc import Callable
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

from asc import api, fail

BUNDLE = os.environ["BUNDLE"]
APPLY = os.environ.get("APPLY") == "true"

STORE = Path(__file__).resolve().parents[1] / "store"
LOCALE = "en-US"
TEXT = STORE / LOCALE
SCREENSHOTS = STORE / "screenshots" / LOCALE
CONFIG = STORE / "app-store-connect.json"
# The price in US dollars of both stores. Play has no API for the price of a paid app; see play-console.md.
PRICE = Path(__file__).resolve().parents[2] / "store" / "price-usd.txt"

# The file name prefix of each screenshot size, and its App Store Connect display type.
DISPLAY_TYPES = {"iphone-6.9": "APP_IPHONE_67", "iphone-6.3": "APP_IPHONE_61"}
# Character limits of App Store Connect, checked here so that a long text fails the pull request run.
LIMITS = {"name": 30, "subtitle": 30, "keywords": 100, "promotional_text": 170, "description": 4000, "release_notes": 4000}
# The states in which App Store Connect accepts changes to an app info or an App Store version.
EDITABLE_INFO_STATES = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED"}
EDITABLE_VERSION_STATES = "PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY"
PRICE_TERRITORY = "USA"
CONFIG_KEYS = {"primaryCategory", "primarySubcategoryOne", "contentRightsDeclaration", "ageRating"}

plan: list[tuple[str, Callable[[], None]]] = []


def change(summary: str, action: Callable[[], None]) -> None:
    plan.append((summary, action))


def get(path: str) -> dict:
    status, body = api("GET", path)
    if status != 200 or body is None:
        fail(f"GET {path} answered {status}: {body}")
    return body


def write(method: str, path: str, body: dict | None) -> dict | None:
    status, answer = api(method, path, body)
    if status not in (200, 201, 204):
        fail(f"{method} {path} answered {status}: {answer}")
    return answer


def short(value: object) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 60 else text[:57] + '…"'


def read_text(name: str) -> str | None:
    path = TEXT / f"{name}.txt"
    if not path.exists():
        return None
    text = path.read_text().strip()
    if not text:
        fail(f"{path} is empty. Delete it or fill it.")
    if name in LIMITS and len(text) > LIMITS[name]:
        fail(f"{path} has {len(text)} characters; App Store Connect allows {LIMITS[name]}.")
    return text


def plan_patch(kind: str, resource: dict, wanted: dict[str, object], label: str) -> None:
    current = resource["attributes"]
    diff = {k: v for k, v in wanted.items() if v is not None and current.get(k) != v}
    for k, v in diff.items():
        print(f"  {label} {k}: {short(current.get(k))} -> {short(v)}")
    if diff:
        path = f"/v1/{kind}/{resource['id']}"
        body = {"data": {"type": kind, "id": resource["id"], "attributes": diff}}
        change(f"{label}: {', '.join(diff)}", lambda: write("PATCH", path, body))


def by_locale(items: list[dict], what: str) -> dict:
    for item in items:
        if item["attributes"]["locale"] == LOCALE:
            return item
    fail(f"No {LOCALE} {what}. The app's primary language must be {LOCALE}.")
    raise AssertionError  # fail() exits; this line only tells the type checker.


def plan_categories(info: dict, config: dict) -> None:
    current = {k: (v.get("data") or {}).get("id") for k, v in info["relationships"].items() if "data" in v}
    wanted = {k: config[k] for k in ("primaryCategory", "primarySubcategoryOne")}
    diff = {k: v for k, v in wanted.items() if current.get(k) != v}
    for k, v in diff.items():
        print(f"  app info {k}: {short(current.get(k))} -> {short(v)}")
    if diff:
        path = f"/v1/appInfos/{info['id']}"
        relationships = {k: {"data": {"type": "appCategories", "id": v}} for k, v in diff.items()}
        body = {"data": {"type": "appInfos", "id": info["id"], "relationships": relationships}}
        change(f"category: {', '.join(diff)}", lambda: write("PATCH", path, body))


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def local_screenshots(prefix: str) -> list[Path]:
    files = sorted(SCREENSHOTS.glob(f"{prefix}-*.jpg"), key=lambda p: int(p.stem.removeprefix(f"{prefix}-")))
    if not files:
        fail(f"No {prefix}-<n>.jpg screenshots in {SCREENSHOTS}.")
    return files


def upload_screenshot(set_id: str, path: Path) -> None:
    data = path.read_bytes()
    answer = write(
        "POST",
        "/v1/appScreenshots",
        {
            "data": {
                "type": "appScreenshots",
                "attributes": {"fileName": path.name, "fileSize": len(data)},
                "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}},
            }
        },
    )
    if answer is None:
        fail(f"Creating the screenshot {path.name} answered with no body.")
    shot = answer["data"]
    for op in shot["attributes"]["uploadOperations"]:
        part = data[op["offset"] : op["offset"] + op["length"]]
        headers = {h["name"]: h["value"] for h in op.get("requestHeaders") or []}
        with urllib.request.urlopen(urllib.request.Request(op["url"], data=part, method=op["method"], headers=headers)):
            pass
    write(
        "PATCH",
        f"/v1/appScreenshots/{shot['id']}",
        {"data": {"type": "appScreenshots", "id": shot["id"], "attributes": {"uploaded": True, "sourceFileChecksum": md5(path)}}},
    )
    print(f"  uploaded {path.name}")


def plan_screenshots(localization_id: str) -> None:
    for prefix, display_type in DISPLAY_TYPES.items():
        files = local_screenshots(prefix)
        sets = get(
            f"/v1/appStoreVersionLocalizations/{localization_id}/appScreenshotSets?filter[screenshotDisplayType]={display_type}"
        )["data"]
        remote = get(f"/v1/appScreenshotSets/{sets[0]['id']}/appScreenshots?limit=10")["data"] if sets else []
        if [s["attributes"].get("sourceFileChecksum") for s in remote] == [md5(f) for f in files]:
            continue
        print(f"  screenshots {display_type}: {len(remote)} in App Store Connect -> {len(files)} from {prefix}-<n>.jpg")

        # Limit: one changed file replaces the whole set. Revisit if uploads get slow or Apple limits them.
        def replace(sets=sets, remote=remote, files=files, display_type=display_type) -> None:
            for shot in remote:
                write("DELETE", f"/v1/appScreenshots/{shot['id']}", None)
            if sets:
                set_id = sets[0]["id"]
            else:
                answer = write(
                    "POST",
                    "/v1/appScreenshotSets",
                    {
                        "data": {
                            "type": "appScreenshotSets",
                            "attributes": {"screenshotDisplayType": display_type},
                            "relationships": {
                                "appStoreVersionLocalization": {
                                    "data": {"type": "appStoreVersionLocalizations", "id": localization_id}
                                }
                            },
                        }
                    },
                )
                if answer is None:
                    fail(f"Creating the {display_type} screenshot set answered with no body.")
                set_id = answer["data"]["id"]
            for f in files:
                upload_screenshot(set_id, f)

        change(f"screenshots {display_type}", replace)


def all_pages(path: str) -> list[dict]:
    items: list[dict] = []
    while path:
        body = get(path)
        items += body["data"]
        path = (body.get("links") or {}).get("next", "").removeprefix("https://api.appstoreconnect.apple.com")
    return items


def read_price() -> Decimal:
    text = PRICE.read_text().strip()
    try:
        price = Decimal(text)
    except InvalidOperation:
        fail(f'{PRICE} must hold a price such as 1.99, not "{text}".')
        raise
    if not price.is_finite() or price < 0 or price.as_tuple().exponent < -2:
        fail(f'{PRICE} must hold a price of at least 0 with at most two decimals, not "{text}".')
    return price


def plan_price(app_id: str, wanted: Decimal) -> None:
    status, schedule = api("GET", f"/v1/apps/{app_id}/appPriceSchedule")
    current: Decimal | None = None
    if status == 200 and schedule is not None:
        today = date.today().isoformat()
        prices = get(
            f"/v1/appPriceSchedules/{schedule['data']['id']}/manualPrices"
            f"?filter[territory]={PRICE_TERRITORY}&include=appPricePoint&fields[appPricePoints]=customerPrice"
        )
        points = {p["id"]: p["attributes"]["customerPrice"] for p in prices.get("included", [])}
        for p in prices["data"]:
            start, end = p["attributes"].get("startDate"), p["attributes"].get("endDate")
            if (start is None or start <= today) and (end is None or end > today):
                current = Decimal(points[p["relationships"]["appPricePoint"]["data"]["id"]])
    elif status != 404:
        fail(f"Could not read the price schedule: {status} {schedule}")
    if current == wanted:
        return
    # The dry run looks the price point up too, so that a price that Apple does not offer fails the pull request.
    points = all_pages(f"/v1/apps/{app_id}/appPricePoints?filter[territory]={PRICE_TERRITORY}&limit=200")
    matches = [p["id"] for p in points if Decimal(p["attributes"]["customerPrice"]) == wanted]
    if len(matches) != 1:
        fail(f"Found {len(matches)} price points of {wanted} in {PRICE_TERRITORY}; expected exactly one.")
    print(f"  price ({PRICE_TERRITORY}): {current} -> {wanted}")

    def set_price() -> None:
        write(
            "POST",
            "/v1/appPriceSchedules",
            {
                "data": {
                    "type": "appPriceSchedules",
                    "relationships": {
                        "app": {"data": {"type": "apps", "id": app_id}},
                        "baseTerritory": {"data": {"type": "territories", "id": PRICE_TERRITORY}},
                        "manualPrices": {"data": [{"type": "appPrices", "id": "${price}"}]},
                    },
                },
                "included": [
                    {
                        "type": "appPrices",
                        "id": "${price}",
                        "attributes": {"startDate": None},
                        "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": matches[0]}}},
                    }
                ],
            },
        )

    change(f"price {wanted} in {PRICE_TERRITORY}", set_price)


config = json.loads(CONFIG.read_text())
if set(config) != CONFIG_KEYS:
    fail(f"{CONFIG} must have exactly the keys {sorted(CONFIG_KEYS)}, not {sorted(config)}.")
price = read_price()

status, body = api("GET", f"/v1/apps?filter[bundleId]={BUNDLE}")
if status in (401, 403):
    print(f"::notice::App Store Connect refused the API key ({status}): check the APP_STORE_CONNECT_* secrets. Nothing synced.")
    sys.exit(0)
if status != 200 or body is None or not body.get("data"):
    fail(f"No App Store Connect app found for bundle id {BUNDLE}: {status} {body}")
app = body["data"][0]
app_id = app["id"]
print(f"App: {BUNDLE} -> {app_id} ({'apply' if APPLY else 'dry run'})")
if app["attributes"]["primaryLocale"] != LOCALE:
    fail(f"The app's primary language is {app['attributes']['primaryLocale']}, but apple/store/ holds {LOCALE}.")

plan_patch("apps", app, {"contentRightsDeclaration": config["contentRightsDeclaration"]}, "app")

infos = get(f"/v1/apps/{app_id}/appInfos?include=primaryCategory,primarySubcategoryOne")["data"]
editable_infos = [i for i in infos if i["attributes"]["state"] in EDITABLE_INFO_STATES]
if editable_infos:
    info = editable_infos[0]
    plan_categories(info, config)
    rating = get(f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]
    plan_patch("ageRatingDeclarations", rating, config["ageRating"], "age rating")
    localization = by_locale(get(f"/v1/appInfos/{info['id']}/appInfoLocalizations")["data"], "app info localization")
    plan_patch(
        "appInfoLocalizations",
        localization,
        {"name": read_text("name"), "subtitle": read_text("subtitle"), "privacyPolicyUrl": read_text("privacy_url")},
        "app info",
    )
else:
    states = [i["attributes"]["state"] for i in infos]
    print(f"::notice::No editable app info (states {states}): name, subtitle, category and age rating wait for the next version.")

versions = get(f"/v1/apps/{app_id}/appStoreVersions?filter[platform]=IOS&filter[appVersionState]={EDITABLE_VERSION_STATES}")[
    "data"
]
if versions:
    version = versions[0]
    print(f"Version {version['attributes']['versionString']} ({version['attributes']['appVersionState']})")
    localization = by_locale(
        get(f"/v1/appStoreVersions/{version['id']}/appStoreVersionLocalizations")["data"], "version localization"
    )
    plan_patch(
        "appStoreVersionLocalizations",
        localization,
        {
            "description": read_text("description"),
            "keywords": read_text("keywords"),
            "promotionalText": read_text("promotional_text"),
            "supportUrl": read_text("support_url"),
            "marketingUrl": read_text("marketing_url"),
            # Apple refuses release notes on the first version of an app: add release_notes.txt after it.
            "whatsNew": read_text("release_notes"),
        },
        "version",
    )
    plan_screenshots(localization["id"])
else:
    print("::notice::No editable App Store version: create one in App Store Connect; version text and screenshots wait for it.")

plan_price(app_id, price)

if APPLY:
    for s, action in plan:
        print(f"Applying: {s}")
        action()

summary = [f"- {s}" for s, _ in plan] or ["- nothing: App Store Connect already matches apple/store/"]
heading = "App Store listing: changes applied" if APPLY else "App Store listing: planned changes (dry run)"
report = "\n".join([f"### {heading}", *summary, "", "App Privacy is a manual step: see apple/store/app-store-connect.md."])
print(report)
if summary_file := os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(summary_file, "a") as f:
        f.write(report + "\n")
