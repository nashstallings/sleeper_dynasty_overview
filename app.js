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
  draftRounds: 4,
  pickOwnership: null,
  playerSeasonStats: null,
  playerAges: null,
  ageCurveScope: "starters",
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
    state.currentWeek = nflState && nflState.week ? nflState.week : null;

    state.myRosterId = null;
    const myRoster = state.rosters.find((r) => r.owner_id === state.userId);
    if (myRoster) state.myRosterId = myRoster.roster_id;
    state.selectedTradePlayers = new Set();

    state.tradedPicks = [];
    state.draftRounds = 4;
    state.pickOwnership = null;
    try {
      const [tradedPicks, drafts] = await Promise.all([
        api(`/league/${leagueId}/traded_picks`),
        api(`/league/${leagueId}/drafts`),
      ]);
      state.tradedPicks = Array.isArray(tradedPicks) ? tradedPicks : [];
      if (Array.isArray(drafts)) {
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
        <p class="news-headline">${n.headline}</p>
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

// How strong a roster is at a position: the combined trade value of its
// top starting-slot-count players there (e.g. top 2 RBs in a 2-RB league),
// so a team needs real depth, not just one standout player, to rate well.
// Falls back to an inverted best search_rank if trade values haven't
// loaded, so needs still work before/without that data.
function positionStrengthByRoster() {
  const result = {}; // position -> { rosterId -> strength }
  SKILL_POSITIONS.forEach((pos) => (result[pos] = {}));
  const slotCounts = dedicatedSlotCounts();
  const haveValues = !!(state.tradeValues && state.tradeValues.players);

  state.rosters.forEach((r) => {
    SKILL_POSITIONS.forEach((pos) => {
      const pids = (r.players || []).filter((pid) => playerPosition(player(pid)) === pos);
      let strength;
      if (haveValues) {
        strength = pids
          .map((pid) => playerValue(pid))
          .filter((v) => v !== null && v !== undefined)
          .sort((a, b) => b - a)
          .slice(0, slotCounts[pos])
          .reduce((sum, v) => sum + v, 0);
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
function buildTradePackage(roster, offerTotal, needPositions, theirNeedPositions) {
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
    }))
    .filter((c) => c.value !== null && c.value !== undefined);

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

// Which draft seasons we have pick values for, derived from whatever
// DynastyProcess's data currently covers (usually the next 3 classes)
// rather than a hardcoded number of years.
function pickTradeSeasons() {
  const picks = state.tradeValues && state.tradeValues.picks;
  if (!picks) return [];
  const years = new Set();
  Object.keys(picks).forEach((key) => {
    const year = key.split(" ")[0];
    if (/^\d{4}$/.test(year)) years.add(year);
  });
  return [...years].sort();
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
  needsCard.innerHTML = needs.length
    ? `
      <h2>Team needs</h2>
      <p class="player-meta" style="margin-bottom:14px">Based on your combined trade value at each position (top players per starting slot) against the rest of the league.</p>
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
      </div>
    `
    : `<h2>Team needs</h2>${emptyState("Your roster looks solid at QB/RB/WR/TE relative to the rest of the league &mdash; no glaring needs detected.")}`;

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

  // Only compute a fairness comparison when every selected player has a
  // known value -- a partial total would be misleading.
  const offerValues = selectedPlayers.map((sp) => sp.value);
  const offerTotal = offerValues.every((v) => v !== null && v !== undefined)
    ? offerValues.reduce((sum, v) => sum + v, 0)
    : null;

  const cards = others.map((roster) => {
    const theirNeedPositions = new Set(rosterNeeds(roster.roster_id).map((n) => n.position));
    const fitCount = selectedPlayers.filter((sp) => theirNeedPositions.has(sp.pos)).length;
    const tradePackage = buildTradePackage(roster, offerTotal, myNeedPositions, theirNeedPositions);
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
      <td><span class="badge badge-${entry.position}">${entry.position}</span></td>
      <td>
        <span class="player-name" data-player-id="${entry.sleeper_id}">${entry.name}</span><br/>
        <span class="player-meta">${entry.team}</span>
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
          <thead><tr><th>Pos</th><th>Player</th><th>Prior &rarr; Recent</th><th>&Delta;</th><th>Value rank</th><th>League status</th></tr></thead>
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

function rosterAgeEntries(rosterId) {
  const roster = rosterById(rosterId);
  const ages = (state.playerAges && state.playerAges.players) || {};
  if (!roster) return [];
  const pool = state.ageCurveScope === "starters" ? roster.starters : roster.players;
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

async function renderAgeCurve() {
  const teamCard = document.getElementById("age-team-card");
  const leagueCard = document.getElementById("age-league-card");
  if (!teamCard || !leagueCard) return;

  if (!state.myRosterId) {
    teamCard.innerHTML = `<h2>Age Curve</h2>${emptyState("You don't own a team in this league.")}`;
    leagueCard.innerHTML = "";
    return;
  }

  teamCard.innerHTML = `<h2>Age Curve</h2>${scopeToggleHtml()}<p class="spinner-note">Loading age data...</p>`;
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
    teamCard.innerHTML = `<h2>Age Curve</h2>${emptyState("Couldn't load player age data (data/player_ages.json missing or unreachable).")}`;
    return;
  }

  const myEntries = rosterAgeEntries(state.myRosterId);
  const myAvgAge = weightedAvgAge(myEntries);

  const leagueRows = state.rosters
    .map((r) => ({ roster: r, avgAge: weightedAvgAge(rosterAgeEntries(r.roster_id)), count: rosterAgeEntries(r.roster_id).length }))
    .filter((r) => r.avgAge !== null)
    .sort((a, b) => a.avgAge - b.avgAge);

  const myRank = leagueRows.findIndex((r) => r.roster.roster_id === state.myRosterId) + 1;
  const rankNote = myRank > 0 ? ` &middot; ${roundOrdinal(myRank)} youngest of ${leagueRows.length} teams` : "";

  const weightingNote = state.tradeValues
    ? "Weighted by each player's trade value, so bench depth counts less than your stars."
    : "Trade values didn't load, so this is a simple (unweighted) average.";

  const posRows = SKILL_POSITIONS
    .map((pos) => {
      const posEntries = myEntries.filter((e) => e.pos === pos);
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
    ${scopeToggleHtml()}
    <p class="player-meta" style="margin-bottom:14px">${weightingNote}</p>
    <div class="age-summary-value">${myAvgAge !== null ? myAvgAge.toFixed(1) : "&mdash;"}</div>
    <p class="player-meta" style="margin-bottom:18px">Value-weighted average age${rankNote}</p>
    ${ageChartHtml(myEntries)}
    ${posRows ? `<table style="margin-top:18px"><thead><tr><th>Pos</th><th># Players</th><th>Avg age</th></tr></thead><tbody>${posRows}</tbody></table>` : ""}`;

  if (!leagueRows.length) return;

  const leagueTableRows = leagueRows
    .map(({ roster, avgAge, count }, i) => {
      const isMe = roster.roster_id === state.myRosterId;
      return `
        <tr class="${isMe ? "me-row" : ""}">
          <td>${i + 1}</td>
          <td>${teamCellHtml(roster, { suffix: isMe ? '<span class="player-meta">you</span>' : "" })}</td>
          <td>${avgAge.toFixed(1)}</td>
          <td>${count}</td>
        </tr>`;
    })
    .join("");

  const countLabel = state.ageCurveScope === "starters" ? "Starters counted" : "Players counted";
  leagueCard.innerHTML = `
    <h2>League Age Comparison</h2>
    <p class="player-meta" style="margin-bottom:14px">Youngest to oldest, by value-weighted average age (${state.ageCurveScope === "starters" ? "starters only" : "full rosters"}).</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Team</th><th>Avg age</th><th>${countLabel}</th></tr></thead>
        <tbody>${leagueTableRows}</tbody>
      </table>
    </div>`;
  refreshScrollHints();
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

function renderPlayerCardNews(pid) {
  const container = document.querySelector("#player-card .player-card-news");
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
      <p class="news-headline">${n.headline}</p>
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

function renderPlayerCardStats(pid, pos) {
  const container = document.querySelector("#player-card .player-card-stats");
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
