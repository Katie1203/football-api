
const express = require('express');
const axios = require('axios');
const audit = require('./audit');
// Optional V4 module: preserve V3.5 operation if V4 was not deployed.
let ruleV4;
try {
  ruleV4 = require('./rule_v4_probability');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes("'./rule_v4_probability'")) throw error;
  console.warn('[RULE V4] rule_v4_probability.js missing; using existing Rule V3.5 fallback. Deploy the module next to index.js to enable V4.');
  ruleV4 = { predict: () => null };
}

// Count actual outgoing HTTP calls (not merely detail resolver attempts).
const httpMetrics={networkCalls:0,cacheHits:0,fallbackCalls:0,failedCalls:0,bySource:{}};
function metricSource(url){try{const h=new URL(url).hostname;return h.includes('api-sports')?'apisports':h.includes('sofascore')?'sofascore':h.includes('flashscore')?'flashscore':h.includes('live-football')?'live-football':h.includes('fotmob')?'fotmob':h.includes('odds')?'odds':h.includes('telegram')?'telegram':'other';}catch{return 'other';}}
axios.interceptors.request.use(config=>{const source=metricSource(axios.getUri(config));config._promaxMetricSource=source;httpMetrics.networkCalls++;(httpMetrics.bySource[source]??={networkCalls:0,failedCalls:0}).networkCalls++;return config;});
axios.interceptors.response.use(r=>r,e=>{if(e.config?._promaxMetricSource){httpMetrics.failedCalls++;httpMetrics.bySource[e.config._promaxMetricSource].failedCalls++;}return Promise.reject(e);});
const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

// ==========================================================
// 1. CONFIG
// ==========================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Shared RapidAPI credential for all four providers.
const PAID_RAPIDAPI_KEY = (process.env.RAPIDAPI_KEY || '').trim();
const FLASHSCORE_API_KEY = PAID_RAPIDAPI_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL =
  `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

const FLASHSCORE_HOST = 'flashscore4.p.rapidapi.com';
const FLASHSCORE_LIVE_URL =
  `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/live?sport_id=1`;

const LIVE_FOOTBALL_HOST =
  'free-api-live-football-data.p.rapidapi.com';

// Verified RapidAPI Livescores endpoint; no extra Render path variable.
const LIVE_FOOTBALL_URL = `https://${LIVE_FOOTBALL_HOST}/football-current-live`;
const FOTMOB_HOST = 'fotmob-api.p.rapidapi.com';
const FOTMOB_KEY = PAID_RAPIDAPI_KEY;
const FOTMOB_CACHE_MS = 60000;
const fotmobDetailCache = new Map();
// FlashScore: always enabled. HTTP errors are logged; no cooldown or retry gate.

// The Odds API v4 requires a sport key (e.g. soccer_epl), not /sports/soccer/odds.
const ODDS_BASE_URL = 'https://api.the-odds-api.com/v4';
const ODDS_REGION = process.env.ODDS_REGION || 'eu';
const ODDS_MAX_SPORTS = Math.max(1, Math.min(40, Number(process.env.ODDS_MAX_SPORTS || 16)));
const ODDS_SPORT_KEYS = (process.env.ODDS_SPORT_KEYS || '').split(',').map(x => x.trim()).filter(Boolean);
let oddsSportsCache = {time: 0, keys: []};
const oddsSportFailures = new Map(); // Per-sport temporary failure cache

// API-Football direct provider (not RapidAPI). Set APISPORTS_KEY in Render.
const APISPORTS_KEY = (process.env.APISPORTS_KEY || '').trim();
const APISPORTS_URL = 'https://v3.football.api-sports.io';
async function apiSportsGet(path, params) {
  if (!APISPORTS_KEY) return null;
  const {data} = await axios.get(`${APISPORTS_URL}${path}`, {
    params, headers: {'x-apisports-key': APISPORTS_KEY}, timeout: 11000
  });
  if (data?.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length))
    throw new Error(`API-Sports error: ${JSON.stringify(data.errors).slice(0,180)}`);
  return data;
}
async function fetchApiSportsLive() {
  if (!APISPORTS_KEY) return [];
  try {
    const data = await apiSportsGet('/fixtures', {live:'all'});
    const rows = Array.isArray(data?.response) ? data.response : [];
    console.log(`[Source API-Football] LIVE ${rows.length} trận`);
    return rows.filter(x => x?.fixture?.id && x?.teams?.home?.name && x?.teams?.away?.name);
  } catch(e) { logSourceError('API-Football','LIVE',e); return []; }
}
function formatApiSportsMatch(raw) {
  return {
    id:String(raw.fixture.id), source:'apisports',
    homeName:raw.teams.home.name, awayName:raw.teams.away.name,
    homeScore:raw.goals?.home ?? 0, awayScore:raw.goals?.away ?? 0,
    league:parseLeagueName({league:raw.league}),
    minute:raw.fixture.status?.elapsed,
    raw:{...raw, minute:raw.fixture.status?.elapsed,
      status:{type:raw.fixture.status?.short, minute:raw.fixture.status?.elapsed},
      _apiSportsStatus:raw.fixture.status?.short,
      _apiSportsEvents:raw.events, events:raw.events}
  };
}
const apiSportsStatsCache = new Map();
async function fetchApiSportsStats(id) {
  const result = createEmptyStats();
  if (!APISPORTS_KEY || !id) return result;
  const cached = apiSportsStatsCache.get(String(id));
  if (cached && Date.now()-cached.time < 90000) return cached.data;
  try {
    const data = await apiSportsGet('/fixtures/statistics',{fixture:id});
    const teams = data?.response;
    if (!Array.isArray(teams) || teams.length !== 2) return result;
    const fieldMap = {'Shots on Goal':'ShotsOnTarget','Total Shots':'TotalShots',
      'Corner Kicks':'Corners','Ball Possession':'Possession',
      'Attacks':'Attacks','Dangerous Attacks':'DangerousAttacks','Dangerous attacks':'DangerousAttacks',
      'Red Cards':'RedCards','Yellow Cards':'YellowCards',
      'Shots off Goal':'ShotsOffTarget','Shots insidebox':'ShotsInsideBox','Shots inside box':'ShotsInsideBox','Blocked Shots':'BlockedShots',
      'Fouls':'Fouls','Goalkeeper Saves':'GoalkeeperSaves','Expected Goals':'ExpectedGoals','expected_goals':'ExpectedGoals','xG':'ExpectedGoals'};
    for (let side=0;side<2;side++) {
      for (const row of teams[side].statistics || []) {
        const suffix=fieldMap[row.type];
        if (!suffix || row.value === null || row.value === undefined || row.value === '') continue;
        const n=Number(String(row.value).replace('%','').trim());
        if (Number.isFinite(n) && n>=0) { const field = `${side===0?'home':'away'}${suffix}`; result[field]=n; result._present[field]=true; }
      }
    }
    result.hasData=Array.isArray(teams[0].statistics) && teams[0].statistics.length>0;
    result.source='apisports';
    apiSportsStatsCache.set(String(id),{time:Date.now(),data:result});
    return result;
  } catch(e) { logSourceError('API-Football','STATS',e); return result; }
}
// ==========================================================
// 2. ALERT / CACHE CONFIG
// ==========================================================

// >= 58% gửi Telegram
const MIN_SEND_PERCENTAGE = 65.0;

// >= 75% BIG BET
const BIG_BET_PERCENTAGE = 75.0;

// Sau cảnh báo đầu tiên:
// AI phải tăng ít nhất +10% mới cảnh báo lại
// Retired: BIG BET follow-up uses verified Spike Score instead of Rule +10.
const ALERT_INCREASE_THRESHOLD = 10.0;

// Tối đa 3 cảnh báo / trận
const MAX_ALERTS_PER_MATCH = 2;

// Khoảng cách tối thiểu giữa 2 cảnh báo
const MIN_ALERT_GAP_MINUTES = 1;
const MIN_TELEGRAM_MINUTE = 65;
const FOLLOWUP_WINDOW_MINUTES = 10;

// Xóa trạng thái trận cũ sau 4 giờ
const ALERT_STATE_TTL =
  4 * 60 * 60 * 1000;

// Cache statistics 90 giây
const STATS_CACHE_TTL =
  90 * 1000;

// Quét 5 phút / lần
const SCAN_INTERVAL_MS =
  5 * 60 * 1000;


const alertState = new Map();
const sendingKeys = new Set();
let auditHydrated = false;
async function hydrateAlertState() {
  if (auditHydrated) return;
  const rows = await audit.getAlertStates();
  for (const r of rows) {
    if (alertState.has(r.matchKey)) continue;
    alertState.set(r.matchKey, {
      alertCount:Number(r.alertNumber), lastPercentage:Number(r.rule)||0,
      lastMinute:Number(r.minute)||0, bigBetSent:r.alertType==='BIG BET',
      alertSnapshot:null, updatedAt:Date.parse(r.createdAt) || Date.now(),
      homeName:r.home, awayName:r.away, league:r.league,
      source:r.source, sourceId:String(r.sourceId || '')
    });
  }
  auditHydrated = true;
  console.log(`[Telegram] Restored ${rows.length} prior match alert states from audit`);
}


const statsCache = new Map();

// Lưu snapshot để tính Momentum
const snapshotState = new Map();
// Dynamic windows: keep snapshots even when DA/ATT are unavailable.
const pressureHistory = new Map();
const postGoalState = new Map();
const PRESSURE_HISTORY_MAX = 40;
// A counter delta is valid only when both readings came from the same provider.
function pressureDelta(a,b,field) {
  if (!a || !b) return null;
  const keys=['home'+field,'away'+field];
  if (!keys.every(k=>a._present?.[k]===true && b._present?.[k]===true)) return null;
  const providersA=a._fieldSources||{}, providersB=b._fieldSources||{};
  if (!keys.every(k=>providersA[k] && providersB[k] && providersA[k]===providersB[k])) return null;
  const diffs=keys.map(k=>Number(b[k])-Number(a[k]));
  return diffs.every(x=>Number.isFinite(x)&&x>=0)?diffs[0]+diffs[1]:null;
}
function getPressureWindow(key,stats,minute,homeScore,awayScore) {
  const now={...makeMatchSnapshot(stats,minute,homeScore,awayScore),
    time:Date.now(),_fieldSources:{...(stats?._fieldSources||stats?.fieldSources||{})}};
  const history=pressureHistory.get(key)||[];
  const last=history[history.length-1];
  // A backwards clock indicates a new timeline. Provider changes do not.
  if(last && minute<last.minute-2) history.length=0;
  const validCount=x=>['TotalShots','ShotsOnTarget','Corners','BigChances'].reduce((n,f)=>n+(['home','away'].every(side=>x._present?.[side+f]===true)?1:0),0);
  if (!history.length || minute>history[history.length-1].minute) {
    if(validCount(now)>=2)history.push(now);
  } else if(minute===history[history.length-1].minute && validCount(now)>validCount(history[history.length-1])) {
    history[history.length-1]=now;
  }
  while(history.length>PRESSURE_HISTORY_MAX)history.shift();
  pressureHistory.set(key,history);
  const window=(size)=>{
    // Nearest valid baseline at least 'size' minutes old; avoid very old stale windows.
    const older=[...history].reverse().find(x=>x.minute<=minute-size && minute-x.minute<=size+5);
    if(!older)return {available:false,reason:'NEED_HISTORY'};
    const fields=['TotalShots','ShotsOnTarget','Corners','BigChances'];
    const delta=Object.fromEntries(fields.map(f=>[f,pressureDelta(older,now,f)]));
    const count=Object.values(delta).filter(v=>v!==null).length;
    // Must have either shot volume or on-target attempts, not just corners/chances.
    const usable=count>=2 && (delta.TotalShots!==null || delta.ShotsOnTarget!==null);
    return {available:usable,reason:usable?'OK':'MISSING_OR_CHANGED_SOURCE',minutes:minute-older.minute,delta,count};
  };
  return {five:window(5),ten:window(10),current:now,history};
}
function pressureEvidence(window) {
  if(!window?.available)return false;
  const d=window.delta||{};
  return (d.ShotsOnTarget??0)>=1 || ((d.TotalShots??0)>=2 && ((d.Corners??0)>=1 || (d.BigChances??0)>=1));
}
function pressureStrength(w) {
  if(!w?.available)return null;
  const d=w.delta||{};
  const duration=Math.max(1,w.minutes||5);
  const five=5/duration;
  return clamp(100*five*((d.TotalShots??0)/7+(d.ShotsOnTarget??0)/3+(d.Corners??0)/5+(d.BigChances??0)/2)/4,0,100);
}


let scanRunning = false;


// ==========================================================
// CLEAN CACHE
// ==========================================================

function cleanupState() {

  const now = Date.now();

  for (const [id, state] of alertState.entries()) {

    if (
      state.updatedAt &&
      now - state.updatedAt > ALERT_STATE_TTL
    ) {
      alertState.delete(id);
    }
  }


  for (const [id, state] of snapshotState.entries()) {

    if (
      state.updatedAt &&
      now - state.updatedAt > ALERT_STATE_TTL
    ) {
      snapshotState.delete(id);
    }
  }


  for(const [id,arr] of pressureHistory.entries()) if(!arr.length || now-(arr[arr.length-1].time||0)>ALERT_STATE_TTL)pressureHistory.delete(id);
  for(const [id,state] of postGoalState.entries())if(now-(state.updatedAt||0)>ALERT_STATE_TTL)postGoalState.delete(id);
  for (const [id, state] of statsCache.entries()) {

    if (
      now - state.time >
      STATS_CACHE_TTL * 5
    ) {
      statsCache.delete(id);
    }
  }
}


// ==========================================================
// 3. TIME VIETNAM
// ==========================================================

function getVietnamTime() {

  const now = new Date();

  const vnTime =
    new Date(
      now.getTime() +
      7 * 60 * 60 * 1000
    );

  return {

    dateStr:
      vnTime
        .toISOString()
        .slice(0, 10),

    timeStr:
      vnTime
        .toISOString()
        .slice(11, 19)

  };
}


// ==========================================================
// 4. COUNTRY / LEAGUE
// ==========================================================

const COUNTRY_MAP = {

  England: 'Anh',

  Spain: 'Tây Ban Nha',

  Italy: 'Ý',

  Germany: 'Đức',

  France: 'Pháp',

  Japan: 'Nhật Bản',

  'South Korea': 'Hàn Quốc',

  Vietnam: 'Việt Nam',

  Brazil: 'Brazil',

  Argentina: 'Argentina',

  Netherlands: 'Hà Lan',

  Portugal: 'Bồ Đào Nha',

  Turkey: 'Thổ Nhĩ Kỳ',

  'Saudi Arabia':
    'Ả Rập Xê Út',

  China: 'Trung Quốc',

  Thailand: 'Thái Lan',

  Australia: 'Úc',

  USA: 'Mỹ',

  Norway: 'Na Uy',

  'Czech Republic':
    'Cộng hòa Séc',

  Denmark: 'Đan Mạch',

  Croatia: 'Croatia',

  Poland: 'Ba Lan',

  Austria: 'Áo',

  World: 'Quốc Tế',

  Europe: 'Châu Âu',

  Asia: 'Châu Á',

  'South America':
    'Nam Mỹ'
};


const LEAGUE_NAME_MAP = {

  'UEFA Champions League':
    'Cúp C1 Châu Âu',

  'UEFA Europa League':
    'Cúp C2 Châu Âu',

  'UEFA Conference League':
    'Cúp C3 Châu Âu',

  'UEFA Nations League':
    'Nations League Châu Âu',

  'AFC Champions League Elite':
    'Cúp C1 Châu Á',

  'AFC Champions League Two':
    'Cúp C2 Châu Á',

  'AFC Asian Cup':
    'Cúp Châu Á (Asian Cup)',

  'CONMEBOL Libertadores':
    'Cúp C1 Nam Mỹ (Libertadores)',

  'CONMEBOL Sudamericana':
    'Cúp C2 Nam Mỹ (Sudamericana)',

  'World Cup':
    'Giải Vô Địch Thế Giới (World Cup)',

  'Club World Cup':
    'Giải VĐQG Thế Giới Các CLB',

  Friendlies:
    'Giao Hữu Quốc Tế',

  'Club Friendly':
    'Giao Hữu CLB',

  'English Premier League':
    'Ngoại Hạng Anh',

  'Tanzanian Premier League':
    'VĐQG Tanzania (Tanzanian Premier League)',

  Championship:
    'Hạng Nhất Anh',

  'League One':
    'Hạng Hai Anh',

  'League Two':
    'Hạng Ba Anh',

  'FA Cup':
    'Cúp FA',

  'EFL Cup':
    'Cúp Liên Đoàn Anh',

  LaLiga:
    'VĐQG Tây Ban Nha',

  'LaLiga 2':
    'Hạng 2 Tây Ban Nha',

  'Copa del Rey':
    'Cúp Nhà Vua Tây Ban Nha',

  'Serie A':
    'VĐQG Ý',

  'Serie B':
    'Hạng 2 Ý',

  'Coppa Italia':
    'Cúp Quốc Gia Ý',

  Bundesliga:
    'VĐQG Đức',

  '2. Bundesliga':
    'Hạng 2 Đức',

  'DFB Pokal':
    'Cúp Quốc Gia Đức',

  'Ligue 1':
    'VĐQG Pháp',

  'Ligue 2':
    'Hạng 2 Pháp',

  'Coupe de France':
    'Cúp Quốc Gia Pháp',

  'J1 League':
    'VĐQG Nhật Bản',

  'J2 League':
    'Hạng 2 Nhật Bản',

  'J3 League':
    'Hạng 3 Nhật Bản',

  'K League 1':
    'VĐQG Hàn Quốc',

  'K League 2':
    'Hạng 2 Hàn Quốc',

  'V-League 1':
    'V-League Việt Nam',

  'Thai League 1':
    'VĐQG Thái Lan',

  'Super League':
    'VĐQG Trung Quốc'
};


// ==========================================================
// PARSE LEAGUE
// ==========================================================

// Country-aware league display: never infer a country from an ambiguous league name.
const LEAGUE_COUNTRY_CODES = {
  ENG:'Anh', GBR:'Anh', ESP:'Tây Ban Nha', ITA:'Ý', GER:'Đức', DEU:'Đức',
  FRA:'Pháp', VIE:'Việt Nam', VNM:'Việt Nam', TAN:'Tanzania', TZA:'Tanzania',
  GHA:'Ghana', NGA:'Nigeria', EGY:'Ai Cập', NOR:'Na Uy', UAE:'UAE',
  IRN:'Iran', KOR:'Hàn Quốc', JPN:'Nhật Bản', THA:'Thái Lan',
  CHN:'Trung Quốc', USA:'Mỹ', BRA:'Brazil', ARG:'Argentina',
  POR:'Bồ Đào Nha', NED:'Hà Lan', NLD:'Hà Lan', SCO:'Scotland',
  AUS:'Úc', SAU:'Ả Rập Xê Út', TUR:'Thổ Nhĩ Kỳ', INT:'Quốc tế'
};
const COUNTRY_LEAGUE_TRANSLATIONS = {
  'anh': {'premier league':'Ngoại Hạng Anh','championship':'Hạng Nhất Anh',
    'league one':'Hạng Hai Anh','league two':'Hạng Ba Anh','fa cup':'Cúp FA Anh',
    'efl cup':'Cúp Liên Đoàn Anh'},
  'tanzania': {'premier league':'VĐQG Tanzania (Tanzanian Premier League)'},
  'ý': {'serie a':'VĐQG Ý','serie b':'Hạng 2 Ý','coppa italia':'Cúp Quốc Gia Ý'},
  'tây ban nha': {'laliga':'VĐQG Tây Ban Nha','la liga':'VĐQG Tây Ban Nha',
    'laliga 2':'Hạng 2 Tây Ban Nha','copa del rey':'Cúp Nhà Vua Tây Ban Nha'},
  'đức': {'bundesliga':'VĐQG Đức','2. bundesliga':'Hạng 2 Đức','dfb pokal':'Cúp Quốc Gia Đức'},
  'pháp': {'ligue 1':'VĐQG Pháp','ligue 2':'Hạng 2 Pháp','coupe de france':'Cúp Quốc Gia Pháp'},
  'việt nam': {'v-league':'V-League Việt Nam','v-league 1':'V-League Việt Nam'},
  'nhật bản': {'j1 league':'VĐQG Nhật Bản','j2 league':'Hạng 2 Nhật Bản','j3 league':'Hạng 3 Nhật Bản'},
  'hàn quốc': {'k league 1':'VĐQG Hàn Quốc','k league 2':'Hạng 2 Hàn Quốc'},
  'thái lan': {'thai league 1':'VĐQG Thái Lan'},
  'trung quốc': {'super league':'VĐQG Trung Quốc'}
};
const UNAMBIGUOUS_LEAGUES = {
  'uefa champions league':'Cúp C1 Châu Âu', 'champions league':'UEFA Champions League',
  'uefa europa league':'Cúp C2 Châu Âu', 'uefa conference league':'Cúp C3 Châu Âu',
  'uefa nations league':'UEFA Nations League',
  'afc champions league elite':'Cúp C1 Châu Á',
  'afc champions league two':'Cúp C2 Châu Á',
  'afc asian cup':'Asian Cup',
  'conmebol libertadores':'Copa Libertadores',
  'conmebol sudamericana':'Copa Sudamericana',
  'fifa club world cup':'FIFA Club World Cup'
};
function leagueCountryName(value) {
  if (!value) return '';
  const raw = String(typeof value === 'object' ? (value.name || value.ccode || value.code || '') : value).trim();
  if (!raw) return '';
  return LEAGUE_COUNTRY_CODES[raw.toUpperCase()] || COUNTRY_MAP[raw] || raw;
}
function parseLeagueName(item) {
  if (!item) return 'Chưa xác định giải';
  const leagueRaw = String(
    item.tournament?.name || item.competitionName || item.league?.name ||
    (typeof item.league === 'string' ? item.league : '') ||
    item.competition?.name || item.competition || item._flashLeagueName || item._fotmobLeagueName || ''
  ).trim();
  const countryRaw = item.tournament?.category?.name || item.tournament?.category?.country?.name ||
    item.category?.name || item.league?.country || item.country?.name ||
    item.country || item._flashCountry || item._fotmobCountry || item.ccode || '';
  const country = leagueCountryName(countryRaw);
  const key = leagueRaw.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
  const countryKey = country.toLocaleLowerCase('en-US');
  if (!leagueRaw) return 'Chưa xác định giải';
  if (UNAMBIGUOUS_LEAGUES[key]) return UNAMBIGUOUS_LEAGUES[key];
  if (key === 'tanzanian premier league') return 'VĐQG Tanzania (Tanzanian Premier League)';
  if (key === 'english premier league') return 'Ngoại Hạng Anh';
  const countryMap = COUNTRY_LEAGUE_TRANSLATIONS[countryKey];
  if (countryMap && countryMap[key]) return countryMap[key];
  // A generic league name can belong to many countries. Keep original English + country.
  if (country && !['world','europe','asia','international','quốc tế'].includes(countryKey)) {
    if (leagueRaw.toLocaleLowerCase('en-US').includes(countryKey)) return leagueRaw;
    return `${leagueRaw} (${country})`;
  }
  return leagueRaw;
}


// ==========================================================
// FILTER LEAGUE
// ==========================================================

function isFilteredLeague(
  leagueName,
  homeName,
  awayName
) {

  const text =

    `${leagueName} ${homeName} ${awayName}`
      .toLowerCase();


  const professionalWomenKeywords = [

    'womens champions league',

    'uefa women',

    'afc women',

    'conmebol libertadores femenina',

    'nwsl',

    'womens super league',

    'd1 arkema',

    'frauen-bundesliga',

    'liga f',

    'serie a fem',

    'a-league women',

    'world cup women',

    'olympic women',

    'shebelieves cup'

  ];


  if (
    professionalWomenKeywords
      .some(
        k => text.includes(k)
      )
  ) {

    return false;
  }


  // Loại U17/U18/U19/U20...
  if (
    /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i
      .test(text)
  ) {

    return true;
  }


  const excluded = [

    'simulated',

    'srl',

    'esports',

    'e-soccer',

    'ncaa',

    'amateur',

    'semi-pro',

    'regional',

    'reserve',

    'state league',

    'local',

    'college',

    'university'

  ];


  return excluded.some(
    k => text.includes(k)
  );
}


// ==========================================================
// 5. MINUTE
// GIỮ LOGIC ĐA NGUỒN
// CHỈ QUÉT 46 -> 88
// ==========================================================

function parseMinuteValue(value) {

  if (
    value === undefined ||
    value === null
  ) {

    return null;
  }


  if (
    typeof value === 'number'
  ) {

    return (
      Number.isFinite(value) &&
      value > 0 &&
      value <= 130
    )
      ? Math.floor(value)
      : null;
  }


  const text =
    String(value)
      .trim()
      .toLowerCase();


  if (!text) {
    return null;
  }


  if (
    [
      'ht',
      'half time',
      'halftime'
    ].includes(text)
  ) {

    return 'HT';
  }


  // Ví dụ 90+4
  const plus =
    text.match(
      /(\d{1,3})\s*\+\s*(\d{1,2})/
    );


  if (plus) {

    const base =
      parseInt(
        plus[1],
        10
      );


    return (
      base > 0 &&
      base <= 120
    )
      ? base
      : null;
  }


  const normal =
    text.match(
      /(\d{1,3})/
    );


  if (normal) {

    const n =
      parseInt(
        normal[1],
        10
      );


    return (
      n > 0 &&
      n <= 130
    )
      ? n
      : null;
  }


  return null;
}


// Verified October 2026 FlashScore / LiveFootball JSON adapters.
function normalizeProviderMinute(raw, source) {
  if (source === 'flashscore' || raw?.match_status?.live_minute != null) {
    const st = raw?.match_status || {};
    if (st.is_finished || st.is_cancelled || st.is_postponed) return 999;
    if (/half.?time|^ht$/i.test(String(st.stage || ''))) return 'HT';
    const n = Number(st.live_minute);
    if (Number.isFinite(n) && n > 0) return n;
    const m = String(st.live_time || '').match(/^(\d{1,3})/);
    return m ? Number(m[1]) : 0;
  }
  if (source === 'live-football' || raw?.status?.liveTime) {
    const st = raw?.status || {};
    if (st.finished || st.cancelled) return 999;
    const lt = st.liveTime || {};
    if (lt.shortKey === 'halftime_short' || /^HT$/i.test(String(lt.short))) return 'HT';
    const m = String(lt.short || '').match(/^(\d{1,3})/);
    if (m) return Number(m[1]);
    const elapsed = String(lt.long || '').match(/^(\d{1,3}):(\d{1,2})$/);
    return elapsed ? Number(elapsed[1]) + 1 : 0;
  }
  return null;
}
function parseVerifiedProviderStats(payload, source) {
  const out = createEmptyStats();
  const aliases = {
    'total shots':'TotalShots','total_shots':'TotalShots',
    'shots on target':'ShotsOnTarget','ShotsOnTarget':'ShotsOnTarget',
    'corner kicks':'Corners','corners':'Corners',
    'ball possession':'Possession','BallPossesion':'Possession',
    'blocked shots':'BlockedShots','blocked_shots':'BlockedShots',
    'shots off target':'ShotsOffTarget','ShotsOffTarget':'ShotsOffTarget',
    'shots inside the box':'ShotsInsideBox','shots_inside_box':'ShotsInsideBox',
    'red cards':'RedCards','red_cards':'RedCards',
    'dangerous attacks':'DangerousAttacks','dangerous_attacks':'DangerousAttacks',
    'total attacks':'Attacks','attacks':'Attacks'
  };
  function put(name, values) {
    const field = aliases[name] || aliases[String(name || '').toLowerCase()];
    if (!field || !Array.isArray(values)) return;
    for (let i=0; i<2; i++) {
      const raw = values[i];
      if (raw === null || raw === undefined || raw === '') continue;
      const n = Number(String(raw).replace('%',''));
      if (!Number.isFinite(n)) continue;
      const key = (i === 0 ? 'home' : 'away') + field;
      out[key] = n; out._present[key] = true; out.hasData = true;
    }
  }
  if (source === 'flashscore') {
    const rows = payload?.match ?? payload?.data?.match;
    if (Array.isArray(rows)) for (const r of rows) put(r.name, [r.home_team, r.away_team]);
  } else if (source === 'live-football') {
    const groups = payload?.response?.stats ?? payload?.stats;
    if (Array.isArray(groups)) for (const g of groups) {
      for (const r of (Array.isArray(g.stats) ? g.stats : [])) {
        const values = Array.isArray(r.rawStats) ? r.rawStats.map(v=>v?.value) : r.stats;
        put(r.key, values);
      }
    }
  }
  if (out.hasData) out.source = source;
  return out;
}

// ==========================================================
// CALCULATE EXACT MINUTE
// ==========================================================

function calculateExactMinute(item) {

  if (!item) {
    return 0;
  }
  const verifiedMinute = normalizeProviderMinute(item, item._providerSource);
  if (verifiedMinute !== null) return verifiedMinute;
  if (item._apiSportsStatus) {
    if (['FT','AET','PEN','CANC','PST','ABD'].includes(item._apiSportsStatus)) return 999;
    if (item._apiSportsStatus === 'HT') return 'HT';
    return parseMinuteValue(item.minute) || 0;
  }


  const statusType =

    String(

      item.status?.type ??

      item.status?.name ??

      item.status ??

      ''

    ).toLowerCase();


  const statusDescription =

    String(

      item.status?.description ??

      item.status?.desc ??

      item.stage ??

      item.state ??

      ''

    ).toLowerCase();


  // Trận đã kết thúc
  if (
    [
      'finished',
      'ended',
      'full time',
      'fulltime',
      'ft',
      'cancelled',
      'canceled',
      'postponed'
    ].some(
      k =>
        statusType === k ||
        statusDescription === k
    )
  ) {

    return 999;
  }


  // Half time
  if (
    statusType === 'halftime' ||

    statusType === 'half time' ||

    statusType === 'ht' ||

    statusDescription
      .includes('halftime') ||

    statusDescription
      .includes('half time') ||

    statusDescription === 'ht'
  ) {

    return 'HT';
  }


  const candidates = [

    item.minute,

    item.minutes,

    item.matchMinute,

    item.match_minute,

    item.liveMinute,

    item.live_minute,

    item.elapsed,

    item.elapsedTime,

    item.elapsed_time,

    item.live?.minute,

    item.live?.minutes,

    item.live?.time,

    item.live?.elapsed,

    item.status?.minute,

    item.status?.minutes,

    item.status?.elapsed,

    item.status?.time,

    item.status?.current,

    item.status?.val,

    item.time?.minute,

    item.time?.minutes,

    item.time?.currentMinute,

    item.time?.current,

    item.time?.played,

    item.time?.elapsed,

    item.stage,

    item.stageName,

    item.stage_name,

    item.timer,

    item.clock,

    item.matchTime,

    item.match_time,

    item.match_status,

    item.matchStatus,

    item.status_short,

    item.statusShort

  ];


  for (
    const v of candidates
  ) {

    const parsed =
      parseMinuteValue(v);


    if (
      parsed === 'HT'
    ) {

      return 'HT';
    }


    if (
      typeof parsed === 'number'
    ) {

      return parsed;
    }
  }


  // Một số API chỉ trả timestamp
  const periodStart =

    Number(

      item.time
        ?.currentPeriodStartTimestamp ??

      item.currentPeriodStartTimestamp ??

      item.time
        ?.currentPeriodStart ??

      item.current_period_start_timestamp

    );


  if (
    Number.isFinite(periodStart) &&
    periodStart > 0
  ) {

    const elapsedSeconds =

      Math.floor(
        Date.now() / 1000
      ) -
      periodStart;


    if (
      elapsedSeconds >= 0 &&
      elapsedSeconds < 3600
    ) {

      const periodMinute =

        Math.floor(
          elapsedSeconds / 60
        ) + 1;


      const period =

        String(

          item.time?.period ??

          item.period ??

          item.status?.period ??

          ''

        ).toLowerCase();


      const secondHalf =

        statusDescription
          .includes('2nd half') ||

        statusDescription
          .includes('second half') ||

        statusDescription
          .includes('hiệp 2') ||

        [
          '2',
          'second',
          '2nd'
        ].includes(period);


      if (secondHalf) {

        return (
          45 +
          periodMinute
        );
      }


      if (
        periodMinute <= 45
      ) {

        return periodMinute;
      }
    }
  }


  return 0;
}


function logSourceError(source, stage, error) {
  const status = error?.response?.status || 'NETWORK';
  const msg = String(error?.response?.data?.message || error?.message || 'Unknown error').slice(0, 160);
  console.warn(`[Source ${source}] ${stage} ERROR | HTTP ${status} | ${msg}`);
}

// ==========================================================
// 6. FETCH LIVE MATCHES
// ==========================================================

// SofaScore independent of all fallback switches. Do not confuse empty results
// with unknown payload structures or request errors.
function unpackSofaLiveEvents(payload) {
  const roots = [payload, payload?.data, payload?.result, payload?.response];
  for (const root of roots) {
    if (Array.isArray(root)) return root;
    for (const key of ['events', 'liveEvents', 'matches', 'live_matches', 'results']) {
      if (Array.isArray(root?.[key])) return root[key];
      if (Array.isArray(root?.[key]?.events)) return root[key].events;
    }
  }
  return null;
}
async function fetchLiveMatchesFromSofaScore() {
  if (!PAID_RAPIDAPI_KEY) {
    console.warn('[Source SofaScore] SKIP | RAPIDAPI_KEY is missing');
    return [];
  }
  try {
    const r = await axios.get(SOFASCORE_LIVE_URL, {
      headers: {
        'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
        'x-rapidapi-host': SOFASCORE_HOST
      },
      timeout: 10000
    });
    const events = unpackSofaLiveEvents(r.data);
    if (events === null) {
      const root = r.data && typeof r.data === 'object' ? Object.keys(r.data).slice(0, 12).join(',') : typeof r.data;
      console.warn(`[Source SofaScore] JSON UNRECOGNIZED | HTTP ${r.status} | keys: ${root}`);
      return [];
    }
    if (!events.length) console.warn('[Source SofaScore] API OK | returned 0 raw live events');
    else console.log(`[Source SofaScore] API OK | ${events.length} raw live events`);
    return events;
  } catch (e) {
    logSourceError('SofaScore', 'LIVE', e);
    return [];
  }
}

// ==========================================================
// FLASHSCORE LIVE
// ==========================================================

async function fetchLiveMatchesFromFlashScore() {

  try {

    if (!FLASHSCORE_API_KEY) {
      return [];
    }


    const r =
      await axios.get(
        FLASHSCORE_LIVE_URL,
        {
          headers: {

            'x-rapidapi-key':
              FLASHSCORE_API_KEY
                .trim(),

            'x-rapidapi-host':
              FLASHSCORE_HOST

          },

          timeout: 8000
        }
      );


    // FlashScore LIVE is an array of tournaments, each containing matches[].
    const payload = Array.isArray(r.data) ? r.data : (r.data?.data ?? r.data?.response ?? []);
    if (!Array.isArray(payload)) return [];
    return payload.flatMap(league => {
      if (!Array.isArray(league?.matches)) return league?.match_id ? [league] : [];
      return league.matches.map(m => ({
        ...m,
        _flashLeagueName: league.name,
        _flashCountry: league.country_name,
        _providerSource: 'flashscore'
      }));
    });

  } catch (e) {

    logSourceError('FlashScore', 'LIVE', e);
    return [];
  }
}


// ==========================================================
// LIVE FOOTBALL
// ==========================================================

async function fetchLiveMatchesFromLiveFootball() {

  try {

    if (!PAID_RAPIDAPI_KEY) {
      console.log('[Source LiveFootball] SKIPPED | RAPIDAPI_KEY missing');
      return [];
    }


    const r =
      await axios.get(
        LIVE_FOOTBALL_URL,
        {
          headers: {

            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY
                .trim(),

            'x-rapidapi-host':
              LIVE_FOOTBALL_HOST

          },

          timeout: 8000
        }
      );


    const payload = r.data?.response ?? r.data?.result ?? r.data?.data ?? r.data;
    const matches = Array.isArray(payload) ? payload : (payload?.live ?? payload?.matches ?? payload?.events ?? []);
    if (!Array.isArray(matches)) {
      console.warn('[Source LiveFootball] Unexpected LIVE response schema');
      return [];
    }
    return matches.map(m => ({...m, _providerSource: 'live-football'}));

  } catch (e) {

    logSourceError('LiveFootball', 'LIVE', e);
    return [];
  }
}

// ==========================================================
// FOTMOB: live discovery + detail stats (actual response schema)
// ==========================================================
function fotmobMinute(status) {
  const live = status?.liveTime || {};
  const value = String(live.short || '').replace(/[\u200e\u200f\u2066-\u2069]/g, '').trim();
  if (/^(HT|FT|AET|PEN)$/i.test(value)) return null;
  const m = value.match(/^(\d{1,3})/);
  return m ? Number(m[1]) : null;
}

function formatFotMobLiveMatch(raw) {
  const minute = fotmobMinute(raw.status);
  return {
    id: String(raw.id), source: 'fotmob',
    homeName: raw.home?.name || '', awayName: raw.away?.name || '',
    homeScore: Number(raw.home?.score || 0), awayScore: Number(raw.away?.score || 0),
    league: parseLeagueName({ league: { name: raw._fotmobLeagueName, country: raw._fotmobCountry } }),
    minute, raw: {
      ...raw, minute, elapsed: minute,
      league: { name: raw._fotmobLeagueName, country: raw._fotmobCountry },
      status: { ...raw.status, ongoing: raw.status?.ongoing, liveTime: raw.status?.liveTime }
    }
  };
}

async function fetchLiveMatchesFromFotMob() {
  if (!FOTMOB_KEY) return [];
  try {
    const response = await axios.get(`https://${FOTMOB_HOST}/api/v1/matches/live`, {
      params: { ccode3: 'USA', timezone: 'UTC' },
      headers: { 'x-rapidapi-key': FOTMOB_KEY.trim(), 'x-rapidapi-host': FOTMOB_HOST },
      timeout: 10000
    });
    const leagues = response.data?.leagues || response.data?.data?.leagues || [];
    const matches = [];
    for (const league of leagues) {
      for (const raw of league.matches || []) {
        if (!raw.status?.ongoing || raw.status?.finished || raw.status?.cancelled) continue;
        const minute = fotmobMinute(raw.status);
        if (minute === null || minute < 46 || minute > 88) continue;
        matches.push({ ...raw, _fotmobLeagueName: league.name, _fotmobCountry: league.ccode });
      }
    }
    return matches;
  } catch (error) {
    logSourceError('FotMob', 'LIVE', error);
    return [];
  }
}

function parseFotMobTeamStats(data) {
  const result = createEmptyStats();
  const sections = data?.content?.stats?.Periods?.All?.stats || [];
  const names = {
    'BallPossesion': ['homePossession', 'awayPossession'],
    'total_shots': ['homeTotalShots', 'awayTotalShots'],
    'ShotsOnTarget': ['homeShotsOnTarget', 'awayShotsOnTarget'],
    'ShotsOffTarget': ['homeShotsOffTarget', 'awayShotsOffTarget'],
    'ShotsInsideBox': ['homeShotsInsideBox', 'awayShotsInsideBox'],
    'blocked_shots': ['homeBlockedShots', 'awayBlockedShots'],
    'corners': ['homeCorners', 'awayCorners'],
    'big_chance': ['homeBigChances', 'awayBigChances'],
    'expected_goals': ['homeExpectedGoals', 'awayExpectedGoals'],
    'yellow_cards': ['homeYellowCards', 'awayYellowCards'],
    'red_cards': ['homeRedCards', 'awayRedCards']
  };
  for (const section of sections) {
    for (const item of section.stats || []) {
      const normalizedKey = String(item.key || item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const aliases = {
        ballpossession: 'BallPossesion', ballpossesion: 'BallPossesion', possession: 'BallPossesion',
        totalshots: 'total_shots', shots: 'total_shots', shotsontarget: 'ShotsOnTarget',
        shotsongoal: 'ShotsOnTarget', shotsofftarget: 'ShotsOffTarget', shotsinsidebox: 'ShotsInsideBox', blockedshots: 'blocked_shots',
        corners: 'corners', cornerkicks: 'corners', bigchances: 'big_chance',
        expectedgoals: 'expected_goals', xg: 'expected_goals',
        yellowcards: 'yellow_cards', redcards: 'red_cards'
      };
      const keys = names[item.key] || names[aliases[normalizedKey]];
      if (!keys || !Array.isArray(item.stats)) continue;
      for (let i = 0; i < 2; i++) {
        const raw = item.rawStats?.[i]?.value ?? item.stats[i];
        if (raw !== null && raw !== undefined && raw !== '') {
          const value = safeNumber(raw);
          if (Number.isFinite(value)) { result[keys[i]] = value; result._present[keys[i]] = true; }
        }
      }
    }
  }
  result.hasData = getCoreStatsCoverage(result) > 0;
  result.source = 'fotmob';
  return result;
}

async function fetchFotMobStats(id) {
  if (!FOTMOB_KEY || !id) return createEmptyStats();
  const cacheKey = String(id);
  const cached = fotmobDetailCache.get(cacheKey);
  if (cached && Date.now() - cached.time < FOTMOB_CACHE_MS) return cached.stats;
  try {
    const response = await axios.get(`https://${FOTMOB_HOST}/api/v1/matches/${encodeURIComponent(id)}`, {
      headers: { 'x-rapidapi-key': FOTMOB_KEY.trim(), 'x-rapidapi-host': FOTMOB_HOST },
      timeout: 10000
    });
    const data = response.data?.data || response.data;
    if (data?.general?.finished || data?.header?.status?.finished) return createEmptyStats();
    const stats = parseFotMobTeamStats(data);
    fotmobDetailCache.set(cacheKey, { time: Date.now(), stats });
    return stats;
  } catch (error) {
    logSourceError('FotMob', 'DETAIL', error);
    return createEmptyStats();
  }
}

async function fetchLiveFootballDetailStats(eventId) {
  if (!PAID_RAPIDAPI_KEY || !eventId) return createEmptyStats();
  try {
    const response = await axios.get(`https://${LIVE_FOOTBALL_HOST}/football-get-match-event-all-stats`, {
      params: { eventid: eventId },
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVE_FOOTBALL_HOST },
      timeout: 10000
    });
    const parsed = parseVerifiedProviderStats(response.data, 'live-football');
    return parsed.hasData ? parsed : parseStatsFromRawMatch(response.data);
  } catch (error) {
    logSourceError('LiveFootball', 'DETAIL', error);
    return createEmptyStats();
  }
}

// ==========================================================
// 7. STATISTICS HELPERS
// ==========================================================

function safeNumber(value) {

  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : 0;
  }

  const text = String(value)
    .replace('%', '')
    .replace(',', '.')
    .trim();

  const num = parseFloat(text);

  return Number.isFinite(num)
    ? num
    : 0;
}


// ==========================================================
// NORMALIZE STAT NAME
// ==========================================================

function normalizeStatName(name) {

  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// ==========================================================
// EMPTY STATS
// ==========================================================

function createEmptyStats() {

  return {

    // ------------------------------
    // ATTACK
    // ------------------------------

    homeAttacks: 0,
    awayAttacks: 0,

    homeDangerousAttacks: 0,
    awayDangerousAttacks: 0,


    // ------------------------------
    // SHOTS
    // ------------------------------

    homeShotsOnTarget: 0,
    awayShotsOnTarget: 0,

    homeTotalShots: 0,
    awayTotalShots: 0,

    homeBlockedShots: 0,
    awayBlockedShots: 0,

    homeShotsOffTarget: 0,
    awayShotsOffTarget: 0,
    homeShotsInsideBox: 0,
    awayShotsInsideBox: 0,


    // ------------------------------
    // POSSESSION
    // ------------------------------

    homePossession: 0,
    awayPossession: 0,


    // ------------------------------
    // CORNERS
    // ------------------------------

    homeCorners: 0,
    awayCorners: 0,


    // ------------------------------
    // CARDS
    // ------------------------------

    homeYellowCards: 0,
    awayYellowCards: 0,

    homeRedCards: 0,
    awayRedCards: 0,


    // ------------------------------
    // OPTIONAL
    // ------------------------------

    homeExpectedGoals: 0,
    awayExpectedGoals: 0,
    homeBigChances: 0,
    awayBigChances: 0,

    homeGoalkeeperSaves: 0,
    awayGoalkeeperSaves: 0,

    homeFouls: 0,
    awayFouls: 0,


    // Có lấy được dữ liệu hay không
    hasData: false,

    source: null,
    // Explicit presence metadata; zero can be a real provider value.
    _present: {}
  };
}


// ==========================================================
// MERGE STATS
// Chỉ ghi đè nếu giá trị mới hợp lệ
// ==========================================================

function mergeStats(target, source) {

  if (!source) {
    return target;
  }

  const keys = Object.keys(
    createEmptyStats()
  );

  for (const key of keys) {

    if (
      key === 'hasData' ||
      key === 'source' || key === '_present'
    ) {
      continue;
    }

    const value =
      safeNumber(source[key]);

    if (source._present?.[key] || value > 0) {
      target[key] = value;
      target._present[key] = true;
    }
  }

  if (source.hasData) {
    target.hasData = true;
  }

  if (source.source) {
    target.source = source.source;
  }

  return target;
}


// ==========================================================
// DETECT STAT TYPE
// ==========================================================

function detectStatType(statName) {

  const n =
    normalizeStatName(statName);


  // ------------------------------------------
  // DANGEROUS ATTACKS
  // PHẢI đặt trước attacks
  // ------------------------------------------

  if (
    n.includes('dangerous attack') ||
    n.includes('danger attacks') ||
    n.includes('dangerous attacks')
  ) {
    return 'dangerousAttacks';
  }


  // ------------------------------------------
  // ATTACKS
  // ------------------------------------------

  if (
    n === 'attacks' ||
    n === 'attack' ||
    n.includes('total attacks')
  ) {
    return 'attacks';
  }


  // ------------------------------------------
  // SHOTS ON TARGET
  // ------------------------------------------

  if (
    n.includes('shots on target') ||
    n.includes('shot on target') ||
    n.includes('shots on goal') ||
    n.includes('shot on goal') ||
    n.includes('on target')
  ) {
    return 'shotsOnTarget';
  }


  // ------------------------------------------
  // BLOCKED SHOTS
  // ------------------------------------------

  if (
    n.includes('blocked shots') ||
    n.includes('shots blocked') ||
    n.includes('blocked shot')
  ) {
    return 'blockedShots';
  }


  // ------------------------------------------
  // SHOTS OFF TARGET
  // ------------------------------------------

  if (
    n.includes('shots off target') ||
    n.includes('shot off target') ||
    n.includes('off target')
  ) {
    return 'shotsOffTarget';
  }


  if (n.includes('shots inside box') || n.includes('shots insidebox') || n.includes('shots in box')) return 'shotsInsideBox';

  // ------------------------------------------
  // TOTAL SHOTS
  // ------------------------------------------

  if (
    n === 'total shots' ||
    n === 'shots total' ||
    n === 'shots' ||
    n.includes('total shot')
  ) {
    return 'totalShots';
  }


  // ------------------------------------------
  // POSSESSION
  // ------------------------------------------

  if (
    n.includes('ball possession') ||
    n === 'possession' ||
    n.includes('possession %')
  ) {
    return 'possession';
  }


  // ------------------------------------------
  // CORNERS
  // ------------------------------------------

  if (
    n.includes('corner kicks') ||
    n.includes('corner kick') ||
    n === 'corners' ||
    n === 'corner'
  ) {
    return 'corners';
  }


  // ------------------------------------------
  // YELLOW CARD
  // ------------------------------------------

  if (
    n.includes('yellow cards') ||
    n.includes('yellow card')
  ) {
    return 'yellowCards';
  }


  // ------------------------------------------
  // RED CARD
  // ------------------------------------------

  if (
    n.includes('red cards') ||
    n.includes('red card')
  ) {
    return 'redCards';
  }


  // ------------------------------------------
  // EXPECTED GOALS (xG) - optional, never part of Rule/Spike
  // ------------------------------------------
  if (n === 'xg' || n === 'expected goals' || n === 'expected goal' || n === 'expectedgoals') return 'expectedGoals';

  // ------------------------------------------
  // BIG CHANCES
  // ------------------------------------------

  if (
    n.includes('big chances') ||
    n.includes('big chance')
  ) {
    return 'bigChances';
  }


  // ------------------------------------------
  // SAVES
  // ------------------------------------------

  if (
    n.includes('goalkeeper saves') ||
    n.includes('goalkeeper save') ||
    n === 'saves'
  ) {
    return 'goalkeeperSaves';
  }


  // ------------------------------------------
  // FOULS
  // ------------------------------------------

  if (
    n === 'fouls' ||
    n.includes('fouls committed')
  ) {
    return 'fouls';
  }


  return null;
}


// ==========================================================
// APPLY STAT
// ==========================================================

function applyStat(
  stats,
  type,
  homeValue,
  awayValue
) {

  if (!type) {
    return;
  }


  const home =
    safeNumber(homeValue);

  const away =
    safeNumber(awayValue);


  const statKey = {attacks:'Attacks',dangerousAttacks:'DangerousAttacks',shotsOnTarget:'ShotsOnTarget',blockedShots:'BlockedShots',shotsOffTarget:'ShotsOffTarget',shotsInsideBox:'ShotsInsideBox',totalShots:'TotalShots',possession:'Possession',corners:'Corners',yellowCards:'YellowCards',redCards:'RedCards',bigChances:'BigChances',goalkeeperSaves:'GoalkeeperSaves',fouls:'Fouls',expectedGoals:'ExpectedGoals'}[type];
  if (statKey) {
    if (homeValue !== null && homeValue !== undefined && homeValue !== '') stats._present['home'+statKey] = true;
    if (awayValue !== null && awayValue !== undefined && awayValue !== '') stats._present['away'+statKey] = true;
  }
  switch (type) {

    case 'attacks':

      stats.homeAttacks = home;
      stats.awayAttacks = away;

      break;


    case 'dangerousAttacks':

      stats.homeDangerousAttacks =
        home;

      stats.awayDangerousAttacks =
        away;

      break;


    case 'shotsOnTarget':

      stats.homeShotsOnTarget =
        home;

      stats.awayShotsOnTarget =
        away;

      break;


    case 'blockedShots':

      stats.homeBlockedShots =
        home;

      stats.awayBlockedShots =
        away;

      break;


    case 'shotsOffTarget':

      stats.homeShotsOffTarget =
        home;

      stats.awayShotsOffTarget =
        away;

      break;


    case 'shotsInsideBox':
      stats.homeShotsInsideBox = home;
      stats.awayShotsInsideBox = away;
      break;

    case 'totalShots':

      stats.homeTotalShots =
        home;

      stats.awayTotalShots =
        away;

      break;


    case 'possession':

      stats.homePossession =
        home;

      stats.awayPossession =
        away;

      break;


    case 'corners':

      stats.homeCorners =
        home;

      stats.awayCorners =
        away;

      break;


    case 'yellowCards':

      stats.homeYellowCards =
        home;

      stats.awayYellowCards =
        away;

      break;


    case 'redCards':

      stats.homeRedCards =
        home;

      stats.awayRedCards =
        away;

      break;


    case 'expectedGoals':
      stats.homeExpectedGoals = home;
      stats.awayExpectedGoals = away;
      break;

    case 'bigChances':

      stats.homeBigChances =
        home;

      stats.awayBigChances =
        away;

      break;


    case 'goalkeeperSaves':

      stats.homeGoalkeeperSaves =
        home;

      stats.awayGoalkeeperSaves =
        away;

      break;


    case 'fouls':

      stats.homeFouls =
        home;

      stats.awayFouls =
        away;

      break;
  }


  if (
    home > 0 ||
    away > 0
  ) {
    stats.hasData = true;
  }
}


// ==========================================================
// 8. GENERIC STAT PARSER
//
// Hỗ trợ nhiều dạng:
//
// {
//   name: "Shots on target",
//   home: "5",
//   away: "3"
// }
//
// hoặc:
//
// {
//   type: "Shots on Target",
//   homeValue: 5,
//   awayValue: 3
// }
//
// ==========================================================

function parseGenericStatObject(
  obj,
  stats
) {

  if (
    !obj ||
    typeof obj !== 'object'
  ) {
    return;
  }


  const statName =

    obj.name ??

    obj.label ??

    obj.type ??

    obj.statName ??

    obj.stat_name ??

    obj.title ??

    obj.key ??
    '';


  const type =
    detectStatType(statName);


  if (!type) {
    return;
  }


  let homeValue =

    obj.home ??

    obj.homeValue ??

    obj.home_value ??

    obj.homeTeam ??

    obj.home_team ??

    obj.valueHome ??

    obj.value_home;


  let awayValue =

    obj.away ??

    obj.awayValue ??

    obj.away_value ??

    obj.awayTeam ??

    obj.away_team ??

    obj.valueAway ??

    obj.value_away;


  // Dạng values: [home, away]
  if (
    Array.isArray(obj.values)
  ) {

    if (
      homeValue === undefined
    ) {
      homeValue =
        obj.values[0];
    }

    if (
      awayValue === undefined
    ) {
      awayValue =
        obj.values[1];
    }
  }


  // Dạng value: [home, away]
  if (
    Array.isArray(obj.value)
  ) {

    if (
      homeValue === undefined
    ) {
      homeValue =
        obj.value[0];
    }

    if (
      awayValue === undefined
    ) {
      awayValue =
        obj.value[1];
    }
  }


  applyStat(
    stats,
    type,
    homeValue,
    awayValue
  );
}


// ==========================================================
// RECURSIVE STAT PARSER
//
// Quét toàn bộ object response.
// ==========================================================

function recursivelyParseStats(
  node,
  stats,
  depth = 0
) {

  if (
    node === null ||
    node === undefined
  ) {
    return;
  }


  if (depth > 8) {
    return;
  }


  if (Array.isArray(node)) {

    for (const item of node) {

      recursivelyParseStats(
        item,
        stats,
        depth + 1
      );
    }

    return;
  }


  if (
    typeof node !== 'object'
  ) {
    return;
  }


  // Providers such as LiveFootball return {key, stats:[home,away], rawStats:[{value},{value}]}.
  // Read only known statistical keys; never turn a title or momentum value into ATT/DA.
  if (Array.isArray(node.stats) && node.stats.length === 2 &&
      node.stats.every(x => x === null || typeof x !== 'object')) {
    const kind = detectStatType(node.key || node.title || node.name || '');
    if (kind) {
      const pair = [0,1].map(i => node.rawStats?.[i]?.value ?? node.stats[i]);
      applyStat(stats, kind, pair[0], pair[1]);
    }
  }

  parseGenericStatObject(
    node,
    stats
  );


  for (
    const value of
    Object.values(node)
  ) {

    if (
      value &&
      typeof value === 'object'
    ) {

      recursivelyParseStats(
        value,
        stats,
        depth + 1
      );
    }
  }
}


// ==========================================================
// 9. PARSE DIRECT KEY OBJECT
//
// Một số API trả:
//
// attacks: { home: 90, away: 80 }
//
// hoặc:
//
// home_attacks: 90
// away_attacks: 80
//
// ==========================================================

function parseDirectKeys(
  data,
  stats
) {

  if (
    !data ||
    typeof data !== 'object'
  ) {
    return;
  }


  const directPairs = [
    { type: 'expectedGoals', homeKeys: ['homeExpectedGoals','home_expected_goals','homeXG','home_xg'], awayKeys: ['awayExpectedGoals','away_expected_goals','awayXG','away_xg'] },

    {
      type: 'attacks',

      homeKeys: [
        'homeAttacks',
        'home_attacks',
        'attacks_home'
      ],

      awayKeys: [
        'awayAttacks',
        'away_attacks',
        'attacks_away'
      ]
    },


    {
      type: 'dangerousAttacks',

      homeKeys: [
        'homeDangerousAttacks',
        'home_dangerous_attacks',
        'dangerous_attacks_home'
      ],

      awayKeys: [
        'awayDangerousAttacks',
        'away_dangerous_attacks',
        'dangerous_attacks_away'
      ]
    },


    {
      type: 'shotsOnTarget',

      homeKeys: [
        'homeShotsOnTarget',
        'home_shots_on_target',
        'shots_on_target_home'
      ],

      awayKeys: [
        'awayShotsOnTarget',
        'away_shots_on_target',
        'shots_on_target_away'
      ]
    },


    {
      type: 'blockedShots',

      homeKeys: [
        'homeBlockedShots',
        'home_blocked_shots',
        'blocked_shots_home'
      ],

      awayKeys: [
        'awayBlockedShots',
        'away_blocked_shots',
        'blocked_shots_away'
      ]
    },


    {
      type: 'totalShots',

      homeKeys: [
        'homeTotalShots',
        'home_total_shots',
        'total_shots_home'
      ],

      awayKeys: [
        'awayTotalShots',
        'away_total_shots',
        'total_shots_away'
      ]
    },


    {
      type: 'corners',

      homeKeys: [
        'homeCorners',
        'home_corners',
        'corners_home'
      ],

      awayKeys: [
        'awayCorners',
        'away_corners',
        'corners_away'
      ]
    },


    {
      type: 'yellowCards',

      homeKeys: [
        'homeYellowCards',
        'home_yellow_cards',
        'yellow_cards_home'
      ],

      awayKeys: [
        'awayYellowCards',
        'away_yellow_cards',
        'yellow_cards_away'
      ]
    },


    {
      type: 'redCards',

      homeKeys: [
        'homeRedCards',
        'home_red_cards',
        'red_cards_home'
      ],

      awayKeys: [
        'awayRedCards',
        'away_red_cards',
        'red_cards_away'
      ]
    },


    {
      type: 'possession',

      homeKeys: [
        'homePossession',
        'home_possession',
        'possession_home'
      ],

      awayKeys: [
        'awayPossession',
        'away_possession',
        'possession_away'
      ]
    }
  ];


  for (
    const pair of directPairs
  ) {

    let homeValue;
    let awayValue;


    for (
      const key of pair.homeKeys
    ) {

      if (
        data[key] !== undefined
      ) {

        homeValue =
          data[key];

        break;
      }
    }


    for (
      const key of pair.awayKeys
    ) {

      if (
        data[key] !== undefined
      ) {

        awayValue =
          data[key];

        break;
      }
    }


    if (
      homeValue !== undefined ||
      awayValue !== undefined
    ) {

      applyStat(
        stats,
        pair.type,
        homeValue,
        awayValue
      );
    }
  }


  // -----------------------------------------
  // Dạng:
  //
  // attacks: {
  //   home: 90,
  //   away: 80
  // }
  //
  // -----------------------------------------

  const objectPairs = [
    ['expectedGoals','expectedGoals'], ['expected_goals','expectedGoals'], ['xg','expectedGoals'],

    [
      'attacks',
      'attacks'
    ],

    [
      'dangerousAttacks',
      'dangerousAttacks'
    ],

    [
      'dangerous_attacks',
      'dangerousAttacks'
    ],

    [
      'shotsOnTarget',
      'shotsOnTarget'
    ],

    [
      'shots_on_target',
      'shotsOnTarget'
    ],

    [
      'blockedShots',
      'blockedShots'
    ],

    [
      'blocked_shots',
      'blockedShots'
    ],

    [
      'totalShots',
      'totalShots'
    ],

    [
      'total_shots',
      'totalShots'
    ],

    [
      'possession',
      'possession'
    ],

    [
      'corners',
      'corners'
    ],

    [
      'yellowCards',
      'yellowCards'
    ],

    [
      'yellow_cards',
      'yellowCards'
    ],

    [
      'redCards',
      'redCards'
    ],

    [
      'red_cards',
      'redCards'
    ]
  ];


  for (
    const [key, type]
    of objectPairs
  ) {

    const obj =
      data[key];


    if (
      obj &&
      typeof obj === 'object' &&
      !Array.isArray(obj)
    ) {

      applyStat(

        stats,

        type,

        obj.home ??
          obj.homeValue ??
          obj.home_value,

        obj.away ??
          obj.awayValue ??
          obj.away_value
      );
    }
  }
}


// ==========================================================
// 10. SOFASCORE STATISTICS
// ==========================================================

async function fetchSofaScoreStats(
  matchId
) {

  const stats =
    createEmptyStats();


  if (
    !PAID_RAPIDAPI_KEY ||
    !matchId
  ) {
    return stats;
  }


  const urls = [

    `https://${SOFASCORE_HOST}/matches/get-statistics?matchId=${matchId}`,

    `https://${SOFASCORE_HOST}/matches/get-statistics?eventId=${matchId}`

  ];


  let lastError = null;

  for (
    const url of urls
  ) {

    try {

      const r =
        await axios.get(
          url,
          {
            headers: {

              'x-rapidapi-key':
                PAID_RAPIDAPI_KEY
                  .trim(),

              'x-rapidapi-host':
                SOFASCORE_HOST

            },

            timeout: 8000
          }
        );


      if (!r.data) {
        continue;
      }


      mergeStats(stats, parseVerifiedProviderStats(r.data, 'flashscore'));
      parseDirectKeys(
        r.data,
        stats
      );


      recursivelyParseStats(
        r.data,
        stats
      );


      if (
        stats.hasData
      ) {

        stats.source =
          'sofascore';

        return stats;
      }

    } catch (e) {
      lastError = e;

      // Thử endpoint tiếp theo
    }
  }


  if (lastError) logSourceError('SofaScore', `STATS matchId=${matchId}`, lastError);
  else console.log(`[Source SofaScore] STATS matchId=${matchId} | Không có chỉ số`);
  return stats;
}


// ==========================================================
// 11. FLASHSCORE STATISTICS
// ==========================================================

const flashScoreStatsCache = new Map();
async function fetchFlashScoreStats(
  matchId
) {

  const stats =
    createEmptyStats();


  if (
    !FLASHSCORE_API_KEY ||
    !matchId
  ) {
    return stats;
  }


  const cached = flashScoreStatsCache.get(String(matchId));
  if (cached && Date.now() - cached.time < 90000) return cached.data;

  // Override via env when the subscribed FlashScore API exposes another route.
  const url = process.env.FLASHSCORE_STATS_URL_TEMPLATE
    ? process.env.FLASHSCORE_STATS_URL_TEMPLATE.replace('{matchId}', encodeURIComponent(matchId))
    : `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/match/stats?match_id=${encodeURIComponent(matchId)}`;
  const urls = [url];


  let lastError = null;

  for (
    const url of urls
  ) {

    try {

      const r =
        await axios.get(
          url,
          {
            headers: {

              'x-rapidapi-key':
                FLASHSCORE_API_KEY
                  .trim(),

              'x-rapidapi-host':
                FLASHSCORE_HOST

            },

            timeout: 8000
          }
        );


      if (!r.data) {
        continue;
      }


      parseDirectKeys(
        r.data,
        stats
      );


      recursivelyParseStats(
        r.data,
        stats
      );


      if (
        stats.hasData
      ) {

        stats.source =
          'flashscore';
        flashScoreStatsCache.set(String(matchId), {time:Date.now(), data:stats});
        return stats;
      }

    } catch (e) {
      lastError = e;

      // thử endpoint tiếp
    }
  }


  if (lastError) logSourceError('FlashScore', `STATS matchId=${matchId}`, lastError);
  else console.log(`[Source FlashScore] STATS matchId=${matchId} | Không có chỉ số`);
  flashScoreStatsCache.set(String(matchId), {time:Date.now(), data:stats});
  return stats;
}


// ==========================================================
// 12. PARSE STATS TỪ RAW MATCH
//
// Nhiều API đã chứa statistics ngay trong match.
// Ưu tiên lấy luôn để giảm API call.
// ==========================================================

function parseStatsFromRawMatch(
  raw
) {

  const stats =
    createEmptyStats();


  if (!raw) {
    return stats;
  }


  parseDirectKeys(
    raw,
    stats
  );


  const candidates = [

    raw.statistics,

    raw.stats,

    raw.matchStatistics,

    raw.match_statistics,

    raw.liveStats,

    raw.live_stats,
    raw.content?.stats, raw.data?.statistics, raw.data?.stats, raw.response?.statistics, raw.response?.stats

  ];


  for (
    const candidate of candidates
  ) {

    if (!candidate) {
      continue;
    }


    parseDirectKeys(
      candidate,
      stats
    );


    recursivelyParseStats(
      candidate,
      stats
    );
  }


  if (
    stats.hasData
  ) {

    stats.source =
      'raw-match';
  }


  return stats;
}


// ==========================================================
// 13. FETCH MATCH DETAIL STATS
//
// Có cache.
// Không gọi nhiều API thừa.
// ==========================================================

// ==========================================================
// CROSS-SOURCE PARTIAL STATS
// 5 chỉ số ưu tiên để quyết định có cần fallback thêm hay không:
// Total Shots / SOT / Corners / Shots Inside Box / Shots Off Target.
// Mục tiêu: ít nhất 4/5; nếu dữ liệu raw của 3 nguồn ghép được 5/5 thì giữ 5/5.
// Chỉ gọi detail API khi sau khi ghép raw vẫn < 4/5 để tránh lãng phí API.
// ==========================================================

function getCoreStatsCoverage(stats) {
  if (!stats) return 0;
  const fields = ['TotalShots','ShotsOnTarget','Corners','ShotsInsideBox','ShotsOffTarget'];
  return fields.filter(field => ['home','away'].every(side =>
    stats._present?.[side+field] === true ||
    // Legacy parsers without presence metadata can still confirm positive values.
    (Number(stats[side+field]) > 0)
  )).length;
}

function mergeMissingStats(target, source, freshness = {}) {
  if (!target || !source) return target;
  target._present ||= {};
  target._fieldSources ||= {};
  target._fieldFreshness ||= {};
  const sourceMinute = Number(freshness.minute);
  const validMinute = Number.isFinite(sourceMinute) && sourceMinute > 0 ? sourceMinute : null;
  const sourcePriority = Number(freshness.priority) || 0;
  const sourceName = freshness.source || source.source || 'fallback';
  for (const key of Object.keys(createEmptyStats())) {
    if (['hasData','source','_present'].includes(key) || key.startsWith('_')) continue;
    const present = source._present?.[key] === true || Number(source[key]) > 0;
    if (!present || !Number.isFinite(Number(source[key]))) continue;
    const oldPresent = target._present[key] === true || Number(target[key]) > 0;
    const old = target._fieldFreshness[key];
    // Never choose the largest value. Replace only when the fixture clock is
    // demonstrably newer, or when a same-minute detail source is more reliable.
    const newer = oldPresent && old && validMinute !== null && old.minute !== null && validMinute > old.minute;
    const sameMinuteBetter = oldPresent && old && validMinute !== null && old.minute === validMinute && sourcePriority > old.priority;
    if (!oldPresent || newer || sameMinuteBetter) {
      target[key] = Number(source[key]);
      target._present[key] = true;
      target._fieldSources[key] = sourceName;
      target._fieldFreshness[key] = {minute:validMinute, priority:sourcePriority};
    }
  }
  if (source.hasData) target.hasData = true;
  return target;
}

// Deduplicate concurrent requests for the SAME provider-native match ID.
// Keep providers independent; never reuse IDs between providers.
const providerStatsRequests = new Map();
const providerStatsCounters = {network:0, reused:0, skippedUnavailable:0};
// Avoid retrying a provider that has no useful stats for the same native fixture every scan.
// This is a per-provider negative cache, NOT a quota circuit breaker.
const EMPTY_PROVIDER_CACHE_MS = 10 * 60 * 1000;
// Capability observations never block a provider from supplying missing CORE stats.
// Only suppress optional-only retries when provider repeatedly lacks those fields.
const providerOptionalUnsupported=new Map();
const OPTIONAL_RECHECK_MS=30*60*1000;

const PROVIDER_STATS_CACHE_MS = STATS_CACHE_TTL;
function providerStatsCacheCleanup() {
  const now = Date.now();
  for (const [key, value] of providerStatsRequests) {
    if (now - value.time > (value.empty ? EMPTY_PROVIDER_CACHE_MS : PROVIDER_STATS_CACHE_MS)) providerStatsRequests.delete(key);
  }
}
async function fetchStatsForSourceMatch(sourceMatch) {
  if (!sourceMatch || sourceMatch.id == null) return createEmptyStats();
  providerStatsCacheCleanup();
  const requestKey = `${sourceMatch.source}:${String(sourceMatch.id)}`;
  const hit = providerStatsRequests.get(requestKey);
  if (hit && (Date.now()-hit.time < (hit.empty ? EMPTY_PROVIDER_CACHE_MS : PROVIDER_STATS_CACHE_MS))) {
    providerStatsCounters.reused++;
    httpMetrics.cacheHits++;
    if(hit.empty) providerStatsCounters.skippedUnavailable++;
    console.log(`[API DEDUP] REUSE ${requestKey} | ${hit.promise ? 'IN_FLIGHT' : 'CACHE'}`);
    return hit.promise || hit.data;
  }
  const entry = {time:Date.now(),promise:null,data:null,empty:false};
  providerStatsCounters.network++;
  const promise = fetchStatsForSourceMatchUncached(sourceMatch);
  entry.promise = promise;
  providerStatsRequests.set(requestKey,entry);
  try {
    const data = await promise;
    entry.data=data;
    entry.empty = getCoreStatsCoverage(data)===0 && !data?.hasData;
    entry.promise=null;
    entry.time=Date.now();
    return data;
  } catch (err) {
    providerStatsRequests.delete(requestKey);
    throw err;
  }
}
async function fetchStatsForSourceMatchUncached(sourceMatch) {

  if (!sourceMatch) {
    return createEmptyStats();
  }

  if (sourceMatch.source === 'sofascore') {
    return fetchSofaScoreStats(sourceMatch.id);
  }

  if (sourceMatch.source === 'flashscore') {
    return fetchFlashScoreStats(sourceMatch.id);
  }

  // Live Football hiện không có detail-stat endpoint riêng trong bản này.
  // Vẫn tham gia fallback bằng toàn bộ statistics có sẵn trong raw match.
  if (sourceMatch.source === 'live-football') {
    return fetchLiveFootballDetailStats(sourceMatch.id);
  }
  if (sourceMatch.source === 'fotmob') {
    return fetchFotMobStats(sourceMatch.id);
  }
  if (sourceMatch.source === 'apisports') return fetchApiSportsStats(sourceMatch.id);

  return createEmptyStats();
}


const crossStatsInFlight = new Map();
async function fetchMatchDetailStats(
  match
) {

  // Cache theo tên trận để 3 nguồn dùng chung kết quả đã ghép.
  const matchKey = createMatchKey(
    match.homeName,
    match.awayName
  );

  // Cross-provider aliases must share a cache key. The previous suffix
  // `matchKey` used raw provider names and defeated alias-based reuse.
  // Scope by fixture date (when kickoff is known) to avoid cross-day reuse.
  const kickoffRaw=match.kickoff ?? match.startTime ?? match.startTimestamp ?? match.raw?.startTimestamp ?? match.raw?.startTime;
  const kickoffNum=Number(kickoffRaw);
  const kickoffMs=kickoffRaw==null?NaN:Number.isFinite(kickoffNum)&&kickoffNum>1e9
    ? (kickoffNum<1e12?kickoffNum*1000:kickoffNum):Date.parse(kickoffRaw);
  const fixtureDay=Number.isFinite(kickoffMs)?new Date(kickoffMs).toISOString().slice(0,10):new Date().toISOString().slice(0,10);
  const cacheKey = `cross:${fixtureDay}:${resolverAliasTokens(match.homeName).join('')}:${resolverAliasTokens(match.awayName).join('')}`;

  // Keep live merged stats short-lived; provider caches are refreshed below.
  const LIVE_STATS_MAX_AGE_MS = 30000;
  const cached = statsCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < (getCoreStatsCoverage(cached.data) === 0 ? Math.min(LIVE_STATS_MAX_AGE_MS, 15000) : LIVE_STATS_MAX_AGE_MS)
  ) {
    return cached.data;
  }


  // Share an unfinished cross-source resolution for the same fixture.
  // This does NOT extend the 90s stats cache or suppress fresh scans.
  const pending = crossStatsInFlight.get(cacheKey);
  if (pending) {
    httpMetrics.cacheHits++;
    console.log(`[API DEDUP] CROSS_IN_FLIGHT ${cacheKey}`);
    return pending;
  }
  const resolvePromise = (async () => {

  // Danh sách cùng một trận từ cả 3 nguồn đã được deduplicateMatches giữ lại.
  // Resolve native IDs independently from the LIVE discovery pool even if
  // deduplication did not attach crossSourceMatches. Never reuse an ID across providers.
  const linked = Array.isArray(match.crossSourceMatches) ? match.crossSourceMatches : [match];
  const sourceMatches = [...linked];
  for (const candidate of independentLiveSourceRegistry) {
    if (sourceMatches.some(m => m.source === candidate.source && String(m.id) === String(candidate.id))) continue;
    if (resolverSameMatch(match, candidate) || resolverExactSameFixture(match, candidate)) sourceMatches.push(candidate);
  }
  if (sourceMatches.length === 1 && independentLiveSourceRegistry.length > 1) {
    console.log(`[DA/ATT RESOLVER] ${match.homeName} vs ${match.awayName} | NO_CROSS_PROVIDER_MATCH | candidates=${independentLiveSourceRegistry.length}`);
  }
  if (sourceMatches.length > linked.length) {
    console.log(`[DA/ATT RESOLVER] ${match.homeName} vs ${match.awayName} | additional=${sourceMatches.slice(linked.length).map(m=>m.source+':'+m.id).join(',')}`);
  }


  // BƯỚC 1: ghép RAW của tất cả nguồn trước — không tốn thêm API call.
  let stats = parseStatsFromRawMatch(match.raw);
  // Seed provenance for the primary raw snapshot (without changing its values).
  stats._fieldFreshness ||= {};
  stats._fieldSources ||= {};
  for (const key of Object.keys(createEmptyStats())) {
    if (key.startsWith('_') || ['hasData','source'].includes(key)) continue;
    if (stats._present?.[key] === true || Number(stats[key]) > 0) {
      stats._fieldFreshness[key] = {minute:Number(match.minute) > 0 ? Number(match.minute) : null, priority:0};
      stats._fieldSources[key] = match.source || 'raw-match';
    }
  }

  for (const sourceMatch of sourceMatches) {

    if (
      sourceMatch.source === match.source &&
      String(sourceMatch.id) === String(match.id)
    ) {
      continue;
    }

    const clockA=Number(match.minute),clockB=Number(sourceMatch.minute);
    if(Number.isFinite(clockA)&&Number.isFinite(clockB)&&clockA>0&&clockB>0&&Math.abs(clockA-clockB)>3){
      console.log(`[STATS FRESHNESS] SKIP_RAW ${sourceMatch.source}:${sourceMatch.id} | minuteDelta=${Math.abs(clockA-clockB)}`);
      continue;
    }
    const rawStats = parseStatsFromRawMatch(sourceMatch.raw);
    mergeMissingStats(stats, rawStats, {minute:sourceMatch.minute, priority:0, source:sourceMatch.source});
  }


  // BƯỚC 2: lấy thêm cả chỉ số phụ nếu còn thiếu, không chỉ kiểm tra 5 core.
  // Ưu tiên SofaScore -> FlashScore -> Live Football.
  const sourcePriority = {
    apisports: 5, sofascore: 4, 'live-football': 3,
    flashscore: 2, fotmob: 1
  };

  const orderedSources = [...sourceMatches].sort(
    (a, b) =>
      (sourcePriority[b.source] || 0) -
      (sourcePriority[a.source] || 0)
  );

  const desiredFields = ['TotalShots','ShotsOnTarget','Corners','ShotsInsideBox','ShotsOffTarget','DangerousAttacks','Attacks'];
  const missingFields = () => desiredFields.filter(f => !['home','away'].every(side => stats._present?.[side+f] === true));
  // Recheck available CORE stats as well: an already-populated field may be stale.
  // Never refresh optional-only sources solely for this verification.
  if (missingFields().length || orderedSources.some(m => m.id != null)) {

    for (const sourceMatch of orderedSources) {

      const clockA=Number(match.minute),clockB=Number(sourceMatch.minute);
      if(Number.isFinite(clockA)&&Number.isFinite(clockB)&&clockA>0&&clockB>0&&Math.abs(clockA-clockB)>3){
        console.log(`[STATS FRESHNESS] SKIP_DETAIL ${sourceMatch.source}:${sourceMatch.id} | minuteDelta=${Math.abs(clockA-clockB)}`);
        continue;
      }
      const outstanding=missingFields();
      const coreMissing=outstanding.some(f=>['TotalShots','ShotsOnTarget','Corners','ShotsInsideBox','ShotsOffTarget'].includes(f));
      const coreRefresh=true; // Verify present CORE fields too, not just missing fields.
      const nativeKey=`${sourceMatch.source}:${String(sourceMatch.id)}`;
      const optionalNegative=providerOptionalUnsupported.get(nativeKey);
      if(!coreMissing && !coreRefresh && optionalNegative && Date.now()-optionalNegative<OPTIONAL_RECHECK_MS){
        console.log(`[API CAPABILITY] SKIP_OPTIONAL ${nativeKey} | cached missing ATT/DA`);
        httpMetrics.cacheHits++;
        continue;
      }
      // Refresh successful provider snapshots after 30s without touching in-flight
      // requests or negative-cache behavior. FlashScore has a separate inner cache.
      const providerHit=providerStatsRequests.get(nativeKey);
      if(providerHit && !providerHit.promise && !providerHit.empty && Date.now()-providerHit.time >= LIVE_STATS_MAX_AGE_MS) providerStatsRequests.delete(nativeKey);
      if(sourceMatch.source === 'flashscore') {
        const flashHit=flashScoreStatsCache.get(String(sourceMatch.id));
        if(flashHit && Date.now()-flashHit.time >= LIVE_STATS_MAX_AGE_MS) flashScoreStatsCache.delete(String(sourceMatch.id));
      }
      httpMetrics.fallbackCalls++;
      const extraStats =
        await fetchStatsForSourceMatch(sourceMatch);
      if(!coreMissing && !['Attacks','DangerousAttacks'].some(f=>['home','away'].every(side=>extraStats?._present?.[side+f]===true))){
        providerOptionalUnsupported.set(nativeKey,Date.now());
      } else if (coreMissing && getCoreStatsCoverage(extraStats)>0){providerOptionalUnsupported.delete(nativeKey);}


      const before = missingFields();
      mergeMissingStats(stats, extraStats, {minute:sourceMatch.minute, priority:10 + (sourcePriority[sourceMatch.source] || 0), source:sourceMatch.source});
      const supplied = before.filter(f => !missingFields().includes(f));
      console.log(`[DETAIL RESULT] ${sourceMatch.source}:${sourceMatch.id} | supplied=${supplied.join(',') || 'NONE'} | rawHasData=${!!extraStats?.hasData} | missing=${missingFields().join(',') || 'none'}`);
      console.log(`[DA/ATT SOURCE] ${sourceMatch.source}:${sourceMatch.id} | DA=${stats._present?.homeDangerousAttacks && stats._present?.awayDangerousAttacks ? `${stats.homeDangerousAttacks}-${stats.awayDangerousAttacks}` : 'MISSING'} | ATT=${stats._present?.homeAttacks && stats._present?.awayAttacks ? `${stats.homeAttacks}-${stats.awayAttacks}` : 'MISSING'}`);
      console.log(`[STATS FALLBACK] ${match.homeName} vs ${match.awayName} | ${sourceMatch.source}:${sourceMatch.id} | core=${getCoreStatsCoverage(stats)}/5 | missing=${missingFields().join(',') || 'none'}`);
    }
  }



  // BƯỚC 3: Total Shots fallback như logic cũ.
  if (!stats._present?.homeTotalShots && stats.homeTotalShots <= 0) {
    stats.homeTotalShots =
      stats.homeShotsOnTarget +
      stats.homeShotsOffTarget +
      stats.homeBlockedShots;
  }

  if (!stats._present?.awayTotalShots && stats.awayTotalShots <= 0) {
    stats.awayTotalShots =
      stats.awayShotsOnTarget +
      stats.awayShotsOffTarget +
      stats.awayBlockedShots;
  }


  // Possession fallback như logic cũ.
  if (
    stats.homePossession > 0 &&
    stats.awayPossession <= 0
  ) {
    stats.awayPossession = Math.max(
      0,
      100 - stats.homePossession
    );
  }

  if (
    stats.awayPossession > 0 &&
    stats.homePossession <= 0
  ) {
    stats.homePossession = Math.max(
      0,
      100 - stats.awayPossession
    );
  }


  console.log(`[STATS MISSING] ${match.homeName} vs ${match.awayName} | ${missingFields().join(',') || 'none'} | matched=${sourceMatches.map(x => x.source+':'+x.id).join(',')} | fieldSources=${JSON.stringify(stats._fieldSources || {})}`);
  console.log(`[Stats 3 nguồn] ${match.homeName} vs ${match.awayName} | ${sourceMatches.map(x => x.source).join(' + ')} | ${getCoreStatsCoverage(stats)}/5 | SH=${stats.homeTotalShots}-${stats.awayTotalShots} SOT=${stats.homeShotsOnTarget}-${stats.awayShotsOnTarget} COR=${stats.homeCorners}-${stats.awayCorners} BOX=${stats.homeShotsInsideBox}-${stats.awayShotsInsideBox} OFF=${stats.homeShotsOffTarget}-${stats.awayShotsOffTarget}`);

  stats.source =
    `cross-source-${getCoreStatsCoverage(stats)}/5`;

  statsCache.set(
    cacheKey,
    {
      time: Date.now(),
      data: stats
    }
  );

  return stats;
  })();
  crossStatsInFlight.set(cacheKey, resolvePromise);
  try {
    return await resolvePromise;
  } finally {
    if (crossStatsInFlight.get(cacheKey) === resolvePromise) crossStatsInFlight.delete(cacheKey);
  }
}


// ==========================================================
// 14. TOTAL HELPERS
// ==========================================================

function calculateTotals(
  stats
) {

  return {

    totalAttacks:

      stats.homeAttacks +
      stats.awayAttacks,


    totalDangerousAttacks:

      stats.homeDangerousAttacks +
      stats.awayDangerousAttacks,


    totalShotsOnTarget:

      stats.homeShotsOnTarget +
      stats.awayShotsOnTarget,


    totalShots:

      stats.homeTotalShots +
      stats.awayTotalShots,


    totalBlockedShots:

      stats.homeBlockedShots +
      stats.awayBlockedShots,


    totalCorners:

      stats.homeCorners +
      stats.awayCorners,


    totalYellowCards:

      stats.homeYellowCards +
      stats.awayYellowCards,


    totalRedCards:

      stats.homeRedCards +
      stats.awayRedCards

  };
}


// ==========================================================
// 15. TEAM PRESSURE SCORE
//
// Dùng để:
// - nhận biết đội ép sân
// - dự đoán đội có khả năng ghi bàn
// - dự đoán tỷ số FT
//
// Không phải AI probability.
// ==========================================================

function calculateTeamPressure(
  stats
) {

  let home = 0;
  let away = 0;


  // Dangerous Attack
  home +=
    stats.homeDangerousAttacks *
    0.28;

  away +=
    stats.awayDangerousAttacks *
    0.28;


  // Attack
  home +=
    stats.homeAttacks *
    0.08;

  away +=
    stats.awayAttacks *
    0.08;


  // SOT
  home +=
    stats.homeShotsOnTarget *
    4.2;

  away +=
    stats.awayShotsOnTarget *
    4.2;


  // Blocked
  home +=
    stats.homeBlockedShots *
    2.0;

  away +=
    stats.awayBlockedShots *
    2.0;


  // Total shots
  home +=
    stats.homeTotalShots *
    0.6;

  away +=
    stats.awayTotalShots *
    0.6;


  // Corners
  home +=
    stats.homeCorners *
    1.5;

  away +=
    stats.awayCorners *
    1.5;


  // Possession
  if (
    stats.homePossession > 0
  ) {

    home +=
      stats.homePossession *
      0.05;
  }


  if (
    stats.awayPossession > 0
  ) {

    away +=
      stats.awayPossession *
      0.05;
  }


  // Big chances nếu API có
  home +=
    stats.homeBigChances *
    4;

  away +=
    stats.awayBigChances *
    4;


  return {

    home:
      Number(
        home.toFixed(2)
      ),

    away:
      Number(
        away.toFixed(2)
      ),

    difference:
      Number(
        Math.abs(
          home - away
        ).toFixed(2)
      )

  };
}


// ==========================================================
// 16. MATCH STYLE
//
// Nhận diện:
// - Đôi công
// - Home ép sân
// - Away ép sân
// - Cân bằng
// - Nhịp thấp
// ==========================================================

function detectMatchStyle(
  stats
) {

  const pressure =
    calculateTeamPressure(
      stats
    );


  const totals =
    calculateTotals(
      stats
    );


  const homeActive =

    stats.homeDangerousAttacks >= 20 ||

    stats.homeShotsOnTarget >= 2 ||

    stats.homeCorners >= 3;


  const awayActive =

    stats.awayDangerousAttacks >= 20 ||

    stats.awayShotsOnTarget >= 2 ||

    stats.awayCorners >= 3;


  // ------------------------------------------
  // ĐÔI CÔNG
  // ------------------------------------------

  if (
    homeActive &&
    awayActive &&
    pressure.difference <= 15 &&
    totals.totalShotsOnTarget >= 5
  ) {

    return {

      type:
        'END_TO_END',

      text:
        '⚔️ ĐÔI CÔNG',

      score: 90
    };
  }


  // ------------------------------------------
  // HOME ÉP SÂN
  // ------------------------------------------

  if (
    pressure.home >
      pressure.away * 1.35 &&
    pressure.difference >= 10
  ) {

    return {

      type:
        'HOME_PRESSURE',

      text:
        '🔥 CHỦ NHÀ ÉP SÂN',

      score: 82
    };
  }


  // ------------------------------------------
  // AWAY ÉP SÂN
  // ------------------------------------------

  if (
    pressure.away >
      pressure.home * 1.35 &&
    pressure.difference >= 10
  ) {

    return {

      type:
        'AWAY_PRESSURE',

      text:
        '🔥 ĐỘI KHÁCH ÉP SÂN',

      score: 82
    };
  }


  // ------------------------------------------
  // CÂN BẰNG NHƯNG CÓ TẤN CÔNG
  // ------------------------------------------

  if (
    totals.totalShotsOnTarget >= 4 ||
    totals.totalDangerousAttacks >= 50
  ) {

    return {

      type:
        'BALANCED_ACTIVE',

      text:
        '⚡ THẾ TRẬN CÂN BẰNG - CÓ TẤN CÔNG',

      score: 65
    };
  }


  return {

    type:
      'LOW_TEMPO',

    text:
      '🐢 NHỊP TRẬN THẤP',

    score: 35
  };
}


// ==========================================================
// 17. FORMAT STATISTICS FOR TELEGRAM
// ==========================================================

function formatStatsText(
  stats
) {

  const style =
    detectMatchStyle(
      stats
    );

  const pressure =
    calculateTeamPressure(
      stats
    );

  const pressureTotal =
    pressure.home +
    pressure.away;

  const homePressureShare =
    pressureTotal > 0
      ? round1(
          pressure.home /
          pressureTotal *
          100
        )
      : 50;

  const awayPressureShare =
    round1(
      100 -
      homePressureShare
    );

  const bigChanceText =
    (
      stats.homeBigChances > 0 ||
      stats.awayBigChances > 0
    )
      ? ` | Big Chance ${stats.homeBigChances}-${stats.awayBigChances}`
      : '';

  return [
    `📊 LIVE: Attack ${stats.homeAttacks}-${stats.awayAttacks} | Danger ${stats.homeDangerousAttacks}-${stats.awayDangerousAttacks} | Poss ${stats.homePossession}%-${stats.awayPossession}%`,
    `🎯 SÚT: Shots ${stats.homeTotalShots}-${stats.awayTotalShots} | SOT ${stats.homeShotsOnTarget}-${stats.awayShotsOnTarget} | Off ${stats.homeShotsOffTarget}-${stats.awayShotsOffTarget}`,
    `🚩 KHÁC: Corner ${stats.homeCorners}-${stats.awayCorners}${bigChanceText}`,
    `🔥 THẾ TRẬN: ${style.text} | Pressure ${homePressureShare}%-${awayPressureShare}%`
  ].join('\n');
}

// ==========================================================
// 18. MATH HELPERS
// ==========================================================

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function round1(value) {
  return Math.round(value * 10) / 10;
}


// ==========================================================
// 19. MOMENTUM SNAPSHOT
//
// Mỗi vòng scan lưu lại statistics.
// Lần scan tiếp theo tính phần tăng:
//
// Attack
// Dangerous Attack
// SOT
// Blocked
// Corners
//
// ==========================================================

function createSnapshot(stats, minute) {

  return {
    minute,

    time: Date.now(),

    homeAttacks:
      stats.homeAttacks,

    awayAttacks:
      stats.awayAttacks,

    homeDangerousAttacks:
      stats.homeDangerousAttacks,

    awayDangerousAttacks:
      stats.awayDangerousAttacks,

    homeShotsOnTarget:
      stats.homeShotsOnTarget,

    awayShotsOnTarget:
      stats.awayShotsOnTarget,

    homeBlockedShots:
      stats.homeBlockedShots,

    awayBlockedShots:
      stats.awayBlockedShots,

    homeCorners:
      stats.homeCorners,

    awayCorners:
      stats.awayCorners,
    homeTotalShots: stats.homeTotalShots, awayTotalShots: stats.awayTotalShots,
    homeBigChances:stats.homeBigChances, awayBigChances:stats.awayBigChances,
    homeRedCards: stats.homeRedCards, awayRedCards: stats.awayRedCards,
    _present: {...(stats._present || {})}
  };
}


// ==========================================================
// CALCULATE MOMENTUM
// ==========================================================

function calculateMomentum(
  matchId,
  stats,
  minute
) {

  const current =
    createSnapshot(
      stats,
      minute
    );


  const previous =
    snapshotState.get(
      matchId
    );


  // Keep the last valid snapshot if a provider returns partial/reset counters.
  const momentumKeys = ['Attacks','DangerousAttacks','ShotsOnTarget','Corners'];
  const currentValid = momentumKeys.every(f => ['home','away'].every(side => current._present?.[side+f]));
  const previousValid = !previous || momentumKeys.every(f => ['home','away'].every(side => previous._present?.[side+f]));
  const monotonic = !previous || momentumKeys.every(f => ['home','away'].every(side =>
    Number(current[side+f]) >= Number(previous[side+f])));
  if (currentValid && (!previous || (previousValid && monotonic && minute > previous.minute))) {
    snapshotState.set(matchId,{...current,updatedAt:Date.now()});
  }
  if (!currentValid || !previousValid || !monotonic) {
    return {available:false,minuteGap:0,score:50,text:'Momentum thiếu dữ liệu hợp lệ',
      totalAttack:0,totalDangerous:0,totalSOT:0,totalBlocked:0,totalCorners:0};
  }


  // Chưa có snapshot trước
  if (!previous) {

    return {
      available: false,

      minuteGap: 0,

      homeAttack: 0,
      awayAttack: 0,

      homeDangerous: 0,
      awayDangerous: 0,

      homeSOT: 0,
      awaySOT: 0,

      homeBlocked: 0,
      awayBlocked: 0,

      homeCorners: 0,
      awayCorners: 0,

      totalAttack: 0,
      totalDangerous: 0,
      totalSOT: 0,
      totalBlocked: 0,
      totalCorners: 0,

      homePressure: 0,
      awayPressure: 0,

      score: 50,

      text:
        '⏳ Đang thu thập Momentum'
    };
  }


  const minuteGap =
    minute -
    safeNumber(
      previous.minute
    );


  // Snapshot lỗi / trận nhảy phút ngược
  if (
    minuteGap <= 0 ||
    minuteGap > 20
  ) {

    return {
      available: false,

      minuteGap,

      homeAttack: 0,
      awayAttack: 0,

      homeDangerous: 0,
      awayDangerous: 0,

      homeSOT: 0,
      awaySOT: 0,

      homeBlocked: 0,
      awayBlocked: 0,

      homeCorners: 0,
      awayCorners: 0,

      totalAttack: 0,
      totalDangerous: 0,
      totalSOT: 0,
      totalBlocked: 0,
      totalCorners: 0,

      homePressure: 0,
      awayPressure: 0,

      score: 50,

      text:
        '⏳ Momentum chưa đủ dữ liệu'
    };
  }


  function delta(currentValue, oldValue) {

    return Math.max(
      0,
      safeNumber(currentValue) -
      safeNumber(oldValue)
    );
  }


  const homeAttack =
    delta(
      current.homeAttacks,
      previous.homeAttacks
    );

  const awayAttack =
    delta(
      current.awayAttacks,
      previous.awayAttacks
    );


  const homeDangerous =
    delta(
      current.homeDangerousAttacks,
      previous.homeDangerousAttacks
    );

  const awayDangerous =
    delta(
      current.awayDangerousAttacks,
      previous.awayDangerousAttacks
    );


  const homeSOT =
    delta(
      current.homeShotsOnTarget,
      previous.homeShotsOnTarget
    );

  const awaySOT =
    delta(
      current.awayShotsOnTarget,
      previous.awayShotsOnTarget
    );


  const homeBlocked =
    delta(
      current.homeBlockedShots,
      previous.homeBlockedShots
    );

  const awayBlocked =
    delta(
      current.awayBlockedShots,
      previous.awayBlockedShots
    );


  const homeCorners =
    delta(
      current.homeCorners,
      previous.homeCorners
    );

  const awayCorners =
    delta(
      current.awayCorners,
      previous.awayCorners
    );


  const totalAttack =
    homeAttack +
    awayAttack;

  const totalDangerous =
    homeDangerous +
    awayDangerous;

  const totalSOT =
    homeSOT +
    awaySOT;

  const totalBlocked =
    homeBlocked +
    awayBlocked;

  const totalCorners =
    homeCorners +
    awayCorners;


  // Chuẩn hóa về 10 phút
  const factor =
    10 /
    Math.max(
      minuteGap,
      1
    );


  const attack10 =
    totalAttack *
    factor;

  const dangerous10 =
    totalDangerous *
    factor;

  const sot10 =
    totalSOT *
    factor;

  const blocked10 =
    totalBlocked *
    factor;

  const corners10 =
    totalCorners *
    factor;


  // ======================================================
  // MOMENTUM SCORE 0-100
  // ======================================================

  let score = 20;


  // Attack
  if (attack10 >= 35) {
    score += 18;
  } else if (attack10 >= 25) {
    score += 14;
  } else if (attack10 >= 15) {
    score += 9;
  } else if (attack10 >= 8) {
    score += 4;
  }


  // Dangerous Attack
  if (dangerous10 >= 20) {
    score += 28;
  } else if (dangerous10 >= 14) {
    score += 22;
  } else if (dangerous10 >= 9) {
    score += 15;
  } else if (dangerous10 >= 5) {
    score += 8;
  }


  // SOT
  if (sot10 >= 4) {
    score += 25;
  } else if (sot10 >= 3) {
    score += 20;
  } else if (sot10 >= 2) {
    score += 14;
  } else if (sot10 >= 1) {
    score += 7;
  }



  // Corners
  if (corners10 >= 4) {
    score += 10;
  } else if (corners10 >= 2) {
    score += 6;
  } else if (corners10 >= 1) {
    score += 3;
  }


  score =
    clamp(
      score,
      0,
      100
    );


  // ======================================================
  // MOMENTUM HOME/AWAY
  // ======================================================

  const homePressure =

    homeAttack * 0.10 +

    homeDangerous * 0.35 +

    homeSOT * 5 +

    homeCorners * 1.8;


  const awayPressure =

    awayAttack * 0.10 +

    awayDangerous * 0.35 +

    awaySOT * 5 +

    awayCorners * 1.8;


  let text =
    '⚡ Momentum trung bình';


  if (score >= 85) {

    text =
      '🔥🔥 MOMENTUM CỰC MẠNH';

  } else if (score >= 75) {

    text =
      '🔥 MOMENTUM RẤT MẠNH';

  } else if (score >= 65) {

    text =
      '⚡ MOMENTUM MẠNH';

  } else if (score < 40) {

    text =
      '🐢 Momentum thấp';
  }


  return {

    available: true,

    minuteGap,

    homeAttack,
    awayAttack,

    homeDangerous,
    awayDangerous,

    homeSOT,
    awaySOT,

    homeBlocked,
    awayBlocked,

    homeCorners,
    awayCorners,

    totalAttack,
    totalDangerous,
    totalSOT,
    totalBlocked,
    totalCorners,

    attack10:
      round1(attack10),

    dangerous10:
      round1(
        dangerous10
      ),

    sot10:
      round1(sot10),

    blocked10:
      round1(
        blocked10
      ),

    corners10:
      round1(
        corners10
      ),

    homePressure:
      round1(
        homePressure
      ),

    awayPressure:
      round1(
        awayPressure
      ),

    score:
      round1(score),

    text
  };
}


// ==========================================================
// 20. FORMAT MOMENTUM TELEGRAM
// ==========================================================

function formatMomentumText(
  momentum
) {

  if (
    !momentum ||
    !momentum.available
  ) {

    return (
      momentum?.text ||
      '⏳ Đang thu thập Momentum'
    );
  }


  return [
    `⚡ ${momentum.minuteGap} PHÚT GẦN NHẤT:`,
    `🚀 Attack: +${momentum.homeAttack} - +${momentum.awayAttack}`,
    `🔥 Dangerous: +${momentum.homeDangerous} - +${momentum.awayDangerous}`,
    `🎯 SOT: +${momentum.homeSOT} - +${momentum.awaySOT}`,
    `🚩 Corners: +${momentum.homeCorners} - +${momentum.awayCorners}`,
    '',
    `${momentum.text} (${momentum.score}%)`
  ].join('\n');
}


// ==========================================================
// 21. ODDS CACHE
// ==========================================================

let oddsCache = {
  time: 0,
  data: []
};

const ODDS_CACHE_TTL =
  2 * 60 * 1000;


// ==========================================================
// NORMALIZE TEAM NAME
// ==========================================================

function cleanTeamName(name) {

  return String(name || '')

    .normalize('NFD')

    .replace(
      /[\u0300-\u036f]/g,
      ''
    )

    .toLowerCase()

    .replace(
      /\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk|fk)\b/g,
      ''
    )

    .replace(
      /[^a-z0-9]/g,
      ''
    )

    .trim();
}


// ==========================================================
// CREATE MATCH KEY
// ==========================================================

function createMatchKey(
  homeName,
  awayName
) {

  return (
    `${cleanTeamName(homeName)}_` +
    `${cleanTeamName(awayName)}`
  );
}


// ==========================================================
// SIMPLE TEAM MATCH
// ==========================================================

function teamNamesSimilar(
  a,
  b
) {

  const x =
    cleanTeamName(a);

  const y =
    cleanTeamName(b);


  if (
    !x ||
    !y
  ) {
    return false;
  }


  if (x === y) {
    return true;
  }


  if (
    x.includes(y) ||
    y.includes(x)
  ) {

    return true;
  }


  return false;
}


// ==========================================================
// 22. FETCH ODDS
// ==========================================================

async function fetchAllLiveOdds() {
  if (!ODDS_API_KEY) {
    console.log('[Odds API] ODDS_API_KEY missing; odds unavailable');
    return [];
  }
  if (Date.now() - oddsCache.time < ODDS_CACHE_TTL) return oddsCache.data;
  const config = { timeout: 12000, params: { apiKey: ODDS_API_KEY } };
  let keys = ODDS_SPORT_KEYS;
  if (!keys.length) {
    if (Date.now() - oddsSportsCache.time < 6 * 60 * 60 * 1000) {
      keys = oddsSportsCache.keys;
    } else {
      try {
        const r = await axios.get(`${ODDS_BASE_URL}/sports/`, { ...config, params: { ...config.params, all: false } });
        keys = (Array.isArray(r.data) ? r.data : [])
          .filter(x => x.active && String(x.key || '').startsWith('soccer_'))
          .map(x => x.key);
        oddsSportsCache = {time: Date.now(), keys};
        console.log(`[Odds API] Active soccer sport keys: ${keys.length}`);
      } catch (e) {
        console.log(`[Odds API] Sports discovery error HTTP ${e.response?.status || 'network'}: ${String(e.response?.data?.message || e.message).slice(0, 180)}`);
        return [];
      }
    }
  }
  // Keep the request budget bounded. Set ODDS_SPORT_KEYS for leagues you need.
  const nowOdds=Date.now();
  const selected = keys.filter(key => (oddsSportFailures.get(key)?.until||0) <= nowOdds).slice(0, ODDS_MAX_SPORTS);
  const skipped=keys.filter(key => (oddsSportFailures.get(key)?.until||0)>nowOdds).length;
  if(skipped) console.log(`[Odds API] cachedFailedSports=${skipped}`);
  const results = await Promise.allSettled(selected.map(async key => {
    const r = await axios.get(`${ODDS_BASE_URL}/sports/${encodeURIComponent(key)}/odds/`, {
      timeout: 12000,
      params: {apiKey: ODDS_API_KEY, regions: ODDS_REGION, markets: 'totals', oddsFormat: 'decimal'}
    });
    return {key, events: Array.isArray(r.data) ? r.data : []};
  }));
  const data = [];
  let ok = 0, failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {ok++; oddsSportFailures.delete(selected[i]); data.push(...r.value.events);}
    else {
      failed++;
      const e = r.reason;
      const status=Number(e.response?.status||0);
      const wait=status===429?15*60*1000:[400,401,403,404,422].includes(status)?60*60*1000:3*60*1000;
      oddsSportFailures.set(selected[i],{until:Date.now()+wait,status});
      console.log(`[Odds API] ${selected[i]} HTTP ${e.response?.status || 'network'}: ${String(e.response?.data?.message || e.message).slice(0, 140)}`);
    }
  });
  console.log(`[Odds API] ${ok}/${selected.length} sports OK | ${data.length} odds events | ${failed} errors`);
  // Don't hammer the service if the response is empty or unsupported.
  oddsCache = {time: Date.now(), data};
  return data;
}

// ==========================================================
// 23. FIND ODDS FOR MATCH
// ==========================================================

function findMatchOdds(
  allOdds,
  homeName,
  awayName,
  homeScore,
  awayScore
) {

  if (
    !Array.isArray(allOdds) ||
    !allOdds.length
  ) {

    return {
      found: false,
      score: 50,
      oddsBonus: 0,
      text:
        '💰 Không có dữ liệu kèo'
    };
  }


  const event =
    allOdds.find(
      x => {

        const normal =

          teamNamesSimilar(
            x.home_team,
            homeName
          ) &&

          teamNamesSimilar(
            x.away_team,
            awayName
          );


        const reverse =

          teamNamesSimilar(
            x.home_team,
            awayName
          ) &&

          teamNamesSimilar(
            x.away_team,
            homeName
          );


        return (
          normal ||
          reverse
        );
      }
    );


  if (!event) {

    return {
      found: false,
      score: 50,
      oddsBonus: 0,
      text:
        '💰 Không tìm thấy kèo phù hợp'
    };
  }


  const currentGoals =
    safeNumber(homeScore) +
    safeNumber(awayScore);


  const overSelections = [];


  for (
    const bookmaker of
    event.bookmakers || []
  ) {

    for (
      const market of
      bookmaker.markets || []
    ) {

      if (
        market.key !== 'totals'
      ) {
        continue;
      }


      for (
        const outcome of
        market.outcomes || []
      ) {

        if (
          String(
            outcome.name
          ).toLowerCase() !==
          'over'
        ) {
          continue;
        }


        const point =
          safeNumber(
            outcome.point
          );


        const price =
          safeNumber(
            outcome.price
          );


        if (
          point > 0 &&
          price > 1
        ) {

          overSelections.push({
            bookmaker:
              bookmaker.title ||
              bookmaker.key ||
              'Bookmaker',

            point,

            price
          });
        }
      }
    }
  }


  if (
    !overSelections.length
  ) {

    return {
      found: true,
      score: 50,
      oddsBonus: 0,
      text:
        '💰 Có trận nhưng không có kèo Over'
    };
  }


  // Tìm line Over gần số bàn hiện tại nhất
  // nhưng vẫn cần thêm bàn để thắng/ăn một phần.
  let candidates =
    overSelections
      .filter(
        x =>
          x.point >
          currentGoals
      );


  if (
    !candidates.length
  ) {

    candidates =
      overSelections;
  }


  candidates.sort(
    (a, b) =>
      Math.abs(
        a.point -
        (currentGoals + 0.5)
      ) -
      Math.abs(
        b.point -
        (currentGoals + 0.5)
      )
  );


  const targetPoint =
    candidates[0].point;


  const sameLine =
    candidates.filter(
      x =>
        x.point ===
        targetPoint
    );


  const avgPrice =

    sameLine.reduce(
      (sum, x) =>
        sum +
        x.price,
      0
    ) /

    Math.max(
      sameLine.length,
      1
    );


  const goalsNeeded =
    targetPoint -
    currentGoals;


  // ======================================================
  // ODDS SCORE 0-100
  // Odds càng thấp => thị trường càng nghiêng Over
  // ======================================================

  let score = 50;


  if (
    avgPrice <= 1.30
  ) {

    score = 95;

  } else if (
    avgPrice <= 1.40
  ) {

    score = 90;

  } else if (
    avgPrice <= 1.50
  ) {

    score = 84;

  } else if (
    avgPrice <= 1.60
  ) {

    score = 78;

  } else if (
    avgPrice <= 1.70
  ) {

    score = 72;

  } else if (
    avgPrice <= 1.85
  ) {

    score = 64;

  } else if (
    avgPrice <= 2.00
  ) {

    score = 56;

  } else if (
    avgPrice <= 2.20
  ) {

    score = 48;

  } else {

    score = 40;
  }


  // Line chỉ cần thêm khoảng 0.5-0.75 bàn
  if (
    goalsNeeded > 0 &&
    goalsNeeded <= 0.75
  ) {

    score += 5;
  }


  score =
    clamp(
      score,
      0,
      100
    );


  // Chỉ để tương thích code cũ
  const oddsBonus =
    clamp(
      (score - 50) *
      0.24,
      -5,
      12
    );


  return {

    found: true,

    point:
      targetPoint,

    price:
      round1(
        avgPrice * 100
      ) / 100,

    currentGoals,

    goalsNeeded:
      round1(
        goalsNeeded
      ),

    score:
      round1(score),

    oddsBonus:
      round1(
        oddsBonus
      ),

    text:
      `💰 Over ${targetPoint} @ ${avgPrice.toFixed(2)} | Odds Score: ${round1(score)}%`
  };
}


// ==========================================================
// 24. SUB SCORE: ATTACK
// ==========================================================

function calculateAttackScore(
  stats,
  minute
) {

  const total =
    stats.homeAttacks +
    stats.awayAttacks;


  if (total <= 0) {
    return 50;
  }


  const rate =
    total /
    Math.max(
      minute,
      1
    );


  let score = 25;


  if (rate >= 2.8) {
    score = 95;
  } else if (rate >= 2.4) {
    score = 88;
  } else if (rate >= 2.0) {
    score = 80;
  } else if (rate >= 1.7) {
    score = 70;
  } else if (rate >= 1.4) {
    score = 60;
  } else if (rate >= 1.1) {
    score = 50;
  } else {
    score = 35;
  }


  return score;
}


// ==========================================================
// 25. SUB SCORE: DANGEROUS ATTACK
// ==========================================================

function calculateDangerousAttackScore(
  stats,
  minute
) {

  const total =

    stats.homeDangerousAttacks +
    stats.awayDangerousAttacks;


  if (total <= 0) {
    return 50;
  }


  const rate =
    total /
    Math.max(
      minute,
      1
    );


  if (rate >= 1.8) {
    return 98;
  }

  if (rate >= 1.5) {
    return 92;
  }

  if (rate >= 1.25) {
    return 85;
  }

  if (rate >= 1.0) {
    return 76;
  }

  if (rate >= 0.75) {
    return 65;
  }

  if (rate >= 0.55) {
    return 55;
  }


  return 38;
}


// ==========================================================
// 26. SUB SCORE: SOT
// ==========================================================

function calculateSOTScore(
  stats,
  minute
) {

  const total =

    stats.homeShotsOnTarget +
    stats.awayShotsOnTarget;


  if (total >= 12) {
    return 98;
  }

  if (total >= 10) {
    return 94;
  }

  if (total >= 8) {
    return 88;
  }

  if (total >= 6) {
    return 78;
  }

  if (total >= 5) {
    return 70;
  }

  if (total >= 4) {
    return 62;
  }

  if (total >= 3) {
    return 52;
  }

  if (total >= 2) {
    return 42;
  }


  // Sau phút 70 mà <=1 SOT
  // là tín hiệu xấu
  if (
    minute >= 70 &&
    total <= 1
  ) {
    return 20;
  }


  return 30;
}


// ==========================================================
// 27. SUB SCORE: BLOCKED SHOTS
// ==========================================================

function calculateBlockedScore(
  stats
) {

  const total =

    stats.homeBlockedShots +
    stats.awayBlockedShots;


  if (total >= 10) {
    return 95;
  }

  if (total >= 8) {
    return 88;
  }

  if (total >= 6) {
    return 78;
  }

  if (total >= 4) {
    return 67;
  }

  if (total >= 2) {
    return 55;
  }

  if (total >= 1) {
    return 45;
  }


  return 35;
}


// ==========================================================
// 28. SUB SCORE: CORNERS
// ==========================================================

function calculateCornerScore(
  stats
) {

  const total =

    stats.homeCorners +
    stats.awayCorners;


  if (total >= 14) {
    return 98;
  }

  if (total >= 11) {
    return 90;
  }

  if (total >= 9) {
    return 82;
  }

  if (total >= 7) {
    return 72;
  }

  if (total >= 5) {
    return 62;
  }

  if (total >= 3) {
    return 52;
  }


  return 38;
}


// ==========================================================
// 29. SUB SCORE: POSSESSION / PRESSURE
//
// Possession một mình không đủ.
// Kết hợp với SOT / Dangerous / Corners.
// ==========================================================

function calculatePossessionPressureScore(
  stats
) {

  const homePoss =
    stats.homePossession;

  const awayPoss =
    stats.awayPossession;


  if (
    homePoss <= 0 &&
    awayPoss <= 0
  ) {

    return 50;
  }


  const possessionDiff =
    Math.abs(
      homePoss -
      awayPoss
    );


  const pressure =
    calculateTeamPressure(
      stats
    );


  let score = 50;


  // Ép sân rõ ràng
  if (
    possessionDiff >= 25 &&
    pressure.difference >= 18
  ) {

    score = 90;

  } else if (
    possessionDiff >= 18 &&
    pressure.difference >= 12
  ) {

    score = 82;

  } else if (
    possessionDiff >= 10 &&
    pressure.difference >= 8
  ) {

    score = 72;

  } else if (
    pressure.difference >= 15
  ) {

    score = 75;

  } else {

    // Possession cân bằng
    // có thể là đôi công
    score = 60;
  }


  return score;
}


// ==========================================================
// 30. SUB SCORE: CARDS
// ==========================================================

function calculateCardScore(
  stats
) {

  const yellow =

    stats.homeYellowCards +
    stats.awayYellowCards;


  const red =

    stats.homeRedCards +
    stats.awayRedCards;


  let score = 45;


  if (yellow >= 7) {
    score += 12;
  } else if (yellow >= 5) {
    score += 8;
  } else if (yellow >= 3) {
    score += 4;
  }


  if (red >= 1) {
    score += 20;
  }


  if (red >= 2) {
    score += 8;
  }


  return clamp(
    score,
    0,
    90
  );
}


// ==========================================================
// 31. SUB SCORE: END TO END / PRESSURE
// ==========================================================

function calculateMatchStyleScore(
  stats
) {

  const style =
    detectMatchStyle(
      stats
    );


  return {
    score:
      style.score,

    type:
      style.type,

    text:
      style.text
  };
}


// ==========================================================
// 32. SCORE STATE
//
// Tỷ số ảnh hưởng động lực.
//
// Hòa / cách biệt 1 bàn:
// hai đội thường còn động lực.
//
// Cách biệt quá lớn:
// giảm nhẹ.
// ==========================================================

function calculateScoreStateScore(
  homeScore,
  awayScore,
  minute
) {

  const h =
    safeNumber(
      homeScore
    );

  const a =
    safeNumber(
      awayScore
    );


  const diff =
    Math.abs(
      h - a
    );


  let score = 60;


  if (diff === 0) {

    score = 80;

  } else if (diff === 1) {

    score = 85;

  } else if (diff === 2) {

    score = 62;

  } else {

    score = 42;
  }


  // Cuối trận + cách biệt 1
  // thường đội thua phải đẩy cao
  if (
    minute >= 75 &&
    diff === 1
  ) {

    score += 8;
  }


  return clamp(
    score,
    0,
    100
  );
}


// ==========================================================
// 33. TIME SCORE
//
// Đây không phải xác suất.
// Chỉ phản ánh giai đoạn trận đấu.
//
// ==========================================================

function calculateTimeScore(
  minute
) {

  if (
    minute >= 46 &&
    minute <= 54
  ) {
    return 52;
  }


  if (
    minute >= 55 &&
    minute <= 64
  ) {
    return 62;
  }


  if (
    minute >= 65 &&
    minute <= 74
  ) {
    return 75;
  }


  if (
    minute >= 75 &&
    minute <= 84
  ) {
    return 88;
  }


  if (
    minute >= 85 &&
    minute <= 89
  ) {
    return 82;
  }


  if (
    minute >= 90 &&
    minute <= 92
  ) {
    return 68;
  }


  return 50;
}


// ==========================================================
// 34. RULE AI ENGINE
//
// TRỌNG SỐ:
//
// Dangerous Attack      18%
// Momentum              16%
// SOT                   14%
// Đôi công / ép sân     11%
// Attack                10%
// Possession pressure    8%
// Blocked                6%
// Corners                6%
// Odds                   7%
// Cards                  2%
// Score state             1%
// Time                    1%
//
// TOTAL = 100%
//
// ==========================================================

// V3: sole Rule scoring engine; legacy V2 is not evaluated.
// Scores are heuristic signals, not calibrated probabilities.
function evaluateRuleV3(stats,momentum,minute,homeScore,awayScore,windows) {
  // Rule V3: only live match statistics. No minute, time remaining, score gap,
  // arbitrary uplift/penalty, or momentum modifier to the Rule score.
  const present=stats?._present||{};
  const pair=f=>{
    const h='home'+f,a='away'+f;
    if(present[h]!==true||present[a]!==true)return null;
    const x=Number(stats[h]),y=Number(stats[a]);
    return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0?[x,y]:null;
  };
  const sum=p=>p?p[0]+p[1]:null;
  const shots=pair('TotalShots'),sot=pair('ShotsOnTarget');
  const corners=pair('Corners'),chances=pair('BigChances');
  const inside=pair('ShotsInsideBox'),xg=pair('ExpectedGoals');
  const poss=pair('Possession'),red=pair('RedCards');
  const attacks=pair('Attacks');
  const groups=[shots,sot,corners,chances,inside,xg,poss,red].filter(Boolean).length;
  const missing=['TotalShots','ShotsOnTarget','Corners','BigChances','ShotsInsideBox','ExpectedGoals','Possession','RedCards','Attacks']
    .filter(f=>!['home','away'].every(side=>present[side+f]===true));
  const reliability={availableGroups:groups,totalGroups:8,coveragePercent:round1(groups/8*100),missing,
    label:groups>=6?'HIGH_COVERAGE':groups>=4?'PARTIAL_COVERAGE':'LOW_COVERAGE'};
  if(!shots&&!sot&&!corners&&!chances&&!inside&&!xg)
    return {efficiency:null,model:'rule-v3.5-independent-evidence-candidate',dataStatus:'INSUFFICIENT_CURRENT_STATS'};
  // Existing normalization retained: no invented scoring bonus, fixed uplift or
  // penalty. Reuse only measured quantities and normalize weights over present data.
  const soft=(value,reference)=>value===null?null:100*Math.max(0,value)/(Math.max(0,value)+reference*.48);
  const pace=(p,reference)=>p?soft(sum(p),reference):null;
  const weighted=items=>{
    const valid=items.filter(([v])=>v!==null&&Number.isFinite(v));
    const w=valid.reduce((n,[,weight])=>n+weight,0);
    return w?valid.reduce((n,[v,weight])=>n+v*weight,0)/w:null;
  };
  // Reject inconsistent SOT>shots or box shots>total shots rather than
  // treating contradictory provider data as quality evidence.
  const validShooting=!!(shots&&sot&&shots.every((n,i)=>sot[i]<=n));
  const validInside=!!(inside&&(!shots||shots.every((n,i)=>inside[i]<=n)));
  const sotRatio=validShooting&&sum(shots)>0?sum(sot)/sum(shots):null;
  const insideRatio=validInside&&shots&&sum(shots)>0?sum(inside)/sum(shots):null;
  const sotVolume=pace(sot,9);
  const shotVolume=pace(shots,23);
  const cornerVolume=pace(corners,11);
  const boxVolume=validInside?pace(inside,14):null;
  const chanceVolume=pace(chances,5);
  const xgVolume=pace(xg,3.1);
  // Independent evidence families: do not count the same SOT/box/chance
  // observation once in Pressure and again in Quality. Pressure is volume
  // and territory; Quality is the observed ability to threaten the goal.
  // Missing values are excluded, never silently treated as zero.
  const quality=weighted([[sotVolume,.38],[chanceVolume,.22],[xgVolume,.27],[boxVolume,.13]]);
  // Shots and corners are separate pressure observations. Possession alone
  // cannot create pressure, and is assessed separately below.
  const pressure=weighted([[shotVolume,.75],[cornerVolume,.25]]);
  // Tempo is a diagnostic derived from live counts; it is not a second score
  // or a match-time factor, and is not multiplied into Rule.
  const tempo=weighted([[shotVolume,.35],[sotVolume,.50],[cornerVolume,.15]]);
  const tempoEvidence='CUMULATIVE_STAT_SIGNAL';
  const tempoLevel=tempo===null?'UNKNOWN':tempo>=75?'HIGH':tempo>=48?'MEDIUM':'LOW';
  // Possession by itself does not demonstrate a scoring chance. Only count
  // measured territorial control when paired with observed attacking activity.
  const hasAttackingEvidence=!!(shots||sot||corners||inside||chances||xg);
  const possessionBalance=poss&&hasAttackingEvidence?Math.min(75,50+Math.abs(poss[0]-poss[1])*.35):null;
  const core=weighted([[pressure,.57],[quality,.40],[possessionBalance,.03]]);
  if(core===null)return {efficiency:null,model:'rule-v3.5-independent-evidence-candidate',dataStatus:'INSUFFICIENT_CURRENT_STATS'};
  const redFactor=1,evidenceFactor=1,qualityFactor=1,recentEvidenceFactor=1;
  const momentumVerified=false,momentumScore=null,momentumContribution=0;
  const candidateProbability=ruleV4.predict(stats);
  const efficiency=candidateProbability===null?round1(clamp(core,0,95)):candidateProbability;
  return {efficiency,model:candidateProbability===null?'rule-v3.5-independent-evidence-candidate':'rule-v4-validated-logistic',dataStatus:'OK',v3Components:{
    pressure:pressure===null?null:round1(pressure),quality:quality===null?null:round1(quality),
    tempo:tempo===null?null:round1(tempo),tempoLevel,tempoEvidence,tempoMethod:'CUMULATIVE_COUNTS_ONLY',
    redFactor,availableGroups:groups,
    reliability,evidenceFactor,qualityFactor,recentEvidenceFactor,momentumVerified,momentumScore,momentumContribution,
    shotAccuracyPercent:sotRatio===null?null:round1(sotRatio*100),
    boxShotPercent:insideRatio===null?null:round1(insideRatio*100),
    pressureMethod:'INDEPENDENT_SHOTS_CORNERS',
    qualityMethod:'SOT_VOLUME_BIG_CHANCES_XG_BOX',
    modelVersion:candidateProbability===null?'V3_5_INDEPENDENT_EVIDENCE_CANDIDATE':'V4_VALIDATED_LOGISTIC'
  }};
}
// Frozen reference: V3 before Advanced upgrade (LIVE FIX version).
// Comparison only; never used for Telegram or BIG BET decisions.

// Display-only diagnostics: never used to gate alerts.
function formatV3Advanced(ai, stats, minute) {
  const c=ai?.v3Components;
  if (!c) return 'V3 ADVANCED: N/A (insufficient current stats)';
  const fmt=x=>x==null?'N/A':Number(x).toFixed(1);
  const available=(field)=>['home','away'].every(side=>stats?._present?.[side+field]===true);
  const missing=['TotalShots','ShotsOnTarget','Corners','BigChances','ShotsInsideBox','ExpectedGoals','Possession','RedCards','Attacks','DangerousAttacks'].filter(f=>!available(f));
  return `1.Tempo ${c.tempoLevel} ${fmt(c.tempo)} (cumulative stats) | 2.Pressure ${fmt(c.pressure)} | 3.Quality ${fmt(c.quality)} | 4.Red x${fmt(c.redFactor)} | 5.Data ${c.reliability?.label||'N/A'} ${c.availableGroups}/8 | Evidence x${fmt(c.evidenceFactor)} Accuracy x${fmt(c.qualityFactor)} SOT% ${fmt(c.shotAccuracyPercent)} | Missing ${missing.join(',')||'none'}`;
}
function v3TelegramDetail(ai,stats,minute){
  const c=ai?.v3Components;
  if(!c)return '🧩 V3 Advanced: Chưa đủ dữ liệu hiện tại';
  const fmt=x=>x==null?'N/A':Number(x).toFixed(1);
  const missing=['Attacks','DangerousAttacks','BigChances','ExpectedGoals'].filter(f=>!['home','away'].every(side=>stats?._present?.[side+f]===true));
  return [
    `🧩 V3 Advanced: Tempo ${c.tempoLevel} (${fmt(c.tempo)}, ước lượng TB trận)`,
    `🔥 Pressure ${fmt(c.pressure)} | 🎯 Quality ${fmt(c.quality)}`,
    `🟥 Red x${fmt(c.redFactor)}`,
    `📡 Data Reliability: ${c.reliability?.label||'N/A'} ${c.availableGroups}/8 nhóm | Thiếu: ${missing.join(', ')||'không'}` ,
    `🔎 SOT/Shots ${fmt(c.shotAccuracyPercent)}% | Evidence x${fmt(c.evidenceFactor)} | Quality adjustment x${fmt(c.qualityFactor)}`
  ].join('\n');
}
function estimateRemainingGoalProbability(stats,momentum,minute,homeScore,awayScore,windows,ruleV3) {
  // AI Goal V3-Aware is informational only. Current LIVE data is sufficient;
  // snapshot history is NOT a prerequisite for this estimate.
  const present=stats?._present||{};
  const pair=(name)=>{
    const h='home'+name, a='away'+name;
    if(present[h]!==true || present[a]!==true) return null;
    const x=Number(stats[h]), y=Number(stats[a]);
    return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0?[x,y]:null;
  };
  const sot=pair('ShotsOnTarget');
  const shots=pair('TotalShots');
  const corners=pair('Corners');
  const chances=pair('BigChances');
  const reds=pair('RedCards');
  const poss=pair('Possession');
  const remaining=Math.max(0,95-Number(minute));
  if(!Number.isFinite(remaining)||remaining===0) return {percent:0,label:'Hết thời gian ước tính (chưa hiệu chuẩn)',calibrated:false};
  // Need at least one attacking volume signal, not merely possession.
  if(!sot&&!shots&&!corners&&!chances)
    return {percent:null,label:'Thiếu thống kê tấn công LIVE',calibrated:false};
  const elapsed=Math.max(10,Math.min(95,Number(minute)||10));
  const sum=p=>p?p[0]+p[1]:null;
  // Conservative per-minute goal intensity proxy. Missing metrics add nothing,
  // but are NOT treated as observed zeros. This is NOT a trained model.
  let rate=0.012;
  if(sot) rate+=0.19*sum(sot)/elapsed;
  if(shots) rate+=0.035*sum(shots)/elapsed;
  if(chances) rate+=0.15*sum(chances)/elapsed;
  if(corners) rate+=0.012*sum(corners)/elapsed;
  // V3-AWARE: Rule V3 is a read-only signal; never changes Rule or alert gating.
  // Keep baseline AI Goal intensity and add a bounded, smooth Rule adjustment.
  const gap=Math.abs(Number(homeScore)-Number(awayScore));
  const gameState=gap>=4?0.72:gap===3?0.82:gap===0?1.06:1;
  const redFactor=reds&&sum(reds)>0?1.07:1;
  const baseLambda=clamp(remaining*rate*gameState*redFactor,0,4);
  const ruleScore=ruleV3?.efficiency==null?null:Number(ruleV3.efficiency);
  const validRule=Number.isFinite(ruleScore)&&ruleScore>=0&&ruleScore<=100;
  // Smooth multiplier: Rule 70 is neutral; 0..100 maps to ~0.75..1.19.
  const ruleMultiplier=validRule?clamp(Math.exp((ruleScore-70)*0.003),0.75,1.20):1;
  // Only verified recent snapshots can affect momentum. Avoid duplicating the
  // cumulative shot/SOT signal already present in both baseline and Rule V3.
  const verifiedMomentum=momentum?.available===true&&Number.isFinite(Number(momentum.score));
  const momentumMultiplier=verifiedMomentum?clamp(Math.exp((Number(momentum.score)-50)*0.002),0.90,1.10):1;
  // Verified recent Tempo informs goal probability, never Rule V3.
  // Use existing source-matched 5/10-minute snapshots; no new API calls.
  const tempoWindow=windows?.ten?.available===true?windows.ten:
    windows?.five?.available===true?windows.five:null;
  const tempoStrength=tempoWindow?pressureStrength(tempoWindow):null;
  // Neutral without verified recent data. Bounded contextual adjustment, not calibrated.
  const tempoMultiplier=tempoStrength===null?1:
    clamp(Math.exp((tempoStrength-50)*0.002),0.90,1.10);
  const lambda=clamp(baseLambda*ruleMultiplier*momentumMultiplier*tempoMultiplier,0,4);
  const available=[sot,shots,corners,chances,reds,poss].filter(Boolean).length;
  const percent=round1((1-Math.exp(-lambda))*100);
  const baselinePercent=round1((1-Math.exp(-baseLambda))*100);
  const divergence=validRule?round1(ruleScore-percent):null;
  return {percent,lambda:round1(lambda),baselinePercent,ruleScore:validRule?ruleScore:null,
    ruleMultiplier:round1(ruleMultiplier),momentumMultiplier:round1(momentumMultiplier),
    tempoStrength:tempoStrength===null?null:round1(tempoStrength),tempoMultiplier:round1(tempoMultiplier),
    divergence,divergenceFlag:validRule&&Math.abs(divergence)>=25,
    label:`AI Goal V3-Aware (${available}/6 nhóm, thử nghiệm chưa hiệu chuẩn)`,
    calibrated:false,source:'current-live-v3-aware',availableGroups:available};
}




// ==========================================================
// 35. SHOULD SEND ALERT
//
// RULE:
//
// Lần đầu >=58%
//       => SEND
//
// Đã báo <75%, sau đó lần đầu >=75%
//       => BIG BET ngay
//
// Sau đó tăng >= +10%
//       => SEND
//
// Tối đa 3 lần.
// ==========================================================

function hasStrongLiveMovement(momentum) {

  if (!momentum?.available) {
    return false;
  }

  return (
    safeNumber(momentum.score) >= 65 ||
    safeNumber(momentum.sot10) >= 2 ||
    safeNumber(momentum.dangerous10) >= 9 ||
    safeNumber(momentum.attack10) >= 25 ||
    safeNumber(momentum.blocked10) >= 2 ||
    safeNumber(momentum.corners10) >= 2
  );
}


// Snapshot mốc chỉ được ghi sau khi Telegram xác nhận gửi thành công.
function makeMatchSnapshot(stats, minute, homeScore, awayScore) {
  return {
    ...createSnapshot(stats || createEmptyStats(), minute),
    homeTotalShots: safeNumber(stats?.homeTotalShots),
    awayTotalShots: safeNumber(stats?.awayTotalShots),
    _present: {...(stats?._present || {})},
    _fieldSources: {...(stats?._fieldSources || stats?.fieldSources || {})},
    homeScore: safeNumber(homeScore),
    awayScore: safeNumber(awayScore)
  };
}

// Kiểm tra biến động MỚI kể từ cảnh báo gần nhất, không dùng momentum cũ.
// L18 BIG BET: compare confirmed, monotonic, per-team statistics since alert #1.
const BIG_SPIKE_MIN_SCORE = 60;
function detectTenMinuteSpike(previous, current) {
  if (!previous || !current) return {confirmed:false, score:0, reason:'NO_SNAPSHOT'};
  const gap = Number(current.minute) - Number(previous.minute);
  if (!(gap > 0 && gap <= FOLLOWUP_WINDOW_MINUTES))
    return {confirmed:false,score:0,reason:'INVALID_TIME_GAP'};
  const delta = (field) => {
    const keys = ['home'+field,'away'+field];
    if (!keys.every(k => previous._present?.[k] === true && current._present?.[k] === true && previous._fieldSources?.[k] && previous._fieldSources?.[k] === current._fieldSources?.[k])) return null;
    const diffs = keys.map(k => Number(current[k]) - Number(previous[k]));
    if (diffs.some(x => !Number.isFinite(x) || x < 0)) return null;
    return diffs;
  };
  const shots = delta('TotalShots'), sot = delta('ShotsOnTarget');
  const corners = delta('Corners'), attacks = delta('Attacks');
  const dangerous = delta('DangerousAttacks');
  const sum = x => x === null ? null : x[0] + x[1];
  const sh = sum(shots), so = sum(sot), co = sum(corners);
  const da = sum(dangerous), at = sum(attacks);
  const cornerDensity = co === null ? null : co / gap;
  const pressure = da !== null && at !== null && da >= 9 && at >= 12;
  const signals = {
    finishing: (sh !== null && sh >= 4) || (so !== null && so >= 2),
    corners: co !== null && co >= 2,
    pressure: pressure
  };
  const score = Math.min(100,
    (sh !== null && sh >= 4 ? 20 : 0) +
    (so !== null && so >= 2 ? 25 : 0) +
    (co !== null && co >= 2 ? 15 : 0) +
    (cornerDensity !== null && cornerDensity >= 0.3 ? 10 : 0) +
    (pressure ? 30 : 0));
  const groups = Object.values(signals).filter(Boolean).length;
  const verifiedFinishing = (so !== null && so >= 1) || (sh !== null && sh >= 2 && ((co !== null && co >= 1) || (da !== null && da >= 9)));
  const confirmed = score >= BIG_SPIKE_MIN_SCORE && groups >= 2 && verifiedFinishing;
  return {confirmed,score,groups,cornerDensity,signals,
    reason:`SPIKE=${score}/100 GROUPS=${groups} SH=${sh ?? 'NA'} SOT=${so ?? 'NA'} COR=${co ?? 'NA'} DENSITY=${cornerDensity?.toFixed(2) ?? 'NA'} DA=${da ?? 'NA'} ATT=${at ?? 'NA'}`};
}

function shouldSendAlert(matchId, currentPercentage, currentMinute, momentum, stats, homeScore, awayScore) {
  const current = currentPercentage == null ? NaN : Number(currentPercentage);
  if (!Number.isFinite(currentMinute) || currentMinute < MIN_TELEGRAM_MINUTE || currentMinute >= 89)
    return {send:false,bigBet:false,reason:'OUTSIDE_ALERT_MINUTES'};
  if (!Number.isFinite(current)) return {send:false,bigBet:false,reason:'STATS_MISSING_DYNAMIC_WINDOW'};
  if (current <= MIN_SEND_PERCENTAGE)
    return {send:false,bigBet:false,reason:`RULE_BELOW_${MIN_SEND_PERCENTAGE}`};
  const previous = alertState.get(matchId);
  if (!previous) return {send:true,bigBet:false,reason:'FIRST_ALERT'};
  if (previous.alertCount >= MAX_ALERTS_PER_MATCH)
    return {send:false,bigBet:false,reason:'MAX_2_ALERTS'};
  const gap = currentMinute - previous.lastMinute;
  if (gap <= 0) return {send:false,bigBet:false,reason:'WAIT_NEXT_MINUTE'};
  if (gap > FOLLOWUP_WINDOW_MINUTES) return {send:false,bigBet:false,reason:'FOLLOWUP_EXPIRED'};
  if (!previous.alertSnapshot) return {send:false,bigBet:false,reason:'RESTART_SNAPSHOT_UNAVAILABLE'};
  const spike = detectTenMinuteSpike(previous.alertSnapshot,
    makeMatchSnapshot(stats,currentMinute,homeScore,awayScore));
  const ruleIncrease = current - Number(previous.lastPercentage);
  if (!(ruleIncrease >= ALERT_INCREASE_THRESHOLD)) return {send:false,bigBet:false,spike,reason:`RULE_DELTA_${ruleIncrease.toFixed(1)}_BELOW_${ALERT_INCREASE_THRESHOLD}`};
  if (!spike.confirmed) return {send:false,bigBet:false,spike,
    reason:`MONITORING ${spike.reason}`};
  return {send:true,bigBet:true,spike,reason:`BIG_BET ${spike.reason}`};
}
// ==========================================================
// 36. SCORE HELPERS
// ==========================================================

function extractScores(raw) {

  const home = safeNumber(
    raw?.homeScore?.current ??
    raw?.homeScore?.display ??
    raw?.home?.score ??
    raw?.score?.home ??
    raw?.scores?.home ??
    raw?.home_score ??
    raw?.homeScore ??
    raw?.homeGoals ??
    raw?.goals?.home ??
    raw?.result?.home ??
    0
  );

  const away = safeNumber(
    raw?.awayScore?.current ??
    raw?.awayScore?.display ??
    raw?.away?.score ??
    raw?.score?.away ??
    raw?.scores?.away ??
    raw?.away_score ??
    raw?.awayScore ??
    raw?.awayGoals ??
    raw?.goals?.away ??
    raw?.result?.away ??
    0
  );

  return {
    home,
    away
  };
}


// ==========================================================
// 37. TEAM NAME HELPERS
// ==========================================================

function extractHomeName(raw) {

  return String(
    raw?.homeTeam?.name ??
    raw?.home?.name ??
    raw?.teams?.home?.name ??
    raw?.home_team?.name ??
    raw?.home_team ??
    raw?.homeName ??
    raw?.home_name ??
    raw?.participant1?.name ??
    'Home'
  );
}


function extractAwayName(raw) {

  return String(
    raw?.awayTeam?.name ??
    raw?.away?.name ??
    raw?.teams?.away?.name ??
    raw?.away_team?.name ??
    raw?.away_team ??
    raw?.awayName ??
    raw?.away_name ??
    raw?.participant2?.name ??
    'Away'
  );
}


// ==========================================================
// 38. MATCH ID
// ==========================================================

function extractMatchId(raw, source) {

  const id =
    raw?.id ??
    raw?.eventId ??
    raw?.event_id ??
    raw?.matchId ??
    raw?.match_id ??
    raw?.fixture?.id ??
    raw?.gameId ??
    raw?.game_id;

  if (
    id !== undefined &&
    id !== null
  ) {
    return String(id);
  }

  const home =
    extractHomeName(raw);

  const away =
    extractAwayName(raw);

  return (
    `${source}_` +
    createMatchKey(
      home,
      away
    )
  );
}


// ==========================================================
// 39. FORMAT MATCH
// ==========================================================

function formatLiveMatch(
  raw,
  source
) {

  const homeName =
    extractHomeName(raw);

  const awayName =
    extractAwayName(raw);

  const score =
    extractScores(raw);

  const id =
    extractMatchId(
      raw,
      source
    );

  return {
    id,

    source,

    homeName,

    awayName,

    homeScore:
      score.home,

    awayScore:
      score.away,

    league: parseLeagueName(raw),
    minute: normalizeProviderMinute(raw, source) ?? calculateExactMinute(raw),
    raw
  };
}


// ==========================================================
// 40. PREDICT FINAL SCORE
//
// Dựa trên:
//
// - Rule Score
// - Phút
// - Tỷ số hiện tại
// - Pressure Home/Away
// - Momentum Home/Away
// - Đôi công / ép sân
//
// Đây là dự đoán Rule,
// không phải xác suất chắc chắn.
// ==========================================================

function predictFinalScore(
  homeScore,
  awayScore,
  percentage,
  minute,
  stats,
  momentum,
  styleType
) {

  const h =
    safeNumber(
      homeScore
    );

  const a =
    safeNumber(
      awayScore
    );

  const pct =
    safeNumber(
      percentage
    );


  // ======================================================
  // KHÔNG ĐỦ NGƯỠNG
  // ======================================================

  if (
    pct <
    MIN_SEND_PERCENTAGE
  ) {

    return {
      home: h,
      away: a,

      text:
        `${h}-${a}`,

      expectedExtraGoals: 0,

      likelyScorer:
        'Chưa đủ tín hiệu',

      confidence:
        'THẤP'
    };
  }


  // ======================================================
  // 1. ƯỚC LƯỢNG SỐ BÀN CÒN LẠI
  // ======================================================

  let expectedExtraGoals = 1;


  // Rule cực cao
  if (
    pct >= 88 &&
    minute <= 78
  ) {

    expectedExtraGoals = 2;

  } else if (
    pct >= 84 &&
    minute <= 72
  ) {

    expectedExtraGoals = 2;

  } else if (
    pct >= 90 &&
    minute <= 84
  ) {

    expectedExtraGoals = 2;
  }


  // Cuối trận không nên dự đoán
  // quá nhiều bàn
  if (
    minute >= 86
  ) {

    expectedExtraGoals = 1;
  }


  // ======================================================
  // 2. PRESSURE CẢ TRẬN
  // ======================================================

  const pressure =
    calculateTeamPressure(
      stats
    );


  let homePower =
    pressure.home;

  let awayPower =
    pressure.away;


  // ======================================================
  // 3. MOMENTUM GẦN NHẤT
  // ======================================================

  if (
    momentum?.available
  ) {

    homePower +=
      momentum.homePressure *
      1.5;

    awayPower +=
      momentum.awayPressure *
      1.5;
  }


  // ======================================================
  // 4. ĐÔI CÔNG / ÉP SÂN
  // ======================================================

  if (
    styleType ===
    'HOME_PRESSURE'
  ) {

    homePower *= 1.15;
  }


  if (
    styleType ===
    'AWAY_PRESSURE'
  ) {

    awayPower *= 1.15;
  }


  // ======================================================
  // 5. ĐỘI ĐANG THUA CÓ THỂ ĐẨY CAO
  // ======================================================

  if (
    minute >= 70
  ) {

    if (
      h < a &&
      h + 2 >= a
    ) {

      homePower *= 1.08;
    }


    if (
      a < h &&
      a + 2 >= h
    ) {

      awayPower *= 1.08;
    }
  }


  // ======================================================
  // 6. TỶ LỆ PRESSURE
  // ======================================================

  const totalPower =
    Math.max(
      homePower +
      awayPower,
      1
    );


  const homeShare =
    homePower /
    totalPower;

  const awayShare =
    awayPower /
    totalPower;


  let predictedHome = h;
  let predictedAway = a;

  let likelyScorer =
    'Hai đội đều có khả năng';


  // ======================================================
  // +1 BÀN
  // ======================================================

  if (
    expectedExtraGoals === 1
  ) {

    if (
      homeShare >= 0.56
    ) {

      predictedHome += 1;

      likelyScorer =
        'Chủ nhà';

    } else if (
      awayShare >= 0.56
    ) {

      predictedAway += 1;

      likelyScorer =
        'Đội khách';

    } else {

      // Cân bằng:
      // ưu tiên đội đang thua
      if (
        h < a
      ) {

        predictedHome += 1;

        likelyScorer =
          'Chủ nhà';

      } else if (
        a < h
      ) {

        predictedAway += 1;

        likelyScorer =
          'Đội khách';

      } else {

        // Hòa và cân bằng
        if (
          homePower >=
          awayPower
        ) {

          predictedHome += 1;

          likelyScorer =
            'Chủ nhà';

        } else {

          predictedAway += 1;

          likelyScorer =
            'Đội khách';
        }
      }
    }
  }


  // ======================================================
  // +2 BÀN
  // ======================================================

  if (
    expectedExtraGoals === 2
  ) {

    // Ép sân cực rõ
    if (
      homeShare >= 0.68
    ) {

      predictedHome += 2;

      likelyScorer =
        'Chủ nhà';

    } else if (
      awayShare >= 0.68
    ) {

      predictedAway += 2;

      likelyScorer =
        'Đội khách';

    } else {

      // Đôi công / cân bằng
      predictedHome += 1;
      predictedAway += 1;

      likelyScorer =
        'Hai đội đều có khả năng';
    }
  }


  // ======================================================
  // CONFIDENCE
  // ======================================================

  let confidence =
    'THAM KHẢO';


  if (
    pct >= 85
  ) {

    confidence =
      'RẤT MẠNH';

  } else if (
    pct >= 75
  ) {

    confidence =
      'MẠNH';

  } else if (
    pct >= 68
  ) {

    confidence =
      'KHÁ';

  } else {

    confidence =
      'TRUNG BÌNH';
  }


  return {

    home:
      predictedHome,

    away:
      predictedAway,

    text:
      `${predictedHome}-${predictedAway}`,

    expectedExtraGoals,

    likelyScorer,

    confidence,

    homePressure:
      round1(
        homePower
      ),

    awayPressure:
      round1(
        awayPower
      ),

    homeShare:
      round1(
        homeShare * 100
      ),

    awayShare:
      round1(
        awayShare * 100
      )
  };
}


// ==========================================================
// 41. GOAL TIMELINE
// ==========================================================

function extractGoalTimeline(
  raw
) {

  const goals = [];
  const unscoredGoals = [];

  const possibleArrays = [

    raw?.incidents,

    raw?.events,

    raw?.goals,

    raw?.timeline,

    raw?.matchEvents,

    raw?.match_events,
    raw?.data?.incidents,
    raw?.data?.events,
    raw?.data?.data?.incidents,
    raw?.result?.incidents,
    raw?.content?.matchFacts?.events?.events,
    raw?.data?.content?.matchFacts?.events?.events,
    raw?.matchFacts?.events?.events

  ];


  for (
    const array of possibleArrays
  ) {

    if (
      !Array.isArray(array)
    ) {
      continue;
    }


    for (
      const event of array
    ) {

      const type =
        String(
          event?.incidentType ??
          event?.type ??
          event?.eventType ??
          event?.event_type ??
          event?.name ??
          event?.eventName ??
          event?.type?.name ??
          ''
        ).toLowerCase();


      const isGoal =

        type === 'goal' ||

        type.includes('goal') ||
        type === '36' ||
        event?.isGoal === true;


      if (!isGoal) {
        continue;
      }


      const rawMinute =
        event?.time ??
        event?.minute ??
        event?.elapsed ??
        event?.matchTime ??
        event?.timeStr ??
        event?.time?.elapsed;


      let minuteText =
        String(
          rawMinute ??
          '?'
        )
          .trim()
          .replace(/['’]/g, '');


      const plusMatch =
        minuteText.match(
          /(\d{1,3})\s*\+\s*(\d{1,2})/
        );


      if (plusMatch) {

        minuteText =
          `${plusMatch[1]}+${plusMatch[2]}`;

      } else {

        const parsedMinute =
          parseMinuteValue(
            rawMinute
          );

        minuteText =
          parsedMinute === 'HT'
            ? 'HT'
            : (
                parsedMinute ||
                '?'
              );
      }


      const homeScore =

        event?.homeScore ??

        event?.score?.home ??
        event?.home_score ??
        event?.score?.homeScore;


      const awayScore =

        event?.awayScore ??

        event?.score?.away ??
        event?.away_score ??
        event?.score?.awayScore;


      if (homeScore === undefined || awayScore === undefined) {
        // Keep event minute only when the scoring side is explicitly identified.
        const side = String(event?.team || event?.teamSide || event?.side || '').toLowerCase();
        if (side === 'home' || side === 'away') unscoredGoals.push({minuteText, side});
        continue;
      }


      goals.push(
        `P${minuteText}: ${homeScore}-${awayScore}`
      );
    }
  }


  if (!goals.length && unscoredGoals.length) {
    // Only reconstruct from provider-confirmed goal events with explicit home/away side.
    const minuteNum = t => { const m = String(t).match(/^(\d+)(?:\+(\d+))?/); return m ? +m[1] * 100 + +(m[2] || 0) : Infinity; };
    let h = 0, a = 0;
    for (const e of unscoredGoals.sort((x,y) => minuteNum(x.minuteText)-minuteNum(y.minuteText))) {
      if (e.side === 'home') h++; else a++;
      goals.push(`P${e.minuteText}: ${h}-${a}`);
    }
  }
  if (!goals.length) return 'Chưa lấy được dữ liệu';


  return [...new Set(goals)].sort((a, b) => {
    const minute = text => {
      const m = text.match(/^P(\d+)(?:\+(\d+))?/);
      return m ? Number(m[1]) + Number(m[2] || 0) / 100 : Infinity;
    };
    return minute(a) - minute(b);
  }).join(' | ');
}

// Goal history: verify incident events against current score, never infer minutes.
function goalHistoryMatches(timeline, home, away) {
  if (!timeline || timeline === 'Chưa lấy được dữ liệu') return false;
  const entries = timeline.split(' | ');
  const last = entries.at(-1)?.match(/:\s*(\d+)-(\d+)$/);
  return entries.length === home + away && !!last &&
    Number(last[1]) === home && Number(last[2]) === away;
}
function goalNameKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(fc|cf|sc|afc|club|football)\b/g, '')
    .replace(/[^a-z0-9]/g, ' ').trim().replace(/\s+/g, ' ');
}
function goalTeamMatches(a, b) {
  const x = goalNameKey(a), y = goalNameKey(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 &&
    (x.includes(y) || y.includes(x)));
}
async function fetchSofaGoalIncidents(eventId) {
  if (!PAID_RAPIDAPI_KEY || !eventId) return null;
  const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents`, {
    params: { eventId },
    headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
    timeout: 6000
  });
  return response.data;
}
async function resolveSofaGoalEventIdByName(match) {
  if (!PAID_RAPIDAPI_KEY) return null;
  try {
    const response = await axios.get(SOFASCORE_LIVE_URL, {
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
      timeout: 8000
    });
    const events = response.data?.events || response.data?.liveEvents || [];
    const candidates = Array.isArray(events) ? events : [];
    const found = candidates.find(ev =>
      goalTeamMatches(match.homeName, ev.homeTeam?.name || ev.home?.name || ev.homeName) &&
      goalTeamMatches(match.awayName, ev.awayTeam?.name || ev.away?.name || ev.awayName)
    );
    return found?.id || found?.eventId || null;
  } catch (err) {
    console.warn(`[GOAL HISTORY] SofaScore live lookup failed: ${err.message}`);
    return null;
  }
}
// Verified multi-provider goal event parser. Missing scores are reconstructed only
// from explicit goal events with a verified home/away team identity.
function extractGoalTimelineV2(payload, match) {
  const root = payload?.data || payload?.result || payload;
  const arrays = [root?.incidents,root?.events,root?.response,root?.goals,
    root?.data?.incidents,root?.data?.events,root?.content?.matchFacts?.events?.events,
    root?.content?.matchFacts?.events,root?.matchFacts?.events?.events,
    root?.header?.events,root?.timeline];
  const events = arrays.find(Array.isArray);
  if (!events) return 'Chưa lấy được dữ liệu';
  const homeId = String(match?.raw?.teams?.home?.id ?? match?.raw?.homeTeam?.id ?? '');
  const awayId = String(match?.raw?.teams?.away?.id ?? match?.raw?.awayTeam?.id ?? '');
  const parsed=[];
  for (const e of events) {
    const type = String(e?.incidentType?.name ?? e?.incidentType ?? e?.type?.name ?? e?.type ?? e?.eventType?.name ?? e?.eventType ?? e?.event_type ?? e?.name ?? '').toLowerCase();
    const detail=String(e?.detail ?? e?.subType ?? e?.subtype ?? '').toLowerCase();
    if (!(type==='goal'||type==='36'||type.includes('goal')||e?.isGoal===true)) continue;
    if (type.includes('disallow')||type.includes('cancel')||detail.includes('missed penalty')||e?.isCancelled===true||e?.isDisallowed===true) continue;
    const minute=e?.time?.elapsed ?? e?.time ?? e?.minute ?? e?.elapsed ?? e?.matchTime ?? e?.timeStr;
    const extra=e?.time?.extra ?? e?.addedTime ?? e?.added_time;
    const minuteString=typeof minute==='number' && Number(extra)>0 ? `${minute}+${extra}` : String(minute??'').replace(/[’']/g,'');
    if (!/^\d{1,3}(?:\+\d{1,2})?$/.test(minuteString)) continue;
    const explicitHome=e?.homeScore ?? e?.home_score ?? e?.score?.home ?? e?.score?.homeScore;
    const explicitAway=e?.awayScore ?? e?.away_score ?? e?.score?.away ?? e?.score?.awayScore;
    let side=typeof e?.isHome==='boolean' ? (e.isHome?'home':'away') : String(e?.teamSide ?? e?.side ?? '').toLowerCase();
    const teamId=String(e?.team?.id ?? e?.teamId ?? '');
    if (!['home','away'].includes(side) && teamId && homeId && awayId) side=teamId===homeId?'home':teamId===awayId?'away':'';
    if (!['home','away'].includes(side) && typeof e?.team?.name==='string') {
      if (goalTeamMatches(e.team.name,match.homeName)) side='home';
      else if (goalTeamMatches(e.team.name,match.awayName)) side='away';
    }
    const hs=explicitHome==null?null:Number(explicitHome),as=explicitAway==null?null:Number(explicitAway);
    if ((!Number.isInteger(hs)||!Number.isInteger(as)) && !['home','away'].includes(side)) continue;
    parsed.push({minute:minuteString,side,hs,as});
  }
  const unique=[...new Map(parsed.map(x=>[`${x.minute}:${x.side}:${x.hs}:${x.as}`,x])).values()];
  unique.sort((a,b)=>{const n=x=>{const [m,e='0']=x.minute.split('+');return +m*100+ +e;};return n(a)-n(b)});
  let h=0,a=0;const output=[];
  for (const e of unique) {
    if (Number.isInteger(e.hs)&&Number.isInteger(e.as)) {h=e.hs;a=e.as;}
    else if (e.side==='home') h++; else if (e.side==='away') a++; else continue;
    output.push(`P${e.minute}: ${h}-${a}`);
  }
  return output.length?output.join(' | '):'Chưa lấy được dữ liệu';
}
async function fetchApiSportsGoalEvents(fixtureId) {
  if (!APISPORTS_KEY || !fixtureId) return null;
  return apiSportsGet('/fixtures/events',{fixture:fixtureId});
}
async function resolveVerifiedGoalHistory(match) {
  const home = Number(match.homeScore), away = Number(match.awayScore);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return 'Chưa xác thực được tỷ số';
  if (home + away === 0) return 'Chưa có bàn thắng (0-0)';
  const candidates = [match, ...(match.crossSourceMatches || [])];
  for (const candidate of candidates) {
    const fromLive = extractGoalTimelineV2(candidate.raw, match);
    if (goalHistoryMatches(fromLive, home, away)) return fromLive;
  }
  const ids = [...new Set(candidates.filter(c => c.source === 'sofascore')
    .map(c => c.id).filter(Boolean).map(String))];
  // Other providers may use different IDs. Resolve by team names only when needed.
  if (!ids.length) {
    const resolved = await resolveSofaGoalEventIdByName(match);
    if (resolved) ids.push(String(resolved));
  }
  if (ids.length) {
    // Resolve alternate SofaScore ID if a cross-source ID cannot supply verified incidents.
    const resolved = await resolveSofaGoalEventIdByName(match);
    if (resolved && !ids.includes(String(resolved))) ids.push(String(resolved));
  }
  for (const id of ids) {
    try {
      const timeline = extractGoalTimelineV2(await fetchSofaGoalIncidents(id), match);
      if (goalHistoryMatches(timeline, home, away)) {
        console.log(`⚽ [GOAL HISTORY OK] ${match.homeName} vs ${match.awayName} | SofaScore eventId=${id}`);
        return timeline;
      }
      console.warn(`[GOAL HISTORY] Incomplete or mismatched incidents | eventId=${id}`);
    } catch (err) {
      console.warn(`[GOAL HISTORY] SofaScore incidents error | eventId=${id} | ${err.response?.status || err.message}`);
    }
  }
  const fotmobIds = [...new Set(candidates.filter(c => c.source === 'fotmob').map(c => c.id).filter(Boolean))];
  for (const id of fotmobIds) {
    if (!FOTMOB_KEY) break;
    try {
      const response = await axios.get(`https://${FOTMOB_HOST}/api/v1/matches/${encodeURIComponent(id)}`, {
        headers: { 'x-rapidapi-key': FOTMOB_KEY.trim(), 'x-rapidapi-host': FOTMOB_HOST }, timeout: 7000
      });
      const timeline = extractGoalTimelineV2(response.data?.data || response.data, match);
      if (goalHistoryMatches(timeline, home, away)) {
        console.log(`⚽ [GOAL HISTORY OK] ${match.homeName} vs ${match.awayName} | FotMob matchId=${id}`);
        return timeline;
      }
      console.log(`[GOAL HISTORY] FotMob incidents incomplete | matchId=${id}`);
    } catch (err) {
      console.warn(`[GOAL HISTORY] FotMob error | matchId=${id} | HTTP ${err.response?.status || err.message}`);
    }
  }
  const apiIds = [...new Set(candidates.filter(c => c.source === 'apisports').map(c => c.id).filter(Boolean))];
  for (const id of apiIds) {
    try {
      const payload=await fetchApiSportsGoalEvents(id);
      const fixtureMatch=candidates.find(c=>c.source==='apisports' && String(c.id)===String(id)) || match;
      const timeline=extractGoalTimelineV2(payload,fixtureMatch);
      if (goalHistoryMatches(timeline,home,away)) {
        console.log(`[GOAL HISTORY OK] ${match.homeName} vs ${match.awayName} | API-Football fixture=${id}`);
        return timeline;
      }
      console.warn(`[GOAL HISTORY] API-Football events incomplete | fixture=${id}`);
    } catch(err) { console.warn(`[GOAL HISTORY] API-Football events error | fixture=${id} | ${err.response?.status||err.message}`); }
  }
  console.log(`[GOAL HISTORY MISSING] ${match.homeName} vs ${match.awayName} | score=${home}-${away} | linked=${candidates.map(c=>`${c.source}:${c.id}`).join(',')}`);
  return `Chưa có lịch sử bàn thắng xác thực (hiện tại ${home}-${away})`;
}

// ==========================================================
// 42. TELEGRAM ESCAPE
//
// Dùng plain text,
// không cần Markdown parse mode.
// ==========================================================

function cleanTelegramText(
  value
) {

  if (
    value === undefined ||
    value === null
  ) {
    return '';
  }

  return String(value);
}


// ==========================================================
// 43. SEND TELEGRAM ALERT
// ==========================================================

async function sendTelegramAlert(
  item,
  alertDecision
) {

  // Telegram only: never send at 89' or later.
  if (!Number.isFinite(Number(item.minute)) || Number(item.minute) >= 89) {
    console.log(`[Telegram BLOCK] MINUTE_89_OR_LATER | ${item.homeName} vs ${item.awayName} | ${item.minute}'`);
    return false;
  }

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {

    console.log(
      '[Telegram] Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
    );

    return false;
  }


  // Defensive send-time alias lock: avoid duplicate FIRST alerts from different
  // provider fixture IDs. Follow-ups remain governed by the existing BIG BET rule.
  const equivalentPrior = [...alertState.entries()].find(([key, prior]) =>
    key !== item.alertKey && prior && Number(prior.alertCount) > 0 &&
    Date.now() - Number(prior.updatedAt || 0) < ALERT_STATE_TTL &&
    resolverTeamScore(prior.homeName, item.homeName) >= .94 &&
    resolverTeamScore(prior.awayName, item.awayName) >= .94 &&
    (prior.lastMinute == null || item.minute == null || Math.abs(Number(prior.lastMinute)-Number(item.minute)) <= 20)
  );
  if (equivalentPrior) {
    console.log(`[ALERT DEDUP] BLOCK_ALIAS_DUPLICATE ${item.homeName} vs ${item.awayName} | existing=${equivalentPrior[0]}`);
    return false;
  }
  if (sendingKeys.has(item.alertKey)) return false;
  sendingKeys.add(item.alertKey);
  const percentage =
    safeNumber(
      item.ai.efficiency
    );


  const previous =
    alertState.get(
      item.alertKey
    );


  const alertNumber =
    previous
      ? previous.alertCount + 1
      : 1;


  const isBigBet = alertNumber === 2 && alertDecision?.bigBet === true;


  // Tiêu đề Telegram: số lần rung và BIG BET là hai trạng thái riêng.
  // Không thay đổi điều kiện xác định isBigBet hoặc số lần gửi.
  let title = alertNumber === 1
    ? '🔔 TÀI LỘC ĐẾN NHÀAA 🔔'
    : `🔔 LỘC ĐẾN LẦN ${alertNumber}`;

  if (isBigBet) {
    title = percentage >= 85
      ? `🔥🔥🔥 BIG BET RẤT MẠNH — RUNG LẦN ${alertNumber}`
      : `🔥 BIG BET — RUNG LẦN ${alertNumber}`;
  }


  const scorePrediction =
    item.scorePrediction;


  // Telegram COMPACT: chỉ thay đổi phần hiển thị, không đổi AI/điều kiện gửi.
  const st = item.stats || {};
  const pair = (home, away) => `${safeNumber(st[home])}-${safeNumber(st[away])}`;
  const hasPair = (home, away) =>
    safeNumber(st[home]) > 0 || safeNumber(st[away]) > 0;
  const statLines = [];
  if (hasPair('homeTotalShots', 'awayTotalShots') || hasPair('homeShotsOnTarget', 'awayShotsOnTarget')) {
    const parts = [];
    if (hasPair('homeTotalShots', 'awayTotalShots')) parts.push(`Sút ${pair('homeTotalShots', 'awayTotalShots')}`);
    if (hasPair('homeShotsOnTarget', 'awayShotsOnTarget')) parts.push(`SOT ${pair('homeShotsOnTarget', 'awayShotsOnTarget')}`);
    statLines.push(`🎯 ${parts.join(' | ')}`);
  }
  if (hasPair('homeAttacks', 'awayAttacks') || hasPair('homeDangerousAttacks', 'awayDangerousAttacks')) {
    const parts = [];
    if (hasPair('homeAttacks', 'awayAttacks')) parts.push(`ATT ${pair('homeAttacks', 'awayAttacks')}`);
    if (hasPair('homeDangerousAttacks', 'awayDangerousAttacks')) parts.push(`DA ${pair('homeDangerousAttacks', 'awayDangerousAttacks')}`);
    statLines.push(`🔥 ${parts.join(' | ')}`);
  }
  if (hasPair('homeCorners', 'awayCorners')) statLines.push(`🚩 Góc ${pair('homeCorners', 'awayCorners')}`);
  if (hasPair('homePossession', 'awayPossession')) statLines.push(`📊 Kiểm soát ${pair('homePossession', 'awayPossession')}%`);
  const momentum = item.momentum;
  const changes = [];
  if (momentum?.available) {
    const addChange = (label, home, away) => {
      const h = safeNumber(momentum[home]);
      const a = safeNumber(momentum[away]);
      if (h > 0 || a > 0) changes.push(`${label} +${h}/+${a}`);
    };
    addChange('ATT', 'homeAttack', 'awayAttack');
    addChange('DA', 'homeDangerous', 'awayDangerous');
    addChange('SOT', 'homeSOT', 'awaySOT');
    addChange('Góc', 'homeCorners', 'awayCorners');
  }
  const prediction = item.scorePrediction || {};
  const pressureText =
    Number.isFinite(Number(prediction.homeShare)) && Number.isFinite(Number(prediction.awayShare))
      ? `📊 Sức ép ${prediction.homeShare}%–${prediction.awayShare}%`
      : null;
  // CLEAN L18: hiển thị Odds tham khảo, không ảnh hưởng Rule.
  const odd = item.odds || {};
  const bookmaker = odd.bookmaker || odd.bookmakerName || 'Nguồn tổng hợp';
  const oddLine = odd.found && Number(odd.price) > 1
    ? `💰 Kèo nhà cái (${cleanTelegramText(bookmaker)}): Over ${odd.point ?? "?"} @ ${Number(odd.price).toFixed(2)} — chỉ tham khảo, KHÔNG cộng Rule`
    : null;
  const oddNote = oddLine ? ` └─> Odds Over ${Number(odd.price) <= 1.85 ? 'ổn định' : 'tham khảo'} (${Number(odd.price).toFixed(2)})` : null;
  // xG chỉ phục vụ nhận định ngắn gọn, không in giá trị, không ảnh hưởng Rule/Spike.
  // Chỉ kết luận về chất lượng cơ hội ĐÃ TẠO khi API xác nhận xG của cả hai đội.
  const xgAvailable = st._present?.homeExpectedGoals === true && st._present?.awayExpectedGoals === true;
  const xgHome = Number(st.homeExpectedGoals);
  const xgAway = Number(st.awayExpectedGoals);
  let qualityAssessment = null;
  if (xgAvailable && Number.isFinite(xgHome) && Number.isFinite(xgAway) && xgHome >= 0 && xgAway >= 0) {
    const xgDiff = xgHome - xgAway;
    const shotsAvailable = st._present?.homeTotalShots === true && st._present?.awayTotalShots === true;
    const homeShots = Number(st.homeTotalShots);
    const awayShots = Number(st.awayTotalShots);
    if (xgDiff >= 0.5) {
      qualityAssessment = shotsAvailable && homeShots < awayShots
        ? '🧠 NHẬN ĐỊNH: Chủ nhà sút ít hơn nhưng tạo cơ hội chất lượng hơn.'
        : '🧠 NHẬN ĐỊNH: Chủ nhà tạo cơ hội chất lượng vượt trội.';
    } else if (xgDiff <= -0.5) {
      qualityAssessment = shotsAvailable && awayShots < homeShots
        ? '🧠 NHẬN ĐỊNH: Đội khách sút ít hơn nhưng tạo cơ hội chất lượng hơn.'
        : '🧠 NHẬN ĐỊNH: Đội khách tạo cơ hội chất lượng vượt trội.';
    } else {
      qualityAssessment = '🧠 NHẬN ĐỊNH: Chất lượng cơ hội hai đội tương đối cân bằng.';
    }
  }
  const compactStats = [
    (hasPair('homeAttacks','awayAttacks') || hasPair('homeDangerousAttacks','awayDangerousAttacks') || hasPair('homePossession','awayPossession'))
      ? `📊 LIVE: Attack ${pair('homeAttacks','awayAttacks')} | Danger ${pair('homeDangerousAttacks','awayDangerousAttacks')} | Poss ${pair('homePossession','awayPossession')}%` : null,
    (hasPair('homeTotalShots','awayTotalShots') || hasPair('homeShotsOnTarget','awayShotsOnTarget'))
      ? `🎯 SÚT: Shots ${pair('homeTotalShots','awayTotalShots')} | SOT ${pair('homeShotsOnTarget','awayShotsOnTarget')} | Off ${pair('homeShotsOffTarget','awayShotsOffTarget')}` : null,
    `🚩 KHÁC: Corner ${pair('homeCorners','awayCorners')} | Big Chance ${pair('homeBigChances','awayBigChances')}`,
    `🔥 THẾ TRẬN: ${prediction.likelyScorer ? cleanTelegramText(prediction.likelyScorer) : 'Đang phân tích'} | Pressure ${prediction.homeShare ?? '?'}%-${prediction.awayShare ?? '?'}%`,
    qualityAssessment,
    `🔎 Rule Confidence: ${item.ruleConfidence?.percent ?? "—"}% (${item.ruleConfidence?.label || "Chưa xác định"}, tham khảo)`,
    v3TelegramDetail(item.ai, st, item.minute),
    `🧠 RULE V3.4: ${percentage.toFixed(1)}%`,
    `🎯 AI Goal (thử nghiệm): ${item.aiGoal?.percent == null ? 'Chưa đủ dữ liệu' : item.aiGoal.percent+'%'} | ${item.aiGoal?.label || 'Chưa hiệu chuẩn'}`,
    ...(isBigBet ? [`🔥 BIG SPIKE: ${alertDecision.spike?.score ?? 0}/100 | ${alertDecision.spike?.reason || ""}`] : []),
    `📈 RULE: ${percentage.toFixed(1)}% | Còn bàn: +${prediction.expectedExtraGoals ?? '?'} | Dự đoán FT: ${prediction.text || 'N/A'}`
  ];
  const messageLines = [
    title,
    `🏆 Giải đấu: ${cleanTelegramText(item.league)}`,
    `⚽ Trận: ${cleanTelegramText(item.homeName)} vs ${cleanTelegramText(item.awayName)}`,
    `⏱ Phút: ${item.minute}' | Tỷ số: ${item.homeScore}-${item.awayScore}`,
    `⚽ DIỄN BIẾN TỶ SỐ: ${item.goalTimeline || 'Chưa có dữ liệu xác thực'}`,
    '',
    ...compactStats,
    ...(changes.length ? [`⚡ Biến động ${momentum.minuteGap || 7}p: ${changes.join(' | ')}`] : []),
    '', oddLine, oddNote
  ];
  const message = messageLines.filter(line => line !== null && line !== undefined).join('\n').trim();

  try {

    console.log(`[Telegram SENDING] #${alertNumber} | ${item.homeName} vs ${item.awayName}`);
    const response = await axios.post(
      `https://api.telegram.org/bot${String(TELEGRAM_BOT_TOKEN).trim()}/sendMessage`,
      {
        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          message,

        disable_web_page_preview:
          true
      },
      {
        timeout: 10000
      }
    );


    if (response.data?.ok !== true || !response.data?.result?.message_id) {
      console.error('[Telegram ERROR] API did not confirm send:', response.data?.description || 'missing message_id');
      return false;
    }
    console.log(`[Telegram SENT] message_id=${response.data.result.message_id} | alert #${alertNumber}`);
    try { await audit.addAlert({...item,alertDecision},alertNumber,response.data.result.message_id); } catch (auditErr) { console.error('[AUDIT SAVE ERROR]',auditErr.message); }

    alertState.set(
      item.alertKey,
      {
        lastPercentage:
          percentage,

        lastMinute:
          item.minute,

        alertCount:
          alertNumber,

        bigBetSent:
          (previous?.bigBetSent || false) ||
          isBigBet,

        alertSnapshot: makeMatchSnapshot(item.stats, item.minute, item.homeScore, item.awayScore),
        homeName:item.homeName, awayName:item.awayName, league:item.league,
        source:item.source, sourceId:String(item.id || ''),
        updatedAt:
          Date.now()
      }
    );


    console.log(
      `[Telegram] ${isBigBet ? '🔥 BIG BET' : '🔔 ALERT'} #${alertNumber} | ${item.homeName} vs ${item.awayName} | ${percentage.toFixed(1)}%`
    );

    // Log xác nhận chỉ xuất hiện SAU KHI Telegram trả về ok/message_id
    // và snapshot cảnh báo đã được lưu thành công.
    console.log(
      `🟢 [ĐÃ BÁO TELEGRAM] ${isBigBet ? '🔥 BIG BET' : '🔔 CẢNH BÁO'} LẦN ${alertNumber}/${MAX_ALERTS_PER_MATCH}` +
      ` | ${item.homeName} vs ${item.awayName}` +
      ` | Phút ${item.minute}' | Tỷ số ${item.homeScore}-${item.awayScore}` +
      ` | Rule ${percentage.toFixed(1)}%` +
      ` | message_id=${response.data.result.message_id}`
    );


    return true;

  } catch (e) {

    console.error(
      '[Telegram Error]',
      e.response?.status || '',
      e.response?.data?.description || e.message
    );

    return false;
  } finally {
    sendingKeys.delete(item.alertKey);
  }
}


// ==========================================================
// 44. FETCH ALL LIVE SOURCES
// ==========================================================

let independentLiveSourceRegistry = [];

async function fetchAllLiveMatches() {

  const [
    sofa,
    flash,
    football,
    fotmob,
    apisports
  ] = await Promise.allSettled([

    fetchLiveMatchesFromSofaScore(),

    fetchLiveMatchesFromFlashScore(),

    fetchLiveMatchesFromLiveFootball(),
    fetchLiveMatchesFromFotMob(),
    fetchApiSportsLive()

  ]);


  const all = [];
  for (const [name, result] of [['SofaScore', sofa], ['FlashScore', flash], ['LiveFootball', football], ['FotMob', fotmob]]) {
    if (result.status === 'fulfilled') {
      console.log(`[Source ${name}] LIVE ${Array.isArray(result.value) ? result.value.length : 0} trận`);
    } else {
      logSourceError(name, 'LIVE', result.reason);
    }
  }


  if (
    sofa.status ===
    'fulfilled'
  ) {

    for (
      const raw of
      sofa.value
    ) {

      all.push(
        formatLiveMatch(
          raw,
          'sofascore'
        )
      );
    }
  }


  if (
    flash.status ===
    'fulfilled'
  ) {

    for (
      const raw of
      flash.value
    ) {

      all.push(
        formatLiveMatch(
          raw,
          'flashscore'
        )
      );
    }
  }


  if (
    football.status ===
    'fulfilled'
  ) {

    for (
      const raw of
      football.value
    ) {

      all.push(
        formatLiveMatch(
          raw,
          'live-football'
        )
      );
    }
  }


  if (fotmob.status === 'fulfilled') {
    for (const raw of fotmob.value) {
      all.push(formatFotMobLiveMatch(raw));
    }
  }
  if (apisports.status === 'fulfilled') {
    for (const raw of apisports.value) all.push(formatApiSportsMatch(raw));
  } else logSourceError('API-Football','LIVE',apisports.reason);


  independentLiveSourceRegistry = all.filter(m => m && m.id != null && m.homeName && m.awayName);
  if (!all.length) console.warn('[Live Discovery] ALL SOURCES EMPTY | check API subscription, JSON structure, and match time');
  else console.log(`[Live Discovery] ${all.length} source records before dedup | SofaScore ${sofa.status === 'fulfilled' ? sofa.value.length : 0} | FotMob ${fotmob.status === 'fulfilled' ? fotmob.value.length : 0}`);
  return all;
}


// ==========================================================
// 45. DEDUPLICATE MATCHES
//
// SofaScore ưu tiên cao nhất.
// ==========================================================

// Cross-source resolver: source IDs are NEVER interchangeable.
// Keep the existing source-priority order and retain each source's native ID.
function resolverTokens(name) {
  const value = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(football club|futbol club|soccer club|fc|cf|sc|afc|fk|sk|ac|club)\b/g, ' ')
    .replace(/\b1907\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return value.split(/\s+/).filter(Boolean);
}
// Provider spelling aliases. Apply only to matching, never overwrite display names.
const RESOLVER_TEAM_ALIASES = [
  // CAHN is also called Cong An Nhan Dan by some live-data providers.
  // This alias only participates in fixture matching; opponent/clock/score/kickoff are still checked.
  [/\b(?:cong\s+an\s+(?:ha\s+noi|nhan\s+dan)|cahn)\b/g, 'cong an ha noi'],
  // Shortened provider name for Kashima Antlers.
  [/\bkashima(?:\s+antlers)?\b/g, 'kashima antlers'],
  // Hapoel Jerusalem FC is also known as Hapoel Katamon (same senior club).
  [/\bhapoel\s+(?:jerusalem|katamon)(?:\s+fc)?\b/g, 'hapoel jerusalem'],
  [/\bpakhtakor\b(?:\s+tashkent)?/g, 'pakhtakor'],
  [/\bal[ -]?qad(?:s|h|ss)iy(?:ah|a)(?:\s+fc)?\b/g, 'al qadsiah'],
  [/\bal[ -]?qadsiah\b/g, 'al qadsiah'],
  [/\b(?:uzb|sau|ksa)\b/g, ' '],
  [/\b(?:northeast|north east)\s+united\b/g, 'northeast united'],
  [/\b(?:atk\s+)?mohun\s+bagan(?:\s+sg)?\b/g, 'mohun bagan'],
];
function resolverAliasTokens(name) {
  let normalized = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [pattern, replacement] of RESOLVER_TEAM_ALIASES) normalized = normalized.replace(pattern, replacement);
  return resolverTokens(normalized);
}
function resolverTeamScore(a, b) {
  const x = resolverAliasTokens(a), y = resolverAliasTokens(b);
  if (!x.length || !y.length) return 0;
  const tags = /^(u\d{2}|women|woman|w|reserves|reserve|ii|iii|b)$/;
  const xt = x.filter(t => tags.test(t)).sort().join('|');
  const yt = y.filter(t => tags.test(t)).sort().join('|');
  if (xt !== yt) return 0;
  const left = x.join(''), right = y.join('');
  if (left === right) return 1;
  const common = x.filter(t => y.includes(t)).length;
  const dice = 2 * common / (x.length + y.length);
  if (left.length >= 6 && right.length >= 6 && (left.includes(right) || right.includes(left))) return Math.max(dice, .92);
  // Fuzzy spelling: e.g. diacritics/transliterations, never match on a short generic token alone.
  const editDistance = (u,v) => {
    const prev = Array.from({length:v.length+1}, (_,i)=>i);
    for (let i=1;i<=u.length;i++) {
      let diag=prev[0]; prev[0]=i;
      for(let j=1;j<=v.length;j++) {
        const old=prev[j];
        prev[j]=Math.min(prev[j]+1,prev[j-1]+1,diag+(u[i-1]===v[j-1]?0:1));
        diag=old;
      }
    }
    return prev[v.length];
  };
  const fuzzy = left.length>=6 && right.length>=6
    ? 1-editDistance(left,right)/Math.max(left.length,right.length) : 0;
  return Math.max(dice,fuzzy);
}
function resolverLeagueCountry(m) {
  const raw = m.raw || {};
  return String(raw._flashCountry || raw._fotmobCountry || raw.league?.country?.name || raw.league?.country || raw.tournament?.category?.country?.name || raw.country || '').toLowerCase().trim();
}
function resolverSameMatch(a, b) {
  if (a.source === b.source) return String(a.id) === String(b.id);
  const home = resolverTeamScore(a.homeName, b.homeName);
  const away = resolverTeamScore(a.awayName, b.awayName);
  // Never reverse home/away or link a match based on score alone.
  if (home < .79 || away < .79 || (home+away)/2 < .87) return false;
  const ac = resolverLeagueCountry(a), bc = resolverLeagueCountry(b);
  if (ac && bc && ac !== bc && ac.length > 2 && bc.length > 2 && !([ac,bc].includes('rou') && [ac,bc].some(x=>x.includes('romania')))) return false;
  const am = Number(a.minute), bm = Number(b.minute);
  if (Number.isFinite(am) && Number.isFinite(bm) && am > 0 && bm > 0 && Math.abs(am-bm)>15) return false;
  // Never merge distinct fixtures when both providers supply valid kickoffs.
  const kickoffMs = m => {
    const v=m.kickoff ?? m.startTime ?? m.startTimestamp ?? m.raw?.startTimestamp ?? m.raw?.startTime;
    if (v == null || v === '') return null;
    const n=Number(v);
    const t=Number.isFinite(n)&&n>1e9?(n<1e12?n*1000:n):Date.parse(v);
    return Number.isFinite(t)?t:null;
  };
  const ak=kickoffMs(a), bk=kickoffMs(b);
  if (ak!==null && bk!==null && Math.abs(ak-bk)>30*60*1000) return false;
  // A score is a changing observation, not a fixture identity. Providers can
  // disagree by several goals in the SAME scan. For near-exact team names and
  // clocks within five minutes, do not split the fixture on its live score.
  // Retain the stricter score check for fuzzy team-name matches.
  const values=[a.homeScore,b.homeScore,a.awayScore,b.awayScore];
  if (values.every(v=>v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v)))) {
    const delta=Math.abs(Number(a.homeScore)-Number(b.homeScore))+Math.abs(Number(a.awayScore)-Number(b.awayScore));
    const sameLiveFixture=home>=.94 && away>=.94 && am>0 && bm>0 && Math.abs(am-bm)<=5;
    if (delta>0 && !sameLiveFixture) return false;
  }
  return true;
}
// A strict secondary check catches provider aliases where country/league metadata
// conflicts or is stale, without linking teams solely by their score.
function resolverExactSameFixture(a,b) {
  if (!a || !b) return false;
  const ah=resolverAliasTokens(a.homeName).join('');
  const bh=resolverAliasTokens(b.homeName).join('');
  const aa=resolverAliasTokens(a.awayName).join('');
  const ba=resolverAliasTokens(b.awayName).join('');
  if (!ah || !aa || ah!==bh || aa!==ba) return false;
  const am=Number(a.minute),bm=Number(b.minute);
  if (!Number.isFinite(am)||!Number.isFinite(bm)||am<=0||bm<=0||Math.abs(am-bm)>5) return false;
  // Score must not be part of the identity check: live feeds can disagree.
  // Do not merge two known different kickoffs.
  const getKickoff=m=>m.kickoff || m.startTime || m.startTimestamp || m.raw?.startTimestamp || m.raw?.startTime;
  const ak=getKickoff(a),bk=getKickoff(b);
  if (ak && bk) {
    const toMs=v=> { const n=Number(v); return Number.isFinite(n)&&n>1e9?(n<1e12?n*1000:n):Date.parse(v); };
    const at=toMs(ak),bt=toMs(bk);
    if (Number.isFinite(at)&&Number.isFinite(bt)&&Math.abs(at-bt)>30*60*1000) return false;
  }
  return true;
}
function deduplicateMatches(matches) {
  const SOURCE_PRIORITY = { sofascore: 4, 'live-football': 3, fotmob: 2, flashscore: 1, apisports: 0 };
  const groups = [];
  for (const match of matches) {
    if (!match || !match.homeName || !match.awayName) continue;
    let group = groups.find(g => g.some(other => resolverSameMatch(other, match) || resolverExactSameFixture(other, match)));
    if (!group) { group = []; groups.push(group); }
    // Each source's matchId/eventId is preserved for its OWN detail endpoint.
    if (!group.some(x => x.source === match.source && String(x.id) === String(match.id))) group.push(match);
  }
  let joined = 0;
  const result = groups.map(group => {
    group.sort((a,b) => (SOURCE_PRIORITY[b.source] ?? -1) - (SOURCE_PRIORITY[a.source] ?? -1));
    const primary = group[0];
    primary.crossSourceMatches = group;
    primary.sourceIds = Object.fromEntries(group.map(m => [m.source, String(m.id)]));
    const actualLeague = group.map(m => m.league).find(v => v && !/^(Bóng Đá Quốc Tế|Chưa xác định giải)$/i.test(String(v)));
    if (actualLeague) primary.league = actualLeague;
    else primary.league = `Chưa xác định giải (${primary.source}:${primary.id})`;
    if (group.length > 1) {
      joined++;
      console.log(`[Cross-Source LINK] ${primary.homeName} vs ${primary.awayName} | ${group.map(m => `${m.source}:${m.id}`).join(' | ')}`);
    }
    return primary;
  });
  const duplicates = matches.length - result.length;
  if (duplicates) console.log(`[DEDUP PRE-STATS] skipped ${duplicates} redundant match records before detail/stat requests`);
  console.log(`[Cross-Source Resolver] ${matches.length} records -> ${result.length} unique matches | linked ${joined} cross-provider matches | removed ${duplicates} duplicate records | native IDs preserved`);
  if (duplicates && !joined) console.log('[Cross-Source Resolver] NOTE: duplicates may be same-source records; no cross-provider native IDs linked');
  return result;
}

// ==========================================================
// 46. CHECK MATCH HAS USEFUL STATS
// ==========================================================

function hasUsefulStats(
  stats
) {

  if (!stats) {
    return false;
  }


  return (

    stats.homeAttacks > 0 ||

    stats.awayAttacks > 0 ||

    stats.homeDangerousAttacks > 0 ||

    stats.awayDangerousAttacks > 0 ||

    stats.homeShotsOnTarget > 0 ||

    stats.awayShotsOnTarget > 0 ||

    stats.homeTotalShots > 0 ||

    stats.awayTotalShots > 0 ||

    stats.homeBlockedShots > 0 ||

    stats.awayBlockedShots > 0 ||

    stats.homeCorners > 0 ||

    stats.awayCorners > 0

  );
}


// ==========================================================
// 47. SCAN ONE MATCH
// ==========================================================

async function analyzeOneMatch(
  match,
  allOdds
) {

  const minuteRaw = match.minute ?? calculateExactMinute(match.raw);


  if (
    minuteRaw === 'HT'
  ) {

    console.log(
      `[Skip] HT | ${match.homeName} vs ${match.awayName}`
    );

    return null;
  }


  const minute =
    typeof minuteRaw === 'number'
      ? minuteRaw
      : parseInt(
          minuteRaw,
          10
        );


  // ======================================================
  // CHỈ QUÉT 46 -> 88
  // ======================================================

  if (
    !Number.isFinite(minute) ||
    minute < 46 ||
    minute > 88
  ) {

    return null;
  }


  // ======================================================
  // FILTER LEAGUE
  // ======================================================

  if (
    isFilteredLeague(
      match.league,
      match.homeName,
      match.awayName
    )
  ) {

    console.log(
      `[Skip League] ${match.league} | ${match.homeName} vs ${match.awayName}`
    );

    return null;
  }


  // ======================================================
  // FETCH STATS
  // ======================================================

  const stats =
    await fetchMatchDetailStats(
      match
    );


  // ======================================================
  // MOMENTUM
  // ======================================================

  // Alert key dùng tên đội để giữ chung
  // trạng thái nếu API nguồn thay đổi.
  const canonicalAlertKey = createMatchKey(
    resolverAliasTokens(match.homeName).join(' '),
    resolverAliasTokens(match.awayName).join(' ')
  );
  // Reuse an existing alert key even when providers spell the same team differently.
  // Only reuse when both teams are strongly matched; never match on score alone.
  const matchingAlertKeys = [...alertState.entries()].filter(([key, prior]) =>
    prior.homeName && prior.awayName &&
    resolverTeamScore(prior.homeName, match.homeName) >= .90 &&
    resolverTeamScore(prior.awayName, match.awayName) >= .90 &&
    // League labels can change after cross-provider resolution. They are NOT identity.
    // Limit name-based reuse to active match state to avoid confusing future rematches.
    Date.now() - Number(prior.updatedAt || 0) < ALERT_STATE_TTL
  );
  const sourceIdMatches = [...alertState.entries()].filter(([, prior]) =>
    prior.source === match.source && prior.sourceId &&
    String(prior.sourceId) === String(match.id) &&
    Date.now() - Number(prior.updatedAt || 0) < ALERT_STATE_TTL
  );
  const alertKey = sourceIdMatches.length === 1
    ? sourceIdMatches[0][0]
    : alertState.has(canonicalAlertKey)
      ? canonicalAlertKey
      : matchingAlertKeys.length === 1 ? matchingAlertKeys[0][0] : canonicalAlertKey;
  if (alertKey !== canonicalAlertKey) {
    console.log(`[ALERT DEDUP] ${match.homeName} vs ${match.awayName} | reused=${alertKey} | canonical=${canonicalAlertKey} | league=${match.league}`);
  }


  const momentum =
    calculateMomentum(
      alertKey,
      stats,
      minute
    );

  // Giai đoạn 46–64: chỉ thu thập dữ liệu và cập nhật Momentum.
  // Quyết định gửi Telegram chỉ được thực hiện từ phút 65.
  if (minute < MIN_TELEGRAM_MINUTE) {
    console.log(`[COLLECT 46-64] ${match.homeName} vs ${match.awayName} | ${minute}' | Momentum=${momentum?.available ? momentum.score : 'N/A'} | NO TELEGRAM`);
  }


  // ======================================================
  // ODDS
  // ======================================================

  const odds =
    findMatchOdds(
      allOdds,
      match.homeName,
      match.awayName,
      match.homeScore,
      match.awayScore
    );


  // ======================================================
  // Nếu không có stats và cũng không odds
  // thì bỏ qua.
  // ======================================================

  if (
    !hasUsefulStats(stats) &&
    !odds.found
  ) {

    console.log(
      ` └─> Không có statistics/odds đủ để phân tích`
    );

    return null;
  }


  // ======================================================
  // AI RULE
  // ======================================================

  const windows=getPressureWindow(alertKey,stats,minute,match.homeScore,match.awayScore);
  if (false && (!windows.five.available || !windows.ten.available)) console.log(`[DYNAMIC DATA] ${match.homeName} vs ${match.awayName} | ${minute}' | 5m=${windows.five.reason || 'PARTIAL'} | 10m=${windows.ten.reason || 'PARTIAL'} | partial windows allowed; require valid provider-matched delta`);
  const lastGoal=postGoalState.get(alertKey);
  const currentTotal=Number(match.homeScore)+Number(match.awayScore);
  if(lastGoal && currentTotal>lastGoal.total && minute>=lastGoal.minute) {
    postGoalState.set(alertKey,{minute,total:currentTotal,updatedAt:Date.now(),baseline:windows.current});
    console.log(`[POST GOAL] ${match.homeName} vs ${match.awayName} | detected at ${minute}' | follow 10m`);
  } else if (!lastGoal) {
    postGoalState.set(alertKey,{minute,total:currentTotal,updatedAt:Date.now(),baseline:windows.current,unverified:true});
  }
  const postGoal=postGoalState.get(alertKey);
  const ai = evaluateRuleV3(stats, momentum, minute, match.homeScore, match.awayScore, windows);
  const aiGoal = estimateRemainingGoalProbability(stats, momentum, minute, match.homeScore, match.awayScore, windows, ai);
  if(aiGoal.divergenceFlag) console.log(`[AI GOAL V3-AWARE DIVERGENCE] ${match.homeName} vs ${match.awayName} | ${minute}' | RuleV3 ${aiGoal.ruleScore}% | AI Goal ${aiGoal.percent}% | Base ${aiGoal.baselinePercent}% | Gap ${aiGoal.divergence}pp | INFO_ONLY`);



  // ======================================================
  // PREDICT FT SCORE
  // ======================================================

  const scorePrediction =
    predictFinalScore(
      match.homeScore,
      match.awayScore,
      ai.efficiency,
      minute,
      stats,
      momentum,
      ai.styleType
    );


  // ======================================================
  // ALERT DECISION
  // ======================================================

  const alertDecision =
    shouldSendAlert(
      alertKey,
      ai.efficiency,
      minute,
      momentum,
      stats,
      match.homeScore,
      match.awayScore
    );


  // After a verified score change, require fresh post-goal evidence before first alert.
  // POST GOAL only gates sending for the first 10 minutes; it never changes Rule scores.
  // At exactly minute +10, the normal Rule/Telegram decision applies again.
  if (!alertState.has(alertKey) && postGoal && !postGoal.unverified && minute>=postGoal.minute && minute-postGoal.minute<10) {
    const delta={};
    for(const f of ['TotalShots','ShotsOnTarget','Corners','BigChances'])delta[f]=pressureDelta(postGoal.baseline,windows.current,f);
    const postWindow={available:Object.values(delta).filter(v=>v!==null).length>=2,delta};
    if(!pressureEvidence(postWindow)) {
      alertDecision.send=false;alertDecision.reason='POST_GOAL_WAIT_FRESH_PRESSURE';
    }
  }

  const compactGoalTimeline =
    extractGoalTimeline(
      match.raw
    );


  const compactBigChance =
    (
      stats.homeBigChances > 0 ||
      stats.awayBigChances > 0
    )
      ? ` | BC ${stats.homeBigChances}-${stats.awayBigChances}`
      : '';


  console.log(
    `⚽ ${match.homeName} ${match.homeScore}-${match.awayScore} ${match.awayName} | ${minute}' | Goals: ${compactGoalTimeline}`
  );


  console.log(
    `📊 ATT ${stats._present?.homeAttacks===true?stats.homeAttacks:'N/A'}-${stats._present?.awayAttacks===true?stats.awayAttacks:'N/A'} | DA ${stats._present?.homeDangerousAttacks===true?stats.homeDangerousAttacks:'N/A'}-${stats._present?.awayDangerousAttacks===true?stats.awayDangerousAttacks:'N/A'} | SH ${stats.homeTotalShots}-${stats.awayTotalShots} | SOT ${stats.homeShotsOnTarget}-${stats.awayShotsOnTarget} | COR ${stats.homeCorners}-${stats.awayCorners} | POSS ${stats.homePossession}-${stats.awayPossession}${compactBigChance} | 🧠 RuleV3 ${ai.efficiency == null ? "N/A (STATS_MISSING)" : ai.efficiency+"%"} | GoalAI ${aiGoal.percent === null ? "N/A" : aiGoal.percent+"%"} | FT ${scorePrediction.text} | Alert ${alertDecision.send ? 'YES' : 'NO'}`
  );


function calculateRuleConfidence(stats, match, minute, momentum, rule) {
  // Informational reliability only; never changes Rule or Telegram gating.
  const fields=['TotalShots','ShotsOnTarget','ShotsOffTarget','BlockedShots','ShotsInsideBox',
    'ShotsOutsideBox','Corners','Attacks','DangerousAttacks','Possession','ExpectedGoals',
    'BigChances','YellowCards','RedCards','GoalkeeperSaves','Fouls'];
  const has=f=>['home','away'].some(side=>stats?._present?.[side+f]===true && Number.isFinite(Number(stats[side+f])));
  const coverage=fields.filter(has).length;
  const sources=stats?.fieldSources||stats?._fieldSources||{};
  const distinctSources=new Set(Object.values(sources).flatMap(v=>Array.isArray(v)?v:[v]).filter(Boolean)).size;
  const coverageScore=coverage/fields.length*100;
  const sourceScore=distinctSources>=2?100:distinctSources===1?70:45;
  const momentumScore=momentum?.available===true?100:40;
  const percent=Math.round((coverageScore*0.75+sourceScore*0.15+momentumScore*0.10)*100)/100;
  return {coverage,total:fields.length,percent,label:`${coverage}/${fields.length} chỉ số`,
    components:{coverage:coverageScore,sourceReliability:sourceScore,momentumReliability:momentumScore},
    method:'multi-stat-evidence-v1'};
}

  console.log(`[V3 ADVANCED] ${match.homeName} vs ${match.awayName} | ${minute}' | ${formatV3Advanced(ai,stats,minute)}`);
  const ruleConfidence = calculateRuleConfidence(stats, match, minute, momentum, ai.efficiency);
  // Một dòng trạng thái trên mỗi trận/vòng quét; không gửi Telegram khi chưa đủ điều kiện.
  const followupState = alertState.get(alertKey);
  const decisionReason = String(alertDecision.reason || 'UNKNOWN');
  const monitoring = !alertDecision.send && followupState &&
    (decisionReason.startsWith('WAIT_') || decisionReason.startsWith('NO_NEW_SPIKE') ||
     decisionReason.startsWith('MONITORING'));
  const followupStatus = alertDecision.send ? 'DU_DIEU_KIEN_GUI' : (monitoring ? 'DANG_THEO_DOI' : 'KHONG_GUI_LAI');
  console.log(`[FOLLOWUP] ${followupStatus} | ${match.homeName} vs ${match.awayName} | ${minute}' | RuleV3 ${ai.efficiency == null ? "N/A (STATS_MISSING)" : ai.efficiency+"%"} | GoalAI ${aiGoal.percent === null ? "N/A" : aiGoal.percent+"%"} | Confidence ${ruleConfidence.percent}% (${ruleConfidence.label}) | Lan ${followupState ? followupState.alertCount + 1 : 1} | ${decisionReason}`);
  const result = {

    ...match,

    ruleConfidence,

    alertKey,

    minute,

    stats,

    momentum,

    odds,

    ai,
    aiGoal,

    scorePrediction,

    goalTimeline:
      compactGoalTimeline,

    alertDecision
  };


  // ======================================================
  // SEND TELEGRAM
  // ======================================================

  if (alertDecision.send && minute >= MIN_TELEGRAM_MINUTE) {
    // Query detailed incidents only for an eligible alert, avoiding extra API calls on every scan.
    if (!odds.found) console.log(`[ODDS MATCH] ${match.homeName} vs ${match.awayName} | ${allOdds?.length || 0} events | ${odds.text || 'NO_LINE'} | no verified Over line`);
    else console.log(`[ODDS MATCH] ${match.homeName} vs ${match.awayName} | Over ${odds.point} @ ${odds.price}`);
    result.goalTimeline = await resolveVerifiedGoalHistory(match);

    const sent = await sendTelegramAlert(
      result,
      alertDecision
    );
    if (!sent) console.error(`[Telegram NOT SENT] ${match.homeName} vs ${match.awayName} | Rule ${ai.efficiency}%`);
  } else if (alertDecision.send) {
    console.log(`[Telegram BLOCK] BEFORE_65 | ${match.homeName} vs ${match.awayName}`);
  }


  return result;
}


// ==========================================================
// 48. MAIN SCANNER
// ==========================================================

async function scanLiveMatches() {

  if (scanRunning) {

    console.log(
      '[Auto-Scan] Vòng trước chưa hoàn thành -> bỏ vòng này.'
    );

    return;
  }


  scanRunning = true;
  const scanHttpStart = {networkCalls:httpMetrics.networkCalls, cacheHits:httpMetrics.cacheHits, fallbackCalls:httpMetrics.fallbackCalls, failedCalls:httpMetrics.failedCalls};

  const startedAt =
    Date.now();


  try {

    await hydrateAlertState();
    cleanupState();


    const vn =
      getVietnamTime();


    console.log('');
    console.log(
      '================================================'
    );

    console.log(
      `[Auto-Scan] ${vn.dateStr} ${vn.timeStr} VN`
    );

    console.log(
      '================================================'
    );


    // ====================================================
    // LIVE MATCHES + ODDS SONG SONG
    // ====================================================

    const [
      liveMatches,
      allOdds
    ] = await Promise.all([

      fetchAllLiveMatches(),

      fetchAllLiveOdds()

    ]);


    console.log(
      `[Live] Tổng từ API: ${liveMatches.length}`
    );


    // ====================================================
    // DEDUPE
    // ====================================================

    const uniqueMatches =
      deduplicateMatches(
        liveMatches
      );


    console.log(
      `[Live] Sau khi loại trùng: ${uniqueMatches.length}`
    );


    // ====================================================
    // PRE FILTER 46 -> 88
    // ====================================================

    const eligibleMatches = [];


    for (
      const match of uniqueMatches
    ) {

      const minuteRaw =
        calculateExactMinute(
          match.raw
        );


      if (
        minuteRaw === 'HT'
      ) {
        continue;
      }


      const minute =
        typeof minuteRaw ===
        'number'
          ? minuteRaw
          : parseInt(
              minuteRaw,
              10
            );


      if (
        !Number.isFinite(minute) ||
        minute < 46 ||
        minute > 88
      ) {
        continue;
      }


      if (
        isFilteredLeague(
          match.league,
          match.homeName,
          match.awayName
        )
      ) {
        continue;
      }


      eligibleMatches.push(
        match
      );
    }


    console.log(
      `[Live] Đủ điều kiện phút 46-88: ${eligibleMatches.length}`
    );


    // ====================================================
    // ANALYZE
    //
    // Chạy từng trận để tránh spam RapidAPI.
    // ====================================================

    const results = [];
    const processedFixtures = [];
    let scanDuplicateCount = 0;

    for (
      const match of
      eligibleMatches
    ) {
      if (processedFixtures.some(prev => resolverSameMatch(prev, match) || resolverExactSameFixture(prev, match))) {
        scanDuplicateCount++;
        console.log(`[API DEDUP] SKIP_FIXTURE ${match.homeName} vs ${match.awayName} | ${match.source}:${match.id}`);
        continue;
      }
      processedFixtures.push(match);

      try {

        const result =
          await analyzeOneMatch(
            match,
            allOdds
          );


        if (result) {

          results.push(
            result
          );
        }

      } catch (e) {

        console.error(
          `[Match Error] ${match.homeName} vs ${match.awayName}:`,
          e.message
        );
      }
    }


    // ====================================================
    // SORT LOG
    // ====================================================

    const ranked =
      results
        .slice()
        .sort(
          (a, b) =>
            b.ai.efficiency -
            a.ai.efficiency
        );


    console.log('');
    console.log(
      '--------------- TOP RULE ---------------'
    );
    console.log(`[API DEDUP SUMMARY] eligible=${eligibleMatches.length} | uniqueAnalyzed=${processedFixtures.length} | duplicateSkipped=${scanDuplicateCount} | detailAttemptsLifetime=${providerStatsCounters.network} | reusedLifetime=${providerStatsCounters.reused} | emptyReusedLifetime=${providerStatsCounters.skippedUnavailable}`);
    console.log(`[API REQUEST METRICS] networkCalls=${httpMetrics.networkCalls} | cacheHits=${httpMetrics.cacheHits} | fallbackCalls=${httpMetrics.fallbackCalls} | failedCalls=${httpMetrics.failedCalls} | scope=PROCESS_LIFETIME | bySource=${JSON.stringify(httpMetrics.bySource)}`);
    console.log(`[API REQUEST THIS SCAN] networkCalls=${httpMetrics.networkCalls-scanHttpStart.networkCalls} | cacheHits=${httpMetrics.cacheHits-scanHttpStart.cacheHits} | fallbackCalls=${httpMetrics.fallbackCalls-scanHttpStart.fallbackCalls} | failedCalls=${httpMetrics.failedCalls-scanHttpStart.failedCalls}`);


    for (
      const item of
      ranked.slice(0, 10)
    ) {

      console.log(
        `${item.minute}' | ${item.ai.efficiency == null ? "N/A" : item.ai.efficiency+"%"} | ${item.homeName} ${item.homeScore}-${item.awayScore} ${item.awayName}`
      );
    }


    const duration =
      (
        (
          Date.now() -
          startedAt
        ) /
        1000
      ).toFixed(1);


    console.log(
      `Scan hoàn tất trong ${duration}s`
    );


    console.log(
      '========================================'
    );


    return ranked;

  } catch (e) {

    console.error(
      '[Auto-Scan Error]',
      e.response?.data ||
      e.message
    );

    return [];

  } finally {

    scanRunning = false;
  }
}


// ==========================================================
// 49. EXPRESS ROUTES
// ==========================================================

app.get(
  '/',
  (req, res) => {

    res.json({
      status: 'ok',

      bot:
        'Football Live AI Rule Bot',

      scanMinutes:
        '46-88',

      telegramThreshold:
        MIN_SEND_PERCENTAGE,

      bigBetThreshold:
        BIG_BET_PERCENTAGE,

      scanIntervalMinutes:
        SCAN_INTERVAL_MS /
        60000,

      features: [
        'Attacks',
        'Dangerous Attacks',
        'Possession',
        'Shots on Target',
        'Corners',
        'End-to-End',
        'Pressure',
        'Momentum',
        'Live Odds',
        'FT Score Prediction'
      ]
    });
  }
);


// ==========================================================
// HEALTH
// ==========================================================

app.get(
  '/health',
  (req, res) => {

    res.json({
      status: 'healthy',
      scanRunning,
      alertMatches:
        alertState.size,
      snapshots:
        snapshotState.size,
      cache:
        statsCache.size,
      time:
        new Date()
          .toISOString()
    });
  }
);


// ==========================================================
// MANUAL SCAN
//
// Truy cập:
//
// https://ten-app.onrender.com/scan
//
// ==========================================================

app.get(
  '/scan',
  async (req, res) => {

    if (scanRunning) {

      return res.status(409).json({
        ok: false,
        message:
          'Scanner đang chạy'
      });
    }


    try {

      const results =
        await scanLiveMatches();


      res.json({
        ok: true,

        analyzed:
          results?.length || 0,

        matches:
          (results || [])
            .slice(0, 20)
            .map(
              x => ({
                league:
                  x.league,

                minute:
                  x.minute,

                match:
                  `${x.homeName} ${x.homeScore}-${x.awayScore} ${x.awayName}`,

                rule:
                  x.ai.efficiency,

                level:
                  x.ai.level,

                predictedFT:
                  x.scorePrediction.text,

                likelyScorer:
                  x.scorePrediction.likelyScorer,

                momentum:
                  x.momentum.score,

                alert:
                  x.alertDecision
                    .send
              })
            )
      });

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


// ==========================================================
// 50. START SERVER
// ==========================================================

audit.setup(app);
audit.init().catch(e=>console.error('[AUDIT INIT]',e.message));
setInterval(()=>audit.reconcile().catch(e=>console.error('[AUDIT FT]',e.message)), 5 * 60 * 1000);
setTimeout(()=>audit.reconcile().catch(e=>console.error('[AUDIT FT]',e.message)), 30 * 1000);

app.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );


    console.log(
      `Telegram Alert >= ${MIN_SEND_PERCENTAGE}%`
    );


    console.log(
      `BIG BET >= ${BIG_BET_PERCENTAGE}%`
    );


    console.log(
      'Scan minute: 46 -> 88'
    );


    console.log(
      `Auto scan every ${SCAN_INTERVAL_MS / 60000} minutes`
    );


    // Chạy lần đầu sau 10 giây
    setTimeout(
      () => {

        scanLiveMatches()
          .catch(
            e =>
              console.error(
                '[Initial Scan]',
                e.message
              )
          );

      },
      10000
    );


   // Sau đó 5 phút / lần
setInterval(
  () => {
    scanLiveMatches()
      .catch(
        e =>
          console.error(
            '[Auto Scan]',
            e.message
          )
      );
  },
  SCAN_INTERVAL_MS
);

  }
);
