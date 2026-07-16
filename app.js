const API_BASE = "https://api.sleeper.app/v1";
const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
const PLAYERS_CACHE_KEY = "sleeper_tf_players_cache_v1";
const PLAYERS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h
const SESSION_KEY = "sleeper_tf_session_v1";

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
  trendingPosTab: "FLEX",
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
}

function emptyState(text) {
  return `<div class="empty-state"><p class="empty-note">${text}</p></div>`;
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
      <div class="matchup-row">
        <div class="matchup-side">
          ${avatarHtml(myRoster.owner_id, { size: "lg" })}
          <span class="matchup-name">${rosterLabel(myRoster)} <span class="player-meta">(you)</span></span>
        </div>
        <span class="matchup-points" style="color:${myWinning ? "var(--good)" : "inherit"}">${myPts}</span>
      </div>
      <div class="matchup-vs">VS</div>
      <div class="matchup-row">
        <div class="matchup-side">
          ${oppRoster ? avatarHtml(oppRoster.owner_id, { size: "lg" }) : ""}
          <span class="matchup-name">${oppRoster ? rosterLabel(oppRoster) : "Bye / TBD"}</span>
        </div>
        <span class="matchup-points" style="color:${oppWinning ? "var(--good)" : "inherit"}">${oppPts}</span>
      </div>`;
  } catch (err) {
    card.innerHTML = `<h2>Week ${state.currentWeek} matchup</h2>${emptyState("Couldn't load matchup data.")}`;
  }
}

function playerRow(pid, { showRank = true } = {}) {
  if (!pid || pid === "0") {
    return `<tr><td colspan="3" class="empty-note">&mdash; Empty slot &mdash;</td></tr>`;
  }
  const p = player(pid);
  const pos = playerPosition(p);
  const injury =
    p.injury_status && p.injury_status !== "Healthy"
      ? `<span class="injury">${p.injury_status}</span>`
      : "";
  const rank = showRank ? `<span class="rank-tag">#${playerRank(p)}</span>` : "";
  return `
    <tr>
      <td><span class="badge badge-${pos}">${pos}</span></td>
      <td>
        <span class="player-name">${playerDisplay(p)}</span>${injury}<br/>
        <span class="player-meta">${p.team || "FA"}</span>
      </td>
      <td>${rank}</td>
    </tr>`;
}

function renderStarters() {
  const card = document.getElementById("starters-card");
  const myRoster = state.rosters.find((r) => r.roster_id === state.myRosterId);
  if (!myRoster) {
    card.innerHTML = `<h2>Starters</h2>${emptyState("You don't own a team in this league.")}`;
    return;
  }
  const rows = (myRoster.starters || []).map((pid) => playerRow(pid)).join("");
  card.innerHTML = `<h2>Starters</h2><table><tbody>${rows}</tbody></table>`;
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
    .sort((a, b) => playerRank(player(a)) - playerRank(player(b)));
  const rows = bench.length
    ? bench.map((pid) => playerRow(pid)).join("")
    : `<tr><td>${emptyState("No bench players")}</td></tr>`;
  card.innerHTML = `<h2>Bench</h2><table><tbody>${rows}</tbody></table>`;
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

function startingSlotCounts() {
  const positions = (state.league && state.league.roster_positions) || [];
  const counts = {};
  positions.forEach((slot) => {
    if (["BN", "IR", "TAXI"].includes(slot)) return;
    counts[slot] = (counts[slot] || 0) + 1;
  });
  return counts;
}

// best (lowest) search_rank at each skill position, per roster
function bestRankByPosition() {
  const result = {}; // position -> { rosterId -> bestRank }
  SKILL_POSITIONS.forEach((pos) => (result[pos] = {}));

  state.rosters.forEach((r) => {
    const seen = {};
    (r.players || []).forEach((pid) => {
      const p = player(pid);
      const pos = playerPosition(p);
      if (!SKILL_POSITIONS.includes(pos)) return;
      const rank = playerRank(p);
      if (seen[pos] === undefined || rank < seen[pos]) seen[pos] = rank;
    });
    SKILL_POSITIONS.forEach((pos) => {
      result[pos][r.roster_id] = seen[pos] !== undefined ? seen[pos] : 9999;
    });
  });
  return result;
}

function computeNeeds() {
  if (!state.myRosterId) return [];
  const totalTeams = state.rosters.length;
  const byPos = bestRankByPosition();
  const needs = [];

  SKILL_POSITIONS.forEach((pos) => {
    const standings = state.rosters
      .map((r) => ({ rosterId: r.roster_id, rank: byPos[pos][r.roster_id] }))
      .sort((a, b) => a.rank - b.rank);
    const placement = standings.findIndex((s) => s.rosterId === state.myRosterId) + 1;
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

function computeTargets(needs) {
  if (!needs.length) return [];
  const needPositions = new Set(needs.map((n) => n.position));
  const candidates = [];

  state.rosters.forEach((r) => {
    if (r.roster_id === state.myRosterId) return;
    const starterSet = new Set(r.starters || []);
    (r.players || []).forEach((pid) => {
      const p = player(pid);
      const pos = playerPosition(p);
      if (!needPositions.has(pos)) return;
      if (p.injury_status === "IR") return;
      candidates.push({
        pid,
        pos,
        rank: playerRank(p),
        isBench: !starterSet.has(pid),
        ownerRoster: r,
      });
    });
  });

  candidates.sort((a, b) => {
    if (a.isBench !== b.isBench) return a.isBench ? -1 : 1; // bench players first
    return a.rank - b.rank;
  });

  const byPosition = {};
  candidates.forEach((c) => {
    byPosition[c.pos] = byPosition[c.pos] || [];
    if (byPosition[c.pos].length < 5) byPosition[c.pos].push(c);
  });
  return byPosition;
}

function renderTradeFinder() {
  const needsCard = document.getElementById("needs-card");
  const targetsCard = document.getElementById("targets-card");

  if (!state.myRosterId) {
    needsCard.innerHTML = `<h2>Team needs</h2>${emptyState("You don't own a team in this league.")}`;
    targetsCard.innerHTML = "";
    return;
  }

  const needs = computeNeeds();
  if (!needs.length) {
    needsCard.innerHTML = `<h2>Team needs</h2>${emptyState("Your roster looks solid at QB/RB/WR/TE relative to the rest of the league &mdash; no glaring needs detected.")}`;
    targetsCard.innerHTML = "";
    return;
  }

  needsCard.innerHTML = `
    <h2>Team needs</h2>
    <p class="player-meta" style="margin-bottom:14px">Based on how your best player at each position ranks (Sleeper's overall rank) against the rest of the league.</p>
    ${needs
      .map(
        (n) => `
      <span class="need-chip sev-${n.severity}">
        <span class="badge badge-${n.position}">${n.position}</span>
        <span class="sev-label">${n.severity} need</span>
        <span class="player-meta">${n.placement}/${n.totalTeams} in league</span>
      </span>`
      )
      .join("")}
  `;

  const targets = computeTargets(needs);
  const sections = Object.keys(targets)
    .map((pos) => {
      const rows = targets[pos]
        .map((c) => {
          const p = player(c.pid);
          return `
          <tr>
            <td><span class="badge badge-${pos}">${pos}</span></td>
            <td>
              <span class="player-name">${playerDisplay(p)}</span><br/>
              <span class="player-meta">${p.team || "FA"} &middot; ${c.isBench ? "Bench" : "Starter"}</span>
            </td>
            <td><span class="rank-tag">#${c.rank}</span></td>
            <td>${teamCellHtml(c.ownerRoster)}</td>
          </tr>`;
        })
        .join("");
      return `
        <h3>${pos} targets</h3>
        <table>
          <thead><tr><th>Pos</th><th>Player</th><th>Rank</th><th>Owned by</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join("");

  targetsCard.innerHTML = `<h2>Suggested trade targets</h2>${sections}`;
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
    renderTrendingContent();
  } catch (err) {
    card.innerHTML = `<h2>Rising metrics</h2>${emptyState("Couldn't load trend data (data/rising_metrics.json missing or unreachable).")}`;
  }
}

const TRENDING_ROWS_PER_TABLE = 10;

function renderTrendingContent() {
  const introCard = document.getElementById("trending-card");
  const grid = document.getElementById("trending-grid");
  const data = state.risingMetrics;
  const tab = POSITION_TABS.find((t) => t.key === state.trendingPosTab) || POSITION_TABS[0];

  introCard.innerHTML = `
    <h2>Rising metrics</h2>
    <p class="player-meta">
      Weeks ${data.recent_weeks[0]}&ndash;${data.recent_weeks[data.recent_weeks.length - 1]} vs.
      weeks ${data.prior_weeks[0]}&ndash;${data.prior_weeks[data.prior_weeks.length - 1]}, ${data.season} season.
      Sourced from <a href="https://nflreadr.nflverse.com/" target="_blank" rel="noopener">nflverse</a> play-by-play data (refreshed weekly), cross-referenced against this league's rosters.
    </p>`;

  const metricCards = tab.metricOrder
    .map((key) => {
      const def = data.metric_defs[key];
      if (!def) return "";

      const leaders = data.players
        .filter(
          (p) => tab.positions.includes(p.position) && def.positions.includes(p.position) && p.metrics[key]
        )
        .map((p) => ({ ...p, m: p.metrics[key] }))
        .filter((p) => p.m.delta > 0)
        .sort((a, b) => b.m.delta - a.m.delta)
        .slice(0, TRENDING_ROWS_PER_TABLE);

      if (!leaders.length) return "";

      const rows = leaders
        .map((l) => {
          const status = leagueStatusForSleeperId(l.sleeper_id);
          return `
          <tr>
            <td><span class="badge badge-${l.position}">${l.position}</span></td>
            <td>
              <span class="player-name">${l.name}</span><br/>
              <span class="player-meta">${l.team}</span>
            </td>
            <td class="player-meta">${formatMetricValue(l.m.prior, def.format)} &rarr; <strong>${formatMetricValue(l.m.recent, def.format)}</strong></td>
            <td><span class="delta-tag">+${formatMetricValue(l.m.delta, def.format)}</span></td>
            <td>${status.html}</td>
          </tr>`;
        })
        .join("");

      return `
        <div class="card metric-card">
          <details>
            <summary>
              <h3>${def.label}${infoIcon(def.description)}</h3>
              <svg class="chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
                <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </summary>
            <table>
              <thead><tr><th>Pos</th><th>Player</th><th>Prior &rarr; Recent</th><th>&Delta;</th><th>League status</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </details>
        </div>`;
    })
    .join("");

  grid.innerHTML = metricCards || "";
  if (!metricCards) {
    introCard.insertAdjacentHTML("beforeend", emptyState("No qualifying risers for this position group yet."));
  }
}

// ---------- tabs ----------

function setupTabs() {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  document.getElementById("change-league-btn").addEventListener("click", () => {
    document.getElementById("app-nav").classList.add("hidden");
    document.getElementById("change-league-btn").classList.add("hidden");
    document.getElementById("app-main").classList.add("hidden");
    document.getElementById("setup").classList.remove("hidden");
  });

  document.querySelectorAll(".sub-tab-btn[data-postab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sub-tab-btn[data-postab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.trendingPosTab = btn.dataset.postab;
      if (state.risingMetrics) renderTrendingContent();
    });
  });
}

// ---------- wiring ----------

function init() {
  setupTabs();

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
