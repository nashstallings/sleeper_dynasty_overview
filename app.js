const API_BASE = "https://api.sleeper.app/v1";
const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
const PLAYERS_CACHE_KEY = "sleeper_tf_players_cache_v1";
const PLAYERS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h
const SESSION_KEY = "sleeper_tf_session_v1";
const TRENDING_POS_TAB_KEY = "sleeper_tf_trending_postab_v1";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function infoIcon(text) {
  return `
    <span class="info-icon" tabindex="0" role="button" aria-label="About this metric">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.3"/>
        <rect x="7.25" y="6.5" width="1.5" height="5" rx="0.75" fill="currentColor"/>
        <rect x="7.25" y="3.75" width="1.5" height="1.5" rx="0.75" fill="currentColor"/>
      </svg>
      <span class="tooltip" role="tooltip">${escapeHtml(text)}</span>
    </span>`;
}

const POSITION_TABS = [
  {
    key: "QB",
    label: "QB",
    positions: ["QB"],
    // passing quality first (what QBs are actually valued on) — rushing is a bonus, not the headline
    metricOrder: ["passing_epa", "yards_per_attempt", "cpoe", "yards_per_carry"],
  },
  {
    key: "RB",
    label: "RB",
    positions: ["RB"],
    // workload + rushing efficiency (an RB's primary job) before receiving-role stats
    metricOrder: ["snap_share", "yards_per_carry", "target_share", "wopr", "yards_per_target"],
  },
  {
    key: "WR",
    label: "WR",
    positions: ["WR"],
    // target volume is the headline breakout signal for WRs; snap share is the least differentiating
    metricOrder: ["target_share", "wopr", "air_yards_share", "yards_per_target", "snap_share"],
  },
  {
    key: "TE",
    label: "TE",
    positions: ["TE"],
    metricOrder: ["target_share", "wopr", "air_yards_share", "yards_per_target", "snap_share"],
  },
  {
    key: "FLEX",
    label: "FLEX",
    positions: ["RB", "WR", "TE"],
    metricOrder: ["target_share", "wopr", "snap_share", "yards_per_target", "yards_per_carry", "air_yards_share"],
  },
  {
    key: "SFLEX",
    label: "SFlex",
    positions: ["QB", "RB", "WR", "TE"],
    metricOrder: [
      "target_share", "wopr", "snap_share", "yards_per_target", "yards_per_carry",
      "air_yards_share", "passing_epa", "yards_per_attempt", "cpoe",
    ],
  },
];

const state = {
  username: null,
  userId: null,
  season: null,
  leagues: [],
  leagueId: null,
  league: null,
  rosters: [],
  users: [],
  players: {},
  myRosterId: null,
  currentWeek: null,
  risingMetrics: null,
  trendingPosTab: localStorage.getItem(TRENDING_POS_TAB_KEY) || "QB",
  playerNews: null,
  selectedTradePlayers: new Set(),
  tradeValues: null,
  tradedPicks: [],
  drafts: [],
  draftRounds: 4,
  pickOwnership: null,
  playerSeasonStats: null,
  playerAges: null,
  nflByes: null,
  ageCurveScope: "starters",
  ageCurveRosterId: null,
  tradeFinderScope: "starters",
  evaluatorPid: null,
  evaluatorSeason: null,
  playerWeeklyStats: null,
  outlookView: "quadrants",
  outlookRows: null,
  powerRankSort: "overall",
  powerRankExpanded: new Set(),
};

// ---------- low-level helpers ----------

async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Sleeper API error (${res.status}) on ${path}`);
  }
  return res.json();
}

function showError(message) {
  const el = document.getElementById("global-error");
  el.textContent = message;
  el.classList.remove("hidden");
  console.error(message);
}

function clearError() {
  const el = document.getElementById("global-error");
  el.textContent = "";
  el.classList.add("hidden");
}

function setStatus(message) {
  document.getElementById("setup-status").textContent = message || "";
}

function saveSession() {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      username: state.username,
      userId: state.userId,
      season: state.season,
      leagueId: state.leagueId,
    })
  );
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

// ---------- player database (cached) ----------

async function loadPlayers() {
  const cached = JSON.parse(localStorage.getItem(PLAYERS_CACHE_KEY) || "null");
  if (cached && Date.now() - cached.ts < PLAYERS_CACHE_MAX_AGE_MS) {
    state.players = cached.data;
    return;
  }
  setStatus("Downloading NFL player database (first load only, ~5MB)...");
  const data = await api("/players/nfl");
  state.players = data;
  try {
    localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // localStorage quota exceeded is fine, just skip caching
  }
}

function player(id) {
  return state.players[id] || { full_name: `Unknown (${id})`, position: "?", team: null };
}

function playerRank(p) {
  const r = p && p.search_rank;
  return typeof r === "number" && r > 0 ? r : 9999;
}

function playerPosition(p) {
  return (p && p.position) || (p && p.fantasy_positions && p.fantasy_positions[0]) || "FLEX";
}

const BENCH_POSITION_ORDER = ["QB", "RB", "WR", "TE", "K"];
function benchPositionRank(pos) {
  const i = BENCH_POSITION_ORDER.indexOf(pos);
  return i === -1 ? BENCH_POSITION_ORDER.length : i;
}

function playerDisplay(p) {
  if (!p) return "Empty";
  if (p.position === "DEF") return p.full_name || p.team;
  return p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
}

// ---------- setup flow ----------

async function findLeagues(username, season) {
  clearError();
  setStatus("Looking up Sleeper user...");
  const user = await api(`/user/${encodeURIComponent(username)}`);
  if (!user || !user.user_id) throw new Error(`No Sleeper user found for "${username}".`);
  state.username = user.username || username;
  state.userId = user.user_id;
  state.season = season;

  setStatus("Fetching leagues...");
  const leagues = await api(`/user/${state.userId}/leagues/nfl/${season}`);
  state.leagues = leagues || [];
  if (state.leagues.length === 0) {
    throw new Error(`No leagues found for ${state.username} in ${season}.`);
  }

  const select = document.getElementById("league-select");
  select.innerHTML = "";
  state.leagues.forEach((lg) => {
    const opt = document.createElement("option");
    opt.value = lg.league_id;
    opt.textContent = `${lg.name} (${lg.season})`;
    select.appendChild(opt);
  });
  document.getElementById("league-picker").classList.remove("hidden");
  setStatus(`Found ${state.leagues.length} league(s). Pick one and load it.`);
}

async function loadLeague(leagueId) {
  clearError();
  setStatus("Loading league data...");
  document.getElementById("load-league-btn").disabled = true;

  try {
    await loadPlayers();

    const [league, rosters, users, nflState] = await Promise.all([
      api(`/league/${leagueId}`),
      api(`/league/${leagueId}/rosters`),
      api(`/league/${leagueId}/users`),
      api(`/state/nfl`),
    ]);

    state.leagueId = leagueId;
    state.league = league;
    state.rosters = rosters || [];
    state.users = users || [];
    // nflState.week keeps counting through the preseason too (season_type
    // "pre"), so a truthy week there doesn't mean the fantasy season -- or
    // even week 1 -- has actually started. Only trust it once real games
    // that count for the league are being played.
    const seasonIsActive = nflState && (nflState.season_type === "regular" || nflState.season_type === "post");
    state.currentWeek = seasonIsActive && nflState.week ? nflState.week : null;

    state.myRosterId = null;
    const myRoster = state.rosters.find((r) => r.owner_id === state.userId);
    if (myRoster) state.myRosterId = myRoster.roster_id;
    state.ageCurveRosterId = state.myRosterId;
    state.selectedTradePlayers = new Set();
    state.powerRankExpanded = new Set();

    state.tradedPicks = [];
    state.drafts = [];
    state.draftRounds = 4;
    state.pickOwnership = null;
    try {
      const [tradedPicks, drafts] = await Promise.all([
        api(`/league/${leagueId}/traded_picks`),
        api(`/league/${leagueId}/drafts`),
      ]);
      state.tradedPicks = Array.isArray(tradedPicks) ? tradedPicks : [];
      if (Array.isArray(drafts)) {
        state.drafts = drafts;
        const withRounds = drafts.find((d) => d.settings && typeof d.settings.rounds === "number" && d.settings.rounds > 0);
        if (withRounds) state.draftRounds = withRounds.settings.rounds;
      }
    } catch {
      // Draft pick info is optional enrichment for the trade builder; the
      // rest of the app works fine without it.
    }

    saveSession();
    setStatus("");
    document.getElementById("setup").classList.add("hidden");
    document.getElementById("app-nav").classList.remove("hidden");
    document.getElementById("change-league-btn").classList.remove("hidden");
    document.getElementById("app-main").classList.remove("hidden");

    renderDashboard();
    renderStandings();
    renderTradeFinder();
    renderTrending();
    renderAgeCurve();
    renderOutlook();
  } catch (err) {
    showError(err.message || String(err));
    setStatus("Failed to load league.");
  } finally {
    document.getElementById("load-league-btn").disabled = false;
  }
}

function teamNameForOwner(ownerId) {
  const u = state.users.find((x) => x.user_id === ownerId);
  if (!u) return "Unclaimed team";
  return (u.metadata && u.metadata.team_name) || u.display_name || "Unnamed team";
}

function rosterLabel(roster) {
  if (!roster) return "Unknown team";
  return teamNameForOwner(roster.owner_id);
}

const AVATAR_COLORS = ["#5b8cff", "#34d399", "#fbbf24", "#f87171", "#a882ff", "#ec6fbb", "#38bdf8", "#fb923c"];

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

window.handleAvatarError = function (img) {
  const span = document.createElement("span");
  span.className = `avatar-fallback${img.dataset.sizeClass || ""}`;
  span.style.background = img.dataset.color;
  span.textContent = img.dataset.initial;
  img.replaceWith(span);
};

function avatarHtml(ownerId, { size = "" } = {}) {
  const name = teamNameForOwner(ownerId);
  const u = state.users.find((x) => x.user_id === ownerId);
  const initial = (name[0] || "?").toUpperCase();
  const color = colorForName(name);
  const sizeClass = size ? ` avatar-${size}` : "";
  if (u && u.avatar) {
    return `<img class="avatar${sizeClass}" src="https://sleepercdn.com/avatars/thumbs/${u.avatar}" alt=""
      data-initial="${initial}" data-color="${color}" data-size-class="${sizeClass}"
      onerror="handleAvatarError(this)" />`;
  }
  return `<span class="avatar-fallback${sizeClass}" style="background:${color}">${initial}</span>`;
}

function teamCellHtml(roster, { size = "", suffix = "" } = {}) {
  if (!roster) return `<div class="team-cell">${avatarHtml(null, { size })}<span>Unknown team</span></div>`;
  return `<div class="team-cell">${avatarHtml(roster.owner_id, { size })}<span>${rosterLabel(roster)}</span>${suffix}</div>`;
}

// ---------- Dashboard ----------

function renderDashboard() {
  renderMatchup();
  renderStarters();
  renderBench();
  renderPlayerNews();
  renderTransactions();
}

function emptyState(text) {
  return `<div class="empty-state"><p class="empty-note">${text}</p></div>`;
}

// Wide tables (buy/sell, age comparison) scroll horizontally inside
// .table-wrap on narrow screens rather than squeezing their columns --
// this flags which ones actually need that so a fade hint only shows up
// when there's really more to scroll to.
function refreshScrollHints() {
  document.querySelectorAll(".table-wrap").forEach((el) => {
    el.classList.toggle("has-scroll", el.scrollWidth > el.clientWidth + 1);
  });
}

async function renderMatchup() {
  const card = document.getElementById("matchup-card");
  const myRoster = state.rosters.find((r) => r.roster_id === state.myRosterId);
  if (!myRoster) {
    card.innerHTML = emptyState("You don't own a team in this league.");
    return;
  }
  if (!state.currentWeek) {
    card.innerHTML = `<h2>This week's matchup</h2>${emptyState("No active NFL week right now (likely offseason).")}`;
    return;
  }

  card.innerHTML = `<h2>Week ${state.currentWeek} matchup</h2><p class="spinner-note">Loading matchup...</p>`;
  try {
    const matchups = await api(`/league/${state.leagueId}/matchups/${state.currentWeek}`);
    const mine = matchups.find((m) => m.roster_id === state.myRosterId);
    if (!mine) {
      card.innerHTML = `<h2>Week ${state.currentWeek} matchup</h2>${emptyState("No matchup found yet for this week.")}`;
      return;
    }
    const opponent = matchups.find(
      (m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id
    );
    const oppRoster = opponent && state.rosters.find((r) => r.roster_id === opponent.roster_id);
    const myPts = (mine.points || 0).toFixed(2);
    const oppPts = opponent ? (opponent.points || 0).toFixed(2) : "-";
    const myWinning = opponent && mine.points > opponent.points;
    const oppWinning = opponent && opponent.points > mine.points;

    card.innerHTML = `
      <h2>Week ${state.currentWeek} matchup</h2>
      <div class="scorebug">
        <div class="sb-team${myWinning ? " leading" : ""}">
          ${avatarHtml(myRoster.owner_id, { size: "lg" })}
          <span class="sb-name">${rosterLabel(myRoster)} <span class="player-meta">(you)</span></span>
          <span class="sb-score">${myPts}</span>
        </div>
        <div class="sb-mid">VS</div>
        <div class="sb-team${oppWinning ? " leading" : ""}">
          ${oppRoster ? avatarHtml(oppRoster.owner_id, { size: "lg" }) : ""}
          <span class="sb-name">${oppRoster ? rosterLabel(oppRoster) : "Bye / TBD"}</span>
          <span class="sb-score">${oppPts}</span>
        </div>
      </div>`;
  } catch (err) {
    card.innerHTML = `<h2>Week ${state.currentWeek} matchup</h2>${emptyState("Couldn't load matchup data.")}`;
  }
}

// Roster slots (e.g. "SUPER_FLEX") don't always match the CSS badge classes we
// have colors for (QB/RB/WR/TE/K/DEF) — shorten the label and fall back to the
// neutral FLEX badge color for anything else.
const SLOT_LABELS = {
  FLEX: "FLEX",
  SUPER_FLEX: "SFLEX",
  WRRB_FLEX: "W/R",
  REC_FLEX: "W/T",
  WR_TE_FLEX: "W/T",
  IDP_FLEX: "IDP",
};
const BADGE_COLOR_SLOTS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function startingSlots() {
  const positions = (state.league && state.league.roster_positions) || [];
  return positions.filter((s) => !["BN", "IR", "TAXI"].includes(s));
}

function playerRow(pid, { slot = null } = {}) {
  if (!pid || pid === "0") {
    return `<tr><td colspan="3" class="empty-note">&mdash; Empty slot &mdash;</td></tr>`;
  }
  const p = player(pid);
  const pos = playerPosition(p);
  const slotIsFlexy = slot && !BADGE_COLOR_SLOTS.has(slot);
  const badgeLabel = slot ? SLOT_LABELS[slot] || slot : pos;
  const badgeClass = slotIsFlexy ? "FLEX" : slot || pos;
  const posTag = slotIsFlexy ? `<span class="pos-tag">${pos}</span>` : "";
  const injury =
    p.injury_status && p.injury_status !== "Healthy"
      ? `<span class="injury">${p.injury_status}</span>`
      : "";
  return `
    <tr>
      <td><span class="badge badge-${badgeClass}">${badgeLabel}</span></td>
      <td>
        <span class="player-name" data-player-id="${pid}">${playerDisplay(p)}</span>${posTag}${injury}<br/>
        <span class="player-meta">${p.team || "FA"}</span>
      </td>
      <td><span class="rank-tag">#${playerRank(p)}</span></td>
    </tr>`;
}

function renderStarters() {
  const card = document.getElementById("starters-card");
  const myRoster = state.rosters.find((r) => r.roster_id === state.myRosterId);
  if (!myRoster) {
    card.innerHTML = `<h2>Starters</h2>${emptyState("You don't own a team in this league.")}`;
    return;
  }
  const slots = startingSlots();
  const rows = (myRoster.starters || [])
    .map((pid, i) => playerRow(pid, { slot: slots[i] }))
    .join("");
  card.innerHTML = `
    <h2>Starters</h2>
    <table>
      <thead><tr><th>Slot</th><th>Player</th><th>Rank</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderBench() {
  const card = document.getElementById("bench-card");
  const myRoster = state.rosters.find((r) => r.roster_id === state.myRosterId);
  if (!myRoster) {
    card.innerHTML = `<h2>Bench</h2>`;
    return;
  }
  const starterSet = new Set(myRoster.starters || []);
  const bench = (myRoster.players || [])
    .filter((pid) => !starterSet.has(pid))
    .sort((a, b) => {
      const posDiff = benchPositionRank(playerPosition(player(a))) - benchPositionRank(playerPosition(player(b)));
      return posDiff !== 0 ? posDiff : playerRank(player(a)) - playerRank(player(b));
    });
  const rows = bench.length
    ? bench.map((pid) => playerRow(pid)).join("")
    : `<tr><td colspan="3">${emptyState("No bench players")}</td></tr>`;
  card.innerHTML = `
    <h2>Bench</h2>
    <table>
      <thead><tr><th>Pos</th><th>Player</th><th>Rank</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

const NEWS_WINDOW_DAYS = 90;

function relativeDate(isoString) {
  const then = new Date(isoString);
  const diffMs = Date.now() - then.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < NEWS_WINDOW_DAYS) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------- News sentiment ----------

// There's no backend/LLM to ask, so this is a deliberately conservative
// keyword heuristic -- and headline-only, never the description: the
// description often brings in context that isn't about this update's own
// sentiment (a different player's injury explaining why *this* player's
// role is expanding, an old injury mentioned in passing while recapping a
// full recovery), which produces confident-looking but wrong matches. The
// headline is written to summarize the actual news, so it's much more
// reliable even though it means fewer items get flagged at all -- which is
// exactly the conservative behavior wanted here. "Won't play" / "will not
// play" are deliberately excluded: RotoWire uses that phrasing both for
// real injury absences and for routine preseason/rest-the-starters news,
// and the two aren't distinguishable from wording alone.
const NEWS_POSITIVE_PHRASES = [
  "cleared to play", "good to go", "full practice", "full participant",
  "no restrictions", "removed from the injury report",
  "not on the injury report", "activated from injured reserve",
  "activated from ir", "returned to practice", "returns to practice",
  "will return", "trending toward playing", "will start",
  "named the starter", "gets the start", "will get the start",
  "signed with", "signs with", "promoted to the active roster",
  "career high", "strong practice", "avoids a serious injury",
  "avoided a serious injury", "avoids serious injury",
  "avoided serious injury", "avoids a significant injury",
  "avoided a significant injury", "feeling great", "feels great",
];

const NEWS_NEGATIVE_PHRASES = [
  "ruled out", "out for the season", "out indefinitely",
  "placed on injured reserve", "placed on ir", "season-ending",
  "torn acl", "torn achilles", "torn meniscus", "requires surgery",
  "undergoing surgery", "undergo surgery", "underwent surgery",
  "will miss", "expected to miss", "miss the rest of", "suspended",
  "suspension", "arrested", "released by", "waived by", "cut by",
  "demoted", "benched", "lost his starting job", "loses his starting job",
  "did not practice", "downgraded to out", "downgraded to doubtful",
  "inactive for", "will be inactive", "did not return", "left the game",
  "carted off", "walking boot", "on crutches",
];

function newsSentiment(item) {
  const text = (item.headline || "").toLowerCase();
  const positive = NEWS_POSITIVE_PHRASES.some((p) => text.includes(p));
  const negative = NEWS_NEGATIVE_PHRASES.some((p) => text.includes(p));
  if (positive === negative) return null; // neither matched, or both did (conflicting) -- stay silent
  return positive ? "up" : "down";
}

function newsSentimentIconHtml(item) {
  const sentiment = newsSentiment(item);
  if (!sentiment) return "";
  const cls = sentiment === "up" ? "news-sentiment news-sentiment-up" : "news-sentiment news-sentiment-down";
  const glyph = sentiment === "up" ? "&#9650;" : "&#9660;";
  const label = sentiment === "up" ? "Sounds like good news" : "Sounds like bad news";
  return `<span class="${cls}" title="${label}" aria-label="${label}">${glyph}</span>`;
}

async function renderPlayerNews() {
  const card = document.getElementById("news-card");
  const myRoster = state.rosters.find((r) => r.roster_id === state.myRosterId);
  if (!myRoster) {
    card.innerHTML = `<h2>Recent News</h2>${emptyState("You don't own a team in this league.")}`;
    return;
  }

  card.innerHTML = `<h2>Recent News</h2><p class="spinner-note">Loading player news...</p>`;

  try {
    if (!state.playerNews) {
      const res = await fetch("data/player_news.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.playerNews = await res.json();
    }
    const data = state.playerNews;
    const rosterSet = new Set(myRoster.players || []);
    const cutoff = Date.now() - NEWS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const items = (data.items || [])
      .filter((n) => n.sleeper_id && rosterSet.has(n.sleeper_id))
      .filter((n) => new Date(n.pub_date).getTime() >= cutoff)
      .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date));

    if (!items.length) {
      card.innerHTML = `<h2>Recent News</h2>${emptyState(`No news for your roster in the last ${NEWS_WINDOW_DAYS} days.`)}`;
      return;
    }

    const rows = items
      .map(
        (n) => `
      <div class="news-item">
        <div class="news-item-head">
          <span class="badge badge-${n.position}">${n.position}</span>
          <span class="player-name" data-player-id="${n.sleeper_id}">${n.player_name}</span>
          <span class="player-meta">${n.team || "FA"}</span>
          <span class="news-date">${relativeDate(n.pub_date)}</span>
        </div>
        <p class="news-headline">${newsSentimentIconHtml(n)}${n.headline}</p>
        ${n.description ? `<p class="player-meta news-desc">${n.description}</p>` : ""}
        <a class="news-link" href="${n.link}" target="_blank" rel="noopener">Read on ${escapeHtml(data.source || "RotoWire")} &rarr;</a>
      </div>`
      )
      .join("");

    card.innerHTML = `
      <h2>Recent News</h2>
      <p class="player-meta" style="margin-bottom:14px">Last ${NEWS_WINDOW_DAYS} days, players on your roster. Sourced from ${escapeHtml(data.source || "RotoWire")}.</p>
      ${rows}`;
  } catch (err) {
    card.innerHTML = `<h2>Recent News</h2>${emptyState("Couldn't load player news (data/player_news.json missing or unreachable).")}`;
  }
}

// ---------- League activity (transactions) ----------

const TRANSACTIONS_LIMIT = 15;
const TRANSACTIONS_WEEKS_BACK = 3;

function rosterById(rosterId) {
  return state.rosters.find((r) => r.roster_id === rosterId);
}

// Sleeper buckets transactions by week ("round"), so a feed needs one fetch
// per week. Before the season starts (no current week yet), all offseason
// trading for this league lands in week 1's bucket, so that alone covers it.
function transactionWeeksToFetch() {
  const week = state.currentWeek;
  if (!week) return [1];
  const weeks = [];
  for (let w = week; w > 0 && weeks.length < TRANSACTIONS_WEEKS_BACK; w--) weeks.push(w);
  return weeks;
}

function transactionRosterIds(txn) {
  if (Array.isArray(txn.roster_ids) && txn.roster_ids.length) return txn.roster_ids;
  const ids = new Set();
  Object.values(txn.adds || {}).forEach((id) => ids.add(id));
  Object.values(txn.drops || {}).forEach((id) => ids.add(id));
  return [...ids];
}

// What a given roster received/gave up in this transaction, across players,
// draft picks, and FAAB -- unified the same way the trade builder treats
// players and picks as interchangeable "assets".
function transactionAssetsForRoster(txn, rosterId) {
  const received = [];
  const sent = [];
  Object.entries(txn.adds || {}).forEach(([pid, rid]) => {
    if (rid === rosterId) received.push(playerDisplay(player(pid)));
  });
  Object.entries(txn.drops || {}).forEach(([pid, rid]) => {
    if (rid === rosterId) sent.push(playerDisplay(player(pid)));
  });
  (txn.draft_picks || []).forEach((dp) => {
    const label = pickLabel(dp.season, dp.round, dp.roster_id, dp.owner_id);
    if (dp.owner_id === rosterId) received.push(label);
    else if (dp.previous_owner_id === rosterId) sent.push(label);
  });
  (txn.waiver_budget || []).forEach((wb) => {
    const label = `$${wb.amount} FAAB`;
    if (wb.receiver === rosterId) received.push(label);
    else if (wb.sender === rosterId) sent.push(label);
  });
  return { received, sent };
}

function transactionTypeBadge(txn) {
  if (txn.type === "trade") return "TRADE";
  if (txn.type === "waiver") return "WAIVER";
  return "FA";
}

function transactionHeadline(txn) {
  const rosterIds = transactionRosterIds(txn);

  if (txn.type === "trade" && rosterIds.length >= 2) {
    return rosterIds
      .map((rid) => {
        const { received } = transactionAssetsForRoster(txn, rid);
        const teamName = escapeHtml(rosterLabel(rosterById(rid)));
        return `${teamName} gets ${received.length ? received.map(escapeHtml).join(", ") : "nothing"}`;
      })
      .join("  &mdash;  ");
  }

  const rid = rosterIds[0];
  const teamName = escapeHtml(rosterLabel(rosterById(rid)));
  const { received, sent } = transactionAssetsForRoster(txn, rid);
  const bidSuffix =
    txn.type === "waiver" && txn.settings && typeof txn.settings.waiver_bid === "number"
      ? ` ($${txn.settings.waiver_bid} bid)`
      : "";
  const bits = [];
  if (received.length) bits.push(`added ${received.map(escapeHtml).join(", ")}${bidSuffix}`);
  if (sent.length) bits.push(`dropped ${sent.map(escapeHtml).join(", ")}`);
  return `${teamName} ${bits.join(", ") || "made a roster move"}`;
}

async function renderTransactions() {
  const card = document.getElementById("transactions-card");
  if (!card) return;
  card.innerHTML = `<h2>League Activity</h2><p class="spinner-note">Loading transactions...</p>`;

  try {
    const weeks = transactionWeeksToFetch();
    const results = await Promise.allSettled(
      weeks.map((w) => api(`/league/${state.leagueId}/transactions/${w}`))
    );
    const all = [];
    results.forEach((r) => {
      if (r.status === "fulfilled" && Array.isArray(r.value)) all.push(...r.value);
    });

    const items = all
      .filter((t) => t.status === "complete" && (t.type === "trade" || t.type === "waiver" || t.type === "free_agent"))
      .sort((a, b) => (b.status_updated || b.created || 0) - (a.status_updated || a.created || 0))
      .slice(0, TRANSACTIONS_LIMIT);

    if (!items.length) {
      card.innerHTML = `<h2>League Activity</h2>${emptyState("No recent trades or waiver moves.")}`;
      return;
    }

    const rows = items
      .map((t) => {
        const ts = t.status_updated || t.created;
        const badge = transactionTypeBadge(t);
        return `
      <div class="news-item">
        <div class="news-item-head">
          <span class="badge badge-${badge}">${badge}</span>
          <span class="news-date">${ts ? relativeDate(new Date(ts).toISOString()) : ""}</span>
        </div>
        <p class="news-headline">${transactionHeadline(t)}</p>
      </div>`;
      })
      .join("");

    card.innerHTML = `
      <h2>League Activity</h2>
      <p class="player-meta" style="margin-bottom:14px">Recent trades and waiver moves, league-wide.</p>
      ${rows}`;
  } catch (err) {
    card.innerHTML = `<h2>League Activity</h2>${emptyState("Couldn't load league transactions.")}`;
  }
}

// ---------- Standings ----------

function renderStandings() {
  const card = document.getElementById("standings-card");
  const rows = [...state.rosters]
    .sort((a, b) => {
      const aw = (a.settings && a.settings.wins) || 0;
      const bw = (b.settings && b.settings.wins) || 0;
      if (bw !== aw) return bw - aw;
      const afpts = fpts(a);
      const bfpts = fpts(b);
      return bfpts - afpts;
    })
    .map((r, i) => {
      const s = r.settings || {};
      const isMe = r.roster_id === state.myRosterId;
      return `
        <tr class="${isMe ? "me-row" : ""}">
          <td>${i + 1}</td>
          <td>${teamCellHtml(r, { suffix: isMe ? '<span class="player-meta">you</span>' : "" })}</td>
          <td>${s.wins || 0}-${s.losses || 0}-${s.ties || 0}</td>
          <td>${fpts(r).toFixed(1)}</td>
          <td>${fptsAgainst(r).toFixed(1)}</td>
        </tr>`;
    })
    .join("");

  card.innerHTML = `
    <h2>Standings</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Team</th><th>Record</th><th>PF</th><th>PA</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function fpts(roster) {
  const s = roster.settings || {};
  return (s.fpts || 0) + (s.fpts_decimal || 0) / 100;
}
function fptsAgainst(roster) {
  const s = roster.settings || {};
  return (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100;
}

// ---------- Trade Finder ----------

// How many dedicated (non-flex) starting slots each skill position gets in
// this league, e.g. {QB:1, RB:2, WR:2, TE:1}. FLEX/SUPER_FLEX slots aren't
// attributed to any one position since several positions can fill them.
// Always at least 1, so a position with zero dedicated slots (rare) still
// gets judged on its single best player.
function dedicatedSlotCounts() {
  const positions = (state.league && state.league.roster_positions) || [];
  const counts = {};
  SKILL_POSITIONS.forEach((pos) => (counts[pos] = 0));
  positions.forEach((slot) => {
    if (SKILL_POSITIONS.includes(slot)) counts[slot] += 1;
  });
  SKILL_POSITIONS.forEach((pos) => {
    if (!counts[pos]) counts[pos] = 1;
  });
  return counts;
}

// How strong a roster is at a position, in one of two modes
// (state.tradeFinderScope):
//  - "starters": the combined trade value of its top starting-slot-count
//    players there (e.g. top 2 RBs in a 2-RB league), so a team needs real
//    depth at the positions it actually starts, not just one standout
//    player, to rate well.
//  - "full": the combined trade value of every rostered player at that
//    position, rewarding bench depth too (useful for dynasty stockpiling,
//    not just this year's lineup).
// Falls back to inverted search_rank if trade values haven't loaded, so
// needs still work before/without that data.
function positionStrengthByRoster() {
  const result = {}; // position -> { rosterId -> strength }
  SKILL_POSITIONS.forEach((pos) => (result[pos] = {}));
  const slotCounts = dedicatedSlotCounts();
  const haveValues = !!(state.tradeValues && state.tradeValues.players);
  const fullRoster = state.tradeFinderScope === "full";

  state.rosters.forEach((r) => {
    SKILL_POSITIONS.forEach((pos) => {
      const pids = (r.players || []).filter((pid) => playerPosition(player(pid)) === pos);
      let strength;
      if (haveValues) {
        const values = pids
          .map((pid) => playerValue(pid))
          .filter((v) => v !== null && v !== undefined)
          .sort((a, b) => b - a);
        strength = (fullRoster ? values : values.slice(0, slotCounts[pos])).reduce((sum, v) => sum + v, 0);
      } else if (fullRoster) {
        strength = pids.reduce((sum, pid) => {
          const rank = playerRank(player(pid));
          return sum + (rank >= 9999 ? 0 : 100000 - rank);
        }, 0);
      } else {
        const bestRank = pids.reduce((best, pid) => Math.min(best, playerRank(player(pid))), 9999);
        strength = bestRank >= 9999 ? 0 : 100000 - bestRank;
      }
      result[pos][r.roster_id] = strength;
    });
  });
  return result;
}

// Needs for any single roster: which skill positions rate in the bottom
// half of the league by positional strength (see positionStrengthByRoster).
// Used both for the passive "Team needs" summary (my roster) and to judge
// whether a given manager would likely want one of the players offered in
// a trade.
function rosterNeeds(rosterId) {
  const totalTeams = state.rosters.length;
  const strengthByPos = positionStrengthByRoster();
  const needs = [];

  SKILL_POSITIONS.forEach((pos) => {
    const standings = state.rosters
      .map((r) => ({ rosterId: r.roster_id, strength: strengthByPos[pos][r.roster_id] }))
      .sort((a, b) => b.strength - a.strength);
    const placement = standings.findIndex((s) => s.rosterId === rosterId) + 1;
    const percentile = placement / totalTeams;

    let severity = null;
    if (percentile > 0.66) severity = "high";
    else if (percentile > 0.5) severity = "med";
    if (severity) {
      needs.push({ position: pos, placement, totalTeams, severity });
    }
  });

  const order = { high: 0, med: 1, low: 2 };
  return needs.sort((a, b) => order[a.severity] - order[b.severity]);
}

function computeNeeds() {
  if (!state.myRosterId) return [];
  return rosterNeeds(state.myRosterId);
}

// Players on `roster` who play one of `positionsSet`, bench players first
// (their owner is more likely to move them) then sorted by rank.
function kCombinations(arr, k) {
  const results = [];
  const combo = [];
  function backtrack(start) {
    if (combo.length === k) {
      results.push(combo.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      backtrack(i + 1);
      combo.pop();
    }
  }
  backtrack(0);
  return results;
}

const TRADE_PACKAGE_MAX_PLAYERS = 3;

// Build one recommended return package from `roster`: the smallest group of
// their players whose combined value is within TRADE_FAIR_VALUE_TOLERANCE of
// `offerTotal`, preferring more need-filling players (and more bench players,
// as a last tiebreak) among equally-fair options at that size. Falls back to
// the closest-value package found if nothing hits the fairness tolerance, or
// to a plain need-based list if the offer's value isn't known.
//
// Players at a position `roster` itself needs (theirNeedPositions) are
// excluded from consideration entirely -- a team that's short at WR isn't a
// realistic source for a WR back, and suggesting "WR for WR" when both sides
// need WR doesn't fill anyone's need, it's just a lateral swap.
//
// excludePickRounds is a Set of "season|round" keys (see renderTradeSuggestions)
// for picks already in the offer -- nobody wants their own 2027 1st back for
// a 2027 1st, regardless of which team originally owned either one.
function buildTradePackage(roster, offerTotal, needPositions, theirNeedPositions, excludePickRounds = new Set()) {
  const starterSet = new Set(roster.starters || []);
  const playerPool = (roster.players || [])
    .map((pid) => {
      const p = player(pid);
      const pos = playerPosition(p);
      return {
        pid,
        pos,
        rank: playerRank(p),
        isBench: !starterSet.has(pid),
        value: playerValue(pid),
        needFill: needPositions.has(pos),
        injury_status: p.injury_status,
      };
    })
    .filter((c) => c.injury_status !== "IR" && c.value !== null && c.value !== undefined)
    // A pick has no position (pos is null), so this filter never excludes
    // one -- picks are always a fine ask regardless of positional needs.
    .filter((c) => !theirNeedPositions.has(c.pos));

  // Draft picks are tradeable too: fungible value with no position, so they
  // never get excluded by the "own need" filter above and never carry a
  // needFill bonus in the ranking, but they're a normal fairness-matching
  // asset otherwise.
  const pickPool = rosterPicks(roster.roster_id)
    .map((pk) => ({
      pid: pk.id,
      pos: null,
      rank: null,
      isBench: true,
      value: pickValue(pk.season, pk.round),
      needFill: false,
      isPick: true,
      roundKey: `${pk.season}|${pk.round}`,
    }))
    .filter((c) => c.value !== null && c.value !== undefined)
    .filter((c) => !excludePickRounds.has(c.roundKey));

  const pool = [...playerPool, ...pickPool];

  if (!pool.length) return null;

  if (offerTotal === null || offerTotal === undefined) {
    const fallback = pool
      .filter((c) => c.needFill)
      .sort((a, b) => (a.isBench !== b.isBench ? (a.isBench ? -1 : 1) : a.rank - b.rank))
      .slice(0, TRADE_RETURN_MAX);
    return fallback.length ? { players: fallback, total: null, diffPct: null, isFair: false } : null;
  }

  const bestOverallPerSize = [];

  for (let size = 1; size <= TRADE_PACKAGE_MAX_PLAYERS; size++) {
    let fairBest = null;
    let overallBest = null;

    kCombinations(pool, size).forEach((combo) => {
      const total = combo.reduce((sum, c) => sum + c.value, 0);
      const diffPct = Math.abs(total - offerTotal) / offerTotal;
      const needCount = combo.filter((c) => c.needFill).length;
      const benchCount = combo.filter((c) => c.isBench).length;
      const candidate = { players: combo, total, diffPct, needCount, benchCount };

      if (!overallBest || diffPct < overallBest.diffPct) overallBest = candidate;

      if (diffPct <= TRADE_FAIR_VALUE_TOLERANCE) {
        if (
          !fairBest ||
          needCount > fairBest.needCount ||
          (needCount === fairBest.needCount &&
            (diffPct < fairBest.diffPct ||
              (diffPct === fairBest.diffPct && benchCount > fairBest.benchCount)))
        ) {
          fairBest = candidate;
        }
      }
    });

    if (fairBest) return { ...fairBest, isFair: true };
    if (overallBest) bestOverallPerSize.push(overallBest);
  }

  const fallback = bestOverallPerSize.sort((a, b) => a.diffPct - b.diffPct)[0];
  return fallback ? { ...fallback, isFair: false } : null;
}

// A league is superflex/2QB if more than one starting slot can take a QB
// (a plain QB slot or a SUPER_FLEX slot) -- affects which value column
// (value_1qb vs value_2qb) is the relevant one, since QBs are worth far
// more in a 2QB/superflex format.
function isSuperflexLeague() {
  return startingSlots().filter((s) => s === "QB" || s === "SUPER_FLEX").length > 1;
}

function playerValue(sleeperId) {
  const entry = state.tradeValues && state.tradeValues.players && state.tradeValues.players[sleeperId];
  if (!entry) return null;
  const val = isSuperflexLeague() ? entry.value_2qb : entry.value_1qb;
  return val === null || val === undefined ? null : val;
}

function formatValue(val) {
  return val === null || val === undefined ? "&mdash;" : val.toLocaleString();
}

// ---------- Draft picks (as tradeable assets) ----------

function roundOrdinal(round) {
  const n = Number(round);
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
}

function pickId(season, round, originalRosterId) {
  return `pick:${season}:${round}:${originalRosterId}`;
}

function isPickId(id) {
  return typeof id === "string" && id.startsWith("pick:");
}

function parsePickId(id) {
  const [, season, round, originalRosterId] = id.split(":");
  return { season, round: Number(round), originalRosterId: Number(originalRosterId) };
}

// Whether Sleeper says this season's rookie draft has already happened --
// used to drop that season's picks from being tradeable even if
// DynastyProcess's data hasn't caught up yet and still has values for them.
function rookieDraftCompleteForSeason(season) {
  return (state.drafts || []).some((d) => String(d.season) === String(season) && d.status === "complete");
}

// Which draft seasons are tradeable, starting from whatever DynastyProcess's
// data currently covers (usually the next 3 classes) but with already-drafted
// seasons dropped and backfilled forward instead, so the tradeable window
// keeps rolling ahead each year rather than shrinking or going stale.
// Backfilled seasons won't have a DynastyProcess value yet -- shown as "--"
// same as any other missing value, until DynastyProcess publishes them.
function pickTradeSeasons() {
  const picks = state.tradeValues && state.tradeValues.picks;
  if (!picks) return [];
  const years = new Set();
  Object.keys(picks).forEach((key) => {
    const year = key.split(" ")[0];
    if (/^\d{4}$/.test(year)) years.add(year);
  });

  let sorted = [...years].sort();
  const droppedCount = sorted.filter((y) => rookieDraftCompleteForSeason(y)).length;
  sorted = sorted.filter((y) => !rookieDraftCompleteForSeason(y));

  let nextYear = sorted.length
    ? Number(sorted[sorted.length - 1]) + 1
    : Number((state.league && state.league.season) || new Date().getFullYear()) + 1;
  for (let i = 0; i < droppedCount; i++) {
    sorted.push(String(nextYear));
    nextYear += 1;
  }

  return sorted;
}

function pickValue(season, round) {
  const picks = state.tradeValues && state.tradeValues.picks;
  const entry = picks && picks[`${season} ${roundOrdinal(round)}`];
  if (!entry) return null;
  const val = isSuperflexLeague() ? entry.value_2qb : entry.value_1qb;
  return val === null || val === undefined ? null : val;
}

// Every roster starts with one pick per round per season in scope; trades
// reassign specific (season, round, original-owner) picks to a new owner.
// Sleeper's traded_picks always names the picks by their ORIGINAL owner's
// roster_id, with owner_id giving the current (possibly multi-hop) owner.
function computePickOwnership() {
  const seasons = pickTradeSeasons();
  const rounds = state.draftRounds || 4;
  const ownership = {}; // `${season}|${round}|${originalRosterId}` -> current owner roster_id

  seasons.forEach((season) => {
    for (let round = 1; round <= rounds; round++) {
      state.rosters.forEach((r) => {
        ownership[`${season}|${round}|${r.roster_id}`] = r.roster_id;
      });
    }
  });

  (state.tradedPicks || []).forEach((tp) => {
    const key = `${tp.season}|${tp.round}|${tp.roster_id}`;
    if (key in ownership) ownership[key] = tp.owner_id;
  });

  return ownership;
}

function rosterPicks(rosterId) {
  const ownership = state.pickOwnership || {};
  const picks = [];
  Object.keys(ownership).forEach((key) => {
    if (ownership[key] !== rosterId) return;
    const [season, round, originalRosterId] = key.split("|");
    picks.push({
      id: pickId(season, round, originalRosterId),
      season,
      round: Number(round),
      originalRosterId: Number(originalRosterId),
    });
  });
  picks.sort((a, b) => (a.season !== b.season ? a.season.localeCompare(b.season) : a.round - b.round));
  return picks;
}

function pickLabel(season, round, originalRosterId, currentOwnerRosterId) {
  const base = `${season} ${roundOrdinal(round)}`;
  if (originalRosterId === currentOwnerRosterId) return base;
  const originalRoster = state.rosters.find((r) => r.roster_id === originalRosterId);
  return `${base} (via ${rosterLabel(originalRoster)})`;
}

// Unified value/label lookup so trade-builder code can treat a selected
// player and a selected draft pick the same way.
function assetValue(id) {
  if (isPickId(id)) {
    const { season, round } = parsePickId(id);
    return pickValue(season, round);
  }
  return playerValue(id);
}

function assetLabel(id, ownerRosterId) {
  if (isPickId(id)) {
    const { season, round, originalRosterId } = parsePickId(id);
    return pickLabel(season, round, originalRosterId, ownerRosterId);
  }
  return playerDisplay(player(id));
}

function tradeFinderScopeToggleHtml() {
  const scopes = [
    { key: "starters", label: "Starters" },
    { key: "full", label: "Full Roster" },
  ];
  const btns = scopes
    .map(
      (s) =>
        `<button type="button" class="scope-toggle-btn${state.tradeFinderScope === s.key ? " active" : ""}" data-tradescope="${s.key}">${s.label}</button>`
    )
    .join("");
  return `<div class="scope-toggle">${btns}</div>`;
}

async function renderTradeFinder() {
  const needsCard = document.getElementById("needs-card");

  if (!state.myRosterId) {
    needsCard.innerHTML = `<h2>Team needs</h2>${emptyState("You don't own a team in this league.")}`;
    document.getElementById("trade-builder-card").innerHTML = "";
    document.getElementById("trade-suggestions-grid").innerHTML = "";
    return;
  }

  if (!state.tradeValues) {
    try {
      const res = await fetch("data/trade_values.json");
      if (res.ok) state.tradeValues = await res.json();
    } catch {
      // trade values are optional enrichment; the tab still works without them
    }
  }
  if (!state.pickOwnership) {
    state.pickOwnership = computePickOwnership();
  }

  const needs = computeNeeds();
  const scopeNote =
    state.tradeFinderScope === "full"
      ? "Based on your combined trade value at each position (entire roster) against the rest of the league."
      : "Based on your combined trade value at each position (top players per starting slot) against the rest of the league.";
  needsCard.innerHTML = `
    <h2>Team needs</h2>
    ${tradeFinderScopeToggleHtml()}
    <p class="player-meta" style="margin-bottom:14px">${scopeNote}</p>
    ${
      needs.length
        ? `
      <div class="need-grid">
        ${needs
          .map(
            (n) => `
          <div class="need-card sev-${n.severity}">
            <span class="badge badge-${n.position}">${n.position}</span>
            <span class="sev-label">${n.severity} need</span>
            <span class="player-meta">${n.placement}/${n.totalTeams} in league</span>
          </div>`
          )
          .join("")}
      </div>`
        : emptyState("Your roster looks solid at QB/RB/WR/TE relative to the rest of the league &mdash; no glaring needs detected.")
    }`;

  renderTradeBuilderPicker();
  renderTradeSuggestions();
}

function myRosterAllPlayers() {
  const myRoster = state.rosters.find((r) => r.roster_id === state.myRosterId);
  if (!myRoster) return { starters: [], bench: [], picks: [] };
  const starterSet = new Set(myRoster.starters || []);
  const starters = (myRoster.starters || []).filter((pid) => pid && pid !== "0");
  const bench = (myRoster.players || [])
    .filter((pid) => !starterSet.has(pid))
    .sort((a, b) => playerRank(player(a)) - playerRank(player(b)));
  const picks = rosterPicks(state.myRosterId);
  return { starters, bench, picks };
}

function tradePickRowHtml(id) {
  const checked = state.selectedTradePlayers.has(id) ? "checked" : "";
  if (isPickId(id)) {
    return `
      <label class="trade-pick-row">
        <input type="checkbox" data-pid="${id}" ${checked} />
        <span class="badge badge-PICK">PICK</span>
        <span class="player-name">${assetLabel(id, state.myRosterId)}</span>
        <span class="value-tag">${formatValue(assetValue(id))}</span>
      </label>`;
  }
  const p = player(id);
  const pos = playerPosition(p);
  return `
    <label class="trade-pick-row">
      <input type="checkbox" data-pid="${id}" ${checked} />
      <span class="badge badge-${pos}">${pos}</span>
      <span class="player-name" data-player-id="${id}">${playerDisplay(p)}</span>
      <span class="player-meta">${p.team || "FA"}</span>
      <span class="value-tag">${formatValue(playerValue(id))}</span>
      <span class="rank-tag">#${playerRank(p)}</span>
    </label>`;
}

function offerValueSummaryHtml() {
  const selectedIds = [...state.selectedTradePlayers];
  if (!selectedIds.length) {
    return `<p class="offer-value-summary player-meta" id="trade-offer-value">Select players or picks below to see your offer's total trade value.</p>`;
  }
  const values = selectedIds.map(assetValue);
  const known = values.filter((v) => v !== null && v !== undefined);
  const missing = values.length - known.length;
  const total = known.length ? known.reduce((sum, v) => sum + v, 0) : null;
  return `
    <p class="offer-value-summary" id="trade-offer-value">
      Your offer value: <strong>${formatValue(total)}</strong>
      ${missing ? `<span class="player-meta">(${missing} selected item${missing > 1 ? "s" : ""} missing a value)</span>` : ""}
    </p>`;
}

function renderTradeBuilderPicker() {
  const card = document.getElementById("trade-builder-card");
  const { starters, bench, picks } = myRosterAllPlayers();
  const formatNote = isSuperflexLeague() ? "superflex/2QB" : "1QB";

  card.innerHTML = `
    <h2>Build a trade offer</h2>
    <p class="player-meta" style="margin-bottom:14px">Select one or more of your players or picks to see which managers might want them, and what to ask for in return. Values assume a ${formatNote} format, from <a href="https://github.com/dynastyprocess/data" target="_blank" rel="noopener">DynastyProcess</a>.</p>
    ${offerValueSummaryHtml()}
    <h3>Starters</h3>
    <div class="trade-pick-list">${starters.map(tradePickRowHtml).join("")}</div>
    ${bench.length ? `<h3>Bench</h3><div class="trade-pick-list">${bench.map(tradePickRowHtml).join("")}</div>` : ""}
    ${picks.length ? `<h3>Draft Picks</h3><div class="trade-pick-list">${picks.map((pk) => tradePickRowHtml(pk.id)).join("")}</div>` : ""}
  `;

  card.querySelectorAll("input[type=checkbox][data-pid]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const pid = cb.dataset.pid;
      if (cb.checked) state.selectedTradePlayers.add(pid);
      else state.selectedTradePlayers.delete(pid);
      const summaryEl = document.getElementById("trade-offer-value");
      if (summaryEl) summaryEl.outerHTML = offerValueSummaryHtml();
      renderTradeSuggestions();
    });
  });
}

const TRADE_RETURN_MAX = 4;
const TRADE_FAIR_VALUE_TOLERANCE = 0.2; // within +/-20% of your offer's total value counts as "about even"

function renderTradeSuggestions() {
  const grid = document.getElementById("trade-suggestions-grid");
  const selectedIds = [...state.selectedTradePlayers];

  if (!selectedIds.length) {
    grid.innerHTML = emptyState("Select one or more of your players above to see trade suggestions for each manager.");
    return;
  }

  const others = state.rosters.filter((r) => r.roster_id !== state.myRosterId);
  if (!others.length) {
    grid.innerHTML = emptyState("No other teams in this league.");
    return;
  }

  const selectedPlayers = selectedIds.map((pid) => ({
    pid,
    isPick: isPickId(pid),
    pos: isPickId(pid) ? null : playerPosition(player(pid)),
    label: assetLabel(pid, state.myRosterId),
    value: assetValue(pid),
  }));
  const myNeedPositions = new Set(computeNeeds().map((n) => n.position));

  // A team offering its 2027 1st doesn't want its 2027 1st back -- exclude
  // same season+round picks from the suggested return, regardless of
  // original owner (a "similar" pick, not just the identical asset).
  const offeredPickRounds = new Set(
    selectedIds.filter(isPickId).map((pid) => {
      const { season, round } = parsePickId(pid);
      return `${season}|${round}`;
    })
  );

  // Only compute a fairness comparison when every selected player has a
  // known value -- a partial total would be misleading.
  const offerValues = selectedPlayers.map((sp) => sp.value);
  const offerTotal = offerValues.every((v) => v !== null && v !== undefined)
    ? offerValues.reduce((sum, v) => sum + v, 0)
    : null;

  const cards = others.map((roster) => {
    const theirNeedPositions = new Set(rosterNeeds(roster.roster_id).map((n) => n.position));
    const fitCount = selectedPlayers.filter((sp) => theirNeedPositions.has(sp.pos)).length;
    const tradePackage = buildTradePackage(roster, offerTotal, myNeedPositions, theirNeedPositions, offeredPickRounds);
    return { roster, theirNeedPositions, fitCount, tradePackage };
  });

  // Best trade offers first: a fair package beats a fallback one, then the
  // closer to even the better, then fewer players is a nicer offer, and
  // only then does "would they actually want it" (fitCount) break ties.
  cards.sort((a, b) => {
    const aFair = a.tradePackage ? a.tradePackage.isFair : false;
    const bFair = b.tradePackage ? b.tradePackage.isFair : false;
    if (aFair !== bFair) return aFair ? -1 : 1;

    const aDiff = a.tradePackage && a.tradePackage.diffPct !== null ? a.tradePackage.diffPct : Infinity;
    const bDiff = b.tradePackage && b.tradePackage.diffPct !== null ? b.tradePackage.diffPct : Infinity;
    if (aDiff !== bDiff) return aDiff - bDiff;

    const aSize = a.tradePackage ? a.tradePackage.players.length : Infinity;
    const bSize = b.tradePackage ? b.tradePackage.players.length : Infinity;
    if (aSize !== bSize) return aSize - bSize;

    return b.fitCount - a.fitCount;
  });

  grid.innerHTML = cards
    .map(({ roster, theirNeedPositions, fitCount, tradePackage }) => {
      const offerRows = selectedPlayers
        .map((sp) => {
          if (sp.isPick) {
            return `
            <div class="offer-row">
              <span class="badge badge-PICK">PICK</span>
              <span class="player-name">${sp.label}</span>
              <span class="value-tag">${formatValue(sp.value)}</span>
            </div>`;
          }
          const fills = theirNeedPositions.has(sp.pos);
          return `
          <div class="offer-row">
            <span class="badge badge-${sp.pos}">${sp.pos}</span>
            <span class="player-name" data-player-id="${sp.pid}">${sp.label}</span>
            <span class="value-tag">${formatValue(sp.value)}</span>
            <span class="${fills ? "fit-yes" : "fit-no"}">${fills ? "Fills a need" : "No flagged need"}</span>
          </div>`;
        })
        .join("");

      const returnHtml =
        tradePackage && tradePackage.players.length
          ? `${
              tradePackage.total !== null
                ? `<p class="package-summary">
                    Package value: <strong>${formatValue(tradePackage.total)}</strong>
                    ${
                      tradePackage.isFair
                        ? `<span class="value-fair-badge">&asymp; Even value</span>`
                        : `<span class="player-meta">(${Math.round(tradePackage.diffPct * 100)}% off your offer)</span>`
                    }
                  </p>`
                : ""
            }
            <table>
              <thead><tr><th>Pos</th><th>Player</th><th>Value</th><th>Rank</th></tr></thead>
              <tbody>${tradePackage.players
                .map((c) => {
                  if (c.isPick) {
                    return `
                  <tr>
                    <td><span class="badge badge-PICK">PICK</span></td>
                    <td><span class="player-name">${assetLabel(c.pid, roster.roster_id)}</span></td>
                    <td>${formatValue(c.value)}</td>
                    <td class="player-meta">&mdash;</td>
                  </tr>`;
                  }
                  const cp = player(c.pid);
                  return `
                <tr>
                  <td><span class="badge badge-${c.pos}">${c.pos}</span></td>
                  <td>
                    <span class="player-name" data-player-id="${c.pid}">${playerDisplay(cp)}</span>${c.needFill ? ` <span class="fit-yes">Fills a need</span>` : ""}<br/>
                    <span class="player-meta">${cp.team || "FA"} &middot; ${c.isBench ? "Bench" : "Starter"}</span>
                  </td>
                  <td>${formatValue(c.value)}</td>
                  <td><span class="rank-tag">#${c.rank}</span></td>
                </tr>`;
                })
                .join("")}</tbody>
            </table>`
          : `<p class="player-meta">No obvious return package available on this roster.</p>`;

      const fitBadge =
        fitCount > 0
          ? `<span class="fit-summary fit-summary-yes">${fitCount}/${selectedPlayers.length} fill a need</span>`
          : `<span class="fit-summary">No flagged needs</span>`;

      return `
      <div class="card trade-manager-card">
        <div class="manager-header">
          ${teamCellHtml(roster)}
          ${fitBadge}
        </div>
        <div class="offer-list">${offerRows}</div>
        <h3>Suggested return package</h3>
        ${returnHtml}
      </div>`;
    })
    .join("");
}

// ---------- Trending (rising metrics from nflverse/BigQuery) ----------

function leagueStatusForSleeperId(sleeperId) {
  if (!sleeperId || !state.players[sleeperId]) {
    return { label: "Not in Sleeper's DB", html: `<span class="player-meta">Not in Sleeper's DB</span>` };
  }
  const roster = state.rosters.find((r) => (r.players || []).includes(sleeperId));
  if (!roster) return { label: "Free agent", html: `<span class="player-meta">Free agent</span>` };
  if (roster.roster_id === state.myRosterId) {
    return { label: "Your roster", html: `<span class="player-meta" style="color:var(--good)">Your roster</span>` };
  }
  return { label: "Rostered", html: teamCellHtml(roster) };
}

function formatMetricValue(val, format) {
  if (val === null || val === undefined) return "&mdash;";
  if (format === "pct") return `${(val * 100).toFixed(1)}%`;
  return val.toFixed(2);
}

async function renderTrending() {
  const card = document.getElementById("trending-card");
  card.innerHTML = `<h2>Rising metrics</h2><p class="spinner-note">Loading trend data...</p>`;

  try {
    if (!state.risingMetrics) {
      const res = await fetch("data/rising_metrics.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.risingMetrics = await res.json();
    }
    if (!state.tradeValues) {
      try {
        const res = await fetch("data/trade_values.json");
        if (res.ok) state.tradeValues = await res.json();
      } catch {
        // Buy Low / Sell High degrades to plain trend direction (no value-tier
        // filtering) when trade values aren't available; see buySellForMetric.
      }
    }
    renderTrendingContent();
  } catch (err) {
    card.innerHTML = `<h2>Rising metrics</h2>${emptyState("Couldn't load trend data (data/rising_metrics.json missing or unreachable).")}`;
  }
}

const TRENDING_BUY_SELL_ROWS = 5;

// A player is a buy-low candidate if their usage/efficiency trend for this
// metric is climbing but their current trade value still falls outside the
// position's "established" tier (top N by value); sell-high is the mirror
// case -- trend falling, but still valued inside that tier. This is a
// snapshot comparison, not a value-history one (DynastyProcess only gives
// us current values, not how they've moved), so the framing is "current
// role vs. current price" rather than "the market hasn't reacted yet".
const BUY_SELL_VALUE_TIER = { QB: 12, RB: 24, WR: 36, TE: 12 };

// Rank every player BigQuery/DynastyProcess has a trade value for, within
// their position, independent of who's actually rostered in this league --
// buy-low/sell-high is a scouting tool, not limited to your own roster.
function positionValueRanks() {
  const values = (state.tradeValues && state.tradeValues.players) || {};
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  Object.keys(values).forEach((sid) => {
    const pos = playerPosition(player(sid));
    if (!byPos[pos]) return;
    const val = playerValue(sid);
    if (val === null || val === undefined) return;
    byPos[pos].push({ sid, val });
  });
  const ranks = {};
  Object.keys(byPos).forEach((pos) => {
    byPos[pos].sort((a, b) => b.val - a.val);
    byPos[pos].forEach((entry, i) => {
      ranks[entry.sid] = i + 1;
    });
  });
  return ranks;
}

// Tier-qualifying candidates (the "true" buy-low/sell-high definition) are
// always shown first, but each table backfills with the next-biggest
// trend movers of the right sign when there aren't enough of them -- a
// table only comes up short of TRENDING_BUY_SELL_ROWS when this position
// group is genuinely out of players trending in that direction at all.
function buySellForMetric(key, positions, ranks, hasValues) {
  const def = state.risingMetrics.metric_defs[key];
  const positive = [];
  const negative = [];

  state.risingMetrics.players.forEach((p) => {
    if (!positions.includes(p.position) || !def.positions.includes(p.position)) return;
    const m = p.metrics[key];
    if (!m) return;
    const rank = p.sleeper_id ? ranks[p.sleeper_id] : undefined;
    const tier = BUY_SELL_VALUE_TIER[p.position];
    const entry = { ...p, m, rank };

    if (m.delta > 0) {
      entry.qualifies = !hasValues || !rank || rank > tier;
      positive.push(entry);
    } else if (m.delta < 0) {
      entry.qualifies = hasValues && !!rank && rank <= tier;
      negative.push(entry);
    }
  });

  // Qualifying entries first, ties broken by trend magnitude within each group.
  positive.sort((a, b) => (b.qualifies - a.qualifies) || b.m.delta - a.m.delta);
  negative.sort((a, b) => (b.qualifies - a.qualifies) || a.m.delta - b.m.delta);

  return {
    buyLow: positive.slice(0, TRENDING_BUY_SELL_ROWS),
    sellHigh: negative.slice(0, TRENDING_BUY_SELL_ROWS),
  };
}

function buySellMiniRowHtml(entry, def) {
  const status = leagueStatusForSleeperId(entry.sleeper_id);
  const deltaSign = entry.m.delta > 0 ? "+" : "";
  const deltaClass = entry.m.delta > 0 ? "delta-tag" : "delta-tag delta-tag-neg";
  const rankText = entry.rank ? `#${entry.rank}` : "&mdash;";
  return `
    <tr>
      <td class="freeze-col">
        <div class="bs-player-cell">
          <span class="badge badge-${entry.position}">${entry.position}</span>
          <span>
            <span class="player-name" data-player-id="${entry.sleeper_id}">${entry.name}</span><br/>
            <span class="player-meta">${entry.team}</span>
          </span>
        </div>
      </td>
      <td class="player-meta">${formatMetricValue(entry.m.prior, def.format)} &rarr; ${formatMetricValue(entry.m.recent, def.format)}</td>
      <td><span class="${deltaClass}">${deltaSign}${formatMetricValue(entry.m.delta, def.format)}</span></td>
      <td>${rankText}</td>
      <td>${status.html}</td>
    </tr>`;
}

function buySellColumnHtml(title, cls, entries, def, emptyText) {
  const heading = `<h4 class="buy-sell-col-title ${cls}">${title}</h4>`;
  if (!entries.length) {
    return `<div class="metric-card-col">${heading}${emptyState(emptyText)}</div>`;
  }
  const rows = entries.map((e) => buySellMiniRowHtml(e, def)).join("");
  return `
    <div class="metric-card-col">
      ${heading}
      <div class="table-wrap">
        <table>
          <thead><tr><th class="freeze-col">Player</th><th>Prior &rarr; Recent</th><th>&Delta;</th><th>Value rank</th><th>League status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function renderTrendingContent() {
  const introCard = document.getElementById("trending-card");
  const grid = document.getElementById("trending-grid");
  const data = state.risingMetrics;
  const tab = POSITION_TABS.find((t) => t.key === state.trendingPosTab) || POSITION_TABS[0];
  const hasValues = !!(state.tradeValues && state.tradeValues.players);

  introCard.innerHTML = `
    <h2>Rising metrics</h2>
    <p class="player-meta">
      Weeks ${data.recent_weeks[0]}&ndash;${data.recent_weeks[data.recent_weeks.length - 1]} vs.
      weeks ${data.prior_weeks[0]}&ndash;${data.prior_weeks[data.prior_weeks.length - 1]}, ${data.season} season.
      Sourced from <a href="https://nflreadr.nflverse.com/" target="_blank" rel="noopener">nflverse</a> play-by-play data (refreshed weekly), cross-referenced against this league's rosters.
    </p>
    <p class="player-meta" style="margin-top:8px">
      Each metric splits into <strong>Buy Low</strong> (trend climbing, value still outside the position's
      established tier &mdash; QB top 12, RB top 24, WR top 36, TE top 12) and <strong>Sell High</strong>
      (trend falling, value still inside it), prioritized first, then backfilled with the next-biggest
      trend movers so each table shows up to ${TRENDING_BUY_SELL_ROWS} players whenever that many exist.
      ${hasValues ? "" : "Trade values didn't load, so this is just showing trend direction without the value cross-reference."}
    </p>`;

  const ranks = positionValueRanks();

  const metricCards = tab.metricOrder
    .map((key) => {
      const def = data.metric_defs[key];
      if (!def) return "";

      const { buyLow, sellHigh } = buySellForMetric(key, tab.positions, ranks, hasValues);
      if (!buyLow.length && !sellHigh.length) return "";

      const buyEmptyText = "No players trending up at this position right now.";
      const sellEmptyText = "No players trending down at this position right now.";

      return `
        <div class="card metric-card">
          <details>
            <summary>
              <h3>${def.label}${infoIcon(def.description)}</h3>
              <svg class="chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
                <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </summary>
            <div class="metric-card-columns">
              ${buySellColumnHtml("Buy Low", "buy", buyLow, def, buyEmptyText)}
              ${buySellColumnHtml("Sell High", "sell", sellHigh, def, sellEmptyText)}
            </div>
          </details>
        </div>`;
    })
    .join("");

  grid.innerHTML = metricCards || "";
  if (!metricCards) {
    introCard.insertAdjacentHTML("beforeend", emptyState("No qualifying buy-low/sell-high candidates for this position group yet."));
  }
  refreshScrollHints();
}

// ---------- Age Curve ----------

const AGE_CHART_HEIGHT = 160;

function ageFromBirthDate(birthDateStr) {
  if (!birthDateStr) return null;
  const dob = new Date(`${birthDateStr}T00:00:00Z`);
  if (isNaN(dob.getTime())) return null;
  return (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

// A player's weight in the age curve is their trade value when we have one
// (so bench depth counts less than your stars), falling back to a uniform
// weight of 1 -- either because trade values never loaded at all (a plain
// average), or because DynastyProcess just doesn't cover that one player.
function ageWeight(sleeperId) {
  const val = playerValue(sleeperId);
  return val === null || val === undefined ? 1 : val;
}

function rosterAgeEntries(rosterId, scope = state.ageCurveScope) {
  const roster = rosterById(rosterId);
  const ages = (state.playerAges && state.playerAges.players) || {};
  if (!roster) return [];
  const pool = scope === "starters" ? roster.starters : roster.players;
  return (pool || [])
    .map((pid) => {
      const info = ages[pid];
      if (!info || !SKILL_POSITIONS.includes(info.position)) return null;
      const age = ageFromBirthDate(info.birth_date);
      if (age === null) return null;
      return { pid, pos: info.position, age, weight: ageWeight(pid) };
    })
    .filter(Boolean);
}

function weightedAvgAge(entries) {
  const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
  if (!totalWeight) return null;
  return entries.reduce((s, e) => s + e.age * e.weight, 0) / totalWeight;
}

// Per-position breakdown of a roster's weighted average age, e.g. for the
// League Age Comparison table's QB/RB/WR/TE columns.
function ageByPosition(entries) {
  const result = {};
  SKILL_POSITIONS.forEach((pos) => {
    result[pos] = weightedAvgAge(entries.filter((e) => e.pos === pos));
  });
  return result;
}

// Groups entries into whole-year age buckets, split by position so the bar
// for each age can be stacked (and colored) the same way position badges
// are colored everywhere else in the app.
function ageBuckets(entries) {
  const buckets = {};
  entries.forEach((e) => {
    const age = Math.floor(e.age);
    if (!buckets[age]) buckets[age] = { QB: 0, RB: 0, WR: 0, TE: 0 };
    buckets[age][e.pos] += e.weight;
  });
  return buckets;
}

function ageChartHtml(entries) {
  if (!entries.length) {
    return emptyState("Not enough data (trade value + birth date) to chart this roster's ages.");
  }
  const buckets = ageBuckets(entries);
  const ageKeys = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b);
  const maxTotal = Math.max(...ageKeys.map((age) => SKILL_POSITIONS.reduce((s, pos) => s + buckets[age][pos], 0)), 1);

  const cols = ageKeys
    .map((age) => {
      const b = buckets[age];
      const segs = SKILL_POSITIONS.filter((pos) => b[pos] > 0)
        .map((pos) => {
          const h = Math.max((b[pos] / maxTotal) * AGE_CHART_HEIGHT, 2);
          return `<div class="age-bar-seg age-seg-${pos}" style="height:${h.toFixed(1)}px"></div>`;
        })
        .join("");
      return `
        <div class="age-bar-col">
          <div class="age-bar-track"><div class="age-bar-stack">${segs}</div></div>
          <div class="age-bar-label">${age}</div>
        </div>`;
    })
    .join("");

  const legend = SKILL_POSITIONS
    .map((pos) => `<span class="age-legend-item"><span class="age-legend-swatch age-seg-${pos}"></span>${pos}</span>`)
    .join("");

  return `<div class="age-chart">${cols}</div><div class="age-legend">${legend}</div>`;
}

function scopeToggleHtml() {
  const scopes = [
    { key: "starters", label: "Starters" },
    { key: "full", label: "Full Roster" },
  ];
  const btns = scopes
    .map(
      (s) =>
        `<button type="button" class="scope-toggle-btn${state.ageCurveScope === s.key ? " active" : ""}" data-agescope="${s.key}">${s.label}</button>`
    )
    .join("");
  return `<div class="scope-toggle">${btns}</div>`;
}

function ageTeamSelectHtml() {
  const selected = state.ageCurveRosterId || state.myRosterId;
  const sorted = [...state.rosters].sort((a, b) => rosterLabel(a).localeCompare(rosterLabel(b)));
  const options = sorted
    .map((r) => {
      const isMe = r.roster_id === state.myRosterId;
      const label = `${rosterLabel(r)}${isMe ? " (you)" : ""}`;
      return `<option value="${r.roster_id}"${r.roster_id === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `
    <div class="age-team-picker">
      <label for="age-team-select">Viewing</label>
      <select id="age-team-select">${options}</select>
    </div>`;
}

async function renderAgeCurve() {
  const teamCard = document.getElementById("age-team-card");
  const leagueCard = document.getElementById("age-league-card");
  if (!teamCard || !leagueCard) return;

  if (!state.myRosterId) {
    teamCard.innerHTML = `<h2>Age Curve</h2>${emptyState("You don't own a team in this league.")}`;
    leagueCard.innerHTML = "";
    return;
  }
  if (!state.ageCurveRosterId) state.ageCurveRosterId = state.myRosterId;
  const viewedRosterId = state.ageCurveRosterId;

  teamCard.innerHTML = `<h2>Age Curve</h2>${ageTeamSelectHtml()}${scopeToggleHtml()}<p class="spinner-note">Loading age data...</p>`;
  leagueCard.innerHTML = "";

  if (!state.playerAges) {
    try {
      const res = await fetch("data/player_ages.json", { cache: "no-store" });
      if (res.ok) state.playerAges = await res.json();
    } catch {
      // handled below via the missing-data empty state
    }
  }
  if (!state.tradeValues) {
    try {
      const res = await fetch("data/trade_values.json");
      if (res.ok) state.tradeValues = await res.json();
    } catch {
      // falls back to an unweighted average
    }
  }

  if (!state.playerAges || !state.playerAges.players) {
    teamCard.innerHTML = `<h2>Age Curve</h2>${ageTeamSelectHtml()}${emptyState("Couldn't load player age data (data/player_ages.json missing or unreachable).")}`;
    return;
  }

  const viewedEntries = rosterAgeEntries(viewedRosterId);
  const viewedAvgAge = weightedAvgAge(viewedEntries);

  const leagueRows = state.rosters
    .map((r) => {
      const entries = rosterAgeEntries(r.roster_id);
      return { roster: r, avgAge: weightedAvgAge(entries), byPos: ageByPosition(entries) };
    })
    .filter((r) => r.avgAge !== null)
    .sort((a, b) => a.avgAge - b.avgAge);

  const viewedRank = leagueRows.findIndex((r) => r.roster.roster_id === viewedRosterId) + 1;
  const rankNote = viewedRank > 0 ? ` &middot; ${roundOrdinal(viewedRank)} youngest of ${leagueRows.length} teams` : "";

  const weightingNote = state.tradeValues
    ? "Weighted by each player's trade value, so bench depth counts less than the team's stars."
    : "Trade values didn't load, so this is a simple (unweighted) average.";

  const posRows = SKILL_POSITIONS
    .map((pos) => {
      const posEntries = viewedEntries.filter((e) => e.pos === pos);
      const avg = weightedAvgAge(posEntries);
      return avg === null
        ? ""
        : `
        <tr>
          <td><span class="badge badge-${pos}">${pos}</span></td>
          <td>${posEntries.length}</td>
          <td>${avg.toFixed(1)}</td>
        </tr>`;
    })
    .join("");

  teamCard.innerHTML = `
    <h2>Age Curve</h2>
    ${ageTeamSelectHtml()}
    ${scopeToggleHtml()}
    <p class="player-meta" style="margin-bottom:14px">${weightingNote}</p>
    <div class="age-summary-value">${viewedAvgAge !== null ? viewedAvgAge.toFixed(1) : "&mdash;"}</div>
    <p class="player-meta" style="margin-bottom:18px">Value-weighted average age${rankNote}</p>
    ${ageChartHtml(viewedEntries)}
    ${posRows ? `<table style="margin-top:18px"><thead><tr><th>Pos</th><th># Players</th><th>Avg age</th></tr></thead><tbody>${posRows}</tbody></table>` : ""}`;

  if (!leagueRows.length) return;

  const leagueTableRows = leagueRows
    .map(({ roster, avgAge, byPos }, i) => {
      const isMe = roster.roster_id === state.myRosterId;
      const posCells = SKILL_POSITIONS
        .map((pos) => `<td>${byPos[pos] !== null ? byPos[pos].toFixed(1) : "&mdash;"}</td>`)
        .join("");
      return `
        <tr class="${isMe ? "me-row" : ""}">
          <td>${i + 1}</td>
          <td class="freeze-col">${teamCellHtml(roster, { suffix: isMe ? '<span class="player-meta">you</span>' : "" })}</td>
          <td>${avgAge.toFixed(1)}</td>
          ${posCells}
        </tr>`;
    })
    .join("");

  leagueCard.innerHTML = `
    <h2>League Age Comparison</h2>
    <p class="player-meta" style="margin-bottom:14px">Youngest to oldest, by value-weighted average age (${state.ageCurveScope === "starters" ? "starters only" : "full rosters"}).</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th class="freeze-col">Team</th><th>Avg age</th><th>QB</th><th>RB</th><th>WR</th><th>TE</th></tr></thead>
        <tbody>${leagueTableRows}</tbody>
      </table>
    </div>`;
  refreshScrollHints();
}

// ---------- Contender / Rebuild Outlook ----------

// Top-left -> top-right -> bottom-left -> bottom-right in the 2x2 grid:
// rows split young (top) vs old (bottom), columns split losing (left) vs
// winning (right) record, both relative to the league median so this
// works regardless of league size or how far into the season it is.
const OUTLOOK_QUADRANTS = [
  {
    key: "rebuild",
    title: "Rebuilding",
    blurb: "Not competitive yet, but time is on your side. Prioritize youth, draft capital, and buy-low upside over win-now vets.",
  },
  {
    key: "rising",
    title: "Rising Contender",
    blurb: "Winning now with a young core -- the best spot to be in. No need to sell short-term assets for picks; look to add proven difference-makers while the window is wide open.",
  },
  {
    key: "retool",
    title: "Retool / Sell",
    blurb: "The toughest spot -- not competitive and aging. Sell veterans for picks and youth now, before their value declines further.",
  },
  {
    key: "winnow",
    title: "Win-Now",
    blurb: "Competitive today, but the roster is aging. If this is a true title contender, push all-in this season -- otherwise, consider selling vets at peak value before their production (and trade value) declines.",
  },
];

function recordForRoster(roster) {
  const s = roster.settings || {};
  const wins = s.wins || 0;
  const losses = s.losses || 0;
  const ties = s.ties || 0;
  return { wins, losses, ties, played: wins + losses + ties };
}

// Pythagorean-style win expectation from season-to-date scoring (points for
// vs. points against) -- a steadier read on team strength than raw win/loss
// record this early in a season, since it isn't swung by a single close
// loss or blowout win the way win% is. Falls back to a neutral 50% before
// any points are on the board at all.
function pythagoreanWinProb(pointsFor, pointsAgainst) {
  if (pointsFor <= 0 && pointsAgainst <= 0) return 0.5;
  const pf2 = pointsFor ** 2;
  const pa2 = pointsAgainst ** 2;
  return pf2 / (pf2 + pa2);
}

// Regular-season length in weeks, from the league's own playoff-start
// setting (games before the playoffs begin) -- falls back to the common
// 14-week default if that setting isn't available for some reason.
function regularSeasonWeeks() {
  const start = state.league && state.league.settings && state.league.settings.playoff_week_start;
  return start && start > 1 ? start - 1 : 14;
}

// Which positions can fill each flex-type roster slot. Dedicated slots
// (QB/RB/WR/TE) aren't listed here -- they only accept their own position,
// handled directly in eligiblePositionsForSlot. K/DEF/IDP slots are left
// out entirely (no eligible positions -> never filled -> 0 points), the
// same scope limit already applied everywhere else in the app (age curve,
// needs, buy/sell, etc. are all skill-position-only).
const FLEX_ELIGIBILITY = {
  FLEX: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  WRRB_FLEX: ["WR", "RB"],
  REC_FLEX: ["WR", "TE"],
  WR_TE_FLEX: ["WR", "TE"],
};

function eligiblePositionsForSlot(slot) {
  if (SKILL_POSITIONS.includes(slot)) return [slot];
  return FLEX_ELIGIBILITY[slot] || [];
}

// Fill the most position-restrictive slots first (a 2-position flex before
// a 3-position one, dedicated slots before any flex) so a wide-open flex
// slot doesn't end up claiming a player a narrower slot actually needed.
function slotFillPriority(slot) {
  if (SKILL_POSITIONS.includes(slot)) return 0;
  const elig = FLEX_ELIGIBILITY[slot];
  return elig ? 1 + elig.length : 99;
}

// Greedy best-lineup assignment over a pool of {pid, pos, projPPG}: not a
// provably optimal assignment in every edge case, but this is exactly how
// fantasy "optimal lineup" calculators work in practice, and is more than
// enough precision for a season-long projection.
function bestLineupPoints(pool, slots) {
  const order = [...slots]
    .map((slot, i) => ({ slot, i }))
    .sort((a, b) => slotFillPriority(a.slot) - slotFillPriority(b.slot) || a.i - b.i);
  const remaining = [...pool];
  let total = 0;
  order.forEach(({ slot }) => {
    const eligible = eligiblePositionsForSlot(slot);
    if (!eligible.length) return;
    let bestIdx = -1;
    let bestPPG = -Infinity;
    remaining.forEach((p, idx) => {
      if (eligible.includes(p.pos) && p.projPPG > bestPPG) {
        bestPPG = p.projPPG;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) {
      total += remaining[bestIdx].projPPG;
      remaining.splice(bestIdx, 1);
    }
  });
  return total;
}

// A player's projected points for a single week: their most recent
// season's points per game, scored using this league's own scoring
// settings when available (same computeLeaguePoints() the player card
// stats table uses). Falls back to 0 for anyone without season stats
// loaded yet (e.g. a rookie with no NFL history) -- they're still
// eligible to be started if nothing better is available, just contribute
// nothing to the projection.
function projectedPPGForPlayer(pid) {
  const stats = state.playerSeasonStats && state.playerSeasonStats.players && state.playerSeasonStats.players[pid];
  const seasons = stats ? Object.keys(stats.seasons || {}).sort((a, b) => b - a) : [];
  if (!seasons.length) return 0;
  const season = stats.seasons[seasons[0]];
  if (!season || !season.games) return 0;
  return computeLeaguePoints(season, stats.position) / season.games;
}

// This roster's best possible lineup for one specific week, with any
// rostered player whose NFL team has a bye that week excluded from the
// pool first -- so a normally-started player gets swapped out for the
// next-best bench option at that position, same as a real manager would
// do. Degrades gracefully to no bye substitutions at all if nfl_byes.json
// hasn't loaded (or hasn't been generated yet).
function projectedWeeklyPoints(roster, week) {
  const byeMap = (state.nflByes && state.nflByes.byes) || {};
  const pool = (roster.players || [])
    .map((pid) => {
      const p = player(pid);
      const pos = playerPosition(p);
      if (!SKILL_POSITIONS.includes(pos)) return null;
      if (p.team && byeMap[p.team] === week) return null;
      return { pid, pos, projPPG: projectedPPGForPlayer(pid) };
    })
    .filter(Boolean);
  return bestLineupPoints(pool, startingSlots());
}

// Sums bye-aware weekly projections across every remaining week of the
// season for this roster. The expensive part of the projection (loops
// over each remaining week), so callers compute this once per roster and
// reuse it rather than calling it multiple times.
function rosterRemainingProjection(roster) {
  const { wins, losses, ties, played } = recordForRoster(roster);
  const totalGames = regularSeasonWeeks();
  const remaining = Math.max(0, totalGames - played);
  let projPointsForRemaining = 0;
  for (let w = played + 1; w <= totalGames; w++) {
    projPointsForRemaining += projectedWeeklyPoints(roster, w);
  }
  return { wins, losses, ties, played, totalGames, remaining, projPointsForRemaining };
}

// Final record if each team's remaining games play out using their best
// possible bye-aware lineup each week, projected from recent per-player
// scoring. Actual results already in the books stay locked in -- only the
// remaining games are projected -- so this is naturally as current as
// Sleeper's own standings: reload the league after a matchup is scored and
// both the actual and projected record move.
//
// There's no per-opponent schedule simulation here (that would need every
// other roster's own weekly projection plus the real remaining schedule,
// which Sleeper doesn't reliably expose for future weeks in every league
// type) -- points-against for the remaining games instead uses this
// team's own season-to-date points-against rate once they have one, or
// leagueAvgProjPPG (the league's average projected scoring, passed in by
// the caller) as a neutral "typical opponent" stand-in before any games
// have been played at all.
function projectedRecordForRoster(roster, remainingProjection, leagueAvgProjPPG) {
  const { wins, losses, ties, played, totalGames, remaining, projPointsForRemaining } = remainingProjection;
  const s = roster.settings || {};
  const actualPointsFor = (s.fpts || 0) + (s.fpts_decimal || 0) / 100;
  const actualPointsAgainst = (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100;

  const projPointsFor = actualPointsFor + projPointsForRemaining;
  const againstRate = played > 0 ? actualPointsAgainst / played : leagueAvgProjPPG;
  const projPointsAgainst = actualPointsAgainst + againstRate * remaining;

  const winProb = pythagoreanWinProb(projPointsFor, projPointsAgainst);
  const projWins = wins + winProb * remaining;
  const projLosses = losses + (1 - winProb) * remaining;
  const projWinPct = totalGames > 0 ? (projWins + ties * 0.5) / totalGames : 0.5;
  return { wins, losses, ties, played, totalGames, remaining, winProb, projWins, projLosses, projWinPct };
}

function median(sortedNums) {
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

function outlookQuadrantHtml(q, teams) {
  const chips = teams
    .map(({ roster, avgAge, wins, losses, ties, projWins, totalGames }) => {
      const record = ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
      const projWinsR = Math.round(projWins);
      const projLossesR = totalGames - projWinsR - ties;
      const projRecord = ties ? `${projWinsR}-${projLossesR}-${ties}` : `${projWinsR}-${projLossesR}`;
      return `
        <div class="outlook-chip">
          ${teamCellHtml(roster)}
          <span class="player-meta">${record} &rarr; proj ${projRecord} &middot; age ${avgAge.toFixed(1)}</span>
        </div>`;
    })
    .join("");
  return `
    <div class="card outlook-quadrant outlook-${q.key}">
      <h3>${q.title}</h3>
      <p class="player-meta" style="margin-bottom:12px">${q.blurb}</p>
      ${chips || emptyState("No teams here right now.")}
    </div>`;
}

async function renderOutlook() {
  const introCard = document.getElementById("outlook-card");
  const grid = document.getElementById("outlook-quadrants");
  if (!introCard || !grid) return;

  introCard.innerHTML = `<h2>Contender / Rebuild Outlook</h2><p class="spinner-note">Loading...</p>`;
  grid.innerHTML = "";
  state.outlookRows = null;

  if (!state.playerAges) {
    try {
      const res = await fetch("data/player_ages.json", { cache: "no-store" });
      if (res.ok) state.playerAges = await res.json();
    } catch {
      // handled below via the missing-data empty state
    }
  }
  if (!state.tradeValues) {
    try {
      const res = await fetch("data/trade_values.json");
      if (res.ok) state.tradeValues = await res.json();
    } catch {
      // falls back to an unweighted average
    }
  }
  if (!state.playerSeasonStats) {
    try {
      const res = await fetch("data/player_season_stats.json", { cache: "no-store" });
      if (res.ok) state.playerSeasonStats = await res.json();
    } catch {
      // players without season stats just project 0 PPG below
    }
  }
  if (!state.nflByes) {
    try {
      const res = await fetch("data/nfl_byes.json", { cache: "no-store" });
      if (res.ok) state.nflByes = await res.json();
    } catch {
      // no bye data -- weekly projections just skip bye substitutions
    }
  }
  if (!state.pickOwnership) {
    state.pickOwnership = computePickOwnership();
  }

  if (!state.playerAges || !state.playerAges.players) {
    introCard.innerHTML = `<h2>Contender / Rebuild Outlook</h2>${emptyState("Couldn't load player age data (data/player_ages.json missing or unreachable).")}`;
    return;
  }

  // Compute each roster's remaining-weeks projection once (it's the
  // expensive part) and reuse it both to derive the league's average
  // projected scoring and in the final per-roster record below.
  const remainingProjByRosterId = {};
  state.rosters.forEach((roster) => {
    remainingProjByRosterId[roster.roster_id] = rosterRemainingProjection(roster);
  });
  const projRates = Object.values(remainingProjByRosterId)
    .filter((r) => r.remaining > 0)
    .map((r) => r.projPointsForRemaining / r.remaining);
  const leagueAvgProjPPG = projRates.length ? projRates.reduce((a, b) => a + b, 0) / projRates.length : 0;

  const rows = state.rosters
    .map((roster) => {
      const avgAge = weightedAvgAge(rosterAgeEntries(roster.roster_id, "starters"));
      if (avgAge === null) return null;
      const remainingProjection = remainingProjByRosterId[roster.roster_id];
      return { roster, avgAge, ...projectedRecordForRoster(roster, remainingProjection, leagueAvgProjPPG) };
    })
    .filter(Boolean);

  if (rows.length < 2) {
    introCard.innerHTML = `<h2>Contender / Rebuild Outlook</h2>${emptyState("Not enough teams with age + trade value data to compare yet.")}`;
    return;
  }

  const medianAge = median([...rows.map((r) => r.avgAge)].sort((a, b) => a - b));
  const medianProjWinPct = median([...rows.map((r) => r.projWinPct)].sort((a, b) => a - b));
  const anyGamesPlayed = rows.some((r) => r.played > 0);
  const haveByeData = !!(state.nflByes && state.nflByes.byes);

  // Every row also gets tagged with its quadrant key here so the Power
  // Rankings view can show the same Contender Tier without re-deriving it.
  rows.forEach((r) => {
    const young = r.avgAge <= medianAge;
    const winning = r.projWinPct >= medianProjWinPct;
    r.quadrantKey = young && winning ? "rising" : !young && winning ? "winnow" : young && !winning ? "rebuild" : "retool";
  });
  state.outlookRows = rows;

  introCard.innerHTML = `
    <h2>Contender / Rebuild Outlook</h2>
    ${outlookViewToggleHtml()}
    <p class="player-meta" style="margin-bottom:6px">
      Splits the league by two axes &mdash; projected final record and starters' value-weighted average age
      &mdash; relative to the league median (age ${medianAge.toFixed(1)}, projected win% ${Math.round(medianProjWinPct * 100)}%),
      to suggest each team's competitive window. Remaining games are projected by playing out each team's best
      possible lineup each week (recent per-player scoring, swapped for the next-best bench option on bye weeks)
      &mdash; actual results already in the books stay locked in, so it updates automatically as real results
      (and scoring) come in each week.
    </p>
    ${
      anyGamesPlayed
        ? ""
        : `<p class="player-meta" style="margin-bottom:6px">No games played yet this season, so points-against for the rest of the year assumes a league-average opponent for everyone &mdash; only the points-for side (each team's own projected scoring) differentiates teams until real results come in.</p>`
    }
    ${
      haveByeData
        ? ""
        : `<p class="player-meta">Bye-week data hasn't loaded, so this week-by-week projection can't yet swap in bench players during a bye &mdash; it's using full rosters as available for now.</p>`
    }`;

  renderOutlookBody();
}

// Quadrants vs. Power Rankings are both derived from the same already-
// computed `state.outlookRows` (age + projected record for quadrants;
// trade value for rankings), so switching between them -- or re-sorting
// the rankings table -- never has to redo the weekly-projection loop,
// the expensive part of renderOutlook() above.
function renderOutlookBody() {
  const grid = document.getElementById("outlook-quadrants");
  if (!grid || !state.outlookRows) return;

  if (state.outlookView === "rankings") {
    grid.className = "";
    grid.innerHTML = powerRankingsHtml(state.outlookRows);
  } else {
    grid.className = "outlook-grid";
    const grouped = { rising: [], winnow: [], rebuild: [], retool: [] };
    state.outlookRows.forEach((r) => grouped[r.quadrantKey].push(r));
    Object.values(grouped).forEach((list) => list.sort((a, b) => b.projWinPct - a.projWinPct));
    grid.innerHTML = OUTLOOK_QUADRANTS.map((q) => outlookQuadrantHtml(q, grouped[q.key])).join("");
  }
  refreshScrollHints();
}

function outlookViewToggleHtml() {
  const views = [
    { key: "quadrants", label: "Quadrants" },
    { key: "rankings", label: "Power Rankings" },
  ];
  const btns = views
    .map((v) => `<button type="button" class="scope-toggle-btn${state.outlookView === v.key ? " active" : ""}" data-outlookview="${v.key}">${v.label}</button>`)
    .join("");
  return `<div class="scope-toggle" style="margin-bottom:14px">${btns}</div>`;
}

// ---------- Power Rankings ----------

const POWER_RANK_COLUMNS = [
  { key: "overall", label: "Overall Rank" },
  { key: "starter", label: "Starter Rank" },
  { key: "QB", label: "QB Rank" },
  { key: "RB", label: "RB Rank" },
  { key: "WR", label: "WR Rank" },
  { key: "TE", label: "TE Rank" },
  { key: "draft", label: "Draft Rank" },
];

function sumPlayerValues(pids) {
  return (pids || []).reduce((sum, pid) => sum + (playerValue(pid) || 0), 0);
}

function positionValueSums(pids) {
  const sums = { QB: 0, RB: 0, WR: 0, TE: 0 };
  (pids || []).forEach((pid) => {
    const pos = playerPosition(player(pid));
    if (sums[pos] !== undefined) sums[pos] += playerValue(pid) || 0;
  });
  return sums;
}

function rosterPicksValue(rosterId) {
  return rosterPicks(rosterId).reduce((sum, p) => sum + (pickValue(p.season, p.round) || 0), 0);
}

// Ranks every entry 1 (highest value) .. N by a value getter, ties broken
// by roster_id so the ordering is at least stable across re-renders.
function rankMetrics(metrics, valueOf) {
  const sorted = [...metrics].sort((a, b) => valueOf(b) - valueOf(a) || a.row.roster.roster_id - b.row.roster.roster_id);
  const rankByRosterId = {};
  sorted.forEach((m, i) => { rankByRosterId[m.row.roster.roster_id] = i + 1; });
  return rankByRosterId;
}

// Trade-value-based power rankings: Overall combines full-roster + owned
// future draft-pick value, Starter is the current starting lineup only,
// QB/RB/WR/TE reflect full-roster depth at that position (not just
// starters, so bench depth counts), and Draft is owned future pick value
// alone. All from the same DynastyProcess data the Trade Finder and Age
// Curve tabs already use -- no separate data pipeline needed.
function powerRankingRows(rows) {
  const metrics = rows.map((row) => {
    const posSums = positionValueSums(row.roster.players);
    const rosterValue = sumPlayerValues(row.roster.players);
    const picksValue = rosterPicksValue(row.roster.roster_id);
    return {
      row,
      posSums,
      starterValue: sumPlayerValues(row.roster.starters),
      picksValue,
      overallValue: rosterValue + picksValue,
    };
  });

  const overallRank = rankMetrics(metrics, (m) => m.overallValue);
  const starterRank = rankMetrics(metrics, (m) => m.starterValue);
  const draftRank = rankMetrics(metrics, (m) => m.picksValue);
  const posRank = {};
  SKILL_POSITIONS.forEach((pos) => {
    posRank[pos] = rankMetrics(metrics, (m) => m.posSums[pos]);
  });

  return metrics.map((m) => {
    const rid = m.row.roster.roster_id;
    return {
      row: m.row,
      ranks: {
        overall: overallRank[rid],
        starter: starterRank[rid],
        QB: posRank.QB[rid],
        RB: posRank.RB[rid],
        WR: posRank.WR[rid],
        TE: posRank.TE[rid],
        draft: draftRank[rid],
      },
      values: {
        overall: m.overallValue,
        starter: m.starterValue,
        QB: m.posSums.QB,
        RB: m.posSums.RB,
        WR: m.posSums.WR,
        TE: m.posSums.TE,
        draft: m.picksValue,
      },
    };
  });
}

// Splits ranks into thirds (best/middle/worst) for the pill coloring --
// relative to league size rather than a fixed cutoff, so it reads the same
// whether the league has 8 teams or 14.
function rankTier(rank, total) {
  const third = total / 3;
  if (rank <= third) return "good";
  if (rank > total - third) return "bad";
  return "mid";
}

// One player row inside an expanded position block: a filled star for a
// starter, a hollow circle for bench, and the same .player-name[data-player-id]
// class used everywhere else in the app -- so clicking it opens the normal
// player card via the existing global click handler, no extra wiring needed.
function powerRankPlayerRowHtml(pid, isStarter) {
  return `
    <div class="pr-player-row${isStarter ? " pr-starter" : ""}">
      <span class="pr-player-left">
        <span class="pr-player-icon">${isStarter ? "&starf;" : "&#9675;"}</span>
        <span class="player-name" data-player-id="${pid}">${escapeHtml(playerDisplay(player(pid)))}</span>
      </span>
      <span class="pr-player-value">${formatValue(playerValue(pid))}</span>
    </div>`;
}

function powerRankPositionBlockHtml(roster, pos, rank, value, avgAge) {
  const starterSet = new Set(roster.starters || []);
  const pids = (roster.players || []).filter((pid) => playerPosition(player(pid)) === pos);
  const sorted = [...pids].sort((a, b) => {
    const aStarter = starterSet.has(a) ? 0 : 1;
    const bStarter = starterSet.has(b) ? 0 : 1;
    if (aStarter !== bStarter) return aStarter - bStarter;
    return (playerValue(b) || 0) - (playerValue(a) || 0);
  });
  const rows = sorted.map((pid) => powerRankPlayerRowHtml(pid, starterSet.has(pid))).join("");
  return `
    <div class="pr-block">
      <div class="pr-block-head"><span class="badge badge-${pos}">${pos}</span><span class="pr-block-rank">Rank ${rank}</span></div>
      <p class="player-meta pr-block-sub">Value: ${formatValue(value)}${avgAge !== null ? ` | Age: ${avgAge.toFixed(1)}` : ""}</p>
      ${rows || `<p class="player-meta">No ${pos}s rostered.</p>`}
    </div>`;
}

function powerRankDraftBlockHtml(roster, rank, value) {
  const picks = rosterPicks(roster.roster_id);
  const rows = picks
    .map(
      (p) => `
    <div class="pr-player-row">
      <span class="pr-player-left">${pickLabel(p.season, p.round, p.originalRosterId, roster.roster_id)}</span>
      <span class="pr-player-value">${formatValue(pickValue(p.season, p.round))}</span>
    </div>`
    )
    .join("");
  return `
    <div class="pr-block">
      <div class="pr-block-head"><span class="badge badge-PICK">PICK</span><span class="pr-block-rank">Rank ${rank}</span></div>
      <p class="player-meta pr-block-sub">Value: ${formatValue(value)}</p>
      ${rows || `<p class="player-meta">No picks owned.</p>`}
    </div>`;
}

// The expanded per-team view: every rostered skill-position player grouped
// by position (starters first, then bench, both by trade value) alongside
// every currently-owned future draft pick, individually valued -- the same
// breakdown the summary row's rank columns are aggregated from.
function powerRankDetailHtml(row, ranks, values) {
  const roster = row.roster;
  const ageByPos = ageByPosition(rosterAgeEntries(roster.roster_id, "full"));
  const needs = rosterNeeds(roster.roster_id);
  const needsText = needs.length ? needs.map((n) => n.position).join(", ") : "None";

  const blocks = SKILL_POSITIONS
    .map((pos) => powerRankPositionBlockHtml(roster, pos, ranks[pos], values[pos], ageByPos[pos]))
    .join("");

  return `
    <div class="power-rank-detail">
      <p class="player-meta" style="margin-bottom:12px">
        Overall value ${formatValue(values.overall)} &middot; Starter value ${formatValue(values.starter)}
        &middot; Avg age ${row.avgAge.toFixed(1)} &middot; Needs: ${needsText}
      </p>
      <div class="pr-blocks">
        ${blocks}
        ${powerRankDraftBlockHtml(roster, ranks.draft, values.draft)}
      </div>
    </div>`;
}

function powerRankingsHtml(rows) {
  if (!state.tradeValues) {
    return emptyState("Couldn't load trade value data (data/trade_values.json missing or unreachable), so power rankings can't be computed.");
  }

  const ranked = powerRankingRows(rows);
  const total = ranked.length;
  const sortKey = POWER_RANK_COLUMNS.some((c) => c.key === state.powerRankSort) ? state.powerRankSort : "overall";
  ranked.sort((a, b) => a.ranks[sortKey] - b.ranks[sortKey]);

  const headerCells = POWER_RANK_COLUMNS
    .map(
      (c) =>
        `<th class="sortable-th" data-sortkey="${c.key}">${c.label}${c.key === sortKey ? ' <span class="sort-arrow">&uarr;</span>' : ""}</th>`
    )
    .join("");

  const bodyRows = ranked
    .map(({ row, ranks, values }) => {
      const tier = OUTLOOK_QUADRANTS.find((q) => q.key === row.quadrantKey);
      const isMe = row.roster.roster_id === state.myRosterId;
      const rid = row.roster.roster_id;
      const expanded = state.powerRankExpanded.has(rid);
      const rankCell = (key) => `<td><span class="rank-pill rank-${rankTier(ranks[key], total)}">${ranks[key]}</span></td>`;
      const summaryRow = `
        <tr class="power-rank-row${isMe ? " me-row" : ""}" data-expand-roster="${rid}">
          <td class="freeze-col">
            <div class="power-rank-team-cell">
              <span class="expand-chevron">${expanded ? "&#9662;" : "&#9656;"}</span>
              ${teamCellHtml(row.roster, { suffix: isMe ? '<span class="player-meta">you</span>' : "" })}
            </div>
          </td>
          <td><span class="tier-badge tier-${tier.key}">${tier.title}</span></td>
          ${rankCell("overall")}
          ${rankCell("starter")}
          ${rankCell("QB")}
          ${rankCell("RB")}
          ${rankCell("WR")}
          ${rankCell("TE")}
          ${rankCell("draft")}
        </tr>`;
      const detailRow = expanded
        ? `<tr class="power-rank-detail-row"><td colspan="${POWER_RANK_COLUMNS.length + 2}">${powerRankDetailHtml(row, ranks, values)}</td></tr>`
        : "";
      return summaryRow + detailRow;
    })
    .join("");

  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th class="freeze-col">Team</th><th>Contender Tier</th>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <p class="player-meta" style="margin-top:10px">
      Ranks are based on DynastyProcess trade value: Overall combines full-roster + owned future draft-pick value,
      Starter is your current starting lineup only, QB/RB/WR/TE reflect full-roster depth at that position, and
      Draft is the value of your currently-owned future picks. Contender Tier is the same age + projected-record
      quadrant shown in the Quadrants view. Click a column header to sort by it, or a team row to see its full
      roster and pick-by-pick breakdown.
    </p>`;
}

// ---------- Player card ----------

window.handlePlayerPhotoError = function (img) {
  const span = document.createElement("span");
  span.className = "player-card-photo-fallback";
  span.style.background = img.dataset.color;
  span.textContent = img.dataset.initial || "?";
  img.replaceWith(span);
};

function fmtStat(val) {
  return val === null || val === undefined ? "&mdash;" : val.toLocaleString();
}

function fmtPpr(val) {
  return val === null || val === undefined ? "&mdash;" : val.toFixed(1);
}

function leagueScoringSettings() {
  return (state.league && state.league.scoring_settings) || null;
}

// Recompute season fantasy points from the raw stat line using the loaded
// league's own scoring_settings (falls back to the precomputed PPR total
// when no league scoring is available, e.g. before a league is loaded).
function computeLeaguePoints(s, pos) {
  const sc = leagueScoringSettings();
  if (!sc) return s.fantasy_points_ppr;
  const n = (v) => (typeof v === "number" ? v : 0);
  let pts =
    n(s.passing_yards) * n(sc.pass_yd) +
    n(s.passing_tds) * n(sc.pass_td) +
    n(s.interceptions) * n(sc.pass_int) +
    n(s.rushing_yards) * n(sc.rush_yd) +
    n(s.rushing_tds) * n(sc.rush_td) +
    n(s.receptions) * n(sc.rec) +
    n(s.receiving_yards) * n(sc.rec_yd) +
    n(s.receiving_tds) * n(sc.rec_td);
  if (pos === "TE") pts += n(s.receptions) * n(sc.bonus_rec_te);
  return pts;
}

function pointsColumnLabel() {
  return leagueScoringSettings() ? "Lg Pts" : "PPR Pts";
}

const PLAYER_CARD_NEWS_WINDOW_DAYS = 90;

function renderPlayerCardNews(pid, container = document.querySelector("#player-card .player-card-news")) {
  if (!container) return;

  const data = state.playerNews;
  if (!data) {
    container.innerHTML = `<h3>Recent News</h3><p class="player-meta">Couldn't load player news.</p>`;
    return;
  }

  const cutoff = Date.now() - PLAYER_CARD_NEWS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const items = (data.items || [])
    .filter((n) => n.sleeper_id === pid)
    .filter((n) => new Date(n.pub_date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date));

  if (!items.length) {
    container.innerHTML = `<h3>Recent News</h3><p class="player-meta">No news in the last ${PLAYER_CARD_NEWS_WINDOW_DAYS} days.</p>`;
    return;
  }

  const rows = items
    .map(
      (n) => `
    <div class="news-item">
      <div class="news-item-head">
        <span class="news-date">${relativeDate(n.pub_date)}</span>
      </div>
      <p class="news-headline">${newsSentimentIconHtml(n)}${n.headline}</p>
      ${n.description ? `<p class="player-meta news-desc">${n.description}</p>` : ""}
      <a class="news-link" href="${n.link}" target="_blank" rel="noopener">Read on ${escapeHtml(data.source || "RotoWire")} &rarr;</a>
    </div>`
    )
    .join("");

  container.innerHTML = `<h3>Recent News</h3>${rows}`;
}

// Which raw season-stat fields to show as columns, per position. The final
// "points" column has no fixed key/label: it's resolved at render time so it
// can reflect the loaded league's scoring settings.
const STAT_COLUMNS_BY_POSITION = {
  QB: [
    { label: "Comp/Att", format: (s) => `${fmtStat(s.completions)}/${fmtStat(s.attempts)}` },
    { label: "Pass Yds", key: "passing_yards" },
    { label: "Pass TD", key: "passing_tds" },
    { label: "INT", key: "interceptions" },
    { label: "Rush Yds", key: "rushing_yards" },
    { label: "Rush TD", key: "rushing_tds" },
    { points: true },
  ],
  RB: [
    { label: "Att", key: "carries" },
    { label: "Rush Yds", key: "rushing_yards" },
    { label: "Rush TD", key: "rushing_tds" },
    { label: "Rec", key: "receptions" },
    { label: "Rec Yds", key: "receiving_yards" },
    { label: "Rec TD", key: "receiving_tds" },
    { points: true },
  ],
  WR: [
    { label: "Tgt", key: "targets" },
    { label: "Rec", key: "receptions" },
    { label: "Rec Yds", key: "receiving_yards" },
    { label: "Rec TD", key: "receiving_tds" },
    { points: true },
  ],
};
STAT_COLUMNS_BY_POSITION.TE = STAT_COLUMNS_BY_POSITION.WR;

function renderPlayerCardStats(pid, pos, container = document.querySelector("#player-card .player-card-stats")) {
  if (!container) return;

  const data = state.playerSeasonStats;
  const playerStats = data && data.players && data.players[pid];
  const seasons = playerStats ? Object.keys(playerStats.seasons || {}).sort((a, b) => b - a) : [];

  if (!seasons.length) {
    container.innerHTML = `<p class="player-meta">No season stats available for this player.</p>`;
    return;
  }

  const cols = STAT_COLUMNS_BY_POSITION[pos] || STAT_COLUMNS_BY_POSITION.WR;
  const headers = cols.map((c) => (c.points ? pointsColumnLabel() : c.label));
  const rows = seasons
    .map((season) => {
      const s = playerStats.seasons[season];
      const cells = cols
        .map((c) => {
          if (c.points) return `<td>${fmtPpr(computeLeaguePoints(s, pos))}</td>`;
          return `<td>${c.format ? c.format(s) : fmtStat(s[c.key])}</td>`;
        })
        .join("");
      return `<tr><td>${season}</td><td>${s.team || "&mdash;"}</td><td>${fmtStat(s.games)}</td>${cells}</tr>`;
    })
    .join("");

  const scoringNote = leagueScoringSettings()
    ? `Points reflect ${escapeHtml((state.league && state.league.name) || "this league")}'s scoring settings.`
    : `Points shown are standard PPR (no league scoring loaded).`;

  container.innerHTML = `
    <table class="player-card-table">
      <thead>
        <tr><th>Season</th><th>Team</th><th>G</th>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="player-meta player-card-scoring-note">${scoringNote}</p>`;
}

async function openPlayerCard(pid) {
  const overlay = document.getElementById("player-card-overlay");
  const card = document.getElementById("player-card");
  const p = player(pid);
  const pos = playerPosition(p);
  const status = leagueStatusForSleeperId(pid);
  const name = playerDisplay(p);
  const initial = (name[0] || "?").toUpperCase();
  const color = colorForName(name);

  card.innerHTML = `
    <button type="button" class="player-card-close" aria-label="Close">&times;</button>
    <div class="player-card-head">
      <img class="player-card-photo" src="https://sleepercdn.com/content/nfl/players/${pid}.jpg" alt=""
        data-initial="${escapeHtml(initial)}" data-color="${color}" onerror="handlePlayerPhotoError(this)" />
      <div class="player-card-head-info">
        <div class="player-card-name">${escapeHtml(playerDisplay(p))}</div>
        <div class="player-card-meta-row">
          <span class="badge badge-${pos}">${pos}</span>
          <span class="player-meta">${p.team || "FA"}</span>
        </div>
        <div class="player-card-owner">${status.html}</div>
      </div>
    </div>
    <div class="player-card-stats">
      <p class="spinner-note">Loading season stats...</p>
    </div>
    <div class="player-card-news">
      <h3>Recent News</h3>
      <p class="spinner-note">Loading news...</p>
    </div>`;

  overlay.classList.remove("hidden");
  card.querySelector(".player-card-close").addEventListener("click", closePlayerCard);

  if (!state.playerSeasonStats) {
    try {
      const res = await fetch("data/player_season_stats.json", { cache: "no-store" });
      if (res.ok) state.playerSeasonStats = await res.json();
    } catch {
      // season stats are optional enrichment; the card still shows the basics without them
    }
  }
  renderPlayerCardStats(pid, pos);

  if (!state.playerNews) {
    try {
      const res = await fetch("data/player_news.json", { cache: "no-store" });
      if (res.ok) state.playerNews = await res.json();
    } catch {
      // news is optional enrichment; the card still shows the basics without them
    }
  }
  renderPlayerCardNews(pid);
}

function closePlayerCard() {
  document.getElementById("player-card-overlay").classList.add("hidden");
}

function setupPlayerCard() {
  document.addEventListener("click", (e) => {
    const nameEl = e.target.closest(".player-name[data-player-id]");
    if (nameEl) {
      e.preventDefault(); // a name inside a trade-pick-row <label> would otherwise also toggle its checkbox
      openPlayerCard(nameEl.dataset.playerId);
      return;
    }
    if (e.target.id === "player-card-overlay") closePlayerCard();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePlayerCard();
  });
}

function setupScrollHints() {
  // A <details> is collapsed via the browser's native disclosure hiding,
  // so a table inside one measures 0-width until it's actually opened --
  // re-check right when that happens rather than relying on render-time.
  document.addEventListener("toggle", (e) => { if (e.target.matches("details")) refreshScrollHints(); }, true);
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refreshScrollHints, 150);
  });
}

function setupAgeCurveToggle() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".scope-toggle-btn[data-agescope]");
    if (!btn || btn.classList.contains("active")) return;
    state.ageCurveScope = btn.dataset.agescope;
    renderAgeCurve();
  });
}

// Unlike the other scope toggles (which just call their full async render
// function again), this one re-renders from the already-computed
// state.outlookRows instead -- switching views or re-sorting shouldn't
// redo the weekly-projection loop that computed them in the first place.
function setupOutlookViewToggle() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".scope-toggle-btn[data-outlookview]");
    if (!btn || btn.classList.contains("active") || !state.outlookRows) return;
    document.querySelectorAll(".scope-toggle-btn[data-outlookview]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.outlookView = btn.dataset.outlookview;
    renderOutlookBody();
  });
}

function setupPowerRankSort() {
  document.addEventListener("click", (e) => {
    const th = e.target.closest("#outlook-quadrants th[data-sortkey]");
    if (!th || !state.outlookRows) return;
    state.powerRankSort = th.dataset.sortkey;
    renderOutlookBody();
  });
}

function setupPowerRankExpand() {
  document.addEventListener("click", (e) => {
    // A player name inside an expanded row should open the player card
    // (via setupPlayerCard's own listener), not toggle the row shut.
    if (e.target.closest(".player-name[data-player-id]")) return;
    const row = e.target.closest("tr.power-rank-row[data-expand-roster]");
    if (!row) return;
    const rid = Number(row.dataset.expandRoster);
    if (state.powerRankExpanded.has(rid)) state.powerRankExpanded.delete(rid);
    else state.powerRankExpanded.add(rid);
    renderOutlookBody();
  });
}

function setupAgeTeamSelect() {
  document.addEventListener("change", (e) => {
    if (e.target.id !== "age-team-select") return;
    state.ageCurveRosterId = Number(e.target.value);
    renderAgeCurve();
  });
}

function setupTradeFinderScopeToggle() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".scope-toggle-btn[data-tradescope]");
    if (!btn || btn.classList.contains("active")) return;
    state.tradeFinderScope = btn.dataset.tradescope;
    renderTradeFinder();
  });
}

// ---------- player evaluator ----------

const EVALUATOR_SEARCH_LIMIT = 8;

function evaluatorSearchResults(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const id in state.players) {
    const p = state.players[id];
    const pos = playerPosition(p);
    if (!SKILL_POSITIONS.includes(pos)) continue;
    const name = playerDisplay(p);
    if (!name || !name.toLowerCase().includes(q)) continue;
    results.push({ pid: id, p, name, pos });
  }
  results.sort((a, b) => playerRank(a.p) - playerRank(b.p));
  return results.slice(0, EVALUATOR_SEARCH_LIMIT);
}

function evaluatorSuggestionsHtml(results) {
  if (!results.length) {
    return `<p class="evaluator-suggestion-empty player-meta">No matching players.</p>`;
  }
  return results
    .map(
      (r) => `
    <button type="button" class="evaluator-suggestion" data-player-id="${r.pid}">
      <span class="badge badge-${r.pos}">${r.pos}</span>
      <span>${escapeHtml(r.name)}</span>
      <span class="player-meta">${r.p.team || "FA"}</span>
    </button>`
    )
    .join("");
}

function setupEvaluatorSearch() {
  const input = document.getElementById("evaluator-search");
  const suggestions = document.getElementById("evaluator-suggestions");
  if (!input || !suggestions) return;

  input.addEventListener("input", () => {
    if (!input.value.trim()) {
      suggestions.classList.add("hidden");
      suggestions.innerHTML = "";
      return;
    }
    suggestions.innerHTML = evaluatorSuggestionsHtml(evaluatorSearchResults(input.value));
    suggestions.classList.remove("hidden");
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) suggestions.classList.remove("hidden");
  });

  document.addEventListener("click", (e) => {
    const suggestion = e.target.closest(".evaluator-suggestion[data-player-id]");
    if (suggestion) {
      const pid = suggestion.dataset.playerId;
      input.value = playerDisplay(player(pid));
      suggestions.classList.add("hidden");
      suggestions.innerHTML = "";
      state.evaluatorPid = pid;
      state.evaluatorSeason = null;
      renderEvaluatorDetail(pid);
      return;
    }
    if (!e.target.closest(".evaluator-search-wrap")) suggestions.classList.add("hidden");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement === input) suggestions.classList.add("hidden");
  });
}

// Season stats, news and weekly stats are each fetched independently, so a
// fast second search before the first player's fetches resolve must not let
// the stale player's data land -- every render is gated on still being the
// selected player once its fetch completes.
async function renderEvaluatorDetail(pid) {
  const container = document.getElementById("evaluator-detail");
  if (!container) return;

  const p = player(pid);
  const pos = playerPosition(p);
  const status = leagueStatusForSleeperId(pid);
  const name = playerDisplay(p);
  const initial = (name[0] || "?").toUpperCase();
  const color = colorForName(name);

  container.innerHTML = `
    <div class="card">
      <div class="player-card-head">
        <img class="player-card-photo" src="https://sleepercdn.com/content/nfl/players/${pid}.jpg" alt=""
          data-initial="${escapeHtml(initial)}" data-color="${color}" onerror="handlePlayerPhotoError(this)" />
        <div class="player-card-head-info">
          <div class="player-card-name">${escapeHtml(name)}</div>
          <div class="player-card-meta-row">
            <span class="badge badge-${pos}">${pos}</span>
            <span class="player-meta">${p.team || "FA"}</span>
          </div>
          <div class="player-card-owner">${status.html}</div>
        </div>
      </div>
      <div class="player-card-stats">
        <p class="spinner-note">Loading season stats...</p>
      </div>
    </div>
    <div class="card" id="evaluator-weekly-card">
      <h3>Weekly Scoring</h3>
      <p class="spinner-note">Loading weekly stats...</p>
    </div>
    <div class="card player-card-news">
      <h3>Recent News</h3>
      <p class="spinner-note">Loading news...</p>
    </div>`;

  const statsContainer = container.querySelector(".player-card-stats");
  const newsContainer = container.querySelector(".player-card-news");
  const weeklyContainer = container.querySelector("#evaluator-weekly-card");

  if (!state.playerSeasonStats) {
    try {
      const res = await fetch("data/player_season_stats.json", { cache: "no-store" });
      if (res.ok) state.playerSeasonStats = await res.json();
    } catch {
      // season stats are optional enrichment; the rest of the evaluator still works
    }
  }
  if (state.evaluatorPid === pid) renderPlayerCardStats(pid, pos, statsContainer);

  if (!state.playerNews) {
    try {
      const res = await fetch("data/player_news.json", { cache: "no-store" });
      if (res.ok) state.playerNews = await res.json();
    } catch {
      // news is optional enrichment; the rest of the evaluator still works
    }
  }
  if (state.evaluatorPid === pid) renderPlayerCardNews(pid, newsContainer);

  if (!state.playerWeeklyStats) {
    try {
      const res = await fetch("data/player_weekly_stats.json", { cache: "no-store" });
      if (res.ok) state.playerWeeklyStats = await res.json();
    } catch {
      // weekly stats are optional enrichment; the rest of the evaluator still works
    }
  }
  if (state.evaluatorPid === pid) renderEvaluatorWeekly(pid, pos, weeklyContainer);
}

function evaluatorSeasonsForPlayer(pid) {
  const data = state.playerWeeklyStats;
  const stats = data && data.players && data.players[pid];
  if (!stats) return [];
  return Object.keys(stats.weeks || {}).sort((a, b) => b - a);
}

function evaluatorWeeklyChartHtml(weeksObj, pos) {
  const weekKeys = Object.keys(weeksObj)
    .map(Number)
    .sort((a, b) => a - b);
  if (!weekKeys.length) return emptyState("No weekly data for this season.");

  const points = weekKeys.map((w) => computeLeaguePoints(weeksObj[w], pos));
  const maxPts = Math.max(...points, 1);

  const cols = weekKeys
    .map((w, i) => {
      const pts = points[i];
      const h = Math.max((Math.max(pts, 0) / maxPts) * AGE_CHART_HEIGHT, 2);
      return `
        <div class="age-bar-col" title="Week ${w}: ${fmtPpr(pts)} pts">
          <div class="age-bar-track"><div class="age-bar-stack"><div class="age-bar-seg age-seg-${pos}" style="height:${h.toFixed(1)}px"></div></div></div>
          <div class="age-bar-label">${w}</div>
        </div>`;
    })
    .join("");

  return `<div class="age-chart">${cols}</div>`;
}

function evaluatorWeeklyTableHtml(weeksObj, pos) {
  const weekKeys = Object.keys(weeksObj)
    .map(Number)
    .sort((a, b) => a - b);
  const cols = STAT_COLUMNS_BY_POSITION[pos] || STAT_COLUMNS_BY_POSITION.WR;
  const headers = cols.map((c) => (c.points ? pointsColumnLabel() : c.label));
  const rows = weekKeys
    .map((w) => {
      const s = weeksObj[w];
      const cells = cols
        .map((c) => {
          if (c.points) return `<td>${fmtPpr(computeLeaguePoints(s, pos))}</td>`;
          return `<td>${c.format ? c.format(s) : fmtStat(s[c.key])}</td>`;
        })
        .join("");
      return `<tr><td>${w}</td><td>${s.opponent ? `@${escapeHtml(s.opponent)}` : "&mdash;"}</td>${cells}</tr>`;
    })
    .join("");

  return `
    <div class="table-wrap">
      <table class="player-card-table">
        <thead><tr><th>Wk</th><th>Opp</th>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function evaluatorSeasonTabsHtml(seasons, activeSeason) {
  return seasons
    .map((s) => `<button type="button" class="sub-tab-btn${s === activeSeason ? " active" : ""}" data-evalseason="${s}">${s}</button>`)
    .join("");
}

function renderEvaluatorWeekly(pid, pos, container = document.getElementById("evaluator-weekly-card")) {
  if (!container) return;

  const seasons = evaluatorSeasonsForPlayer(pid);
  if (!seasons.length) {
    container.innerHTML = `<h3>Weekly Scoring</h3><p class="player-meta">No weekly stats available for this player.</p>`;
    return;
  }
  if (!state.evaluatorSeason || !seasons.includes(state.evaluatorSeason)) {
    state.evaluatorSeason = seasons[0];
  }
  const weeksObj = state.playerWeeklyStats.players[pid].weeks[state.evaluatorSeason] || {};

  container.innerHTML = `
    <h3>Weekly Scoring</h3>
    <div class="sub-tab-nav">${evaluatorSeasonTabsHtml(seasons, state.evaluatorSeason)}</div>
    ${evaluatorWeeklyChartHtml(weeksObj, pos)}
    ${evaluatorWeeklyTableHtml(weeksObj, pos)}`;
  refreshScrollHints();
}

function setupEvaluatorSeasonTabs() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#evaluator-weekly-card .sub-tab-btn[data-evalseason]");
    if (!btn || !state.evaluatorPid) return;
    state.evaluatorSeason = btn.dataset.evalseason;
    renderEvaluatorWeekly(state.evaluatorPid, playerPosition(player(state.evaluatorPid)));
  });
}

// ---------- tabs ----------

function setupTabs() {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
      refreshScrollHints();
    });
  });

  document.getElementById("change-league-btn").addEventListener("click", () => {
    document.getElementById("app-nav").classList.add("hidden");
    document.getElementById("change-league-btn").classList.add("hidden");
    document.getElementById("app-main").classList.add("hidden");
    document.getElementById("setup").classList.remove("hidden");
  });

  document.querySelectorAll(".sub-tab-btn[data-postab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.postab === state.trendingPosTab);
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sub-tab-btn[data-postab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.trendingPosTab = btn.dataset.postab;
      localStorage.setItem(TRENDING_POS_TAB_KEY, state.trendingPosTab);
      if (state.risingMetrics) renderTrendingContent();
    });
  });
}

// ---------- wiring ----------

function init() {
  setupTabs();
  setupPlayerCard();
  setupAgeCurveToggle();
  setupAgeTeamSelect();
  setupTradeFinderScopeToggle();
  setupOutlookViewToggle();
  setupPowerRankSort();
  setupPowerRankExpand();
  setupEvaluatorSearch();
  setupEvaluatorSeasonTabs();
  setupScrollHints();

  const seasonInput = document.getElementById("season");
  seasonInput.value = new Date().getFullYear();

  document.getElementById("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value.trim();
    const season = document.getElementById("season").value.trim() || String(new Date().getFullYear());
    if (!username) return;
    document.getElementById("load-leagues-btn").disabled = true;
    try {
      await findLeagues(username, season);
    } catch (err) {
      showError(err.message || String(err));
      setStatus("");
    } finally {
      document.getElementById("load-leagues-btn").disabled = false;
    }
  });

  document.getElementById("load-league-btn").addEventListener("click", () => {
    const leagueId = document.getElementById("league-select").value;
    if (leagueId) loadLeague(leagueId);
  });

  const saved = loadSession();
  if (saved && saved.username && saved.leagueId) {
    document.getElementById("username").value = saved.username;
    seasonInput.value = saved.season || seasonInput.value;
    state.username = saved.username;
    state.userId = saved.userId;
    state.season = saved.season;
    setStatus("Restoring your last session...");
    findLeagues(saved.username, saved.season)
      .then(() => {
        document.getElementById("league-select").value = saved.leagueId;
        return loadLeague(saved.leagueId);
      })
      .catch((err) => {
        showError(err.message || String(err));
        setStatus("");
      });
  }
}

document.addEventListener("DOMContentLoaded", init);
