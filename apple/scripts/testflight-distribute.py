# /// script
# requires-python = ">=3.12"
# dependencies = ["pyjwt==2.15.1", "cryptography==50.0.2"]
# ///
"""Adds the TestFlight build of this run to an external beta group and submits it for Beta App Review, so
every tagged upload reaches external testers with no manual step in App Store Connect.

Usage: uv run apple/scripts/testflight-distribute.py (the `distribute` job of ios.yml).
Run after `ios.yml`'s "Archive and upload" step. Needs no Xcode, only the App Store Connect API: a JWT
signed with the same Admin key that uploads the build (see that job's comment for the secrets and
variables). BUILD_NUMBER is the build number of the upload: the script acts on that build only.

The external beta group itself, and its Beta App Review contact information (App Store Connect's
TestFlight tab > Test Information), are a one-time setup in the App Store Connect UI. This script
never creates or changes either; it only looks the group up by name (GROUP_NAME, default "Testers").
"""

import os
import sys
import time

from asc import api, fail

BUNDLE = os.environ["BUNDLE"]
BUILD_NUMBER = os.environ["BUILD_NUMBER"]
GROUP_NAME = os.environ.get("GROUP_NAME", "Testers")
POLL_DEADLINE_MIN = float(os.environ.get("POLL_DEADLINE_MIN", "40"))

if not BUILD_NUMBER.isdigit():
    print(f"::error::BUILD_NUMBER must be the build number of the upload, not '{BUILD_NUMBER}'.")
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

# 2. Poll for the build of this run to show up and finish Apple's own processing. A build that Apple does
# not list yet is an empty answer: keep polling, never fall back to another build.
deadline = time.time() + POLL_DEADLINE_MIN * 60
build = None
while time.time() < deadline:
    status, body = api(
        "GET",
        f"/v1/builds?filter[app]={app_id}&filter[version]={BUILD_NUMBER}&limit=1"
        "&fields[builds]=version,processingState,uploadedDate",
    )
    if status == 200 and not body.get("data"):
        print(f"Build {BUILD_NUMBER} is not listed yet.")
    elif status == 200:
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
    fail(f"Timed out after {POLL_DEADLINE_MIN:g} minutes waiting for build {BUILD_NUMBER} to finish processing.")

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
# submitted, in review or approved answers ENTITY_UNPROCESSABLE.INVALID_QC_STATE (confirmed by hand
# against the real API: re-running this on an already-submitted build). That means there is nothing new
# to do. Any other error fails the job, so a real validation failure never looks green.
ALREADY_COVERED_CODES = {"ENTITY_UNPROCESSABLE.INVALID_QC_STATE"}
status, body = api(
    "POST",
    "/v1/betaAppReviewSubmissions",
    {"data": {"type": "betaAppReviewSubmissions", "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}},
)
codes = {e.get("code") for e in (body or {}).get("errors", [])} if body else set()
if status in (200, 201):
    print(f"Submitted build {build_version} for Beta App Review.")
elif codes and codes <= ALREADY_COVERED_CODES:
    print(f"Build {build_version} needs no new Beta App Review submission (already covered): {codes}")
else:
    fail(f"Beta App Review submission for build {build_version} returned {status}: {body}")

print(f"::notice::Build {build_version} is in '{GROUP_NAME}'.")
