"""Refresh data/rising_metrics.json from BigQuery (ff-python-api.nflreadpy.*).

Computes, per player, the delta between their most recent 4 weeks and the
4 weeks before that for a handful of usage/efficiency metrics, and writes
the top risers per metric to a static JSON file that the front-end fetches
directly (no client-side BigQuery access / credentials needed).

Requires GCP_SA_KEY env var: a JSON service account key with BigQuery
read access to the ff-python-api project (same key used by the sibling
contract_dynasty_draft repo's daily refresh job works fine here too).
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import bigquery
from google.oauth2 import service_account

PROJECT_ID = "ff-python-api"
DATASET = "nflreadpy"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "rising_metrics.json"

QUERY = f"""
WITH bounds AS (
  SELECT MAX(week) AS max_wk, MAX(season) AS season
  FROM `{PROJECT_ID}.{DATASET}.player_stats`
  WHERE season_type = 'REG'
),
stats AS (
  SELECT
    ps.player_id, pl.gsis_id, ps.player_display_name AS name, ps.position, ps.team, ps.week,
    ps.target_share, ps.wopr, ps.targets, ps.carries,
    SAFE_DIVIDE(ps.receiving_yards, NULLIF(ps.targets, 0)) AS ypt,
    SAFE_DIVIDE(ps.rushing_yards, NULLIF(ps.carries, 0)) AS ypc,
    sn.offense_pct AS snap_pct
  FROM `{PROJECT_ID}.{DATASET}.player_stats` ps
  LEFT JOIN `{PROJECT_ID}.{DATASET}.players` pl ON pl.gsis_id = ps.player_id
  LEFT JOIN `{PROJECT_ID}.{DATASET}.snap_counts` sn
    ON sn.pfr_player_id = pl.pfr_id AND sn.week = ps.week AND sn.season = ps.season AND sn.game_type = 'REG'
  CROSS JOIN bounds
  WHERE ps.season = bounds.season AND ps.season_type = 'REG'
    AND ps.position IN ('WR', 'TE', 'RB')
    AND ps.week > bounds.max_wk - 8
),
windows AS (
  SELECT
    player_id, ANY_VALUE(gsis_id) gsis_id, ANY_VALUE(name) name, ANY_VALUE(position) position, ANY_VALUE(team) team,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, snap_pct, NULL)) recent_snap_pct,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, snap_pct, NULL)) prior_snap_pct,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, target_share, NULL)) recent_target_share,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, target_share, NULL)) prior_target_share,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, ypt, NULL)) recent_ypt,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, ypt, NULL)) prior_ypt,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, wopr, NULL)) recent_wopr,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, wopr, NULL)) prior_wopr,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, ypc, NULL)) recent_ypc,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, ypc, NULL)) prior_ypc,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, targets, NULL)) recent_targets_avg,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, carries, NULL)) recent_carries_avg,
    COUNTIF(week > (SELECT max_wk FROM bounds) - 4) recent_games,
    COUNTIF(week <= (SELECT max_wk FROM bounds) - 4) prior_games
  FROM stats
  GROUP BY player_id
),
qualified AS (
  SELECT *,
    recent_snap_pct - prior_snap_pct AS snap_pct_delta,
    recent_target_share - prior_target_share AS target_share_delta,
    recent_ypt - prior_ypt AS ypt_delta,
    recent_wopr - prior_wopr AS wopr_delta,
    recent_ypc - prior_ypc AS ypc_delta
  FROM windows
  WHERE recent_games >= 2 AND prior_games >= 2
)
SELECT 'snap_share' AS metric, name, position, team, gsis_id,
  ROUND(prior_snap_pct, 3) AS prior_val, ROUND(recent_snap_pct, 3) AS recent_val, ROUND(snap_pct_delta, 3) AS delta
FROM qualified WHERE recent_snap_pct IS NOT NULL AND prior_snap_pct IS NOT NULL
QUALIFY ROW_NUMBER() OVER (ORDER BY snap_pct_delta DESC) <= 12

UNION ALL
SELECT 'target_share', name, position, team, gsis_id,
  ROUND(prior_target_share, 3), ROUND(recent_target_share, 3), ROUND(target_share_delta, 3)
FROM qualified WHERE recent_target_share IS NOT NULL AND prior_target_share IS NOT NULL
QUALIFY ROW_NUMBER() OVER (ORDER BY target_share_delta DESC) <= 12

UNION ALL
SELECT 'yards_per_target', name, position, team, gsis_id,
  ROUND(prior_ypt, 2), ROUND(recent_ypt, 2), ROUND(ypt_delta, 2)
FROM qualified WHERE recent_ypt IS NOT NULL AND prior_ypt IS NOT NULL AND recent_targets_avg >= 3
QUALIFY ROW_NUMBER() OVER (ORDER BY ypt_delta DESC) <= 12

UNION ALL
SELECT 'wopr', name, position, team, gsis_id,
  ROUND(prior_wopr, 3), ROUND(recent_wopr, 3), ROUND(wopr_delta, 3)
FROM qualified WHERE recent_wopr IS NOT NULL AND prior_wopr IS NOT NULL
QUALIFY ROW_NUMBER() OVER (ORDER BY wopr_delta DESC) <= 12

UNION ALL
SELECT 'yards_per_carry', name, position, team, gsis_id,
  ROUND(prior_ypc, 2), ROUND(recent_ypc, 2), ROUND(ypc_delta, 2)
FROM qualified WHERE recent_ypc IS NOT NULL AND prior_ypc IS NOT NULL AND position = 'RB' AND recent_carries_avg >= 3
QUALIFY ROW_NUMBER() OVER (ORDER BY ypc_delta DESC) <= 12
"""

BOUNDS_QUERY = f"""
SELECT MAX(season) AS season, MAX(week) AS max_wk
FROM `{PROJECT_ID}.{DATASET}.player_stats`
WHERE season_type = 'REG'
"""

METRIC_META = {
    "snap_share": {
        "label": "Snap Share",
        "format": "pct",
        "description": "Share of offensive snaps played, last 4 weeks vs. the 4 weeks before that.",
    },
    "target_share": {
        "label": "Target Share",
        "format": "pct",
        "description": "Share of team targets, last 4 weeks vs. the 4 weeks before that.",
    },
    "wopr": {
        "label": "WOPR (Opportunity Score)",
        "format": "num",
        "description": "Weighted Opportunity Rating — combines target share and air yards share into one usage score. Last 4 weeks vs. the 4 weeks before that.",
    },
    "yards_per_target": {
        "label": "Yards / Target",
        "format": "num",
        "description": "Receiving yards per target — the closest proxy Sleeper's free data supports for yards-per-route-run efficiency (routes-run charting isn't publicly available). Min. 3 targets/week in the recent window.",
    },
    "yards_per_carry": {
        "label": "Yards / Carry",
        "format": "num",
        "description": "Rushing yards per carry, RBs only. Min. 3 carries/week in the recent window.",
    },
}


def get_client():
    sa_info = json.loads(os.environ["GCP_SA_KEY"])
    credentials = service_account.Credentials.from_service_account_info(
        sa_info, scopes=["https://www.googleapis.com/auth/bigquery.readonly"]
    )
    return bigquery.Client(project=PROJECT_ID, credentials=credentials)


def main():
    client = get_client()

    bounds = list(client.query(BOUNDS_QUERY).result())[0]
    season, max_wk = bounds.season, bounds.max_wk
    recent_weeks = list(range(max_wk - 3, max_wk + 1))
    prior_weeks = list(range(max_wk - 7, max_wk - 3))

    rows = list(client.query(QUERY).result())

    metrics = {key: {**meta, "leaders": []} for key, meta in METRIC_META.items()}
    for row in rows:
        metrics[row.metric]["leaders"].append(
            {
                "name": row.name,
                "position": row.position,
                "team": row.team,
                "gsis_id": row.gsis_id,
                "prior": row.prior_val,
                "recent": row.recent_val,
                "delta": row.delta,
            }
        )

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "season": season,
        "season_type": "REG",
        "recent_weeks": recent_weeks,
        "prior_weeks": prior_weeks,
        "metrics": metrics,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {OUT_PATH} (season {season}, weeks {prior_weeks} -> {recent_weeks})")


if __name__ == "__main__":
    main()
