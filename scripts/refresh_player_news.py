"""Refresh data/player_news.json from RotoWire's public NFL news RSS feed.

RotoWire publishes a public RSS feed of player news
(https://www.rotowire.com/rss/news.php?sport=NFL) intended for
syndication/personal use. This script fetches it, keeps only items that
look like single-player news (RotoWire's long-standing title convention
is "Player Name: headline"), resolves each player name against the same
BigQuery player crosswalk used by refresh_rising_metrics.py to attach a
real Sleeper player_id, and writes a static JSON file the front-end
fetches directly.

Doing the player-name -> sleeper_id resolution here (rather than in the
browser) avoids fragile client-side name matching (Jr./Sr./suffix/
punctuation differences) -- the same lesson learned from the Trending
tab, where matching had to go through BigQuery's sleeper_id crosswalk
column instead of trusting name strings.

The output intentionally is NOT filtered to any specific team/league,
since this script has no notion of who's viewing the site -- it's a
general "recent player news, with an ID attached" feed covering every
current QB/RB/WR/TE. The front-end filters it down to the loaded
league's roster and the desired time window (last 30 days for the "Recent
News" widget, last 90 days on a player's own card) at render time.

RotoWire's RSS feed only exposes a small rolling window of its most
recent items, not a 90-day archive, so each run merges newly matched
items into whatever was already collected (see load_existing_items)
rather than overwriting -- otherwise coverage would be capped at
whatever sliver of news happens to still be in the feed at the moment
of each individual fetch.

Requires GCP_SA_KEY env var (same as refresh_rising_metrics.py).
"""

import json
import os
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.request import Request, urlopen

from google.cloud import bigquery
from google.oauth2 import service_account

PROJECT_ID = "ff-python-api"
DATASET = "nflreadpy"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "player_news.json"

FEED_URL = "https://www.rotowire.com/rss/news.php?sport=NFL"
SOURCE_NAME = "RotoWire"
SOURCE_PAGE_URL = "https://www.rotowire.com/rss/"

# Keep a wider window than the 2 weeks the UI shows, so a missed/late
# scheduled run doesn't leave a visible gap.
MAX_AGE_DAYS = 90

USER_AGENT = (
    "Mozilla/5.0 (compatible; DynastyOverviewBot/1.0; "
    "+https://github.com/nashstallings/sleeper_dynasty_overview)"
)

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def normalize_name(name):
    name = name.lower().replace(".", "").replace("'", "")
    name = re.sub(r"[^a-z0-9\s-]", "", name)
    parts = name.split()
    if parts and parts[-1] in SUFFIXES:
        parts = parts[:-1]
    return " ".join(parts).strip()


def strip_html(text):
    if not text:
        return ""
    text = TAG_RE.sub(" ", text)
    text = text.replace("&nbsp;", " ")
    return WS_RE.sub(" ", text).strip()


def get_bq_client():
    sa_info = json.loads(os.environ["GCP_SA_KEY"])
    credentials = service_account.Credentials.from_service_account_info(
        sa_info, scopes=["https://www.googleapis.com/auth/bigquery"]
    )
    return bigquery.Client(project=PROJECT_ID, credentials=credentials)


def load_player_lookup(client):
    query = f"""
    SELECT display_name, sleeper_id, gsis_id, position, team
    FROM `{PROJECT_ID}.{DATASET}.players`
    WHERE position IN ('QB', 'RB', 'WR', 'TE')
      AND display_name IS NOT NULL
      AND last_season >= 2023
    """
    lookup = {}
    for row in client.query(query).result():
        key = normalize_name(row.display_name)
        if not key:
            continue
        sleeper_id = None
        if row.sleeper_id is not None:
            sleeper_id = str(int(row.sleeper_id))
        # Prefer rows that actually have a sleeper_id if a name collides.
        if key in lookup and lookup[key]["sleeper_id"] and not sleeper_id:
            continue
        lookup[key] = {
            "display_name": row.display_name,
            "sleeper_id": sleeper_id,
            "gsis_id": row.gsis_id,
            "position": row.position,
            "team": row.team,
        }
    return lookup


def fetch_feed_xml():
    req = Request(FEED_URL, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, text/xml"})
    with urlopen(req, timeout=30) as resp:
        return resp.read()


def load_existing_items():
    """RotoWire's RSS feed only exposes a small rolling window of its most
    recent items (often a literal handful across the whole league), not a
    90-day archive. If we rebuilt the output from scratch every run, our
    real coverage would be capped at whatever sliver of news happens to
    still be in that window at each fetch -- so instead we carry forward
    whatever we already collected and only let items age out via
    MAX_AGE_DAYS, not via a fresh feed pull evicting them early."""
    if not OUT_PATH.exists():
        return []
    try:
        return json.loads(OUT_PATH.read_text()).get("items", [])
    except (json.JSONDecodeError, OSError):
        return []


def parse_items(xml_bytes):
    # Local import: keep the XML parser import next to its only use.
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_bytes)
    items = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        description = strip_html(item.findtext("description") or "")
        pub_date_raw = (item.findtext("pubDate") or "").strip()

        if ":" not in title:
            continue  # not a single-player note (e.g. a general roundup article)
        name_part, _, headline_part = title.partition(":")
        name_part = name_part.strip()
        headline_part = headline_part.strip()
        if not name_part or not headline_part:
            continue

        try:
            pub_date = parsedate_to_datetime(pub_date_raw)
            if pub_date.tzinfo is None:
                pub_date = pub_date.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue

        items.append(
            {
                "raw_name": name_part,
                "headline": headline_part,
                "description": description,
                "link": link,
                "pub_date": pub_date,
            }
        )
    return items


def main():
    client = get_bq_client()
    lookup = load_player_lookup(client)

    xml_bytes = fetch_feed_xml()
    raw_items = parse_items(xml_bytes)

    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    matched, unmatched, stale = 0, 0, 0
    fresh_items = []

    for item in raw_items:
        if item["pub_date"] < cutoff:
            stale += 1
            continue
        player = lookup.get(normalize_name(item["raw_name"]))
        if not player:
            unmatched += 1
            continue
        matched += 1
        fresh_items.append(
            {
                "player_name": player["display_name"],
                "sleeper_id": player["sleeper_id"],
                "gsis_id": player["gsis_id"],
                "position": player["position"],
                "team": player["team"],
                "headline": item["headline"],
                "description": item["description"],
                "link": item["link"],
                "pub_date": item["pub_date"].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        )

    # Merge with whatever we already collected (see load_existing_items for
    # why), keyed by (sleeper_id, pub_date) since RotoWire's <link> always
    # points at the player's profile page, not a per-story URL.
    existing_items = load_existing_items()
    existing_keys = {(it.get("sleeper_id"), it.get("pub_date")) for it in existing_items}
    fresh_keys = {(it.get("sleeper_id"), it.get("pub_date")) for it in fresh_items}
    newly_added = len(fresh_keys - existing_keys)

    combined = {}
    for it in existing_items + fresh_items:
        combined[(it.get("sleeper_id"), it.get("pub_date"))] = it

    def still_fresh(it):
        try:
            pub = datetime.strptime(it["pub_date"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            return False
        return pub >= cutoff

    output_items = [it for it in combined.values() if still_fresh(it)]
    output_items.sort(key=lambda x: x["pub_date"], reverse=True)

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE_NAME,
        "source_url": SOURCE_PAGE_URL,
        "max_age_days": MAX_AGE_DAYS,
        "items": output_items,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(
        f"Wrote {OUT_PATH}: {len(output_items)} items total ({newly_added} new this run). "
        f"This fetch: matched={matched}, unmatched_name={unmatched}, "
        f"older_than_{MAX_AGE_DAYS}d={stale}, total_feed_items={len(raw_items)}"
    )


if __name__ == "__main__":
    main()
