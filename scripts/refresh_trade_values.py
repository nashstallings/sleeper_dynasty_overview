"""Refresh data/trade_values.json from DynastyProcess's open dynasty trade
value dataset (https://github.com/dynastyprocess/data), joined against
their player ID crosswalk to attach each player's Sleeper ID directly --
no BigQuery/Sleeper API round-trip needed for this one.
"""

import csv
import io
import json
import urllib.request
from datetime import datetime, timezone

VALUES_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values.csv"
IDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"
OUTPUT_PATH = "data/trade_values.json"
USER_AGENT = (
    "Mozilla/5.0 (compatible; DynastyOverviewBot/1.0; "
    "+https://github.com/nashstallings/sleeper_dynasty_overview)"
)


def fetch_csv(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def to_int(val):
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return None


def clean(val):
    """This CSV export uses the literal string "NA" for missing values."""
    return val if val and val != "NA" else None


def main():
    values_rows = fetch_csv(VALUES_URL)
    id_rows = fetch_csv(IDS_URL)

    fp_to_sleeper = {}
    for row in id_rows:
        fp_id = clean(row.get("fantasypros_id"))
        sleeper_id = clean(row.get("sleeper_id"))
        if fp_id and sleeper_id:
            fp_to_sleeper[fp_id] = sleeper_id

    players = {}
    matched = 0
    unmatched = 0
    for row in values_rows:
        sleeper_id = fp_to_sleeper.get(clean(row.get("fp_id")))
        if not sleeper_id:
            unmatched += 1
            continue
        matched += 1
        players[sleeper_id] = {
            "name": row.get("player"),
            "position": row.get("pos"),
            "team": row.get("team"),
            "value_1qb": to_int(row.get("value_1qb")),
            "value_2qb": to_int(row.get("value_2qb")),
        }

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "DynastyProcess",
        "source_url": "https://github.com/dynastyprocess/data",
        "players": players,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    print(
        f"Wrote {OUTPUT_PATH}: {len(players)} players "
        f"(matched={matched}, unmatched_no_sleeper_id={unmatched})"
    )


if __name__ == "__main__":
    main()
