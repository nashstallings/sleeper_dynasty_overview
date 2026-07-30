"""Refresh data/trade_values.json from DynastyProcess's open dynasty trade
value dataset (https://github.com/dynastyprocess/data), joined against
their player ID crosswalk to attach each player's Sleeper ID directly --
no BigQuery/Sleeper API round-trip needed for this one.
"""

import csv
import io
import json
import re
import urllib.request
from datetime import datetime, timezone

VALUES_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values.csv"
IDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"
OUTPUT_PATH = "data/trade_values.json"
USER_AGENT = (
    "Mozilla/5.0 (compatible; DynastyOverviewBot/1.0; "
    "+https://github.com/nashstallings/sleeper_dynasty_overview)"
)

# values.csv rows with pos=="PICK" name draft picks in a few formats:
#   "2026 Pick 1.01"   -- exact slot, only for the nearest/current draft class
#   "2027 Early 1st"   -- tercile within a round, for the next class out
#   "2027 1st"         -- round-level aggregate (also present for 2027/2028)
# We only need a value per (season, round), not per exact slot, since we
# can't know which exact slot a given team will end up owning ahead of time.
PICK_ROUND_RE = re.compile(r"^(\d{4}) (\d+)(?:st|nd|rd|th)$")
PICK_SLOTTED_RE = re.compile(r"^(\d{4}) Pick (\d+)\.\d+$")


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


def ordinal(n):
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def parse_pick_name(name):
    """Returns (season, round, is_round_level) for a pick row, or None if
    the name doesn't match a format we know how to use (e.g. tercile rows,
    which we skip in favor of the round-level or slot-averaged value)."""
    m = PICK_ROUND_RE.match(name)
    if m:
        return m.group(1), int(m.group(2)), True
    m = PICK_SLOTTED_RE.match(name)
    if m:
        return m.group(1), int(m.group(2)), False
    return None


def build_picks(values_rows):
    round_level = {}  # (season, round) -> {value_1qb, value_2qb}
    slotted = {}  # (season, round) -> [(value_1qb, value_2qb), ...]

    for row in values_rows:
        if row.get("pos") != "PICK":
            continue
        parsed = parse_pick_name((row.get("player") or "").strip())
        if not parsed:
            continue
        season, round_, is_round_level = parsed
        entry = (to_int(row.get("value_1qb")), to_int(row.get("value_2qb")))
        if is_round_level:
            round_level[(season, round_)] = entry
        else:
            slotted.setdefault((season, round_), []).append(entry)

    def avg(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals)) if vals else None

    picks = {}
    for key in set(round_level) | set(slotted):
        season, round_ = key
        if key in round_level:
            v1, v2 = round_level[key]
        else:
            pairs = slotted[key]
            v1 = avg(v for v, _ in pairs)
            v2 = avg(v for _, v in pairs)
        picks[f"{season} {ordinal(round_)}"] = {"value_1qb": v1, "value_2qb": v2}

    return picks


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

    picks = build_picks(values_rows)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "DynastyProcess",
        "source_url": "https://github.com/dynastyprocess/data",
        "players": players,
        "picks": picks,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    print(
        f"Wrote {OUTPUT_PATH}: {len(players)} players "
        f"(matched={matched}, unmatched_no_sleeper_id={unmatched}), "
        f"{len(picks)} draft pick season/round values"
    )


if __name__ == "__main__":
    main()
