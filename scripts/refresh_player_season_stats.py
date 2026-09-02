"""Refresh data/player_season_stats.json from BigQuery (ff-python-api.nflreadpy.*).

Aggregates weekly player_stats into season totals for the last few regular
seasons, keyed by sleeper_id, so the front-end's player card can show a
season-by-season stat line without needing live BigQuery access.

The advanced-metric columns (target_share, wopr, air_yards_share, cpoe,
passing_epa, snap_share) and the snap_counts join are copied directly from
the already-running refresh_rising_metrics.py's query -- same column
names, same join condition (pfr_player_id/week/season/game_type) -- so
this rides on a source/schema combination already verified in production,
unlike a from-scratch guess. passing_epa is kept as a season total (not
pre-divided) so the front-end can compute EPA/attempt itself, matching how
every other per-attempt/per-carry/per-target column here is already
computed client-side from raw totals.

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
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "player_season_stats.json"

# Current season plus this many prior ones (e.g. 4 total seasons of history).
SEASONS_BACK = 4

QUERY = f"""
WITH bounds AS (
  SELECT MAX(season) AS max_season
  FROM `{PROJECT_ID}.{DATASET}.player_stats`
  WHERE season_type = 'REG'
)
SELECT
  ps.player_id AS gsis_id,
  CASE WHEN pl.sleeper_id IS NOT NULL THEN CAST(CAST(pl.sleeper_id AS INT64) AS STRING) END AS sleeper_id,
  ANY_VALUE(ps.player_display_name) AS name,
  ANY_VALUE(ps.position) AS position,
  ps.season,
  ARRAY_AGG(ps.team ORDER BY ps.week DESC LIMIT 1)[OFFSET(0)] AS team,
  COUNT(DISTINCT ps.week) AS games,
  SUM(ps.completions) AS completions,
  SUM(ps.attempts) AS attempts,
  SUM(ps.passing_yards) AS passing_yards,
  SUM(ps.passing_tds) AS passing_tds,
  SUM(ps.passing_interceptions) AS interceptions,
  SUM(ps.carries) AS carries,
  SUM(ps.rushing_yards) AS rushing_yards,
  SUM(ps.rushing_tds) AS rushing_tds,
  SUM(ps.targets) AS targets,
  SUM(ps.receptions) AS receptions,
  SUM(ps.receiving_yards) AS receiving_yards,
  SUM(ps.receiving_tds) AS receiving_tds,
  SUM(ps.fantasy_points_ppr) AS fantasy_points_ppr,
  ROUND(AVG(ps.target_share), 3) AS target_share,
  ROUND(AVG(ps.wopr), 3) AS wopr,
  ROUND(AVG(ps.air_yards_share), 3) AS air_yards_share,
  ROUND(AVG(ps.passing_cpoe), 2) AS cpoe,
  SUM(ps.passing_epa) AS passing_epa,
  ROUND(AVG(sn.offense_pct), 3) AS snap_share
FROM `{PROJECT_ID}.{DATASET}.player_stats` ps
LEFT JOIN `{PROJECT_ID}.{DATASET}.players` pl ON pl.gsis_id = ps.player_id
LEFT JOIN `{PROJECT_ID}.{DATASET}.snap_counts` sn
  ON sn.pfr_player_id = pl.pfr_id AND sn.week = ps.week AND sn.season = ps.season AND sn.game_type = 'REG'
CROSS JOIN bounds
WHERE ps.season_type = 'REG'
  AND ps.position IN ('QB', 'RB', 'WR', 'TE')
  AND ps.season > bounds.max_season - {SEASONS_BACK}
GROUP BY ps.player_id, sleeper_id, ps.season
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

    players = {}
    matched, unmatched = 0, 0
    seasons_seen = set()

    for row in rows:
        if not row.sleeper_id:
            unmatched += 1
            continue
        matched += 1
        seasons_seen.add(row.season)

        entry = players.setdefault(
            row.sleeper_id,
            {"name": row.name, "position": row.position, "seasons": {}},
        )
        entry["seasons"][str(row.season)] = {
            "team": row.team,
            "games": row.games,
            "completions": row.completions,
            "attempts": row.attempts,
            "passing_yards": row.passing_yards,
            "passing_tds": row.passing_tds,
            "interceptions": row.interceptions,
            "carries": row.carries,
            "rushing_yards": row.rushing_yards,
            "rushing_tds": row.rushing_tds,
            "targets": row.targets,
            "receptions": row.receptions,
            "receiving_yards": row.receiving_yards,
            "receiving_tds": row.receiving_tds,
            "fantasy_points_ppr": (
                round(row.fantasy_points_ppr, 1) if row.fantasy_points_ppr is not None else None
            ),
            "target_share": row.target_share,
            "wopr": row.wopr,
            "air_yards_share": row.air_yards_share,
            "cpoe": row.cpoe,
            "passing_epa": row.passing_epa,
            "snap_share": row.snap_share,
        }

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "seasons_included": sorted(seasons_seen),
        "players": players,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(
        f"Wrote {OUT_PATH}: {len(players)} players, seasons {sorted(seasons_seen)} "
        f"(matched={matched}, unmatched_no_sleeper_id={unmatched})"
    )


if __name__ == "__main__":
    main()
