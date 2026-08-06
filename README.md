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
- **Catch up on player news** &mdash; a Recent News card on the My Team tab shows
  the last 90 days of news for players on your roster.
- **Look up any player** &mdash; click a player's name anywhere in the app (My
  Team, Trade Finder, Trending) to open a card with their photo, team,
  position, who owns them in your league (or "Free agent"), and their stat
  line for the last few seasons.

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

**Team needs** works the same way for every roster in the league, including
yours: for each of QB / RB / WR / TE, the app sums each team's trade value
at that position across as many players as the league starts there (e.g.
your top 2 RBs in a 2-RB league, not just your single best one) &mdash; so
a team needs real depth, not just one standout player, to rate well. If a
team's combined value at a position ranks in the bottom half of the
league, that position is flagged as a **need** for that team. The card at
the top of the tab shows your own needs as a quick summary. (FLEX/SUPER_FLEX
slots aren't attributed to any one position, since several positions can
fill them. If trade values haven't loaded, this falls back to comparing
each team's single best player by Sleeper's overall `search_rank`.)

**Build a trade offer** is interactive: check one or more players from your
own roster (starters and bench) that you'd consider trading away. The app
then shows a card for every other manager in the league, so you can see:

- Whether each selected player fills a **flagged need** for that manager
  (green "Fills a need") or not (muted "No flagged need") &mdash; based on
  the same needs calculation as above, just run for their roster instead of
  yours.
- A **suggested return package** &mdash; not just a list, but an actual
  combination of their players that would make the trade even.

Every player shows a **trade value** (from
[DynastyProcess](https://github.com/dynastyprocess/data)'s open dynasty
value dataset, refreshed daily), and your offer's running total is shown
as you select players. For each manager, the app searches their roster for
the smallest group of players whose combined value lands within &plusmn;20%
of your offer &mdash; checking 1-player packages first, then 2, then 3, so
it never suggests more players than necessary. When multiple packages of
the same size would be about as fair, it prefers the one using more
players at positions *you* need. If nothing on their roster gets close
enough to be fair, it shows their closest possible package instead,
labeled with how far off it is (e.g. "18% off your offer") rather than
mislabeling it as even.

Manager cards are ranked by how good the proposed trade actually is, best
first: a fair/even package beats a fallback one, then the closer to even
the better, then fewer players in the package is preferred, and only as a
final tiebreak does whether your offer fills a flagged need for them come
into it. A team that would love your players but has nothing to offer back
ranks below a team with a genuinely fair trade on the table. Values switch
to the superflex/2QB scale automatically if your league starts more than
one QB-eligible slot (QB or SUPER_FLEX).

**Draft picks count too.** Both sides of a trade can include future picks,
not just players: your "Draft Picks" list shows every pick you currently
own (accounting for trades already made in the league &mdash; a pick you
acquired shows "via [team]", and one you traded away won't show up at
all), each with a value from the same DynastyProcess dataset. Return
packages can include a manager's picks the same way. Pick ownership is
computed from Sleeper's `traded_picks` endpoint against a default of one
pick per round per season (rounds read from the league's draft settings),
for however many draft classes the value dataset currently covers (usually
the next 3). Since a future pick's exact draft slot isn't knowable yet,
each pick is valued at the generic season/round level (e.g. "2027 2nd"),
not a projected exact slot.

This is a heuristic based on roster construction and community-sourced
trade values, not weekly projections, so use it as a starting point for
research, not gospel.

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

## How player news works

RotoWire publishes a public [NFL news RSS feed](https://www.rotowire.com/rss/news.php?sport=NFL)
intended for syndication. `.github/workflows/refresh-player-news.yml` runs
`scripts/refresh_player_news.py` every 3 hours, which:

1. Fetches that feed.
2. Keeps only items matching RotoWire's "Player Name: headline" convention
   (skipping general roundup articles that aren't about one player).
3. Resolves each player name against the same BigQuery player crosswalk used
   by the Trending pipeline (covering every current QB/RB/WR/TE, not just
   players on any particular team), attaching a real Sleeper `player_id`
   &mdash; this avoids fragile client-side name matching (Jr./Sr./punctuation
   differences).
4. Merges the newly matched items into whatever was already collected and
   commits the result to `data/player_news.json`. RotoWire's feed only
   exposes a small rolling window of its most recent items rather than a
   full 90-day archive, so each run accumulates onto the existing file
   (items simply age out after 90 days) instead of overwriting it &mdash;
   otherwise coverage would be capped at whatever sliver of news happened
   to still be in the feed at the moment of that one fetch.

The My Team tab's Recent News card fetches that accumulated file and filters
it client-side down to players on your currently-loaded roster, from the
last 90 days &mdash; so switching leagues re-filters the same broad dataset
rather than needing a per-league fetch. Uses the same `GCP_SA_KEY` secret as
the Trending refresh; no separate credential needed.

## Player cards

Click any player's name anywhere in the app &mdash; Starters/Bench, the
Trade Finder builder and manager suggestions, Trending leaderboards &mdash;
to open a card with their headshot ([Sleeper's own CDN](https://sleepercdn.com/),
falling back to a colored initial if a player has no photo yet), team,
position, and who currently owns them in your loaded league (or "Free
agent").

The stat line comes from `scripts/refresh_player_season_stats.py`, which
aggregates BigQuery's weekly `nflreadpy.player_stats` into season totals
per player (up to the last 4 regular seasons, 2022&ndash;2025 currently),
refreshed weekly via `.github/workflows/refresh-player-season-stats.yml`
into `data/player_season_stats.json`. Columns shown depend on position
(e.g. a QB sees completions/attempts/passing yards/TDs/INTs, a WR sees
targets/receptions/receiving yards/TDs), plus a fantasy-points column
recalculated per season from the raw stats using the *loaded league's own*
`scoring_settings` (passing/rushing/receiving yardage and TD rates,
interceptions, receptions, and TE-premium bonus) &mdash; so a standard,
half-PPR, full-PPR, or TE-premium league each see accurate season totals for
their own rules, not a generic PPR number. Falls back to a standard PPR total
if no league is loaded. Uses the same `GCP_SA_KEY` secret as the other
BigQuery-backed pipelines.

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
