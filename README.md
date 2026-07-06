# Sleeper Trade Finder

A small, static web app that connects to your [Sleeper](https://sleeper.com) fantasy
football account and helps you:

- **Track your team** &mdash; starters, bench, and your current-week matchup.
- **Check league standings** &mdash; records and points for/against for every team.
- **Find trade targets** &mdash; flags your weakest roster positions (relative to the
  rest of the league) and surfaces bench players on other rosters who could fill
  those needs.

There is no backend, no build step, and no login. It's plain HTML/CSS/JS that
talks directly to Sleeper's public, read-only API from your browser. Nothing
you type is sent anywhere except Sleeper's API.

## Using it

1. Open the app (see [Running it](#running-it) below).
2. Enter your Sleeper **username** and the **season** (e.g. `2026`), then click
   "Find my leagues".
3. Pick one of your leagues from the dropdown and click "Load league".
4. Use the tabs to browse **My Team**, **Standings**, and **Trade Finder**.

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

## Running it

**Option 1 &mdash; GitHub Pages (recommended):** In this repo's Settings ->
Pages, set "Deploy from a branch" to `main` / `/ (root)`. GitHub will publish
the app at `https://<your-username>.github.io/<repo-name>/`.

**Option 2 &mdash; locally:** Any static file server works, e.g.:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000`. (Opening `index.html` directly via
`file://` also works in most browsers, since Sleeper's API allows
cross-origin requests.)

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
