const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

// ==========================================================
// 1. CONFIG
// ==========================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

const FLASHSCORE_HOST = 'flashscore-api1.p.rapidapi.com';
const FLASHSCORE_LIVE_URL = `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/live?sport_id=1`;

const LIVE_FOOTBALL_HOST = 'football-live-stream-api.p.rapidapi.com';
const LIVE_FOOTBALL_URL = `https://${LIVE_FOOTBALL_HOST}/matches`;

const ODDS_API_URL = ODDS_API_KEY
  ? `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`
  : '';


// ==========================================================
// 2. ALERT / CACHE CONFIG
// ==========================================================
const MIN_SEND_PERCENTAGE = 60.0;
const BIG_BET_PERCENTAGE = 75.0;
const ALERT_INCREASE_THRESHOLD = 10.0;
const MAX_ALERTS_PER_MATCH = 3;
const MIN_ALERT_GAP_MINUTES = 5;
const ALERT_STATE_TTL = 4 * 60 * 60 * 1000;
const STATS_CACHE_TTL = 90 * 1000;
const SCAN_INTERVAL_MS = 7 * 60 * 1000;

const alertState = new Map();
const statsCache = new Map();
const snapshotState = new Map();
let scanRunning = false;

function cleanupState() {
  const now = Date.now();
  for (const [id, state] of alertState.entries()) {
    if (state.updatedAt && now - state.updatedAt > ALERT_STATE_TTL) alertState.delete(id);
  }
  for (const [id, state] of snapshotState.entries()) {
    if (state.updatedAt && now - state.updatedAt > ALERT_STATE_TTL) snapshotState.delete(id);
  }
  for (const [id, state] of statsCache.entries()) {
    if (now - state.time > STATS_CACHE_TTL * 5) statsCache.delete(id);
  }
}


// ==========================================================
// 3. TIME VIETNAM
// ==========================================================
function getVietnamTime() {
  const now = new Date();
  const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return { dateStr: vnTime.toISOString().slice(0, 10), timeStr: vnTime.toISOString().slice(11, 19) };
}


// ==========================================================
// 4. COUNTRY / LEAGUE
// ==========================================================
const COUNTRY_MAP = {
  England: 'Anh', Spain: 'Tây Ban Nha', Italy: 'Ý', Germany: 'Đức', France: 'Pháp',
  Japan: 'Nhật Bản', 'South Korea': 'Hàn Quốc', Vietnam: 'Việt Nam', Brazil: 'Brazil',
  Argentina: 'Argentina', Netherlands: 'Hà Lan', Portugal: 'Bồ Đào Nha', Turkey: 'Thổ Nhĩ Kỳ',
  'Saudi Arabia': 'Ả Rập Xê Út', China: 'Trung Quốc', Thailand: 'Thái Lan', Australia: 'Úc',
  USA: 'Mỹ', Norway: 'Na Uy', 'Czech Republic': 'Cộng hòa Séc', Denmark: 'Dan Mạch',
  Croatia: 'Croatia', Poland: 'Ba Lan', Austria: 'Áo', World: 'Quốc Tế', Europe: 'Châu Âu',
  Asia: 'Châu Á', 'South America': 'Nam Mỹ'
};

const LEAGUE_NAME_MAP = {
  'UEFA Champions League': 'Cúp C1 Châu Âu', 'UEFA Europa League': 'Cúp C2 Châu Âu',
  'UEFA Conference League': 'Cúp C3 Châu Âu', 'UEFA Nations League': 'Nations League Châu Âu',
  'AFC Champions League Elite': 'Cúp C1 Châu Á', 'AFC Champions League Two': 'Cúp C2 Châu Á',
  'AFC Asian Cup': 'Cúp Châu Á (Asian Cup)', 'CONMEBOL Libertadores': 'Cúp C1 Nam Mỹ (Libertadores)',
  'CONMEBOL Sudamericana': 'Cúp C2 Nam Mỹ (Sudamericana)', 'World Cup': 'Giải Vô Địch Thế Giới (World Cup)',
  'Club World Cup': 'Giải VĐQG Thế Giới Các CLB', Friendlies: 'Giao Hữu Quốc Tế',
  'Club Friendly': 'Giao Hữu CLB', 'Premier League': 'Ngoại Hạng Anh', Championship: 'Hạng Nhất Anh',
  'League One': 'Hạng Hai Anh', 'League Two': 'Hạng Ba Anh', 'FA Cup': 'Cúp FA',
  'EFL Cup': 'Cúp Liên Đoàn Anh', LaLiga: 'VĐQG Tây Ban Nha', 'LaLiga 2': 'Hạng 2 Tây Ban Nha',
  'Copa del Rey': 'Cúp Nhà Vua Tây Ban Nha', 'Serie A': 'VĐQG Ý', 'Serie B': 'Hạng 2 Ý',
  'Coppa Italia': 'Cúp Quốc Gia Ý', Bundesliga: 'VĐQG Đức', '2. Bundesliga': 'Hạng 2 Đức',
  'DFB Pokal': 'Cúp Quốc Gia Đức', 'Ligue 1': 'VĐQG Pháp', 'Ligue 2': 'Hạng 2 Pháp',
  'Coupe de France': 'Cúp Quốc Gia Pháp', 'J1 League': 'VĐQG Nhật Bản', 'J2 League': 'Hạng 2 Nhật Bản',
  'J3 League': 'Hạng 3 Nhật Bản', 'K League 1': 'VĐQG Hàn Quốc', 'K League 2': 'Hạng 2 Hàn Quốc',
  'V-League 1': 'V-League Việt Nam', 'Thai League 1': 'VĐQG Thái Lan', 'Super League': 'VĐQG Trung Quốc'
};

function parseLeagueName(item) {
  if (!item) return 'Bóng Đá Quốc Tế';
  const category = item.tournament?.category?.name || item.category?.name || item.country?.name || '';
  const tournament = item.tournament?.name || item.competitionName || item.league?.name || item.league || item.competition || '';
  if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];
  const translatedCategory = COUNTRY_MAP[category] || category;
  let translatedTournament = String(tournament)
    .replace(/\bPremier League\b/gi, 'Giải VĐQG')
    .replace(/\bDivision 1\b/gi, 'Hạng 1')
    .replace(/\bDivision 2\b/gi, 'Hạng 2')
    .replace(/\bSuper League\b/gi, 'VĐQG')
    .replace(/\bCup\b/gi, 'Cúp');
  if (translatedCategory && translatedTournament) {
    if (translatedTournament.toLowerCase().includes(translatedCategory.toLowerCase())) return translatedTournament;
    return `${translatedTournament} (${translatedCategory})`;
  }
  return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}

function isFilteredLeague(leagueName, homeName, awayName) {
  const text = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
  const professionalWomenKeywords = ['womens champions league', 'uefa women', 'afc women', 'nwsl', 'womens super league'];
  if (professionalWomenKeywords.some(k => text.includes(k))) return false;
  if (/\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i.test(text)) return true;
  const excluded = ['simulated', 'srl', 'esports', 'e-soccer', 'ncaa', 'amateur', 'semi-pro', 'regional', 'reserve'];
  return excluded.some(k => text.includes(k));
}


// ==========================================================
// 5. MINUTE
// ==========================================================
function parseMinuteValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return (Number.isFinite(value) && value > 0 && value <= 130) ? Math.floor(value) : null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (['ht', 'half time', 'halftime'].includes(text)) return 'HT';
  const plus = text.match(/(\d{1,3})\s*\+\s*(\d{1,2})/);
  if (plus) {
    const base = parseInt(plus[1], 10);
    return (base > 0 && base <= 120) ? base : null;
  }
  const normal = text.match(/(\d{1,3})/);
  if (normal) {
    const n = parseInt(normal[1], 10);
    return (n > 0 && n <= 130) ? n : null;
  }
  return null;
}

function calculateExactMinute(item) {
  if (!item) return 0;
  const statusType = String(item.status?.type ?? item.status?.name ?? item.status ?? '').toLowerCase();
  const statusDescription = String(item.status?.description ?? item.status?.desc ?? item.stage ?? item.state ?? '').toLowerCase();
  if (['finished', 'ended', 'full time', 'fulltime', 'ft', 'cancelled', 'canceled', 'postponed'].some(k => statusType === k || statusDescription === k)) return 999;
  if (statusType.includes('ht') || statusDescription.includes('halftime') || statusDescription.includes('half time')) return 'HT';

  const candidates = [item.minute, item.minutes, item.matchMinute, item.elapsed, item.live?.minute, item.status?.minute];
  for (const v of candidates) {
    const parsed = parseMinuteValue(v);
    if (parsed === 'HT') return 'HT';
    if (typeof parsed === 'number') return parsed;
  }
  return 0;
}


// ==========================================================
// 6. FETCH LIVE MATCHES (SOFASCORE)
// ==========================================================
async function fetchLiveMatchesFromSofaScore() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];
    const r = await axios.get(SOFASCORE_LIVE_URL, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST }, timeout: 10000 });
    return r.data?.events || r.data?.liveEvents || [];
  } catch (e) { return []; }
}


// ==========================================================
// 7. FETCH LIVE MATCHES (FLASHSCORE)
// ==========================================================
async function fetchLiveMatchesFromFlashScore() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];
    const r = await axios.get(FLASHSCORE_LIVE_URL, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': FLASHSCORE_HOST }, timeout: 8000 });
    return Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.matches || []);
  } catch (e) { return []; }
}


// ==========================================================
// 8. FETCH LIVE MATCHES (LIVE FOOTBALL)
// ==========================================================
async function fetchLiveMatchesFromLiveFootball() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];
    const r = await axios.get(LIVE_FOOTBALL_URL, { params: { status: 'live' }, headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVE_FOOTBALL_HOST }, timeout: 8000 });
    return r.data?.result || r.data?.matches || [];
  } catch (e) { return []; }
}


// ==========================================================
// 9. STATISTICS HELPERS (SAFE NUMBER & NORMALIZE)
// ==========================================================
function safeNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const num = parseFloat(String(value).replace('%', '').replace(',', '.').trim());
  return Number.isFinite(num) ? num : 0;
}

function normalizeStatName(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function createEmptyStats() {
  return {
    homeAttacks: 0, awayAttacks: 0, homeDangerousAttacks: 0, awayDangerousAttacks: 0,
    homeShotsOnTarget: 0, awayShotsOnTarget: 0, homeTotalShots: 0, awayTotalShots: 0,
    homeBlockedShots: 0, awayBlockedShots: 0, homeShotsOffTarget: 0, awayShotsOffTarget: 0,
    homePossession: 0, awayPossession: 0, homeCorners: 0, awayCorners: 0,
    homeYellowCards: 0, awayYellowCards: 0, homeRedCards: 0, awayRedCards: 0,
    homeBigChances: 0, awayBigChances: 0, hasData: false, source: null
  };
}

function mergeStats(target, source) {
  if (!source) return target;
  for (const key of Object.keys(createEmptyStats())) {
    if (key === 'hasData' || key === 'source') continue;
    const val = safeNumber(source[key]);
    if (val > 0) target[key] = val;
  }
  if (source.hasData) target.hasData = true;
  return target;
}


// ==========================================================
// 10. DETECT STAT TYPE & APPLY STAT
// ==========================================================
function detectStatType(statName) {
  const n = normalizeStatName(statName);
  if (n.includes('dangerous attack')) return 'dangerousAttacks';
  if (n === 'attacks' || n === 'attack') return 'attacks';
  if (n.includes('shots on target') || n.includes('on target')) return 'shotsOnTarget';
  if (n.includes('blocked shots')) return 'blockedShots';
  if (n.includes('shots off target')) return 'shotsOffTarget';
  if (n === 'total shots' || n === 'shots') return 'totalShots';
  if (n.includes('possession')) return 'possession';
  if (n.includes('corners')) return 'corners';
  if (n.includes('yellow cards')) return 'yellowCards';
  if (n.includes('red cards')) return 'redCards';
  if (n.includes('big chances')) return 'bigChances';
  return null;
}

function applyStat(stats, type, homeValue, awayValue) {
  if (!type) return;
  const home = safeNumber(homeValue);
  const away = safeNumber(awayValue);
  if (type === 'attacks') { stats.homeAttacks = home; stats.awayAttacks = away; }
  if (type === 'dangerousAttacks') { stats.homeDangerousAttacks = home; stats.awayDangerousAttacks = away; }
  if (type === 'shotsOnTarget') { stats.homeShotsOnTarget = home; stats.awayShotsOnTarget = away; }
  if (type === 'blockedShots') { stats.homeBlockedShots = home; stats.awayBlockedShots = away; }
  if (type === 'shotsOffTarget') { stats.homeShotsOffTarget = home; stats.awayShotsOffTarget = away; }
  if (type === 'totalShots') { stats.homeTotalShots = home; stats.awayTotalShots = away; }
  if (type === 'possession') { stats.homePossession = home; stats.awayPossession = away; }
  if (type === 'corners') { stats.homeCorners = home; stats.awayCorners = away; }
  if (type === 'yellowCards') { stats.homeYellowCards = home; stats.awayYellowCards = away; }
  if (type === 'redCards') { stats.homeRedCards = home; stats.awayRedCards = away; }
  if (type === 'bigChances') { stats.homeBigChances = home; stats.awayBigChances = away; }
  if (home > 0 || away > 0) stats.hasData = true;
}

function parseGenericStatObject(obj, stats) {
  if (!obj || typeof obj !== 'object') return;
  const type = detectStatType(obj.name ?? obj.label ?? obj.type ?? obj.title ?? '');
  if (!type) return;
  let home = obj.home ?? obj.homeValue ?? obj.valueHome;
  let away = obj.away ?? obj.awayValue ?? obj.valueAway;
  if (Array.isArray(obj.values)) { home = obj.values[0]; away = obj.values[1]; }
  applyStat(stats, type, home, away);
}

function recursivelyParseStats(node, stats, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { node.forEach(i => recursivelyParseStats(i, stats, depth + 1)); return; }
  if (typeof node !== 'object') return;
  parseGenericStatObject(node, stats);
  Object.values(node).forEach(v => { if (v && typeof v === 'object') recursivelyParseStats(v, stats, depth + 1); });
}

function parseDirectKeys(data, stats) {
  if (!data || typeof data !== 'object') return;
  const pairs = [
    { type: 'attacks', h: ['homeAttacks', 'home_attacks'], a: ['awayAttacks', 'away_attacks'] },
    { type: 'dangerousAttacks', h: ['homeDangerousAttacks', 'home_dangerous_attacks'], a: ['awayDangerousAttacks', 'away_dangerous_attacks'] },
    { type: 'shotsOnTarget', h: ['homeShotsOnTarget', 'home_shots_on_target'], a: ['awayShotsOnTarget', 'away_shots_on_target'] },
    { type: 'corners', h: ['homeCorners', 'home_corners'], a: ['awayCorners', 'away_corners'] },
    { type: 'possession', h: ['homePossession', 'home_possession'], a: ['awayPossession', 'away_possession'] }
  ];
  for (const p of pairs) {
    let hv, av;
    for (const k of p.h) if (data[k] !== undefined) { hv = data[k]; break; }
    for (const k of p.a) if (data[k] !== undefined) { av = data[k]; break; }
    if (hv !== undefined || av !== undefined) applyStat(stats, p.type, hv, av);
  }
}


// ==========================================================
// 11. FETCH SOFASCORE STATS
// ==========================================================
async function fetchSofaScoreStats(matchId) {
  const stats = createEmptyStats();
  if (!PAID_RAPIDAPI_KEY || !matchId) return stats;
  try {
    const r = await axios.get(`https://${SOFASCORE_HOST}/matches/get-statistics?matchId=${matchId}`, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST }, timeout: 8000 });
    if (r.data) { parseDirectKeys(r.data, stats); recursivelyParseStats(r.data, stats); if (stats.hasData) stats.source = 'sofascore'; }
  } catch (e) {}
  return stats;
}


// ==========================================================
// 12. FETCH FLASHSCORE STATS
// ==========================================================
async function fetchFlashScoreStats(matchId) {
  const stats = createEmptyStats();
  if (!PAID_RAPIDAPI_KEY || !matchId) return stats;
  try {
    const r = await axios.get(`https://${FLASHSCORE_HOST}/api/flashscore/v2/match/${matchId}/statistics`, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': FLASHSCORE_HOST }, timeout: 8000 });
    if (r.data) { parseDirectKeys(r.data, stats); recursivelyParseStats(r.data, stats); if (stats.hasData) stats.source = 'flashscore'; }
  } catch (e) {}
  return stats;
}


// ==========================================================
// 13. FETCH MATCH DETAIL STATS (CROSS-SOURCE)
// ==========================================================
function parseStatsFromRawMatch(raw) {
  const stats = createEmptyStats();
  if (!raw) return stats;
  parseDirectKeys(raw, stats);
  [raw.statistics, raw.stats, raw.liveStats].forEach(c => { if (c) { parseDirectKeys(c, stats); recursivelyParseStats(c, stats); } });
  if (stats.hasData) stats.source = 'raw-match';
  return stats;
}

function getCoreStatsCoverage(stats) {
  if (!stats) return 0;
  return [
    safeNumber(stats.homeAttacks) + safeNumber(stats.awayAttacks) > 0,
    safeNumber(stats.homeDangerousAttacks) + safeNumber(stats.awayDangerousAttacks) > 0,
    safeNumber(stats.homeShotsOnTarget) + safeNumber(stats.awayShotsOnTarget) > 0,
    safeNumber(stats.homeCorners) + safeNumber(stats.awayCorners) > 0
  ].filter(Boolean).length;
}

function mergeMissingStats(target, source) {
  if (!target || !source) return target;
  for (const key of Object.keys(createEmptyStats())) {
    if (key === 'hasData' || key === 'source') continue;
    if (safeNumber(target[key]) <= 0 && safeNumber(source[key]) > 0) target[key] = safeNumber(source[key]);
  }
  if (source.hasData) target.hasData = true;
  return target;
}

async function fetchMatchDetailStats(match) {
  const matchKey = `${cleanTeamNameDeep(match.homeName)}_${cleanTeamNameDeep(match.awayName)}`;
  const cacheKey = `cross:${matchKey}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.time < STATS_CACHE_TTL) return cached.data;

  let stats = parseStatsFromRawMatch(match.raw);
  const sourceMatches = Array.isArray(match.crossSourceMatches) ? match.crossSourceMatches : [match];

  for (const sm of sourceMatches) {
    if (sm.source === match.source && String(sm.id) === String(match.id)) continue;
    mergeMissingStats(stats, parseStatsFromRawMatch(sm.raw));
  }

  if (getCoreStatsCoverage(stats) < 4) {
    for (const sm of sourceMatches) {
      if (getCoreStatsCoverage(stats) >= 4) break;
      let extra = createEmptyStats();
      if (sm.source === 'sofascore') extra = await fetchSofaScoreStats(sm.id);
      else if (sm.source === 'flashscore') extra = await fetchFlashScoreStats(sm.id);
      mergeMissingStats(stats, extra);
    }
  }

  if (stats.homeTotalShots <= 0) stats.homeTotalShots = stats.homeShotsOnTarget + stats.homeShotsOffTarget + stats.homeBlockedShots;
  if (stats.awayTotalShots <= 0) stats.awayTotalShots = stats.awayShotsOnTarget + stats.awayShotsOffTarget + stats.awayBlockedShots;

  stats.source = `cross-source-${getCoreStatsCoverage(stats)}/4`;
  statsCache.set(cacheKey, { time: Date.now(), data: stats });
  return stats;
}
// ==========================================================
// 14. TOTAL HELPERS
// ==========================================================
function calculateTotals(stats) {
  return {
    totalAttacks: stats.homeAttacks + stats.awayAttacks,
    totalDangerousAttacks: stats.homeDangerousAttacks + stats.awayDangerousAttacks,
    totalShotsOnTarget: stats.homeShotsOnTarget + stats.awayShotsOnTarget,
    totalShots: stats.homeTotalShots + stats.awayTotalShots,
    totalBlockedShots: stats.homeBlockedShots + stats.awayBlockedShots,
    totalCorners: stats.homeCorners + stats.awayCorners
  };
}


// ==========================================================
// 15. TEAM PRESSURE SCORE
// ==========================================================
function calculateTeamPressure(stats) {
  let home = stats.homeDangerousAttacks * 0.28 + stats.homeAttacks * 0.08 + stats.homeShotsOnTarget * 4.2 + stats.homeBlockedShots * 2.0 + stats.homeTotalShots * 0.6 + stats.homeCorners * 1.5 + (stats.homePossession > 0 ? stats.homePossession * 0.05 : 0) + stats.homeBigChances * 4;
  let away = stats.awayDangerousAttacks * 0.28 + stats.awayAttacks * 0.08 + stats.awayShotsOnTarget * 4.2 + stats.awayBlockedShots * 2.0 + stats.awayTotalShots * 0.6 + stats.awayCorners * 1.5 + (stats.awayPossession > 0 ? stats.awayPossession * 0.05 : 0) + stats.awayBigChances * 4;
  return { home: Number(home.toFixed(2)), away: Number(away.toFixed(2)), difference: Number(Math.abs(home - away).toFixed(2)) };
}


// ==========================================================
// 16. MATCH STYLE
// ==========================================================
function detectMatchStyle(stats) {
  const pressure = calculateTeamPressure(stats);
  const totals = calculateTotals(stats);
  if (stats.homeDangerousAttacks >= 20 && stats.awayDangerousAttacks >= 20 && pressure.difference <= 15 && totals.totalShotsOnTarget >= 5) {
    return { type: 'END_TO_END', text: '⚔️ ĐÔI CÔNG', score: 90 };
  }
  if (pressure.home > pressure.away * 1.35 && pressure.difference >= 10) return { type: 'HOME_PRESSURE', text: '🔥 CHỦ NHÀ ÉP SÂN', score: 82 };
  if (pressure.away > pressure.home * 1.35 && pressure.difference >= 10) return { type: 'AWAY_PRESSURE', text: '🔥 ĐỘI KHÁCH ÉP SÂN', score: 82 };
  if (totals.totalShotsOnTarget >= 4 || totals.totalDangerousAttacks >= 50) return { type: 'BALANCED_ACTIVE', text: '⚡ THẾ TRẬN CÂN BẰNG - CÓ TẤN CÔNG', score: 65 };
  return { type: 'LOW_TEMPO', text: '🐢 NHỊP TRẬN THẤP', score: 35 };
}


// ==========================================================
// 17. FORMAT STATISTICS FOR TELEGRAM
// ==========================================================
function formatStatsText(stats) {
  const style = detectMatchStyle(stats);
  const pressure = calculateTeamPressure(stats);
  const total = pressure.home + pressure.away;
  const hShare = total > 0 ? round1(pressure.home / total * 100) : 50;
  const aShare = round1(100 - hShare);
  return [
    `📊 LIVE: Attack ${stats.homeAttacks}-${stats.awayAttacks} | Danger ${stats.homeDangerousAttacks}-${stats.awayDangerousAttacks} | Poss ${stats.homePossession}%-${stats.awayPossession}%`,
    `🎯 SÚT: Shots ${stats.homeTotalShots}-${stats.awayTotalShots} | SOT ${stats.homeShotsOnTarget}-${stats.awayShotsOnTarget}`,
    `🚩 KHÁC: Corner ${stats.homeCorners}-${stats.awayCorners} | Yellow ${stats.homeYellowCards}-${stats.awayYellowCards}`,
    `🔥 THẾ TRẬN: ${style.text} | Pressure ${hShare}%-${aShare}%`
  ].join('\n');
}


// ==========================================================
// 18. MATH HELPERS
// ==========================================================
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round1(value) { return Math.round(value * 10) / 10; }


// ==========================================================
// 19. MOMENTUM SNAPSHOT
// ==========================================================
function createSnapshot(stats, minute) {
  return { minute, time: Date.now(), homeAttacks: stats.homeAttacks, awayAttacks: stats.awayAttacks, homeDangerousAttacks: stats.homeDangerousAttacks, awayDangerousAttacks: stats.awayDangerousAttacks, homeShotsOnTarget: stats.homeShotsOnTarget, awayShotsOnTarget: stats.awayShotsOnTarget, homeCorners: stats.homeCorners, awayCorners: stats.awayCorners };
}


// ==========================================================
// 20. FORMAT MOMENTUM TEXT
// ==========================================================
function calculateMomentum(matchId, stats, minute) {
  const current = createSnapshot(stats, minute);
  const previous = snapshotState.get(matchId);
  snapshotState.set(matchId, { ...current, updatedAt: Date.now() });
  if (!previous) return { available: false, score: 50, text: '⏳ Đang thu thập Momentum' };
  const minuteGap = minute - safeNumber(previous.minute);
  if (minuteGap <= 0 || minuteGap > 20) return { available: false, score: 50, text: '⏳ Momentum chưa đủ dữ liệu' };

  const delta = (c, o) => Math.max(0, safeNumber(c) - safeNumber(o));
  const factor = 10 / Math.max(minuteGap, 1);
  const attack10 = (delta(current.homeAttacks, previous.homeAttacks) + delta(current.awayAttacks, previous.awayAttacks)) * factor;
  const dangerous10 = (delta(current.homeDangerousAttacks, previous.homeDangerousAttacks) + delta(current.awayDangerousAttacks, previous.awayDangerousAttacks)) * factor;
  const sot10 = (delta(current.homeShotsOnTarget, previous.homeShotsOnTarget) + delta(current.awayShotsOnTarget, previous.awayShotsOnTarget)) * factor;

  let score = 20;
  if (attack10 >= 25) score += 14;
  if (dangerous10 >= 14) score += 22;
  if (sot10 >= 3) score += 20;
  score = clamp(score, 0, 100);

  return { available: true, minuteGap, score: round1(score), text: score >= 75 ? '🔥 MOMENTUM RẤT MẠNH' : '⚡ Momentum trung bình' };
}

function formatMomentumText(momentum) {
  if (!momentum || !momentum.available) return momentum?.text || '⏳ Đang thu thập Momentum';
  return `${momentum.text} (${momentum.score}%)`;
}


// ==========================================================
// 21. ODDS CACHE & ADVANCED TEAM MATCHING
// ==========================================================
let oddsCache = { time: 0, data: [] };
const ODDS_CACHE_TTL = 2 * 60 * 1000;

function cleanTeamNameDeep(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|united|city)\b/g, '').replace(/[^a-z0-9]/g, '').trim();
}

function teamNamesSimilarAdvanced(a, b) {
  const x = cleanTeamNameDeep(a);
  const y = cleanTeamNameDeep(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}


// ==========================================================
// 22. FETCH ODDS
// ==========================================================
async function fetchAllLiveOdds() {
  if (!ODDS_API_KEY || !ODDS_API_URL) return [];
  if (oddsCache.data.length && Date.now() - oddsCache.time < ODDS_CACHE_TTL) return oddsCache.data;
  try {
    const r = await axios.get(ODDS_API_URL, { timeout: 10000 });
    oddsCache = { time: Date.now(), data: Array.isArray(r.data) ? r.data : [] };
    return oddsCache.data;
  } catch (e) { return []; }
}


// ==========================================================
// 23. FIND ODDS FOR MATCH
// ==========================================================
function findMatchOdds(allOdds, homeName, awayName, homeScore, awayScore) {
  if (!Array.isArray(allOdds) || !allOdds.length) {
    return { found: false, score: 50, oddsBonus: 0, text: '💰 Không có dữ liệu kèo' };
  }
  const event = allOdds.find(x => {
    const normal = teamNamesSimilarAdvanced(x.home_team, homeName) && teamNamesSimilarAdvanced(x.away_team, awayName);
    const reverse = teamNamesSimilarAdvanced(x.home_team, awayName) && teamNamesSimilarAdvanced(x.away_team, homeName);
    return normal || reverse;
  });
  if (!event) return { found: false, score: 50, oddsBonus: 0, text: '💰 Không tìm thấy kèo phù hợp' };

  const currentGoals = safeNumber(homeScore) + safeNumber(awayScore);
  const overSelections = [];
  for (const bookmaker of event.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (market.key !== 'totals') continue;
      for (const outcome of market.outcomes || []) {
        if (String(outcome.name).toLowerCase() !== 'over') continue;
        const point = safeNumber(outcome.point);
        const price = safeNumber(outcome.price);
        if (point > 0 && price > 1) overSelections.push({ bookmaker: bookmaker.title || 'Bookmaker', point, price });
      }
    }
  }
  if (!overSelections.length) return { found: true, score: 50, oddsBonus: 0, text: '💰 Có trận nhưng không có kèo Over' };

  let candidates = overSelections.filter(x => x.point > currentGoals);
  if (!candidates.length) candidates = overSelections;
  candidates.sort((a, b) => Math.abs(a.point - (currentGoals + 0.5)) - Math.abs(b.point - (currentGoals + 0.5)));

  const targetPoint = candidates[0].point;
  const sameLine = candidates.filter(x => x.point === targetPoint);
  const avgPrice = sameLine.reduce((sum, x) => sum + x.price, 0) / Math.max(sameLine.length, 1);
  const goalsNeeded = targetPoint - currentGoals;

  let score = 50;
  if (avgPrice <= 1.30) score = 95;
  else if (avgPrice <= 1.40) score = 90;
  else if (avgPrice <= 1.50) score = 84;
  else if (avgPrice <= 1.60) score = 78;
  else if (avgPrice <= 1.70) score = 72;
  else if (avgPrice <= 1.85) score = 64;
  else if (avgPrice <= 2.00) score = 56;
  else if (avgPrice <= 2.20) score = 48;
  else score = 40;

  if (goalsNeeded > 0 && goalsNeeded <= 0.75) score += 5;
  score = clamp(score, 0, 100);
  const oddsBonus = clamp((score - 50) * 0.24, -5, 12);

  return {
    found: true, point: targetPoint, price: round1(avgPrice * 100) / 100, currentGoals,
    goalsNeeded: round1(goalsNeeded), score: round1(score), oddsBonus: round1(oddsBonus),
    text: `💰 Over ${targetPoint} @ ${avgPrice.toFixed(2)} | Odds Score: ${round1(score)}%`
  };
}
// ==========================================================
// 24. SUB SCORE: ATTACK
// ==========================================================
function calculateAttackScore(stats, minute) {
  const total = stats.homeAttacks + stats.awayAttacks;
  if (total <= 0) return 50;
  const rate = total / Math.max(minute, 1);
  if (rate >= 2.4) return 88;
  if (rate >= 1.7) return 70;
  return 50;
}


// ==========================================================
// 25. SUB SCORE: DANGEROUS ATTACK
// ==========================================================
function calculateDangerousAttackScore(stats, minute) {
  const total = stats.homeDangerousAttacks + stats.awayDangerousAttacks;
  if (total <= 0) return 50;
  const rate = total / Math.max(minute, 1);
  if (rate >= 1.5) return 92;
  if (rate >= 1.0) return 76;
  return 55;
}


// ==========================================================
// 26. SUB SCORE: SOT
// ==========================================================
function calculateSOTScore(stats, minute) {
  const total = stats.homeShotsOnTarget + stats.awayShotsOnTarget;
  if (total >= 8) return 88;
  if (total >= 5) return 70;
  if (minute >= 70 && total <= 1) return 20;
  return 40;
}


// ==========================================================
// 27. SUB SCORE: BLOCKED SHOTS
// ==========================================================
function calculateBlockedScore() { return 50; }


// ==========================================================
// 28. SUB SCORE: CORNERS
// ==========================================================
function calculateCornerScore() { return 50; }


// ==========================================================
// 29. SUB SCORE: POSSESSION / PRESSURE
// ==========================================================
function calculatePossessionPressureScore() { return 60; }


// ==========================================================
// 30. SUB SCORE: CARDS
// ==========================================================
function calculateCardScore() { return 50; }


// ==========================================================
// 31. SUB SCORE: END TO END / PRESSURE
// ==========================================================
function calculateMatchStyleScore(stats) {
  const s = detectMatchStyle(stats);
  return { score: s.score, type: s.type, text: s.text };
}


// ==========================================================
// 32. SCORE STATE
// ==========================================================
function calculateScoreStateScore() { return 70; }


// ==========================================================
// 33. TIME SCORE
// ==========================================================
function calculateTimeScore() { return 60; }


// ==========================================================
// 34. RULE AI ENGINE
// ==========================================================
function evaluateMatchDynamicAI(stats, oddsAnalysis, momentum, minute, homeScore, awayScore) {
  const dan = calculateDangerousAttackScore(stats, minute);
  const mom = momentum?.available ? momentum.score : 50;
  const sot = calculateSOTScore(stats, minute);
  const style = calculateMatchStyleScore(stats);
  const oddsBonus = oddsAnalysis?.oddsBonus || 0;

  let finalScore = dan * 0.3 + mom * 0.3 + sot * 0.2 + style.score * 0.2 + oddsBonus;
  finalScore = clamp(round1(finalScore), 5, 95);

  let level = 'KHÔNG ĐỦ ĐIỀU KIỆN';
  if (finalScore >= BIG_BET_PERCENTAGE) level = '🔥 BIG BET';
  else if (finalScore >= MIN_SEND_PERCENTAGE) level = '🔔 CÓ TÍN HIỆU';

  return {
    efficiency: finalScore,
    shouldSend: finalScore >= MIN_SEND_PERCENTAGE,
    isBigBet: finalScore >= BIG_BET_PERCENTAGE,
    level,
    styleType: style.type,
    detailText: `Dangerous: ${dan}%, Momentum: ${mom}%, SOT: ${sot}%, Odds Bonus: ${oddsBonus}`
  };
}


// ==========================================================
// 35. SHOULD SEND ALERT
// ==========================================================
function hasStrongLiveMovement(momentum) {
  if (!momentum?.available) return false;
  return safeNumber(momentum.score) >= 65;
}

function shouldSendAlert(matchId, currentPercentage) {
  const current = safeNumber(currentPercentage);
  if (current < MIN_SEND_PERCENTAGE) return { send: false, bigBet: false };
  const previous = alertState.get(matchId);
  const bigBetConfirmed = current >= BIG_BET_PERCENTAGE;
  if (!previous) return { send: true, bigBet: bigBetConfirmed, reason: 'Cảnh báo đầu tiên' };
  if (previous.alertCount >= MAX_ALERTS_PER_MATCH) return { send: false, bigBet: false };
  return { send: true, bigBet: bigBetConfirmed, reason: 'Biến động đạt chuẩn' };
}


// ==========================================================
// 36. SCORE HELPERS
// ==========================================================
function extractScores(raw) {
  return {
    home: safeNumber(raw?.homeScore?.current ?? raw?.score?.home ?? 0),
    away: safeNumber(raw?.awayScore?.current ?? raw?.score?.away ?? 0)
  };
}


// ==========================================================
// 37. TEAM NAME HELPERS
// ==========================================================
function extractHomeName(raw) { return String(raw?.homeTeam?.name ?? raw?.home?.name ?? 'Home'); }
function extractAwayName(raw) { return String(raw?.awayTeam?.name ?? raw?.away?.name ?? 'Away'); }


// ==========================================================
// 38. MATCH ID
// ==========================================================
function extractMatchId(raw, source) {
  return String(raw?.id ?? `${source}_${createMatchKey(extractHomeName(raw), extractAwayName(raw))}`);
}
// ==========================================================
// 39. FORMAT MATCH
// ==========================================================
function formatLiveMatch(raw, source) {
  return {
    id: extractMatchId(raw, source), source,
    homeName: extractHomeName(raw), awayName: extractAwayName(raw),
    homeScore: extractScores(raw).home, awayScore: extractScores(raw).away,
    league: parseLeagueName(raw), raw
  };
}


// ==========================================================
// 40. PREDICT FINAL SCORE
// ==========================================================
function predictFinalScore(h, a) {
  return { text: `${h + 1}-${a}`, expectedExtraGoals: 1, likelyScorer: 'Đội ép sân', confidence: 'MẠNH', homeShare: 50, awayShare: 50 };
}


// ==========================================================
// 41. GOAL TIMELINE
// ==========================================================
function extractGoalTimeline() { return 'Chưa có bàn thắng'; }


// ==========================================================
// 42. TELEGRAM ESCAPE
// ==========================================================
function cleanTelegramText(v) { return v ? String(v) : ''; }


// ==========================================================
// 43. SEND TELEGRAM ALERT
// ==========================================================
async function sendTelegramAlert(item, alertDecision) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  const message = `🔔 RUNG: ${item.homeName} vs ${item.awayName} (${item.minute}') - AI: ${item.ai.efficiency}%`;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: message });
    alertState.set(item.alertKey, { lastPercentage: item.ai.efficiency, lastMinute: item.minute, alertCount: 1, updatedAt: Date.now() });
    return true;
  } catch (e) { return false; }
}


// ==========================================================
// 44. FETCH ALL LIVE SOURCES
// ==========================================================
async function fetchAllLiveMatches() {
  const [sofa, flash, football] = await Promise.allSettled([fetchLiveMatchesFromSofaScore(), fetchLiveMatchesFromFlashScore(), fetchLiveMatchesFromLiveFootball()]);
  const all = [];
  if (sofa.status === 'fulfilled') sofa.value.forEach(r => all.push(formatLiveMatch(r, 'sofascore')));
  if (flash.status === 'fulfilled') flash.value.forEach(r => all.push(formatLiveMatch(r, 'flashscore')));
  if (football.status === 'fulfilled') football.value.forEach(r => all.push(formatLiveMatch(r, 'live-football')));
  return all;
}


// ==========================================================
// 45. DEDUPLICATE MATCHES
// ==========================================================
function deduplicateMatches(matches) {
  const grouped = new Map();
  for (const m of matches) {
    const k = createMatchKey(m.homeName, m.awayName);
    if (!k || k === '_') continue;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(m);
  }
  const result = [];
  for (const arr of grouped.values()) {
    const primary = arr[0];
    primary.crossSourceMatches = arr;
    result.push(primary);
  }
  return result;
}


// ==========================================================
// 46. CHECK MATCH HAS USEFUL STATS
// ==========================================================
function hasUsefulStats(stats) {
  return stats && (stats.homeAttacks > 0 || stats.awayAttacks > 0 || stats.homeShotsOnTarget > 0);
}


// ==========================================================
// 47. SCAN ONE MATCH
// ==========================================================
async function analyzeOneMatch(match, allOdds) {
  const minuteRaw = calculateExactMinute(match.raw);
  if (minuteRaw === 'HT') return null;
  const minute = typeof minuteRaw === 'number' ? minuteRaw : parseInt(minuteRaw, 10);
  if (!Number.isFinite(minute) || minute < 46 || minute > 92) return null;
  if (isFilteredLeague(match.league, match.homeName, match.awayName)) return null;

  const stats = await fetchMatchDetailStats(match);
  const alertKey = createMatchKey(match.homeName, match.awayName);
  const momentum = calculateMomentum(alertKey, stats, minute);
  const odds = findMatchOdds(allOdds, match.homeName, match.awayName, match.homeScore, match.awayScore);

  if (!hasUsefulStats(stats) && !odds.found) return null;

  const ai = evaluateMatchDynamicAI(stats, odds, momentum, minute, match.homeScore, match.awayScore);
  const scorePrediction = predictFinalScore(match.homeScore, match.awayScore);
  const alertDecision = shouldSendAlert(alertKey, ai.efficiency);

  const result = { ...match, alertKey, minute, stats, momentum, odds, ai, scorePrediction, goalTimeline: 'Chưa có', alertDecision };
  if (ai.shouldSend && alertDecision.send && minute >= 65) {
    await sendTelegramAlert(result, alertDecision);
  }
  return result;
}


// ==========================================================
// 48. MAIN SCANNER
// ==========================================================
async function scanLiveMatches() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    cleanupState();
    const [liveMatches, allOdds] = await Promise.all([fetchAllLiveMatches(), fetchAllLiveOdds()]);
    const uniqueMatches = deduplicateMatches(liveMatches);
    const results = [];
    for (const m of uniqueMatches) {
      try {
        const res = await analyzeOneMatch(m, allOdds);
        if (res) results.push(res);
      } catch (e) {}
    }
    return results;
  } catch (e) {
    return [];
  } finally {
    scanRunning = false;
  }
}


// ==========================================================
// 49. EXPRESS ROUTE: ROOT
// ==========================================================
app.get('/', (req, res) => res.json({ status: 'ok', bot: 'Football Live AI Rule Bot' }));


// ==========================================================
// 50. EXPRESS ROUTE: HEALTH
// ==========================================================
app.get('/health', (req, res) => res.json({ status: 'healthy', scanRunning, alerts: alertState.size }));


// ==========================================================
// 51. EXPRESS ROUTE: SCAN
// ==========================================================
app.get('/scan', async (req, res) => {
  if (scanRunning) return res.status(409).json({ ok: false });
  const results = await scanLiveMatches();
  res.json({ ok: true, analyzed: results?.length || 0 });
});


// ==========================================================
// 52. START SERVER
// ==========================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setTimeout(() => scanLiveMatches().catch(() => {}), 10000);
  setInterval(() => scanLiveMatches().catch(() => {}), SCAN_INTERVAL_MS);
});