"""Refresh data/rising_metrics.json from BigQuery (ff-python-api.nflreadpy.*).

Computes, per player, the delta between their most recent 4 weeks and the
4 weeks before that for a handful of usage/efficiency metrics, and writes
one row per player (with whichever metrics apply to their position) to a
static JSON file that the front-end fetches directly (no client-side
BigQuery access / credentials needed). The front-end slices this by
position tab (QB/RB/WR/TE/FLEX/SFLEX) and re-sorts per metric itself, so
this script doesn't need to precompute a separate leaderboard per
position/metric combination.

No injury-report data is loaded into BigQuery, so weeks a player was
playing hurt (or barely played) are approximated instead of detected
directly: a week is excluded for a player if their snap share that week
fell below INJURY_DROP_THRESHOLD of their own peak snap share over the
8-week window, and only for players whose peak was at least
INJURY_MIN_PEAK_SNAP_PCT (i.e. real weekly contributors, so bench/depth
players with naturally low, variable snaps aren't misflagged).

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

INJURY_MIN_PEAK_SNAP_PCT = 0.5
INJURY_DROP_THRESHOLD = 0.25

MIN_TARGETS_PER_WEEK = 3
MIN_CARRIES_PER_WEEK = 3
MIN_ATTEMPTS_PER_WEEK = 10
MIN_SNAP_SHARE_RECENT = 0.5

QUERY = f"""
WITH bounds AS (
  SELECT MAX(week) AS max_wk, MAX(season) AS season
  FROM `{PROJECT_ID}.{DATASET}.player_stats`
  WHERE season_type = 'REG'
),
raw_stats AS (
  SELECT
    ps.player_id, pl.gsis_id,
    CASE WHEN pl.sleeper_id IS NOT NULL THEN CAST(CAST(pl.sleeper_id AS INT64) AS STRING) END AS sleeper_id,
    ps.player_display_name AS name, ps.position, ps.team, ps.week,
    ps.target_share, ps.wopr, ps.targets, ps.carries, ps.attempts,
    ps.air_yards_share, ps.passing_cpoe,
    SAFE_DIVIDE(ps.receiving_yards, NULLIF(ps.targets, 0)) AS ypt,
    SAFE_DIVIDE(ps.rushing_yards, NULLIF(ps.carries, 0)) AS ypc,
    SAFE_DIVIDE(ps.passing_yards, NULLIF(ps.attempts, 0)) AS ypa,
    SAFE_DIVIDE(ps.passing_epa, NULLIF(ps.attempts, 0)) AS epa_per_att,
    sn.offense_pct AS snap_pct
  FROM `{PROJECT_ID}.{DATASET}.player_stats` ps
  LEFT JOIN `{PROJECT_ID}.{DATASET}.players` pl ON pl.gsis_id = ps.player_id
  LEFT JOIN `{PROJECT_ID}.{DATASET}.snap_counts` sn
    ON sn.pfr_player_id = pl.pfr_id AND sn.week = ps.week AND sn.season = ps.season AND sn.game_type = 'REG'
  CROSS JOIN bounds
  WHERE ps.season = bounds.season AND ps.season_type = 'REG'
    AND ps.position IN ('QB', 'RB', 'WR', 'TE')
    AND ps.week > bounds.max_wk - 8
),
-- a player's own peak snap share over the window stands in for their "healthy" role
baseline AS (
  SELECT player_id, MAX(snap_pct) AS peak_snap_pct
  FROM raw_stats
  GROUP BY player_id
),
-- drop weeks that look like the player was playing hurt / clearly limited
stats AS (
  SELECT r.*
  FROM raw_stats r
  JOIN baseline b USING (player_id)
  WHERE b.peak_snap_pct < {INJURY_MIN_PEAK_SNAP_PCT}
     OR r.snap_pct IS NULL
     OR r.snap_pct >= {INJURY_DROP_THRESHOLD} * b.peak_snap_pct
),
windows AS (
  SELECT
    player_id, ANY_VALUE(gsis_id) gsis_id, ANY_VALUE(sleeper_id) sleeper_id,
    ANY_VALUE(name) name, ANY_VALUE(position) position, ANY_VALUE(team) team,
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
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, ypa, NULL)) recent_ypa,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, ypa, NULL)) prior_ypa,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, epa_per_att, NULL)) recent_epa,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, epa_per_att, NULL)) prior_epa,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, air_yards_share, NULL)) recent_air_yards_share,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, air_yards_share, NULL)) prior_air_yards_share,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, passing_cpoe, NULL)) recent_cpoe,
    AVG(IF(week <= (SELECT max_wk FROM bounds) - 4, passing_cpoe, NULL)) prior_cpoe,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, targets, NULL)) recent_targets_avg,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, carries, NULL)) recent_carries_avg,
    AVG(IF(week > (SELECT max_wk FROM bounds) - 4, attempts, NULL)) recent_attempts_avg,
    COUNTIF(week > (SELECT max_wk FROM bounds) - 4) recent_games,
    COUNTIF(week <= (SELECT max_wk FROM bounds) - 4) prior_games
  FROM stats
  GROUP BY player_id
)
SELECT
  name, position, team, gsis_id, sleeper_id,

  IF(recent_snap_pct IS NOT NULL AND prior_snap_pct IS NOT NULL AND recent_snap_pct > {MIN_SNAP_SHARE_RECENT},
     ROUND(prior_snap_pct, 3), NULL) AS snap_share_prior,
  IF(recent_snap_pct IS NOT NULL AND prior_snap_pct IS NOT NULL AND recent_snap_pct > {MIN_SNAP_SHARE_RECENT},
     ROUND(recent_snap_pct, 3), NULL) AS snap_share_recent,

  IF(recent_target_share IS NOT NULL AND prior_target_share IS NOT NULL,
     ROUND(prior_target_share, 3), NULL) AS target_share_prior,
  IF(recent_target_share IS NOT NULL AND prior_target_share IS NOT NULL,
     ROUND(recent_target_share, 3), NULL) AS target_share_recent,

  IF(recent_wopr IS NOT NULL AND prior_wopr IS NOT NULL,
     ROUND(prior_wopr, 3), NULL) AS wopr_prior,
  IF(recent_wopr IS NOT NULL AND prior_wopr IS NOT NULL,
     ROUND(recent_wopr, 3), NULL) AS wopr_recent,

  IF(recent_ypt IS NOT NULL AND prior_ypt IS NOT NULL AND recent_targets_avg >= {MIN_TARGETS_PER_WEEK},
     ROUND(prior_ypt, 2), NULL) AS yards_per_target_prior,
  IF(recent_ypt IS NOT NULL AND prior_ypt IS NOT NULL AND recent_targets_avg >= {MIN_TARGETS_PER_WEEK},
     ROUND(recent_ypt, 2), NULL) AS yards_per_target_recent,

  IF(recent_ypc IS NOT NULL AND prior_ypc IS NOT NULL AND recent_carries_avg >= {MIN_CARRIES_PER_WEEK},
     ROUND(prior_ypc, 2), NULL) AS yards_per_carry_prior,
  IF(recent_ypc IS NOT NULL AND prior_ypc IS NOT NULL AND recent_carries_avg >= {MIN_CARRIES_PER_WEEK},
     ROUND(recent_ypc, 2), NULL) AS yards_per_carry_recent,

  IF(recent_ypa IS NOT NULL AND prior_ypa IS NOT NULL AND recent_attempts_avg >= {MIN_ATTEMPTS_PER_WEEK},
     ROUND(prior_ypa, 2), NULL) AS yards_per_attempt_prior,
  IF(recent_ypa IS NOT NULL AND prior_ypa IS NOT NULL AND recent_attempts_avg >= {MIN_ATTEMPTS_PER_WEEK},
     ROUND(recent_ypa, 2), NULL) AS yards_per_attempt_recent,

  IF(recent_epa IS NOT NULL AND prior_epa IS NOT NULL AND recent_attempts_avg >= {MIN_ATTEMPTS_PER_WEEK},
     ROUND(prior_epa, 3), NULL) AS passing_epa_prior,
  IF(recent_epa IS NOT NULL AND prior_epa IS NOT NULL AND recent_attempts_avg >= {MIN_ATTEMPTS_PER_WEEK},
     ROUND(recent_epa, 3), NULL) AS passing_epa_recent,

  IF(recent_air_yards_share IS NOT NULL AND prior_air_yards_share IS NOT NULL AND recent_targets_avg >= {MIN_TARGETS_PER_WEEK},
     ROUND(prior_air_yards_share, 3), NULL) AS air_yards_share_prior,
  IF(recent_air_yards_share IS NOT NULL AND prior_air_yards_share IS NOT NULL AND recent_targets_avg >= {MIN_TARGETS_PER_WEEK},
     ROUND(recent_air_yards_share, 3), NULL) AS air_yards_share_recent,

  IF(recent_cpoe IS NOT NULL AND prior_cpoe IS NOT NULL AND recent_attempts_avg >= {MIN_ATTEMPTS_PER_WEEK},
     ROUND(prior_cpoe, 2), NULL) AS cpoe_prior,
  IF(recent_cpoe IS NOT NULL AND prior_cpoe IS NOT NULL AND recent_attempts_avg >= {MIN_ATTEMPTS_PER_WEEK},
     ROUND(recent_cpoe, 2), NULL) AS cpoe_recent

FROM windows
WHERE recent_games >= 2 AND prior_games >= 2
"""

BOUNDS_QUERY = f"""
SELECT MAX(season) AS season, MAX(week) AS max_wk
FROM `{PROJECT_ID}.{DATASET}.player_stats`
WHERE season_type = 'REG'
"""

INJURY_NOTE = (
    "Excludes weeks a player's snap share cratered to under a quarter of their own "
    "peak (a proxy for playing hurt/limited, since no injury-report data is loaded)."
)

# key -> (label, format, positions this metric applies to)
METRIC_DEFS = {
    "snap_share": {
        "label": "Snap Share",
        "format": "pct",
        "positions": ["RB", "WR", "TE"],
        "description": (
            "Share of offensive snaps played, last 4 weeks vs. the 4 weeks before that. "
            f"Only players currently above {int(MIN_SNAP_SHARE_RECENT * 100)}% snap share. " + INJURY_NOTE
        ),
    },
    "target_share": {
        "label": "Target Share",
        "format": "pct",
        "positions": ["RB", "WR", "TE"],
        "description": "Share of team targets, last 4 weeks vs. the 4 weeks before that. " + INJURY_NOTE,
    },
    "wopr": {
        "label": "WOPR (Opportunity Score)",
        "format": "num",
        "positions": ["RB", "WR", "TE"],
        "description": (
            "Weighted Opportunity Rating — combines target share and air yards share into "
            "one usage score. Last 4 weeks vs. the 4 weeks before that. " + INJURY_NOTE
        ),
    },
    "yards_per_target": {
        "label": "Yards / Target",
        "format": "num",
        "positions": ["RB", "WR", "TE"],
        "description": (
            "Receiving yards per target — the closest proxy Sleeper's free data supports for "
            "yards-per-route-run efficiency (routes-run charting isn't publicly available). "
            f"Min. {MIN_TARGETS_PER_WEEK} targets/week in the recent window. " + INJURY_NOTE
        ),
    },
    "yards_per_carry": {
        "label": "Yards / Carry",
        "format": "num",
        "positions": ["QB", "RB"],
        "description": f"Rushing yards per carry. Min. {MIN_CARRIES_PER_WEEK} carries/week in the recent window. " + INJURY_NOTE,
    },
    "yards_per_attempt": {
        "label": "Yards / Attempt",
        "format": "num",
        "positions": ["QB"],
        "description": f"Passing yards per attempt. Min. {MIN_ATTEMPTS_PER_WEEK} attempts/week in the recent window. " + INJURY_NOTE,
    },
    "passing_epa": {
        "label": "Passing EPA / Attempt",
        "format": "num",
        "positions": ["QB"],
        "description": (
            "Expected Points Added per pass attempt — a play-by-play efficiency metric that "
            f"accounts for down, distance, and situation. Min. {MIN_ATTEMPTS_PER_WEEK} attempts/week "
            "in the recent window. " + INJURY_NOTE
        ),
    },
    "cpoe": {
        "label": "CPOE",
        "format": "num",
        "positions": ["QB"],
        "description": (
            "Completion % Over Expected — passing accuracy adjusted for throw difficulty, "
            f"independent of scheme or receiver play. Min. {MIN_ATTEMPTS_PER_WEEK} attempts/week "
            "in the recent window. " + INJURY_NOTE
        ),
    },
    "air_yards_share": {
        "label": "Air Yards Share",
        "format": "pct",
        "positions": ["WR", "TE"],
        "description": (
            "Share of the team's total air yards (downfield distance thrown, not yards after "
            f"catch) — a signal of a growing vertical/red-zone role. Min. {MIN_TARGETS_PER_WEEK} "
            "targets/week in the recent window. " + INJURY_NOTE
        ),
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

    players = []
    for row in rows:
        metrics = {}
        for key in METRIC_DEFS:
            prior = getattr(row, f"{key}_prior")
            recent = getattr(row, f"{key}_recent")
            if prior is None or recent is None:
                continue
            metrics[key] = {
                "prior": prior,
                "recent": recent,
                "delta": round(recent - prior, 4),
            }
        if not metrics:
            continue
        players.append(
            {
                "name": row.name,
                "position": row.position,
                "team": row.team,
                "gsis_id": row.gsis_id,
                "sleeper_id": row.sleeper_id,
                "metrics": metrics,
            }
        )

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "season": season,
        "season_type": "REG",
        "recent_weeks": recent_weeks,
        "prior_weeks": prior_weeks,
        "injury_filter": {
            "min_peak_snap_pct": INJURY_MIN_PEAK_SNAP_PCT,
            "drop_threshold": INJURY_DROP_THRESHOLD,
            "description": INJURY_NOTE,
        },
        "metric_defs": METRIC_DEFS,
        "players": players,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {OUT_PATH} ({len(players)} players, season {season}, weeks {prior_weeks} -> {recent_weeks})")


if __name__ == "__main__":
    main()
