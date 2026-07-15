# Dynasty Overview

A small, static web app that connects to your [Sleeper](https://sleeper.com) fantasy
football account and helps you:

- **Track your team** &mdash; starters, bench, and your current-week matchup.
- **Check league standings** &mdash; records and points for/against for every team.
- **Find trade targets** &mdash; flags your weakest roster positions (relative to the
  rest of the league) and surfaces bench players on other rosters who could fill
  those needs.
- **Spot risers** &mdash; a Trending tab surfaces players whose snap share, target
  share, and receiving/rushing efficiency are climbing week over week, and shows
  whether they're on your roster, a rival's, or unrostered in your league.

There is no backend, no build step, and no login. It's plain HTML/CSS/JS that
talks directly to Sleeper's public, read-only API from your browser. Nothing
you type is sent anywhere except Sleeper's API.

## Using it

1. Open the app (see [Running it](#running-it) below).
2. Enter your Sleeper **username** and the **season** (e.g. `2026`), then click
   "Find my leagues".
3. Pick one of your leagues from the dropdown and click "Load league".
4. Use the tabs to browse **My Team**, **Standings**, **Trade Finder**, and **Trending**.

Your username and chosen league are remembered in your browser (`localStorage`)
so you won't have to re-enter them next time. Use "Switch league" to pick a
different one.

## How the Trade Finder works

For each of QB / RB / WR / TE, the app looks at the best player you own at
that position (using Sleeper's overall `search_rank`, an approximate
overall/ADP-style ranking) and compares it to every other team's best player
at that position. If your best player at a position ranks in the bottom half
of the league, that position is flagged as a **need**.

For each need, the app lists players from other rosters at that position,
sorted by rank, with bench players surfaced first &mdash; those are more
likely to be available in a trade since their current owner isn't starting
them.

This is a heuristic based on roster construction, not weekly projections or
trade values, so use it as a starting point for research, not gospel.

## How Trending works

Sleeper's API doesn't expose advanced usage/efficiency stats (no snap counts,
no target share, no routes run), so this tab is backed by a second, separate
data source: [nflverse](https://nflreadr.nflverse.com/) play-by-play data,
pre-aggregated into [`data/rising_metrics.json`](data/rising_metrics.json) by
a scheduled job (see below) rather than fetched live in the browser.

The tab is split into position sub-tabs &mdash; **QB, RB, WR, TE, FLEX**
(RB/WR/TE combined), and **SFlex** (QB/RB/WR/TE combined, for superflex
leagues). Each single-position tab shows metrics picked for what actually
matters at that position, rather than one generic set reused everywhere:

- **QB:** Yards / Attempt, Passing EPA / Attempt, CPOE, Yards / Carry
- **RB:** Snap Share, Target Share, WOPR, Yards / Target, Yards / Carry
- **WR:** Snap Share, Target Share, WOPR, Yards / Target, Air Yards Share
- **TE:** Snap Share, Target Share, WOPR, Yards / Target, Air Yards Share

Snap share is skipped for QB (and filtered out of the QB rows in SFlex) since
it's a near-binary "are they starting or not" signal for quarterbacks, not a
gradual trend worth surfacing.

FLEX and SFlex show the union of whatever's relevant across their combined
positions (so more than the position-tab counts above), since they're meant
to be the comprehensive "everything" views.

- **Snap share** &mdash; share of offensive snaps played (RB/WR/TE). Only
  shown for players currently above 50% snap share, so a backup buried on
  the depth chart doesn't clutter the list.
- **Target share** &mdash; share of team targets (RB/WR/TE).
- **WOPR** &mdash; Weighted Opportunity Rating, a target-share + air-yards-share
  usage blend (RB/WR/TE).
- **Yards / target** &mdash; the closest proxy this data source supports for
  yards-per-route-run efficiency (RB/WR/TE). True YPRR needs routes-run
  charting (e.g. PFF), which isn't part of the free nflverse feed, so treat
  this as a stand-in, not the real thing.
- **Air yards share** &mdash; share of the team's total downfield throw
  distance (WR/TE), a signal of a growing vertical/red-zone role.
- **Yards / carry** &mdash; rushing efficiency (QB/RB).
- **Yards / attempt** &mdash; passing efficiency (QB only).
- **Passing EPA / attempt** &mdash; Expected Points Added per pass attempt, a
  situation-aware passing efficiency metric (QB only).
- **CPOE** &mdash; Completion % Over Expected, passing accuracy adjusted for
  throw difficulty (QB only).

For each metric, every player's most recent 4 weeks are compared to the 4
weeks before that, and the biggest positive movers are listed (max 10 per
table, minimum weekly volume required &mdash; see the description shown
above each table in the app for exact thresholds). Tables render two per
row, and are ordered per tab by what's actually most predictive at that
position &mdash; e.g. QB leads with passing efficiency (Passing EPA/Attempt),
not Yards/Carry, since rushing is a bonus for a quarterback, not the
headline stat.

Each riser is cross-referenced against the league you loaded: if Sleeper
knows the player and they're on a roster in your league, you'll see whose
(with "Your roster" called out); otherwise they're marked a free agent, or
"Not in Sleeper's DB" for deep-roster/practice-squad players Sleeper doesn't
track.

### Keeping the trending data fresh

`.github/workflows/refresh-rising-metrics.yml` re-runs the aggregation
weekly (Tuesday mornings, after Monday Night Football) via
`scripts/refresh_rising_metrics.py`, which queries a BigQuery project
(`ff-python-api.nflreadpy`) populated by a companion daily job and commits
the refreshed `data/rising_metrics.json` back to the repo.

For the scheduled refresh to run, this repo needs a `GCP_SA_KEY` repository
secret: a service account JSON key with BigQuery read access to that project
(Settings -> Secrets and variables -> Actions). Without it, the workflow
fails but the site keeps serving whatever snapshot is already committed. You
can also trigger a refresh manually from the Actions tab
("Run workflow" on "Refresh Rising Metrics").

## Running it

**Option 1 &mdash; GitHub Pages (recommended):** In this repo's Settings ->
Pages, set "Deploy from a branch" to `main` / `/ (root)`. GitHub will publish
the app at `https://<your-username>.github.io/<repo-name>/`.

**Option 2 &mdash; locally:** Any static file server works, e.g.:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000`. My Team / Standings / Trade Finder also
work opening `index.html` directly via `file://`, since Sleeper's API allows
cross-origin requests &mdash; but the Trending tab needs a real HTTP server,
since browsers block `fetch()` of local files (like `data/rising_metrics.json`)
from a `file://` page.

## Notes & limitations

- Sleeper's API is public and requires no API key or OAuth, but it is also
  unofficial/undocumented in places and could change without notice.
- The NFL player database (`/players/nfl`) is a large (~5MB) payload; the app
  caches it in `localStorage` for 12 hours to avoid re-downloading it on every
  visit.
- `search_rank` is Sleeper's general-purpose ranking, not a dynasty/redraft
  trade calculator value &mdash; treat trade suggestions as a lead, not a
  final answer.
- Kickers and defenses are intentionally excluded from the needs/trade-finder
  logic; they're low-value and easily streamed.
- Trending data reflects whatever season/weeks the BigQuery source has most
  recently loaded (regular season only). During the offseason it'll show
  last season's final weeks until the new season's games start generating
  data.
