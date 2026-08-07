"""Refresh data/player_ages.json from BigQuery (ff-python-api.nflreadpy.players).

nflreadpy's players table (already loaded into BigQuery by the sibling
contract_dynasty_draft repo's nfl_data_refresh.py) carries each player's
birth_date alongside the same sleeper_id crosswalk used by
refresh_player_season_stats.py. Birth dates don't change, so this just
needs to run periodically to pick up new players (rookies, etc.) -- the
front-end computes each player's current age from birth_date at render
time, so there's nothing time-sensitive to recompute here.

Requires GCP_SA_KEY env var (same as refresh_rising_metrics.py).
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import bigquery
from google.oauth2 import service_account

PROJECT_ID = "ff-python-api"
DATASET = "nflreadpy"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "player_ages.json"

QUERY = f"""
SELECT
  sleeper_id,
  ANY_VALUE(display_name) AS name,
  ANY_VALUE(position) AS position,
  ANY_VALUE(birth_date) AS birth_date
FROM (
  SELECT
    CASE WHEN sleeper_id IS NOT NULL THEN CAST(CAST(sleeper_id AS INT64) AS STRING) END AS sleeper_id,
    display_name,
    position,
    birth_date
  FROM `{PROJECT_ID}.{DATASET}.players`
  WHERE position IN ('QB', 'RB', 'WR', 'TE')
)
WHERE sleeper_id IS NOT NULL AND birth_date IS NOT NULL
GROUP BY sleeper_id
"""


def get_client():
    sa_info = json.loads(os.environ["GCP_SA_KEY"])
    credentials = service_account.Credentials.from_service_account_info(
        sa_info, scopes=["https://www.googleapis.com/auth/bigquery"]
    )
    return bigquery.Client(project=PROJECT_ID, credentials=credentials)


def main():
    client = get_client()
    rows = list(client.query(QUERY).result())

    players = {
        row.sleeper_id: {
            "name": row.name,
            "position": row.position,
            "birth_date": row.birth_date.isoformat() if hasattr(row.birth_date, "isoformat") else str(row.birth_date),
        }
        for row in rows
    }

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "players": players,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {OUT_PATH}: {len(players)} players with birth dates")


if __name__ == "__main__":
    main()
