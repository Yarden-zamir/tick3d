"""Adds the newest TestFlight build to an external beta group and submits it for Beta App Review, so
every signed upload reaches external testers with no manual step in App Store Connect.

Run after `ios.yml`'s "Archive and upload" step (see the `distribute` job). Needs no Xcode, only the
App Store Connect API: a JWT signed with the same Admin key that uploads the build (see that job's
comment for the secrets and variables). Validated by hand once against the real API (see the ios
workflow's git history) before this became part of CI.

The external beta group itself, and its Beta App Review contact information (App Store Connect's
TestFlight tab > Test Information), are a one-time setup in the App Store Connect UI. This script
never creates or changes either; it only looks the group up by name (GROUP_NAME, default "Testers")
and acts on the app's most recently uploaded build.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

import jwt

ISSUER = os.environ["ISSUER"]
KEY_ID = os.environ["KEY_ID"]
PRIVATE_KEY = os.environ["PRIVATE_KEY"]
BUNDLE = os.environ["BUNDLE"]
GROUP_NAME = os.environ.get("GROUP_NAME", "Testers")
POLL_DEADLINE_MIN = float(os.environ.get("POLL_DEADLINE_MIN", "25"))


def token():
    now = int(time.time())
    return jwt.encode(
        {"iss": ISSUER, "iat": now, "exp": now + 1190, "aud": "appstoreconnect-v1"},
        PRIVATE_KEY,
        algorithm="ES256",
        headers={"kid": KEY_ID, "typ": "JWT"},
    )


def api(method, path, body=None):
    url = f"https://api.appstoreconnect.apple.com{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)


def fail(message):
    print(f"::error::{message}")
    sys.exit(1)


# 0. Find the App Store Connect app id for our bundle id, so nothing is hardcoded.
status, body = api("GET", f"/v1/apps?filter[bundleId]={BUNDLE}")
if status != 200 or not body.get("data"):
    fail(f"No App Store Connect app found for bundle id {BUNDLE}: {status} {body}")
app_id = body["data"][0]["id"]
print(f"App: {BUNDLE} -> {app_id}")

# 1. Find the external beta group by name. Never create it: that is a deliberate, manual step.
# The API's betaGroups listing takes no reliable name filter, so this matches client side.
status, body = api("GET", f"/v1/apps/{app_id}/betaGroups")
if status != 200:
    fail(f"Could not list beta groups: {status} {body}")
groups = [g for g in body.get("data", []) if g["attributes"]["name"] == GROUP_NAME]
if not groups:
    fail(f"No external beta group named '{GROUP_NAME}'. Create it once in App Store Connect's TestFlight tab.")
group = groups[0]
if group["attributes"].get("isInternalGroup"):
    fail(f"'{GROUP_NAME}' is an internal group, not external. Rename or pick the right group.")
group_id = group["id"]
print(f"Beta group '{GROUP_NAME}': {group_id}")

# 2. Poll for the most recently uploaded build to finish Apple's own processing.
deadline = time.time() + POLL_DEADLINE_MIN * 60
build = None
while time.time() < deadline:
    status, body = api(
        "GET",
        f"/v1/builds?filter[app]={app_id}&sort=-uploadedDate&limit=1"
        "&fields[builds]=version,processingState,uploadedDate",
    )
    if status == 200 and body.get("data"):
        b = body["data"][0]
        state = b["attributes"]["processingState"]
        print(f"Build {b['attributes']['version']} (uploaded {b['attributes']['uploadedDate']}): {state}")
        if state == "VALID":
            build = b
            break
        if state in ("FAILED", "INVALID"):
            fail(f"Build processing ended in {state}.")
    else:
        print(f"::warning::Could not read builds yet: {status} {body}")
    time.sleep(30)

if build is None:
    fail("Timed out waiting for the build to finish processing.")

build_id = build["id"]
build_version = build["attributes"]["version"]

# 3. Add the build to the external group. Testers in the group are notified automatically.
status, body = api(
    "POST",
    f"/v1/betaGroups/{group_id}/relationships/builds",
    {"data": [{"type": "builds", "id": build_id}]},
)
if status not in (200, 204):
    fail(f"Could not add build {build_version} to '{GROUP_NAME}': {status} {body}")
print(f"Added build {build_version} to '{GROUP_NAME}'.")

# 4. Submit for Beta App Review. Apple requires this once per version before external testers get it;
# a later build of an already-approved version is usually auto-available. A build that is already
# submitted, in review or approved answers 409, or 422 ENTITY_UNPROCESSABLE.INVALID_QC_STATE
# (confirmed by hand against the real API: re-running this on an already-submitted build) — both mean
# there is nothing new to do, not a failure.
ALREADY_COVERED_CODES = {"ENTITY_UNPROCESSABLE.INVALID_QC_STATE"}
status, body = api(
    "POST",
    "/v1/betaAppReviewSubmissions",
    {"data": {"type": "betaAppReviewSubmissions", "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}},
)
codes = {e.get("code") for e in (body or {}).get("errors", [])} if body else set()
if status in (200, 201):
    print(f"Submitted build {build_version} for Beta App Review.")
elif status == 409 or codes & ALREADY_COVERED_CODES:
    print(f"Build {build_version} needs no new Beta App Review submission (already covered): {codes or status}")
else:
    print(f"::warning::Beta App Review submission for build {build_version} returned {status}: {body}")

print(f"::notice::Build {build_version} is in '{GROUP_NAME}'.")
