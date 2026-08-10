"""Refresh data/nfl_byes.json from BigQuery (ff-python-api.nflreadpy.*).

A team's bye week isn't stored directly anywhere in nflreadpy -- it's
derived by finding, for the current season's regular season, which week(s)
each team has no game at all (appears in neither home_team nor away_team).
Normally that's exactly one week per team.

Schema assumption: this queries `nflreadpy.schedules` with a `season_type`
column (matching the convention already used by `player_stats` in this same
BigQuery project -- see refresh_rising_metrics.py / refresh_player_season_stats.py),
rather than nflreadr's usual `game_type` column name. If this script fails
with an "Unrecognized name" error for season_type on the schedules table,
that assumption was wrong for this table specifically -- check the actual
column name (likely `game_type`, with regular-season rows valued `'REG'`)
and swap it in the query below.

Requires GCP_SA_KEY env var (same as the sibling refresh_*.py scripts).
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import bigquery
from google.oauth2 import service_account

PROJECT_ID = "ff-python-api"
DATASET = "nflreadpy"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "nfl_byes.json"

QUERY = f"""
WITH bounds AS (
  SELECT MAX(season) AS season
  FROM `{PROJECT_ID}.{DATASET}.schedules`
  WHERE game_type = 'REG'
),
weeks AS (
  SELECT DISTINCT s.week
  FROM `{PROJECT_ID}.{DATASET}.schedules` s, bounds
  WHERE s.season = bounds.season AND s.game_type = 'REG'
),
teams AS (
  SELECT DISTINCT team FROM (
    SELECT home_team AS team FROM `{PROJECT_ID}.{DATASET}.schedules` s, bounds
      WHERE s.season = bounds.season AND s.game_type = 'REG'
    UNION ALL
    SELECT away_team AS team FROM `{PROJECT_ID}.{DATASET}.schedules` s, bounds
      WHERE s.season = bounds.season AND s.game_type = 'REG'
  )
),
played AS (
  SELECT home_team AS team, week FROM `{PROJECT_ID}.{DATASET}.schedules` s, bounds
    WHERE s.season = bounds.season AND s.game_type = 'REG'
  UNION ALL
  SELECT away_team AS team, week FROM `{PROJECT_ID}.{DATASET}.schedules` s, bounds
    WHERE s.season = bounds.season AND s.game_type = 'REG'
)
SELECT teams.team, weeks.week AS bye_week, bounds.season
FROM teams
CROSS JOIN weeks
CROSS JOIN bounds
LEFT JOIN played ON played.team = teams.team AND played.week = weeks.week
WHERE played.team IS NULL
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

    # A team should have exactly one bye. If the schedule table only has
    # past weeks loaded so far, every not-yet-played future week would also
    # show up as "missing" here -- collect all candidate weeks per team and
    # keep the earliest, which is far more likely to be the real bye than a
    # future week that's just not played yet.
    candidates = {}
    season = None
    for row in rows:
        season = str(row.season)
        candidates.setdefault(row.team, []).append(row.bye_week)

    byes = {}
    multi_week_teams = []
    for team, weeks in candidates.items():
        weeks.sort()
        byes[team] = weeks[0]
        if len(weeks) > 1:
            multi_week_teams.append((team, weeks))

    if multi_week_teams:
        print(
            "WARNING: these teams had more than one candidate bye week "
            "(schedule data may be incomplete) -- took the earliest: "
            f"{multi_week_teams}"
        )

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "season": season,
        "byes": byes,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {OUT_PATH}: season {season}, {len(byes)} teams")


if __name__ == "__main__":
    main()
