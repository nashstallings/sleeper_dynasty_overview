"""Refresh data/player_weekly_stats.json from BigQuery (ff-python-api.nflreadpy.*).

Pulls per-player, per-week stat lines (rather than season totals, see
refresh_player_season_stats.py) for the last few regular seasons, keyed by
sleeper_id, so the front-end's Player Evaluator tab can chart and table out
week-by-week scoring without needing live BigQuery access.

This is the same source table and player_id join as
refresh_player_season_stats.py, just without the SUM()/GROUP BY collapse
down to season -- one row per (player, season, week) instead. The
advanced-metric columns (target_share, wopr, air_yards_share, cpoe,
passing_epa, snap_share) and the snap_counts join are copied directly
from refresh_rising_metrics.py's already-running query, so this rides on
a source/schema combination already verified in production rather than a
fresh guess.

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
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "player_weekly_stats.json"

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
  ps.player_display_name AS name,
  ps.position AS position,
  ps.season,
  ps.week,
  ps.team,
  ps.opponent_team AS opponent,
  ps.completions,
  ps.attempts,
  ps.passing_yards,
  ps.passing_tds,
  ps.passing_interceptions AS interceptions,
  ps.carries,
  ps.rushing_yards,
  ps.rushing_tds,
  ps.targets,
  ps.receptions,
  ps.receiving_yards,
  ps.receiving_tds,
  ps.fantasy_points_ppr,
  ps.target_share,
  ps.wopr,
  ps.air_yards_share,
  ps.passing_cpoe AS cpoe,
  ps.passing_epa,
  sn.offense_pct AS snap_share
FROM `{PROJECT_ID}.{DATASET}.player_stats` ps
LEFT JOIN `{PROJECT_ID}.{DATASET}.players` pl ON pl.gsis_id = ps.player_id
LEFT JOIN `{PROJECT_ID}.{DATASET}.snap_counts` sn
  ON sn.pfr_player_id = pl.pfr_id AND sn.week = ps.week AND sn.season = ps.season AND sn.game_type = 'REG'
CROSS JOIN bounds
WHERE ps.season_type = 'REG'
  AND ps.position IN ('QB', 'RB', 'WR', 'TE')
  AND ps.season > bounds.max_season - {SEASONS_BACK}
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
            {"name": row.name, "position": row.position, "weeks": {}},
        )
        season_weeks = entry["weeks"].setdefault(str(row.season), {})
        season_weeks[str(row.week)] = {
            "team": row.team,
            "opponent": row.opponent,
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
            "target_share": round(row.target_share, 3) if row.target_share is not None else None,
            "wopr": round(row.wopr, 3) if row.wopr is not None else None,
            "air_yards_share": round(row.air_yards_share, 3) if row.air_yards_share is not None else None,
            "cpoe": round(row.cpoe, 2) if row.cpoe is not None else None,
            "passing_epa": row.passing_epa,
            "snap_share": round(row.snap_share, 3) if row.snap_share is not None else None,
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
