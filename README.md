# Dynasty Overview

A small, static web app that connects to your [Sleeper](https://sleeper.com) fantasy
football account and helps you:

- **Track your team** &mdash; starters, bench, and your current-week matchup.
- **Check league standings** &mdash; records and points for/against for every team.
- **Find trade targets** &mdash; flags your weakest roster positions (relative to the
  rest of the league) and surfaces bench players on other rosters who could fill
  those needs.
- **Spot risers, buy-lows, and sell-highs** &mdash; a Trending tab surfaces
  players whose snap share, target share, and receiving/rushing efficiency
  are climbing or falling week over week, split into a Buy Low table (trend
  up, still valued outside the position's established tier) and a Sell High
  table (trend down, still valued inside it) for every metric. Shows
  whether each player is on your roster, a rival's, or unrostered in your
  league.
- **Catch up on player news** &mdash; a Recent News card on the My Team tab shows
  the last 90 days of news for players on your roster.
- **See what the league is doing** &mdash; a League Activity card on the My Team
  tab shows recent trades and waiver/free-agent moves from every team, not
  just yours.
- **Look up any player** &mdash; click a player's name anywhere in the app (My
  Team, Trade Finder, Trending) to open a card with their photo, team,
  position, who owns them in your league (or "Free agent"), and their stat
  line for the last few seasons.
- **See your contention window** &mdash; an Age Curve tab shows a value-weighted
  average age, a chart of roster value by age and position, and how that
  compares to the rest of the league, for your team or any other in a team
  selector. Defaults to starters only (a truer read on a win-now window),
  with a toggle to switch to full rosters. The league comparison table
  breaks average age out by QB/RB/WR/TE too.
- **See who's contending vs. rebuilding** &mdash; an Outlook tab splits the
  league into four quadrants by projected final record (each team's
  remaining games played out using their best possible bye-aware lineup
  each week, from real per-player scoring projections, updating
  automatically as real results come in) and starters' average age, both
  relative to the league median: Rising Contender (young + winning),
  Win-Now (old + winning), Rebuilding (young + losing), and Retool/Sell
  (old + losing), each with a short note on what that window suggests
  doing. A Power Rankings toggle switches to a sortable, trade-value-based
  ranking table instead (Overall / Starter / QB / RB / WR / TE / Draft
  rank, plus the same contender tier as a badge).
- **Evaluate any player** &mdash; a Player Evaluator tab lets you search any
  QB/RB/WR/TE in the league (not just players in your league) and see their
  season-by-season stat line for the last 5 seasons plus a week-by-week
  scoring chart and table for each of those seasons.
There is no backend, no build step, and no login. It's plain HTML/CSS/JS that
talks directly to Sleeper's public, read-only API from your browser. Nothing
you type is sent anywhere except Sleeper's API.

## Using it

1. Open the app (see [Running it](#running-it) below).
2. Enter your Sleeper **username** and the **season** (e.g. `2026`), then click
   "Find my leagues".
3. Pick one of your leagues from the dropdown and click "Load league".
4. Use the tabs to browse **My Team**, **Standings**, **Trade Finder**,
   **Trending**, **Age Curve**, **Outlook**, and **Evaluator**.

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
weeks before that (minimum weekly volume required &mdash; see the
description shown above each table in the app for exact thresholds), and
split into two tables side by side:

- **Buy Low** (left) &mdash; trend is climbing, but the player's current
  trade value rank still falls outside their position's "established" tier
  (top 12 QB, top 24 RB, top 36 WR, top 12 TE).
- **Sell High** (right) &mdash; trend is falling, but the player is still
  valued inside that tier.

This cross-references [`data/trade_values.json`](data/trade_values.json)
(the same DynastyProcess values the Trade Finder uses) client-side, no new
data pipeline needed. It's a snapshot comparison, not a value-history one
&mdash; the app only has DynastyProcess's *current* values, not how they've
moved over time, so it can't actually detect "the market hasn't reacted
yet." What it detects is current role vs. current price being out of sync,
which is the more practical version of the same idea anyway. If trade
values fail to load, both tables fall back to plain trend direction
(unfiltered by value tier) rather than going empty. Each table shows up to
5 players: tier-qualifying candidates are prioritized first, then backfilled
with the next-biggest trend movers of the right direction if there aren't
5 true qualifiers, so a table only comes up short when this position group
has no players trending that way at all. Every player league-wide is
considered (not just your own roster), since this doubles as a scouting
tool for trade targets.

Metric cards are ordered per tab by what's actually most predictive at that
position &mdash; e.g. QB leads with passing efficiency (Passing EPA/Attempt),
not Yards/Carry, since rushing is a bonus for a quarterback, not the
headline stat.

Each player is cross-referenced against the league you loaded: if Sleeper
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

## How League Activity works

The League Activity card on the My Team tab reads directly from Sleeper's
`/league/{id}/transactions/{week}` endpoint &mdash; no BigQuery pipeline
involved, since this is inherently per-league, real-time data Sleeper already
serves live. Sleeper buckets transactions by week, so on load the app fetches
the current week plus the two before it (or just week 1 if the season hasn't
started yet, since Sleeper stores all of a league's offseason activity there
before Week 1 begins), merges the results, and shows the 15 most recent
completed trades, waiver claims, and free-agent adds/drops league-wide
&mdash; skipping failed waiver bids and any non-roster (e.g. commissioner)
transactions. Trades show what each side gave up and received, including
traded picks and FAAB; waiver claims show the winning bid.

## How Age Curve works

`scripts/refresh_player_ages.py` queries BigQuery's `players` table (the
same one `refresh_player_season_stats.py` joins against for its
`sleeper_id` crosswalk) for each QB/RB/WR/TE's `birth_date`, and commits
the result to `data/player_ages.json`. Birth dates don't change, so the
workflow just runs weekly to pick up new players (rookies, etc.) &mdash;
current age is computed client-side from `birth_date` at render time
instead of being baked into the file, so it's never stale.

The Age Curve tab combines that with the same trade-value data the Trade
Finder uses: each player on a roster is weighted by their trade value (so a
bench dart-throw doesn't count as much as your RB1) to produce a
value-weighted average age, a chart of that roster's value broken out by
age and position, and a league-wide table ranking every team youngest to
oldest (with QB/RB/WR/TE average-age columns of its own). If trade values
fail to load, it falls back to a simple (unweighted) average instead of
hiding the feature entirely.

A team selector defaults to your own roster but lets you pull up the same
breakdown for anyone else in the league. A Starters / Full Roster toggle
controls which players feed all of this (both the selected team's numbers
and the league-wide comparison, so it stays an apples-to-apples ranking
either way). It defaults to starters, since bench age doesn't say much
about how long a team's current window to win is open.

## How Outlook works

The Outlook tab reuses the same age-weighting data as Age Curve (starters
only, fixed regardless of the Age Curve tab's own toggle) alongside each
team's **projected final record**, and sorts every team into one of four
quadrants:

- **Rising Contender** &mdash; young starters, winning projection.
- **Win-Now** &mdash; old starters, winning projection.
- **Rebuilding** &mdash; young starters, losing projection.
- **Retool / Sell** &mdash; old starters, losing projection.

The projection plays each team's remaining games out using their **best
possible lineup each week**, not a flat scoring rate: for every remaining
week, it takes each rostered player's projected points (their most recent
season's points per game, scored using this league's own scoring settings
via the same `computeLeaguePoints()` the player card stats table uses),
excludes anyone whose NFL team has a bye that week
(`data/nfl_byes.json`), and fills the league's actual starting lineup
slots &mdash; including FLEX/SUPERFLEX &mdash; with the best remaining
eligible players. So a bye doesn't just vanish a starter's points; the
next-best bench option at that position gets credited instead, same as a
real manager would do. Weeks already played stay locked in (this only
projects what's left), and points-against for the rest of the season uses
the team's own season-to-date rate once it has one, or the league's
average projected scoring as a neutral stand-in before any games are
played. The final win probability comes from a Pythagorean-style
expectation (points for&sup2; / (points for&sup2; + points against&sup2;))
over those projected season totals. Regular-season length comes from the
league's own playoff-start setting. Since it's computed fresh from
Sleeper's current standings and roster every time the app loads, the
projected record moves on its own each week as real matchups are scored
&mdash; there's nothing to refresh or recalculate by hand.

`data/nfl_byes.json` comes from a weekly BigQuery job
(`scripts/refresh_nfl_byes.py`) that derives each team's bye week from
nflverse's schedule data (the week a team appears in neither `home_team`
nor `away_team`) &mdash; the same `ff-python-api.nflreadpy` project the
other refresh jobs pull from. If that file hasn't loaded yet, the
week-by-week projection just uses full rosters as available (no bye
substitution) rather than breaking, and the tab says so.

Both axes are relative to the league's own median (age and projected win%),
not a fixed cutoff, so it works the same whether it's week 2 or week 15 and
regardless of league size. Before any games are played, points-for still
differentiates teams (it's driven by real per-player projections
regardless of games played), but points-against falls back to a
league-average estimate for everyone since there's no real defense/schedule
data yet &mdash; the tab notes this rather than presenting it as a fully
settled read. Each quadrant includes a short note on what that competitive
window suggests doing (sell veterans, target win-now vets, stay patient,
etc.).

A **Power Rankings** toggle switches the tab from the quadrant grid to a
sortable table (à la Dynasty Daddy's power rankings), ranking every team
1..N across:

- **Overall Rank** &mdash; full-roster trade value plus the value of every
  future draft pick you currently own.
- **Starter Rank** &mdash; trade value of your current starting lineup only.
- **QB / RB / WR / TE Rank** &mdash; combined trade value of your **top N**
  players at that position (top 3 QB, top 4 RB, top 5 WR, top 2 TE) &mdash;
  deep bench depth past that count doesn't inflate the position's value,
  same idea as the Trade Finder's own needs calculation.
- **Draft Rank** &mdash; value of your currently-owned future picks alone.

All of it comes from the same DynastyProcess trade-value data (and pick
ownership accounting) the Trade Finder and Age Curve tabs already use
&mdash; no new data pipeline. The **Contender Tier** column reuses the exact
same quadrant classification as the Quadrants view (age + projected
record), so the two views stay consistent with each other. Click any rank
column header to re-sort the table by it; switching views or re-sorting
never re-runs the weekly-projection loop above, since it's all derived from
the same rows computed once per page load.

Clicking a team's row (anywhere except a player name) expands it into a
full breakdown: every rostered QB/RB/WR/TE grouped by position and sorted
by value (highest first, with a filled star marking starters), plus every
future draft pick you currently own, individually valued and labeled with
which team it was originally that team's if it's been traded (e.g.
"2027 1st (via Some Team)"). Within each position group, a dashed divider
after the Nth player marks where the position's value cap kicks in &mdash;
everyone below it is still shown (so you can see your real depth) but
dimmed, since they don't count toward that position's rank/value. Each
group also repeats that group's rank/value/average-age, and the panel notes
your overall/starter value and flagged needs (the same needs the Trade
Finder tab computes) up top. Clicking a player name inside the expanded
view opens the normal player card instead of collapsing the row.

## How Player Evaluator works

The Evaluator tab is a standalone search over the full Sleeper player
directory (already loaded client-side for the rest of the app), not scoped
to your league &mdash; you can look up anyone at QB/RB/WR/TE, rostered or
not. Selecting a player reuses the same season-stat-line rendering as the
[player card](#player-cards) (`data/player_season_stats.json`, scored with
the loaded league's own scoring settings), so it stays perfectly consistent
with what you see everywhere else in the app. The player's name is
clickable the same way it is everywhere else, opening the full player card
modal (photo, ownership status, and Recent News) instead of duplicating
that content inline on the Evaluator page.

An **Advanced Metrics** card shows the same recent-4-weeks-vs-prior-4-weeks
trend data the Trending tab is built on (`data/rising_metrics.json`),
filtered to whichever metrics apply to this player's position &mdash; QB
gets Passing EPA/Attempt and CPOE, RB/WR/TE get Target Share, WOPR, and
(WR/TE only) Air Yards Share, RB/QB get Yards/Carry, and so on, matching
the same position-to-metric mapping the Trending tab uses. No separate
pipeline: it's the exact same data, just re-sliced to one player instead
of a league-wide leaderboard, so the two tabs never disagree. A metric a
player didn't see enough volume to qualify for (e.g. too few pass attempts
in the recent window) shows as "Not enough recent volume to qualify"
rather than a blank or a misleading zero.

The week-by-week chart and table are new: they come from
`scripts/refresh_player_weekly_stats.py`, refreshed weekly via
`.github/workflows/refresh-player-weekly-stats.yml` into
`data/player_weekly_stats.json`. It's the same BigQuery source and
`sleeper_id` join as the season-stats pipeline, just kept at weekly grain
(one row per player/season/week) instead of aggregated into season totals.
Season tabs let you flip between the last 5 years of a player's career; the
bar chart and the detailed stat table below it both use the same
per-position columns (and league scoring) as the season table. If this file
hasn't loaded yet or has no data for a given player, the weekly section
says so rather than showing nothing.

The chart scales bar heights against a fixed, labeled point axis (rounded
up to the next 10, with a 30-point floor) rather than that season's own
best week, so a 12-point week always looks like a 12-point week &mdash;
switching season tabs never silently re-scales the chart underneath you.
Any week over 20 points is colored differently from the rest (a teal bar
instead of the position's usual color) to call out standout scoring weeks
at a glance.

*A note on this specific pipeline:* like the bye-week data, this was
written without the ability to run a live query against BigQuery in the
authoring session &mdash; the query mirrors the season-stats script closely
enough that it should hold up, but if the scheduled workflow fails, check
its logs before assuming the underlying data is unavailable.

## Player cards

Click any player's name anywhere in the app &mdash; Starters/Bench, the
Trade Finder builder and manager suggestions, Trending leaderboards &mdash;
to open a card with their headshot ([Sleeper's own CDN](https://sleepercdn.com/),
falling back to a colored initial if a player has no photo yet), team,
position, and who currently owns them in your loaded league (or "Free
agent"). The card's own content (stats + news) scrolls internally once it
runs longer than the viewport &mdash; a heavily-covered player with dozens
of news items caps out at the window's height instead of growing past it,
and the close button stays put in the corner regardless of scroll position.

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
- `data/player_weekly_stats.json` (used by the Evaluator tab) is
  substantially larger than the season-stats file it's derived from, since
  it's one row per player per week rather than per season. It's only
  fetched the first time you open the Evaluator tab, not on every page
  load.
