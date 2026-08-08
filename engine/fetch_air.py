"""Fetch current PM2.5 for the covered cities and write it as a static file.

Run by a scheduled workflow, never by the browser, so the API token stays in
repository secrets rather than in page source.

Scope is deliberately limited to cities with a real government monitor nearby.
Extending the list to places without one would produce numbers that look just as
confident and mean much less, and the whole project rests on the input being
defensible.
"""

import json
import os
import sys
import urllib.request

CITIES = {
    "delhi": "Delhi", "gurugram": "Gurugram", "noida": "Noida",
    "mumbai": "Mumbai", "bengaluru": "Bengaluru", "kolkata": "Kolkata",
    "chennai": "Chennai", "hyderabad": "Hyderabad", "pune": "Pune",
    "lucknow": "Lucknow", "patna": "Patna", "ahmedabad": "Ahmedabad",
    "jaipur": "Jaipur", "kanpur": "Kanpur", "chandigarh": "Chandigarh",
}

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "frontend", "data", "air", "latest.json")


def fetch(slug, token):
    url = "https://api.waqi.info/feed/{}/?token={}".format(slug, token)
    req = urllib.request.Request(url, headers={"User-Agent": "saans/1.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.load(r)
    if d.get("status") != "ok":
        return None
    iaqi = d["data"].get("iaqi", {})
    pm = iaqi.get("pm25", {}).get("v")
    if pm is None:
        return None
    return {
        "pm25": float(pm),
        "station": d["data"].get("city", {}).get("name"),
        "updated": d["data"].get("time", {}).get("s"),
    }


def main():
    token = os.environ.get("WAQI_TOKEN")
    if not token:
        print("WAQI_TOKEN not set; leaving the existing file untouched.")
        return 0

    # Start from whatever is already on disk so one failed city does not wipe a
    # reading that was fine an hour ago.
    existing = {}
    if os.path.exists(OUT):
        try:
            existing = json.load(open(OUT)).get("cities", {})
        except ValueError:
            existing = {}

    cities = {}
    ok = 0
    for slug, name in CITIES.items():
        try:
            r = fetch(slug, token)
        except Exception as e:
            print("  {}: {}".format(slug, type(e).__name__))
            r = None
        if r:
            cities[slug] = {"name": name, **r}
            ok += 1
        elif slug in existing:
            cities[slug] = existing[slug]
            cities[slug]["stale"] = True

    if not cities:
        print("nothing fetched and nothing cached; not writing an empty file")
        return 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"cities": cities}, f, indent=2, sort_keys=True)
    print("wrote {} cities, {} fresh".format(len(cities), ok))
    return 0


if __name__ == "__main__":
    sys.exit(main())
