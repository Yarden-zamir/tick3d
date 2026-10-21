"""App Store Connect API access for the scripts in this folder: a JWT signed with the Admin API key.

Reads ISSUER, KEY_ID and PRIVATE_KEY from the environment. The scripts import this file; `uv run` puts the
script folder on the import path. Each script declares pyjwt and cryptography in its own inline metadata.
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
