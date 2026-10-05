
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

// API chính theo gói RapidAPI của Render. Không hard-code key.
const PRIMARY_RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'free-api-live-football-data.p.rapidapi.com';
const PRIMARY_LIVE_URL = `https://${PRIMARY_RAPIDAPI_HOST}/football-current-live`;

// Primary Premium: match-detail/statistics adapter.
// API này dùng nhiều tên route giữa các version. Bot thử các route detail phổ biến
// trên CÙNG host/subscription hiện tại; dừng ngay khi tìm được response 200 có stats.
const PRIMARY_DETAIL_ROUTE_BUILDERS = [
  (id) => ({ path: '/football-get-match-detail', params: { eventid: id } }),
  (id) => ({ path: '/football-get-match-detail', params: { matchid: id } }),
  (id) => ({ path: '/football-match-detail', params: { eventid: id } }),
  (id) => ({ path: '/football-match-detail', params: { matchid: id } }),
  (id) => ({ path: '/football-get-match-statistics', params: { eventid: id } }),
  (id) => ({ path: '/football-get-match-statistics', params: { matchid: id } })
];
const primaryWorkingDetailRoute = { value: null };


// Legacy sources chỉ làm fallback. Khi một nguồn trả 429, bot tạm nghỉ nguồn đó
// để không đốt quota / spam request trong các vòng quét tiếp theo.
const SOURCE_429_COOLDOWN_MS = 60 * 60 * 1000;
const sourceCooldownUntil = new Map();

// Trận Interrupted thường vẫn nằm trong feed live rất lâu.
// Sau lần đầu gặp IR, tạm ẩn khỏi log/scan 60 phút rồi mới kiểm tra lại.
const INTERRUPTED_COOLDOWN_MS = 60 * 60 * 1000;
const interruptedCooldownUntil = new Map();

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL =
  `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

const FLASHSCORE_HOST = 'flashscore-api1.p.rapidapi.com';
const FLASHSCORE_LIVE_URL =
  `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/live?sport_id=1`;

const LIVE_FOOTBALL_HOST =
  'football-live-stream-api.p.rapidapi.com';

const LIVE_FOOTBALL_URL =
  `https://${LIVE_FOOTBALL_HOST}/matches`;

// The Odds API: `upcoming` is a valid sport key and also returns live games.
// One region + one market = 1 credit per successful request.
const ODDS_API_URL = ODDS_API_KEY
  ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`
  : '';


// ==========================================================
// 2. ALERT / CACHE CONFIG
// ==========================================================

// >= 58% gửi Telegram
const MIN_SEND_PERCENTAGE = 58.0;

// >= 75% BIG BET
const BIG_BET_PERCENTAGE = 75.0;

// Sau cảnh báo đầu tiên:
// AI phải tăng ít nhất +10% mới cảnh báo lại
const ALERT_INCREASE_THRESHOLD = 10.0;

// Tối đa 3 cảnh báo / trận
const MAX_ALERTS_PER_MATCH = 3;

// Khoảng cách tối thiểu giữa 2 cảnh báo
const MIN_ALERT_GAP_MINUTES = 5;

// Xóa trạng thái trận cũ sau 4 giờ
const ALERT_STATE_TTL =
  4 * 60 * 60 * 1000;

// Cache statistics 90 giây
const STATS_CACHE_TTL =
  90 * 1000;

// Quét 7 phút / lần để giảm số lượt gọi API
const SCAN_INTERVAL_MS =
  7 * 60 * 1000;

// Log gọn mặc định. Đặt DEBUG_LOG=true trên Render nếu cần chẩn đoán chi tiết.
const DEBUG_LOG = String(process.env.DEBUG_LOG || 'false').toLowerCase() === 'true';
const debugLog = (...args) => { if (DEBUG_LOG) console.log(...args); };

// Pro Sofa = 10.000 request/tháng. Live 7 phút/lần ~6.171 request/tháng.
// Tối đa 2 request Sofa statistics/vòng. Cache 15 phút; ưu tiên trận chưa có dữ liệu.
// Mục tiêu: không làm trận H2 thứ 2 biến mất nhưng vẫn kiểm soát quota Pro.
const SOFA_STATS_PER_SCAN_LIMIT = 2;
const SOFA_STATS_CACHE_TTL = 15 * 60 * 1000;
let sofaStatsRequestsThisScan = 0;


const alertState = new Map();

const statsCache = new Map();

// Lưu snapshot để tính Momentum
const snapshotState = new Map();
// Baseline H2: tuyệt đối không dùng thống kê H1 cộng dồn để chấm Rule.
const h2BaselineState = new Map();

let scanRunning = false;


// ==========================================================
// CLEAN CACHE
// ==========================================================

function cleanupState() {

  const now = Date.now();

  for (const [key, until] of interruptedCooldownUntil.entries()) {
    if (!until || until <= now) interruptedCooldownUntil.delete(key);
  }

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


  for (const [id, state] of h2BaselineState.entries()) {
    if (state.updatedAt && now - state.updatedAt > ALERT_STATE_TTL) h2BaselineState.delete(id);
  }

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

  'Premier League':
    'Ngoại Hạng Anh',

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

function parseLeagueName(item) {

  if (!item) {
    return 'Bóng Đá Quốc Tế';
  }


  const category =

    item.tournament?.category?.name ||

    item.category?.name ||

    item.country?.name ||

    '';


  const tournament =

    item.tournament?.name ||

    item.competitionName ||

    item.league?.name ||

    item.league ||

    item.competition ||

    '';


  if (
    LEAGUE_NAME_MAP[tournament]
  ) {

    return (
      LEAGUE_NAME_MAP[tournament]
    );
  }


  const translatedCategory =

    COUNTRY_MAP[category] ||

    category;


  let translatedTournament =

    String(tournament)

      .replace(
        /\bPremier League\b/gi,
        'Giải VĐQG'
      )

      .replace(
        /\bDivision 1\b/gi,
        'Hạng 1'
      )

      .replace(
        /\bDivision 2\b/gi,
        'Hạng 2'
      )

      .replace(
        /\bSuper League\b/gi,
        'VĐQG'
      )

      .replace(
        /\bCup\b/gi,
        'Cúp'
      );


  if (
    translatedCategory &&
    translatedTournament
  ) {

    if (
      translatedTournament
        .toLowerCase()
        .includes(
          translatedCategory
            .toLowerCase()
        )
    ) {

      return translatedTournament;
    }


    return (
      `${translatedTournament} (${translatedCategory})`
    );
  }


  return (
    translatedTournament ||
    translatedCategory ||
    'Bóng Đá Quốc Tế'
  );
}


// ==========================================================
// FILTER LEAGUE
// ==========================================================

function isFilteredLeague(
  leagueName,
  homeName,
  awayName
) {

  // Quét live toàn cầu: không loại U21/reserve/regional chỉ vì tên giải.
  // Chỉ status/phút quyết định việc đưa trận vào scan.
  return false;

  /* Legacy filter giữ lại bên dưới để dễ khôi phục nếu cần.

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
*/
}


// ==========================================================
// 5. MINUTE
// GIỮ LOGIC ĐA NGUỒN
// CHỈ QUÉT 46 -> 92
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


// ==========================================================
// CALCULATE EXACT MINUTE
// ==========================================================

function collectMinuteCandidatesDeep(root) {
  const out = [];
  const seen = new Set();
  const keyRe = /^(minute|minutes|matchminute|match_minute|liveminute|live_minute|elapsed|elapsedtime|elapsed_time|livetime|live_time|clock|timer|matchtime|match_time|currentminute|current_minute|played|time)$/i;

  function walk(value, key = '', depth = 0) {
    if (value == null || depth > 6) return;
    if (typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const v of value.slice(0, 30)) walk(v, key, depth + 1);
        return;
      }
      for (const [k, v] of Object.entries(value)) {
        if (keyRe.test(k)) {
          if (v && typeof v === 'object') {
            for (const subKey of ['short', 'long', 'value', 'current', 'minute', 'minutes', 'elapsed']) {
              if (v[subKey] !== undefined) out.push(v[subKey]);
            }
          } else {
            out.push(v);
          }
        }
        if (v && typeof v === 'object') walk(v, k, depth + 1);
      }
    }
  }
  walk(root);
  return out;
}

function compactClockDebug(item) {
  const pick = {
    minute: item?.minute,
    minutes: item?.minutes,
    matchMinute: item?.matchMinute ?? item?.match_minute,
    liveMinute: item?.liveMinute ?? item?.live_minute,
    elapsed: item?.elapsed ?? item?.elapsedTime ?? item?.elapsed_time,
    liveTime: item?.status?.liveTime ?? item?.status?.live_time ?? item?.liveTime ?? item?.live_time,
    status: item?.status,
    time: item?.time,
    clock: item?.clock,
    timer: item?.timer,
    matchTime: item?.matchTime ?? item?.match_time
  };
  try { return JSON.stringify(pick); } catch (_) { return '[unserializable]'; }
}

function calculateExactMinute(item) {

  if (!item) {
    return 0;
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

    // Primary LiveFootball: status.liveTime can be either an object
    // ({ short: "52'", long: "52:14" }) or a direct string.
    item.status?.liveTime,

    item.status?.liveTime?.short,

    item.status?.liveTime?.long,

    item.status?.live_time,

    item.status?.live_time?.short,

    item.status?.live_time?.long,

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


  // Fallback: một số response Primary thay đổi vị trí field phút giữa các trận.
  // Chỉ quét các key liên quan clock/time, không lấy số từ score hoặc ID.
  candidates.push(...collectMinuteCandidatesDeep(item));

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


// ==========================================================
// MATCH CLOCK / STATUS CLASSIFICATION FOR FILTER LOGS
// Does not invent a minute when the provider only returns a state.
// ==========================================================

function classifyMatchClock(item, minuteRaw) {
  const liveTime =
    item?.status?.liveTime ??
    item?.status?.live_time ??
    item?.liveTime ??
    item?.live_time ??
    null;

  const short = String(
    liveTime?.short ??
    liveTime?.shortKey ??
    liveTime ??
    ''
  ).trim().toLowerCase();

  const long = String(
    liveTime?.long ??
    item?.status?.description ??
    item?.status?.type ??
    item?.status?.name ??
    item?.stage ??
    item?.state ??
    ''
  ).trim().toLowerCase();

  const combined = `${short} ${long}`;

  if (
    /(^|\\s)(ir|int|interrupted|suspended|susp)(\\s|$)/i.test(combined) ||
    combined.includes('interrupted') ||
    combined.includes('suspended')
  ) {
    return { kind: 'INTERRUPTED', minute: null, raw: short || long || 'IR' };
  }

  if (
    minuteRaw === 'HT' ||
    /(^|\\s)(ht|half[ -]?time)(\\s|$)/i.test(combined)
  ) {
    return { kind: 'HALFTIME', minute: null, raw: short || long || 'HT' };
  }

  if (
    minuteRaw === 999 ||
    /(^|\\s)(ft|finished|ended|full[ -]?time|cancelled|canceled|postponed)(\\s|$)/i.test(combined)
  ) {
    return { kind: 'FINISHED', minute: null, raw: short || long || 'FT' };
  }

  const minute = typeof minuteRaw === 'number'
    ? minuteRaw
    : parseInt(minuteRaw, 10);

  if (Number.isFinite(minute) && minute > 0 && minute < 999) {
    return { kind: 'MINUTE', minute, raw: short || String(minuteRaw) };
  }

  return { kind: 'UNKNOWN', minute: null, raw: short || long || 'N/A' };
}

function isPlaceholderMatch(match) {
  const home = String(match?.homeName || '').trim().toLowerCase();
  const away = String(match?.awayName || '').trim().toLowerCase();

  return (
    !home || !away ||
    (home === 'home' && away === 'away') ||
    home === 'home team' || away === 'away team' ||
    home === 'unknown' || away === 'unknown'
  );
}

// ==========================================================
// 6. FETCH LIVE MATCHES
// ==========================================================

function sourceInCooldown(name) {
  return (sourceCooldownUntil.get(name) || 0) > Date.now();
}

function handleRapidApiError(name, e) {
  const status = e.response?.status;
  const headers = e.response?.headers || {};
  const data = e.response?.data;

  console.error(`[${name}]`, {
    status: status || null,
    message: data?.message || e.message,
    remaining: headers['x-ratelimit-requests-remaining'] ?? headers['x-ratelimit-remaining'] ?? null,
    reset: headers['x-ratelimit-requests-reset'] ?? headers['x-ratelimit-reset'] ?? null
  });

  if (status === 429) {
    sourceCooldownUntil.set(name, Date.now() + SOURCE_429_COOLDOWN_MS);
    console.log(`[${name}] 429 -> tạm nghỉ nguồn này 60 phút, bot tiếp tục nguồn khác.`);
  }
}

async function fetchLiveMatchesFromPrimaryRapidApi() {
  try {
    if (!PAID_RAPIDAPI_KEY || !PRIMARY_RAPIDAPI_HOST) return [];
    if (sourceInCooldown('Primary RapidAPI')) return [];

    const r = await axios.get(PRIMARY_LIVE_URL, {
      headers: {
        'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
        'x-rapidapi-host': PRIMARY_RAPIDAPI_HOST
      },
      timeout: 10000
    });

    const rows = r.data?.response?.live || r.data?.live || r.data?.response || [];
    const list = Array.isArray(rows) ? rows : [];
    console.log(`[Primary RapidAPI] HTTP ${r.status} | live: ${list.length}`);
    return list;
  } catch (e) {
    handleRapidApiError('Primary RapidAPI', e);
    return [];
  }
}

async function fetchLiveMatchesFromSofaScore() {

  try {

    if (!PAID_RAPIDAPI_KEY || sourceInCooldown('Sofa Live')) {
      return [];
    }


    const r =
      await axios.get(
        SOFASCORE_LIVE_URL,
        {
          headers: {

            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY
                .trim(),

            'x-rapidapi-host':
              SOFASCORE_HOST

          },

          timeout: 10000
        }
      );


    const list = r.data?.events || r.data?.liveEvents || [];
    const rows = Array.isArray(list) ? list : [];
    debugLog(`[Sofa Live] HTTP ${r.status} | live: ${rows.length}`);
    return rows;

  } catch (e) {

    handleRapidApiError('Sofa Live', e);

    return [];
  }
}


// ==========================================================
// FLASHSCORE LIVE
// ==========================================================

async function fetchLiveMatchesFromFlashScore() {

  if (sourceInCooldown('FlashScore Live')) {
    debugLog('[FlashScore Live] cooldown -> skip');
    return [];
  }

  console.log('[FlashScore Live] REQUEST...');

  if (!PAID_RAPIDAPI_KEY) {
    console.log('[FlashScore Live] SKIP | thiếu RAPIDAPI_KEY');
    return [];
  }

  try {
    const r = await axios.get(FLASHSCORE_LIVE_URL, {
      headers: {
        'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
        'x-rapidapi-host': FLASHSCORE_HOST
      },
      timeout: 8000,
      validateStatus: () => true
    });

    if (r.status < 200 || r.status >= 300) {
      const message = r.data?.message || r.data?.error ||
        (typeof r.data === 'string' ? r.data.slice(0, 300) : 'HTTP error');
      console.log(`[FlashScore Live] HTTP ${r.status} | ERROR: ${message}`);
      if (r.status === 429) {
        sourceCooldownUntil.set('FlashScore Live', Date.now() + SOURCE_429_COOLDOWN_MS);
        sourceCooldownUntil.set('FlashScore Stats', Date.now() + SOURCE_429_COOLDOWN_MS);
        console.log('[FlashScore Live] 429 -> tạm nghỉ nguồn bổ sung này 60 phút.');
      }
      return [];
    }

    const body = r.data;
    const keys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body).slice(0, 20).join(',')
      : (Array.isArray(body) ? '[array]' : typeof body);
    console.log(`[FlashScore Live] HTTP ${r.status} | response keys: ${keys || 'none'}`);

    // Hỗ trợ các response shape thường gặp mà không tạo dữ liệu giả.
    const candidates = [
      body,
      body?.data,
      body?.matches,
      body?.events,
      body?.response,
      body?.data?.matches,
      body?.data?.events,
      body?.data?.response
    ];
    const list = candidates.find(Array.isArray) || [];

    console.log(`[FlashScore Live] parsed live: ${list.length}`);
    return list;

  } catch (e) {
    console.log(
      `[FlashScore Live] REQUEST FAILED | ${e.code || 'ERR'} | ${e.message || 'Unknown error'}`
    );
    return [];
  }
}


// ==========================================================
// LIVE FOOTBALL
// ==========================================================

async function fetchLiveMatchesFromLiveFootball() {

  try {

    if (!PAID_RAPIDAPI_KEY) {
      return [];
    }


    const r =
      await axios.get(
        LIVE_FOOTBALL_URL,
        {
          params: {
            status: 'live'
          },

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


    const list = r.data?.result || r.data?.matches || r.data?.data || [];
    const rows = Array.isArray(list) ? list : [];
    console.log(`[LiveFootball] HTTP ${r.status} | live: ${rows.length}`);
    return rows;

  } catch (e) {
    handleRapidApiError('LiveFootball', e);
    return [];
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

    homeBigChances: 0,
    awayBigChances: 0,

    homeGoalkeeperSaves: 0,
    awayGoalkeeperSaves: 0,

    homeFouls: 0,
    awayFouls: 0,


    // Theo dõi trường nào API THỰC SỰ trả về.
    // Nhờ vậy 0-0 thật khác với dữ liệu bị thiếu.
    availableStats: {},

    // Có lấy được dữ liệu hay không
    hasData: false,

    source: null
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
      key === 'source' ||
      key === 'availableStats'
    ) {
      continue;
    }

    const value =
      safeNumber(source[key]);

    if (value > 0) {
      target[key] = value;
    }
  }

  if (source.availableStats && typeof source.availableStats === 'object') {
    target.availableStats = {
      ...(target.availableStats || {}),
      ...source.availableStats
    };
  }

  if (source.hasData || Object.values(source.availableStats || {}).some(Boolean)) {
    target.hasData = true;
  }

  if (source.source) { target.source = source.source; }
  if (source.isSecondHalfPeriod) target.isSecondHalfPeriod = true;

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

  // Chỉ đánh dấu available khi API thực sự có field/value.
  // Giá trị 0 vẫn là dữ liệu hợp lệ nếu field tồn tại.
  const homeProvided = homeValue !== undefined && homeValue !== null && homeValue !== '';
  const awayProvided = awayValue !== undefined && awayValue !== null && awayValue !== '';
  if (homeProvided || awayProvided) {
    stats.availableStats = stats.availableStats || {};
    stats.availableStats[type] = true;
    stats.hasData = true;
  }


  const home =
    safeNumber(homeValue);

  const away =
    safeNumber(awayValue);


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
// 9B. PRIMARY RAPIDAPI PREMIUM - MATCH DETAIL / STATISTICS
// ==========================================================
async function fetchPrimaryRapidApiStats(matchId) {
  const empty = createEmptyStats();
  if (!PAID_RAPIDAPI_KEY || !PRIMARY_RAPIDAPI_HOST || !matchId || sourceInCooldown('Primary Stats')) return empty;

  const headers = {
    'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
    'x-rapidapi-host': PRIMARY_RAPIDAPI_HOST
  };

  let probes = PRIMARY_DETAIL_ROUTE_BUILDERS.map(build => build(matchId));
  if (primaryWorkingDetailRoute.value) {
    const preferred = probes.find(x => x.path === primaryWorkingDetailRoute.value.path &&
      Object.keys(x.params)[0] === primaryWorkingDetailRoute.value.paramKey);
    if (preferred) probes = [preferred];
  }

  for (const probe of probes) {
    const url = `https://${PRIMARY_RAPIDAPI_HOST}${probe.path}`;
    try {
      const r = await axios.get(url, { headers, params: probe.params, timeout: 8000 });
      const data = r.data;
      const stats = createEmptyStats();
      parseDirectKeys(data, stats);
      recursivelyParseStats(data, stats);

      const paramKey = Object.keys(probe.params)[0];
      console.log(`[Primary Stats] ${probe.path}?${paramKey}=... | HTTP ${r.status} | ${stats.hasData ? 'STATS OK' : 'không có stats'}`);

      // Route 200 là route hợp lệ: nhớ lại để các trận sau không probe 6 lần.
      primaryWorkingDetailRoute.value = { path: probe.path, paramKey };

      if (stats.hasData) {
        stats.source = 'primary-rapidapi-detail';
        return stats;
      }

      // Route hợp lệ nhưng trận không có coverage stats -> không spam các route khác.
      return stats;
    } catch (e) {
      const status = e.response?.status || 'NO_RESPONSE';
      const message = e.response?.data?.message || e.response?.data?.error || e.message || 'Unknown error';
      if (status === 404) {
        console.log(`[Primary Stats] ${probe.path} | HTTP 404 -> thử route kế tiếp`);
        continue;
      }
      if (status === 429) {
        handleRapidApiError('Primary Stats', e);
        return empty;
      }
      if (status === 401 || status === 403) {
        console.log(`[Primary Stats] ${probe.path} | HTTP ${status} | ${message}`);
        continue;
      }
      console.log(`[Primary Stats] ${probe.path} | HTTP ${status} | ${message}`);
    }
  }

  console.log(`[Primary Stats] match ${matchId} | chưa tìm được route detail/statistics hợp lệ trên host hiện tại`);
  return empty;
}

function findSecondHalfStatNode(root) {
  const seen = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    const period = String(node.period ?? node.periodName ?? node.name ?? '').toUpperCase();
    if (['2ND','SECOND','SECOND_HALF','2H','2'].includes(period) && (node.groups || node.statistics || node.stats)) return node;
    if (Array.isArray(node)) { for (const x of node) { const r=walk(x); if (r) return r; } }
    else { for (const v of Object.values(node)) { const r=walk(v); if (r) return r; } }
    return null;
  }
  return walk(root);
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
    !matchId ||
    sourceInCooldown('Sofa Stats') ||
    sourceInCooldown('Sofa Live')
  ) {
    return stats;
  }

  const sofaCacheKey = `sofa:${matchId}`;
  const sofaCached = statsCache.get(sofaCacheKey);
  if (sofaCached && Date.now() - sofaCached.time < SOFA_STATS_CACHE_TTL) return sofaCached.data;
  if (sofaStatsRequestsThisScan >= SOFA_STATS_PER_SCAN_LIMIT) return stats;
  sofaStatsRequestsThisScan += 1;


  const urls = [

    `https://${SOFASCORE_HOST}/matches/get-statistics?matchId=${matchId}`,

    `https://${SOFASCORE_HOST}/matches/get-statistics?eventId=${matchId}`

  ];


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


      const secondHalfNode = findSecondHalfStatNode(r.data);
      const statsRoot = secondHalfNode || r.data;
      parseDirectKeys(statsRoot, stats);
      recursivelyParseStats(statsRoot, stats);
      if (secondHalfNode && stats.hasData) stats.isSecondHalfPeriod = true;


      if (
        stats.hasData
      ) {

        stats.source =
          'sofascore';
        statsCache.set(sofaCacheKey, { time: Date.now(), data: stats });

        return stats;
      }

    } catch (e) {

      if (e.response?.status === 429) {
        handleRapidApiError('Sofa Stats', e);
        break;
      }
      // Thử endpoint tiếp theo nếu không phải rate-limit.
    }
  }


  return stats;
}


// ==========================================================
// 11. FLASHSCORE STATISTICS
// ==========================================================

async function fetchFlashScoreStats(
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

    `https://${FLASHSCORE_HOST}/api/flashscore/v2/match/${matchId}/statistics`,

    `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/${matchId}/statistics`,

    `https://${FLASHSCORE_HOST}/api/flashscore/v2/match/statistics?match_id=${matchId}`

  ];


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

        return stats;
      }

    } catch (e) {
      const status = e.response?.status || 'NO_RESPONSE';
      const message = e.response?.data?.message || e.response?.data?.error || e.message || 'Unknown error';
      console.log(`[FlashScore Stats] endpoint ${url} | HTTP ${status} | ${message}`);
      // thử endpoint tiếp
    }
  }

  console.log(`[FlashScore Stats] match ${matchId} | không lấy được statistics`);
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

  // Primary LiveFootball thường lồng statistics sâu trong object live.
  // Quét toàn bộ raw match để không bỏ sót stats chỉ vì provider đổi nesting.
  recursivelyParseStats(
    raw,
    stats
  );


  const candidates = [

    raw.statistics,

    raw.stats,

    raw.matchStatistics,

    raw.match_statistics,

    raw.liveStats,

    raw.live_stats

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

// Cache danh sách live của nguồn phụ. Các nguồn này KHÔNG tạo trận để quét;
// chỉ dùng để tìm đúng event ID và bổ sung statistics cho trận LiveFootball chính.
const supplementLiveCache = new Map();
const SUPPLEMENT_LIVE_TTL = 6 * 60 * 1000;

async function getSupplementLive(source) {
  const cached = supplementLiveCache.get(source);
  if (cached && Date.now() - cached.time < SUPPLEMENT_LIVE_TTL) return cached.rows;

  let rawRows = [];
  if (source === 'sofascore') rawRows = await fetchLiveMatchesFromSofaScore();
  if (source === 'flashscore') rawRows = await fetchLiveMatchesFromFlashScore();
  if (source === 'primary-rapidapi') rawRows = await fetchLiveMatchesFromPrimaryRapidApi();

  const rows = (Array.isArray(rawRows) ? rawRows : [])
    .map(raw => formatLiveMatch(raw, source))
    .filter(m => !isPlaceholderMatch(m));

  supplementLiveCache.set(source, { time: Date.now(), rows });
  return rows;
}

function findSupplementMatch(rows, primaryMatch) {
  return (rows || []).find(m =>
    teamNamesSimilar(m.homeName, primaryMatch.homeName) &&
    teamNamesSimilar(m.awayName, primaryMatch.awayName)
  ) || (rows || []).find(m =>
    teamNamesSimilar(m.homeName, primaryMatch.awayName) &&
    teamNamesSimilar(m.awayName, primaryMatch.homeName)
  ) || null;
}

async function fetchSupplementStats(match, source) {
  try {
    const rows = await getSupplementLive(source);
    const found = findSupplementMatch(rows, match);
    if (!found?.id) {
      debugLog(`[Supplement] ${source} | ${match.homeName} vs ${match.awayName} | không tìm thấy trận tương ứng`);
      return createEmptyStats();
    }

    debugLog(`[Supplement] ${source} | matched ID=${found.id}`);
    if (source === 'sofascore') return await fetchSofaScoreStats(found.providerId || found.id);
    if (source === 'primary-rapidapi') return found.providerId ? await fetchPrimaryRapidApiStats(found.providerId) : createEmptyStats();
    return await fetchFlashScoreStats(found.providerId || found.id);
  } catch (e) {
    console.log(`[Supplement] ${source} | ERROR: ${e.message}`);
    return createEmptyStats();
  }
}

async function fetchMatchDetailStats(match) {
  const cacheKey = `${match.source}:${match.id}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.time < STATS_CACHE_TTL) return cached.data;

  // Sofa MAIN: tận dụng dữ liệu có sẵn trong live response trước, không tốn request.
  let stats = parseStatsFromRawMatch(match.raw);
  if (stats.hasData) stats.source = 'sofascore-live';

  // Chỉ gọi detail Sofa khi raw live chưa đủ. Có budget 1 request/vòng + cache 15 phút.
  if (match.source === 'sofascore' && match.providerId) {
    const sofaStats = await fetchSofaScoreStats(match.providerId);
    mergeStats(stats, sofaStats);
  }

  // LiveFootball là nguồn phụ: chỉ bổ sung field còn thiếu.
  if (!sourceInCooldown('Primary RapidAPI') && !sourceInCooldown('Primary Stats')) {
    const primaryStats = await fetchSupplementStats(match, 'primary-rapidapi');
    mergeStats(stats, primaryStats);
  }

  // FlashScore là fallback cuối. 429 sẽ tự cooldown 60 phút.
  if (!sourceInCooldown('FlashScore Live') && !sourceInCooldown('FlashScore Stats')) {
    const flashStats = await fetchSupplementStats(match, 'flashscore');
    mergeStats(stats, flashStats);
  }

  if (stats.hasData) stats.source = 'merged:sofascore+supplements';

  if (stats.homeTotalShots <= 0) {
    stats.homeTotalShots = stats.homeShotsOnTarget + stats.homeShotsOffTarget + stats.homeBlockedShots;
    if (stats.availableStats?.shotsOnTarget || stats.availableStats?.shotsOffTarget || stats.availableStats?.blockedShots) {
      stats.availableStats.totalShots = true; stats.hasData = true;
    }
  }
  if (stats.awayTotalShots <= 0) {
    stats.awayTotalShots = stats.awayShotsOnTarget + stats.awayShotsOffTarget + stats.awayBlockedShots;
    if (stats.availableStats?.shotsOnTarget || stats.availableStats?.shotsOffTarget || stats.availableStats?.blockedShots) {
      stats.availableStats.totalShots = true; stats.hasData = true;
    }
  }

  statsCache.set(cacheKey, { time: Date.now(), data: stats });
  return stats;
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


  const lines = [];


  lines.push(
    `🚀 Attack: ${stats.homeAttacks} - ${stats.awayAttacks}`
  );


  lines.push(
    `🔥 Dangerous Attack: ${stats.homeDangerousAttacks} - ${stats.awayDangerousAttacks}`
  );


  lines.push(
    `📊 Possession: ${stats.homePossession}% - ${stats.awayPossession}%`
  );


  lines.push(
    `🎯 SOT: ${stats.homeShotsOnTarget} - ${stats.awayShotsOnTarget}`
  );


  lines.push(
    `🥅 Total Shots: ${stats.homeTotalShots} - ${stats.awayTotalShots}`
  );


  lines.push(
    `🧱 Blocked: ${stats.homeBlockedShots} - ${stats.awayBlockedShots}`
  );


  lines.push(
    `🚩 Corners: ${stats.homeCorners} - ${stats.awayCorners}`
  );


  lines.push(
    `🟨 Yellow: ${stats.homeYellowCards} - ${stats.awayYellowCards}`
  );


  lines.push(
    `🟥 Red: ${stats.homeRedCards} - ${stats.awayRedCards}`
  );


  if (
    stats.homeBigChances > 0 ||
    stats.awayBigChances > 0
  ) {

    lines.push(
      `💥 Big Chances: ${stats.homeBigChances} - ${stats.awayBigChances}`
    );
  }


  lines.push('');

  lines.push(
    style.text
  );


  return lines.join('\n');
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
      stats.awayCorners
  };
}


// ==========================================================
// H2-ONLY STATS (46' -> hiện tại)
// Nếu provider chỉ trả cumulative full-match, lần đầu thấy trận ở H2 được dùng
// làm baseline. Không có baseline 45/46 thì KHÔNG giả định số full-match là H2.
// ==========================================================
function deriveSecondHalfStats(matchKey, fullStats, minute) {
  const empty = createEmptyStats();
  const available = fullStats?.availableStats || {};
  if (fullStats?.isSecondHalfPeriod) {
    const direct = { ...fullStats, availableStats: { ...(fullStats.availableStats || {}) } };
    direct.source = 'sofascore-2nd-half';
    direct.h2FromMinute = 46; direct.h2ToMinute = minute; direct.baselineReady = true;
    return direct;
  }
  let base = h2BaselineState.get(matchKey);

  if (!base) {
    h2BaselineState.set(matchKey, {
      stats: JSON.parse(JSON.stringify(fullStats || createEmptyStats())),
      minute, updatedAt: Date.now()
    });
    empty.source = 'h2-baseline-pending';
    empty.h2FromMinute = minute;
    empty.h2ToMinute = minute;
    empty.baselineReady = false;
    return empty;
  }

  const pairs = [
    ['attacks','homeAttacks','awayAttacks'],
    ['dangerousAttacks','homeDangerousAttacks','awayDangerousAttacks'],
    ['shotsOnTarget','homeShotsOnTarget','awayShotsOnTarget'],
    ['shotsOffTarget','homeShotsOffTarget','awayShotsOffTarget'],
    ['blockedShots','homeBlockedShots','awayBlockedShots'],
    ['totalShots','homeTotalShots','awayTotalShots'],
    ['corners','homeCorners','awayCorners'],
    ['yellowCards','homeYellowCards','awayYellowCards'],
    ['redCards','homeRedCards','awayRedCards'],
    ['bigChances','homeBigChances','awayBigChances'],
    ['fouls','homeFouls','awayFouls']
  ];
  for (const [flag,h,a] of pairs) {
    if (!available[flag]) continue;
    empty[h] = Math.max(0, safeNumber(fullStats[h]) - safeNumber(base.stats?.[h]));
    empty[a] = Math.max(0, safeNumber(fullStats[a]) - safeNumber(base.stats?.[a]));
    empty.availableStats[flag] = true;
    empty.hasData = true;
  }

  // Possession là tỷ lệ tức thời/cumulative không thể trừ có ý nghĩa.
  // Không dùng possession full-match cho Rule H2 nếu provider không trả period H2 riêng.
  empty.source = 'h2-delta';
  empty.h2FromMinute = Math.max(46, safeNumber(base.minute));
  empty.h2ToMinute = minute;
  empty.baselineReady = true;
  return empty;
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


  snapshotState.set(
    matchId,
    {
      ...current,
      updatedAt: Date.now()
    }
  );


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


  // Blocked
  if (blocked10 >= 4) {
    score += 10;
  } else if (blocked10 >= 2) {
    score += 6;
  } else if (blocked10 >= 1) {
    score += 3;
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

    homeBlocked * 2 +

    homeCorners * 1.8;


  const awayPressure =

    awayAttack * 0.10 +

    awayDangerous * 0.35 +

    awaySOT * 5 +

    awayBlocked * 2 +

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
    `🧱 Blocked: +${momentum.homeBlocked} - +${momentum.awayBlocked}`,
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

// Live odds phải đủ mới cho phân tích live; cache đúng một chu kỳ quét để tránh gọi lặp.
const ODDS_CACHE_TTL = 7 * 60 * 1000;


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

function teamNamesSimilar(a, b) {
  const x = cleanTeamName(a);
  const y = cleanTeamName(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;

  // Fuzzy token matching để xử lý khác biệt tên giữa SofaScore và bookmaker.
  const tokens = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !['fc','cf','club','sc','afc','fk','cd'].includes(t));

  const ax = tokens(a);
  const bx = tokens(b);
  if (!ax.length || !bx.length) return false;
  const common = ax.filter(t => bx.includes(t)).length;
  const ratio = common / Math.max(Math.min(ax.length, bx.length), 1);
  return common >= 1 && ratio >= 0.5;
}


// ==========================================================
// 22. FETCH ODDS
// ==========================================================

async function fetchAllLiveOdds() {

  if (
    !ODDS_API_KEY ||
    !ODDS_API_URL
  ) {
    return [];
  }


  if (
    oddsCache.data.length &&
    Date.now() -
      oddsCache.time <
      ODDS_CACHE_TTL
  ) {

    return oddsCache.data;
  }


  try {

    const r =
      await axios.get(
        ODDS_API_URL,
        {
          timeout: 10000
        }
      );


    const data =
      Array.isArray(r.data)
        ? r.data
        : [];


    oddsCache = {
      time:
        Date.now(),

      data
    };


    return data;

  } catch (e) {

    console.error(
      '[Odds API]',
      e.message
    );

    return [];
  }
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
      score: null,
      oddsBonus: 0,
      text:
        '💰 Kèo nhà cái: N/A.'
    };
  }


  const event =
    allOdds.find(
      x => {

        // Chỉ coi là live/in-play nếu trận đã bắt đầu.
        const commence = Date.parse(x.commence_time || '');
        if (Number.isFinite(commence) && commence > Date.now() + 2 * 60 * 1000) {
          return false;
        }

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
      score: null,
      oddsBonus: 0,
      text:
        '💰 Kèo nhà cái: N/A.'
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
      found: false,
      score: null,
      oddsBonus: 0,
      text:
        '💰 Kèo nhà cái: N/A'
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

function evaluateMatchDynamicAI(
  stats,
  oddsAnalysis,
  momentum,
  minute,
  homeScore,
  awayScore
) {
  const available = stats.availableStats || {};
  const attackScore = calculateAttackScore(stats, minute);
  const dangerousScore = calculateDangerousAttackScore(stats, minute);
  const sotScore = calculateSOTScore(stats, minute);
  const blockedScore = calculateBlockedScore(stats);
  const cornerScore = calculateCornerScore(stats);
  const possessionScore = calculatePossessionPressureScore(stats);
  const cardScore = calculateCardScore(stats);
  const style = calculateMatchStyleScore(stats);
  const scoreState = calculateScoreStateScore(homeScore, awayScore, minute);
  const timeScore = calculateTimeScore(minute);
  const totals = calculateTotals(stats);
  const scoreDiff = Math.abs(safeNumber(homeScore) - safeNumber(awayScore));
  const notes = [];

  // ======================================================
  // AI V2: ƯU TIÊN DỮ LIỆU GẦN NHẤT, KHÔNG ĐẾM TRÙNG
  // Momentum 25 | Dangerous 18 | SOT 15 | Shots/Blocked 10
  // Pressure/Style 8 | Corners 6 | Score context 7
  // Odds 6 | Cards 3 | Possession 2 = 100
  // Dữ liệu thiếu bị loại khỏi mẫu số, KHÔNG mặc định 50.
  // ======================================================
  const components = [];
  const add = (name, score, weight, isAvailable) => {
    if (isAvailable && Number.isFinite(score)) {
      components.push({ name, score, weight });
    }
  };

  const styleAvailable = !!(
    available.dangerousAttacks || available.shotsOnTarget ||
    available.attacks || available.corners || available.totalShots ||
    available.blockedShots
  );

  // Gộp Total shots + Blocked để tránh đếm hai tín hiệu dứt điểm quá mạnh.
  let shotPressureScore = null;
  if (available.totalShots || available.blockedShots) {
    const totalShots = safeNumber(stats.homeTotalShots) + safeNumber(stats.awayTotalShots);
    const blocked = safeNumber(stats.homeBlockedShots) + safeNumber(stats.awayBlockedShots);
    shotPressureScore = clamp(25 + totalShots * 3.2 + blocked * 3.5, 20, 92);
  }

  add('momentum', momentum?.score, 25, momentum?.available === true);
  add('dangerous', dangerousScore, 18, !!available.dangerousAttacks);
  add('sot', sotScore, 15, !!available.shotsOnTarget);
  add('shotPressure', shotPressureScore, 10,
    Number.isFinite(shotPressureScore));
  add('pressureStyle', style.score, 8, styleAvailable);
  add('corners', cornerScore, 6, !!available.corners);
  add('scoreContext', scoreState, 7, true);
  add('odds', oddsAnalysis?.score, 6,
    oddsAnalysis?.found === true && Number.isFinite(oddsAnalysis?.score));
  add('cards', cardScore, 3, !!(available.yellowCards || available.redCards));
  add('possession', possessionScore, 2, !!available.possession);

  const totalWeight = components.reduce((sum, x) => sum + x.weight, 0);
  let finalScore = totalWeight > 0
    ? components.reduce((sum, x) => sum + x.score * x.weight, 0) / totalWeight
    : 0;
  const dataConfidence = round1(totalWeight);

  // ======================================================
  // RECENT EVIDENCE: thay đổi thật giữa 2 lần quét
  // ======================================================
  let recentEvidence = 0;
  if (momentum?.available) {
    if (safeNumber(momentum.totalSOT) >= 1) recentEvidence += 3;
    if (safeNumber(momentum.totalDangerous) >= 5) recentEvidence += 2;
    if (safeNumber(momentum.totalBlocked) >= 1) recentEvidence += 1;
    if (safeNumber(momentum.totalCorners) >= 1) recentEvidence += 1;
    if (safeNumber(momentum.totalAttack) >= 8) recentEvidence += 1;
  }

  const hotRecent = momentum?.available && (
    safeNumber(momentum.totalSOT) >= 2 ||
    (safeNumber(momentum.totalSOT) >= 1 && safeNumber(momentum.totalDangerous) >= 8) ||
    (safeNumber(momentum.totalDangerous) >= 12 &&
      (safeNumber(momentum.totalCorners) + safeNumber(momentum.totalBlocked) >= 2))
  );

  // ======================================================
  // 46-52': WARM-UP HIỆP 2
  // Chỉ dùng H2 delta; nếu chưa có baseline thì không cho tự tin quá mức.
  // ======================================================
  if (minute >= 46 && minute <= 52 && !momentum?.available) {
    finalScore = Math.min(finalScore, 64);
    notes.push('⏳ Warm-up hiệp 2: chưa có snapshot mới');
  }

  // 53-59': nếu vẫn chưa có momentum thì chỉ cho tối đa 67%.
  if (minute >= 53 && minute <= 59 && !momentum?.available) {
    finalScore = Math.min(finalScore, 67);
    notes.push('⚠️ Chưa xác nhận nhịp tấn công hiệp 2');
  }

  // ======================================================
  // MOMENTUM / HOẠT ĐỘNG GẦN NHẤT
  // ======================================================
  if (momentum?.available) {
    if (hotRecent && momentum.score >= 80) {
      finalScore += 5;
      notes.push('🔥 Recent pressure rất mạnh');
    } else if (recentEvidence >= 4 && momentum.score >= 65) {
      finalScore += 2;
      notes.push('⚡ Recent pressure tốt');
    }

    // 7 phút gần nhất không tạo SOT và rất ít dangerous => trận nguội.
    if (safeNumber(momentum.totalSOT) === 0 &&
        safeNumber(momentum.totalDangerous) < 5 &&
        safeNumber(momentum.totalCorners) === 0 &&
        safeNumber(momentum.totalBlocked) === 0) {
      finalScore -= minute >= 80 ? 12 : 8;
      notes.push('🐢 Không có cơ hội nguy hiểm mới');
    } else if (momentum.score < 40) {
      finalScore -= minute >= 80 ? 8 : 5;
      notes.push('🐢 Momentum thấp');
    }
  } else if (minute >= 80) {
    finalScore -= 7;
    notes.push('⚠️ Cuối trận nhưng chưa có Momentum');
  }

  // ======================================================
  // CHẤT LƯỢNG TẤN CÔNG HIỆP 2
  // stats tại đây đã là H2-only, không chứa H1.
  // ======================================================
  if (available.shotsOnTarget && minute >= 65 && totals.totalShotsOnTarget <= 2) {
    finalScore -= 7;
    notes.push('⚠️ SOT hiệp 2 thấp');
  }
  if (available.dangerousAttacks && minute >= 65 && totals.totalDangerousAttacks < 30) {
    finalScore -= 5;
    notes.push('⚠️ Dangerous Attack hiệp 2 thấp');
  }

  // ======================================================
  // BỐI CẢNH TỶ SỐ
  // Cách biệt lớn không được tự coi là trận nhiều bàn sẽ còn bàn.
  // ======================================================
  if (scoreDiff >= 3 && minute >= 70) {
    finalScore -= 9;
    notes.push('⚠️ Cách biệt lớn làm giảm động lực');
  } else if (scoreDiff >= 2 && minute >= 80) {
    finalScore -= 5;
    notes.push('⚠️ Cách biệt tỷ số cuối trận');
  }

  // Hòa hoặc chỉ cách 1 bàn ở cuối trận có động lực, nhưng chỉ cộng khi có recent pressure.
  if (minute >= 70 && scoreDiff <= 1 && momentum?.available && recentEvidence >= 3) {
    finalScore += 2;
    notes.push('⚔️ Tỷ số còn cạnh tranh + có pressure');
  }

  // ======================================================
  // ODDS CHỈ LÀ XÁC NHẬN, KHÔNG ĐƯỢC CỨU LIVE STATS YẾU
  // ======================================================
  if (oddsAnalysis?.found && Number.isFinite(oddsAnalysis?.score)) {
    if (oddsAnalysis.score >= 75 && momentum?.available && recentEvidence >= 3) {
      finalScore += 1.5;
      notes.push('💰 Odds đồng thuận với live pressure');
    }
    if (oddsAnalysis.score < 60 && !momentum?.available) {
      finalScore -= 1;
    }
  }

  // ======================================================
  // TRẦN ĐIỂM THEO BẰNG CHỨNG TRỰC TIẾP
  // ======================================================
  const directSignals = [
    !!available.dangerousAttacks,
    !!available.shotsOnTarget,
    momentum?.available === true,
    !!available.corners,
    Number.isFinite(shotPressureScore),
    oddsAnalysis?.found === true
  ].filter(Boolean).length;

  if (directSignals <= 1) finalScore = Math.min(finalScore, 60);
  else if (directSignals === 2) finalScore = Math.min(finalScore, 66);

  // 70%+ từ phút 60 trở đi nên có snapshot recent.
  if (minute >= 60 && !momentum?.available) {
    finalScore = Math.min(finalScore, 69);
  }

  // Cuối trận: 70%+ phải có hành động mới rõ ràng.
  if (minute >= 80 && (!momentum?.available || recentEvidence < 3)) {
    finalScore = Math.min(finalScore, 67);
  }
  if (minute >= 86 && (!momentum?.available || recentEvidence < 4)) {
    finalScore = Math.min(finalScore, 64);
  }

  finalScore = round1(clamp(finalScore, 5, 95));

  // BIG BET >=75 nhưng phải có dữ liệu trực tiếp + recent confirmation.
  const reliableBigBet =
    finalScore >= BIG_BET_PERCENTAGE &&
    dataConfidence >= 55 &&
    directSignals >= 3 &&
    minute >= 53 &&
    momentum?.available === true &&
    recentEvidence >= 4 &&
    (minute < 86 || hotRecent);

  let level = 'KHÔNG ĐỦ ĐIỀU KIỆN';
  if (reliableBigBet && finalScore >= 85) level = '🔥🔥 BIG BET RẤT MẠNH';
  else if (reliableBigBet) level = '🔥 BIG BET';
  else if (finalScore >= 65) level = '⚡ KHẢ NĂNG CAO';
  else if (finalScore >= MIN_SEND_PERCENTAGE) level = '🔔 CÓ TÍN HIỆU';

  const fmt = (name, score, ok) => `${name}: ${ok ? `${round1(score)}%` : 'N/A'}`;
  const detailLines = [
    fmt('⚡ Momentum Score', momentum?.score, momentum?.available === true),
    fmt('🔥 Dangerous Attack Score', dangerousScore, !!available.dangerousAttacks),
    fmt('🎯 SOT Score', sotScore, !!available.shotsOnTarget),
    fmt('🥅 Shot Pressure', shotPressureScore, Number.isFinite(shotPressureScore)),
    fmt('⚔️ Pressure/Style', style.score, styleAvailable),
    fmt('🚩 Corner Score', cornerScore, !!available.corners),
    fmt('💰 Odds Score', oddsAnalysis?.score,
      oddsAnalysis?.found === true && Number.isFinite(oddsAnalysis?.score)),
    `🧭 Recent Evidence: ${momentum?.available ? `${recentEvidence}/8` : 'N/A'}`,
    `📦 Data Confidence: ${dataConfidence}%`
  ];
  if (notes.length) detailLines.push('', ...notes);

  return {
    efficiency: finalScore,
    shouldSend: finalScore >= MIN_SEND_PERCENTAGE,
    isBigBet: reliableBigBet,
    dataConfidence,
    recentEvidence,
    directSignals,
    hotRecent,
    availableComponents: components.map(x => x.name),
    level,
    attackScore: available.attacks ? round1(attackScore) : null,
    dangerousScore: available.dangerousAttacks ? round1(dangerousScore) : null,
    momentumScore: momentum?.available ? round1(momentum.score) : null,
    sotScore: available.shotsOnTarget ? round1(sotScore) : null,
    blockedScore: available.blockedShots ? round1(blockedScore) : null,
    cornerScore: available.corners ? round1(cornerScore) : null,
    possessionScore: available.possession ? round1(possessionScore) : null,
    cardScore: (available.yellowCards || available.redCards) ? round1(cardScore) : null,
    styleScore: styleAvailable ? round1(style.score) : null,
    oddsScore: oddsAnalysis?.found ? round1(oddsAnalysis.score) : null,
    scoreState: round1(scoreState),
    timeScore: round1(timeScore),
    styleType: styleAvailable ? style.type : 'UNKNOWN',
    styleText: styleAvailable ? style.text : '📊 THẾ TRẬN: N/A',
    detailText: detailLines.join('\n')
  };
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

function shouldSendAlert(
  matchId,
  currentPercentage,
  currentMinute,
  allowBigBet = true
) {

  const current =
    safeNumber(
      currentPercentage
    );


  if (
    current <
    MIN_SEND_PERCENTAGE
  ) {

    return {
      send: false,
      reason:
        `Rule ${current}% < ${MIN_SEND_PERCENTAGE}%`
    };
  }


  const previous =
    alertState.get(
      matchId
    );


  // Lần đầu
  if (!previous) {

    return {
      send: true,

      bigBet:
        current >=
        BIG_BET_PERCENTAGE,

      reason:
        'Cảnh báo đầu tiên'
    };
  }


  // Max alert
  if (
    previous.alertCount >=
    MAX_ALERTS_PER_MATCH
  ) {

    return {
      send: false,

      reason:
        `Đã đạt tối đa ${MAX_ALERTS_PER_MATCH} cảnh báo`
    };
  }


  const minuteGap =

    currentMinute -
    previous.lastMinute;


  // ======================================================
  // BIG BET LẦN ĐẦU
  //
  // 68% đã gửi
  // lên 76%
  // vẫn gửi BIG BET
  // dù chưa tăng đủ +10.
  // ======================================================

  if (
    allowBigBet &&
    current >=
      BIG_BET_PERCENTAGE &&
    !previous.bigBetSent
  ) {

    return {
      send: true,

      bigBet: true,

      reason:
        `Lần đầu vượt BIG BET ${BIG_BET_PERCENTAGE}%`
    };
  }


  // Khoảng cách cảnh báo
  if (
    minuteGap <
    MIN_ALERT_GAP_MINUTES
  ) {

    return {
      send: false,

      reason:
        `Mới cảnh báo ${minuteGap} phút trước`
    };
  }


  const increase =

    current -
    previous.lastPercentage;


  if (
    increase >=
    ALERT_INCREASE_THRESHOLD
  ) {

    return {
      send: true,

      bigBet:
        current >=
        BIG_BET_PERCENTAGE,

      reason:
        `Rule tăng +${increase.toFixed(1)}%`
    };
  }


  return {

    send: false,

    reason:
      `Rule chỉ tăng ${increase >= 0 ? '+' : ''}${increase.toFixed(1)}%, cần +${ALERT_INCREASE_THRESHOLD}%`
  };
}
// ==========================================================
// 36. SCORE HELPERS
// ==========================================================

function extractScores(raw) {

  // free-api-live-football-data thường trả status.scoreStr dạng '1 - 0'.
  const scoreStr = String(raw?.status?.scoreStr ?? raw?.scoreStr ?? '').trim();
  const scoreMatch = scoreStr.match(/(\d+)\s*[-:]\s*(\d+)/);
  if (scoreMatch) {
    return { home: safeNumber(scoreMatch[1]), away: safeNumber(scoreMatch[2]) };
  }

  const home = safeNumber(
    raw?.homeScore?.current ??
    raw?.homeScore?.display ??
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
    raw?.participants?.[0]?.name ??
    raw?.team1?.name ??
    raw?.team_home?.name ??
    raw?.localteam?.name ??
    raw?.localTeam?.name ??
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
    raw?.participants?.[1]?.name ??
    raw?.team2?.name ??
    raw?.team_away?.name ??
    raw?.visitorteam?.name ??
    raw?.visitorTeam?.name ??
    'Away'
  );
}


// ==========================================================
// 38. MATCH ID
// ==========================================================

function extractProviderMatchId(raw) {
  const id =
    raw?.id ??
    raw?.eventId ??
    raw?.event_id ??
    raw?.matchId ??
    raw?.match_id ??
    raw?.fixture?.id ??
    raw?.gameId ??
    raw?.game_id;

  return (id !== undefined && id !== null && String(id).trim() !== '')
    ? String(id)
    : null;
}

function extractMatchId(raw, source) {

  const id = extractProviderMatchId(raw);

  if (id) {
    return id;
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

    // ID thật do provider cấp. Không dùng fallback tên đội để gọi endpoint detail/stats.
    providerId: extractProviderMatchId(raw),

    source,

    homeName,

    awayName,

    homeScore:
      score.home,

    awayScore:
      score.away,

    league:
      parseLeagueName(raw),

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


  const possibleArrays = [

    raw?.incidents,

    raw?.events,

    raw?.goals,

    raw?.timeline,

    raw?.matchEvents,

    raw?.match_events

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
          ''
        ).toLowerCase();


      const isGoal =

        type === 'goal' ||

        type.includes('goal') ||

        event?.isGoal === true;


      if (!isGoal) {
        continue;
      }


      const minute =

        parseMinuteValue(
          event?.time ??
          event?.minute ??
          event?.elapsed ??
          event?.matchTime
        );


      const player =

        event?.player?.name ??

        event?.playerName ??

        event?.scorer?.name ??

        event?.scorer ??

        '';


      const homeScore =

        event?.homeScore ??

        event?.score?.home;


      const awayScore =

        event?.awayScore ??

        event?.score?.away;


      let line =
        `⚽ ${minute || '?'}'`;


      if (player) {
        line += ` ${player}`;
      }


      if (
        homeScore !== undefined &&
        awayScore !== undefined
      ) {

        line +=
          ` (${homeScore}-${awayScore})`;
      }


      goals.push(line);
    }
  }


  if (
    !goals.length
  ) {

    return (
      'Không có timeline bàn thắng từ API'
    );
  }


  return [
    ...new Set(goals)
  ].join('\n');
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

async function sendTelegramAlert(item, alertDecision) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
    return false;
  }

  const percentage = safeNumber(item.ai?.efficiency);
  const previous = alertState.get(item.alertKey);
  const alertNumber = previous ? previous.alertCount + 1 : 1;
  const isBigBet = item.ai?.isBigBet === true;

  const homeScore = safeNumber(item.homeScore);
  const awayScore = safeNumber(item.awayScore);
  const totalGoals = homeScore + awayScore;

  // Kết quả dự đoán FT đã được predictFinalScore() tạo trong analyzeOneMatch().
  const scorePrediction = item.scorePrediction || {
    home: homeScore,
    away: awayScore,
    text: `${homeScore}-${awayScore}`,
    expectedExtraGoals: 0,
    likelyScorer: 'Chưa đủ tín hiệu',
    confidence: 'THẤP'
  };

  const hasPredictedHome = Number.isFinite(Number(scorePrediction.home));
  const hasPredictedAway = Number.isFinite(Number(scorePrediction.away));
  const predictedHome = hasPredictedHome ? Number(scorePrediction.home) : homeScore;
  const predictedAway = hasPredictedAway ? Number(scorePrediction.away) : awayScore;

  let remainingGoals;
  if (hasPredictedHome && hasPredictedAway) {
    remainingGoals = Math.max(0, predictedHome + predictedAway - totalGoals);
  } else {
    remainingGoals = Math.max(0, safeNumber(scorePrediction.expectedExtraGoals));
  }

  const hs = item.h2Stats || createEmptyStats();
  const av = hs.availableStats || {};
  const fmtPair = (label, flag, h, a) => av[flag]
    ? `• ${label}: ${safeNumber(hs[h])}-${safeNumber(hs[a])}`
    : `• ${label}: N/A`;
  const h2Lines = [
    fmtPair('⚽ Sút', 'totalShots', 'homeTotalShots', 'awayTotalShots'),
    fmtPair('🎯 Sút trúng đích', 'shotsOnTarget', 'homeShotsOnTarget', 'awayShotsOnTarget'),
    fmtPair('🧱 Sút bị chặn', 'blockedShots', 'homeBlockedShots', 'awayBlockedShots'),
    fmtPair('🚩 Phạt góc', 'corners', 'homeCorners', 'awayCorners'),
    fmtPair('⚡ Dangerous Attack', 'dangerousAttacks', 'homeDangerousAttacks', 'awayDangerousAttacks'),
    fmtPair('🟨 Thẻ vàng', 'yellowCards', 'homeYellowCards', 'awayYellowCards')
  ];
  const h2From = hs.baselineReady ? safeNumber(hs.h2FromMinute) : item.minute;
  const h2Range = hs.baselineReady ? `${h2From}' → ${item.minute}'` : `đang tạo baseline tại ${item.minute}'`;

  let momentumText = '• 📈 Momentum gần nhất: N/A';
  if (item.momentum?.available && Number.isFinite(Number(item.momentum.score))) {
    momentumText = `• 📈 Momentum gần nhất: ${Number(item.momentum.score).toFixed(1)}%`;
  }

  let oddsText = '💰 Kèo nhà cái: N/A.';
  if (item.odds?.found) {
    if (item.odds.text && !String(item.odds.text).toLowerCase().includes('không tìm')) {
      oddsText = String(item.odds.text);
    } else if (
      item.odds.point !== undefined &&
      item.odds.point !== null &&
      Number.isFinite(Number(item.odds.price))
    ) {
      oddsText = `💰 Live Over ${item.odds.point} @${Number(item.odds.price).toFixed(2)}.`;
    }
  }
  if (oddsText !== '💰 Kèo nhà cái: N/A.' && !oddsText.startsWith('💰')) {
    oddsText = `💰 ${oddsText}`;
  }

  let likelyScorer = scorePrediction.likelyScorer || 'Chưa đủ tín hiệu';
  const scorerLower = String(likelyScorer).toLowerCase();
  if (scorerLower === 'chủ nhà' || scorerLower === 'home') {
    likelyScorer = `Chủ nhà - ${item.homeName}`;
  } else if (scorerLower === 'đội khách' || scorerLower === 'away' || scorerLower === 'khách') {
    likelyScorer = `Đội khách - ${item.awayName}`;
  }

  let goalPredictionText;
  if (percentage >= 75) {
    goalPredictionText = 'Tín hiệu rất mạnh xuất hiện thêm bàn thắng. 🔥 BIG BET';
  } else if (percentage >= 65) {
    goalPredictionText = 'Khả năng cao xuất hiện thêm bàn thắng.';
  } else if (percentage >= MIN_SEND_PERCENTAGE) {
    goalPredictionText = 'Có tín hiệu xuất hiện thêm bàn thắng, nhưng mức xác nhận chưa cao.';
  } else {
    goalPredictionText = 'Chưa đủ tín hiệu xác nhận sẽ có thêm bàn thắng.';
  }

  const bigBetLine = isBigBet ? '\n🔥 BIG BET' : '';

  const message = `🔔 RUNG CHUÔNG VÀNGGGG🔔
🏆 Giải đấu: ${cleanTelegramText(item.league)}
⚔️ Trận đấu: ${cleanTelegramText(item.homeName)} ${homeScore}-${awayScore} ${cleanTelegramText(item.awayName)}
⏱️ Thời gian: Phút ${item.minute}'

⚽ DIỄN BIẾN TỶ SỐ:
• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})

📊 THẾ TRẬN HIỆP 2 (${h2Range}):
${h2Lines.join('\n')}
${momentumText}
• ${oddsText}

🔮 DỰ ĐOÁN TỶ SỐ FT:
• ${scorePrediction.text || `${predictedHome}-${predictedAway}`}

⚽ DỰ KIẾN BÀN CÒN LẠI:
• +${remainingGoals} bàn

🎯 ĐỘI CÓ KHẢ NĂNG GHI BÀN:
• ${cleanTelegramText(likelyScorer)}

🎯 Nhận định: ${goalPredictionText}
📈 Hiệu suất Rule: ${percentage.toFixed(1)}%${bigBetLine}`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: true
      },
      { timeout: 10000 }
    );

    alertState.set(item.alertKey, {
      lastPercentage: percentage,
      lastMinute: item.minute,
      alertCount: alertNumber,
      bigBetSent: (previous?.bigBetSent || false) || isBigBet,
      updatedAt: Date.now()
    });

    console.log(
      `[Telegram] ${isBigBet ? '🔥 BIG BET' : '🔔 ALERT'} #${alertNumber} | ${item.homeName} vs ${item.awayName} | Rule ${percentage.toFixed(1)}% | FT ${scorePrediction.text} | Còn +${remainingGoals} bàn`
    );
    return true;
  } catch (e) {
    console.error('[Telegram Error]', e.response?.data || e.message);
    return false;
  }
}


// ==========================================================
// 44. FETCH ALL LIVE SOURCES
// ==========================================================

async function fetchAllLiveMatches() {
  // SofaScore vẫn là nguồn ưu tiên số 1, nhưng KHÔNG còn là cổng bắt buộc.
  // Primary RapidAPI và FlashScore được phép bổ sung những trận Sofa không có.
  // FlashScore tự cooldown khi 429 nên không làm hỏng vòng scan.
  const [sofaRaw, primaryRaw, flashRaw] = await Promise.all([
    fetchLiveMatchesFromSofaScore(),
    fetchLiveMatchesFromPrimaryRapidApi(),
    sourceInCooldown('FlashScore Live') ? Promise.resolve([]) : fetchLiveMatchesFromFlashScore()
  ]);

  const buckets = [
    ['sofascore', sofaRaw],
    ['primary-rapidapi', primaryRaw],
    ['flashscore', flashRaw]
  ];

  const all = [];
  const counts = {};
  for (const [source, rows] of buckets) {
    let valid = 0;
    for (const raw of (Array.isArray(rows) ? rows : [])) {
      const match = formatLiveMatch(raw, source);
      if (isPlaceholderMatch(match)) continue;
      all.push(match);
      valid += 1;
    }
    counts[source] = { raw: Array.isArray(rows) ? rows.length : 0, valid };
  }

  console.log(`[Sources] Sofa=${counts.sofascore.valid} | Primary=${counts['primary-rapidapi'].valid} | Flash=${counts.flashscore.valid}`);
  return all;
}

// ==========================================================
// 45. DEDUPLICATE MATCHES
//
// SofaScore ưu tiên cao nhất.
// ==========================================================

function deduplicateMatches(
  matches
) {

  const uniqueMap = new Map();

  const SOURCE_PRIORITY = {
    'primary-rapidapi': 4,
    sofascore: 3,
    flashscore: 2,
    'live-football': 1
  };

  // Khi 2 nguồn cùng trả một trận, ưu tiên record có clock/phút sử dụng được.
  // Chỉ dùng source priority khi chất lượng clock tương đương.
  function clockQuality(match) {
    if (!match || isPlaceholderMatch(match)) return -10;
    const rawMinute = calculateExactMinute(match.raw);
    const clock = classifyMatchClock(match.raw, rawMinute);
    if (clock.kind === 'MINUTE' && Number.isFinite(clock.minute)) {
      if (clock.minute >= 46 && clock.minute <= 92) return 100;
      return 70;
    }
    if (clock.kind === 'HALFTIME') return 50;
    if (clock.kind === 'INTERRUPTED') return 30;
    if (clock.kind === 'FINISHED') return 20;
    return 0;
  }

  for (const match of matches) {
    if (!match || isPlaceholderMatch(match)) continue;

    const key = createMatchKey(match.homeName, match.awayName);
    if (!key || key === '_') continue;

    const existing = uniqueMap.get(key);
    if (!existing) {
      uniqueMap.set(key, match);
      continue;
    }

    const cq = clockQuality(match);
    const eq = clockQuality(existing);
    const cp = SOURCE_PRIORITY[match.source] || 0;
    const ep = SOURCE_PRIORITY[existing.source] || 0;

    if (cq > eq || (cq === eq && cp > ep)) {
      uniqueMap.set(key, match);
    }
  }

  return Array.from(uniqueMap.values());
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


  const available = stats.availableStats || {};

  // Dữ liệu 0-0 vẫn là dữ liệu thật nếu API đã trả field đó.
  if (
    available.attacks ||
    available.dangerousAttacks ||
    available.shotsOnTarget ||
    available.totalShots ||
    available.blockedShots ||
    available.corners ||
    available.possession ||
    available.yellowCards ||
    available.redCards
  ) {
    return true;
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

  const minuteRaw =
    calculateExactMinute(
      match.raw
    );


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
  // CHỈ QUÉT 46 -> 92
  // ======================================================

  if (
    !Number.isFinite(minute) ||
    minute < 46 ||
    minute > 92
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


  console.log(`[Analyze] ${minute}' | ${match.league} | ${match.homeName} ${match.homeScore}-${match.awayScore} ${match.awayName}`);


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
  const alertKey =
    createMatchKey(
      match.homeName,
      match.awayName
    );


  // Chỉ dùng dữ liệu phát sinh trong H2. Full-match stats chỉ làm nguồn để tính delta.
  const h2Stats = deriveSecondHalfStats(alertKey, stats, minute);

  const momentum =
    calculateMomentum(
      alertKey,
      h2Stats,
      minute
    );


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
    !hasUsefulStats(h2Stats) &&
    !odds.found
  ) {

    const availableKeys = Object.entries(h2Stats.availableStats || {})
      .filter(([, value]) => value)
      .map(([key]) => key);

    console.log(` ├─ H2 Statistics: N/A | source=${h2Stats.source || match.source}`);
    console.log(` ├─ Available fields: ${availableKeys.length ? availableKeys.join(', ') : 'none'}`);
    console.log(` ├─ Odds match: N/A`);
    console.log(` └─> Chờ dữ liệu H2: không dùng stats H1 cộng dồn để tính Rule`);

    return null;
  }

  const availableKeys = Object.entries(h2Stats.availableStats || {})
    .filter(([, value]) => value)
    .map(([key]) => key);

  console.log(
    ` ├─ H2 Statistics: ${hasUsefulStats(h2Stats) ? 'OK' : 'N/A'} | fields=${availableKeys.length ? availableKeys.join(',') : 'none'} | source=${h2Stats.source || match.source}`
  );
  console.log(` ├─ Odds match: ${odds.found ? 'OK' : 'N/A'}`);


  // ======================================================
  // AI RULE
  // ======================================================

  const ai =
    evaluateMatchDynamicAI(
      h2Stats,
      odds,
      momentum,
      minute,
      match.homeScore,
      match.awayScore
    );


  console.log(
    ` ├─ Rule: ${ai.efficiency}% | ${ai.level}`
  );


  console.log(
    ` ├─ ${ai.styleText}`
  );


  if (
    momentum.available
  ) {

    console.log(
      ` ├─ Momentum: ${momentum.score}%`
    );
  }


  // ======================================================
  // PREDICT FT SCORE
  // ======================================================

  const scorePrediction =
    predictFinalScore(
      match.homeScore,
      match.awayScore,
      ai.efficiency,
      minute,
      h2Stats,
      momentum,
      ai.styleType
    );


  console.log(
    ` ├─ FT dự đoán: ${scorePrediction.text}`
  );


  // ======================================================
  // ALERT DECISION
  // ======================================================

  const alertDecision =
    shouldSendAlert(
      alertKey,
      ai.efficiency,
      minute,
      ai.isBigBet
    );


  console.log(
    ` └─ Alert: ${alertDecision.send ? 'YES' : 'NO'} | ${alertDecision.reason}`
  );


  const result = {

    ...match,

    alertKey,

    minute,

    stats,
    h2Stats,

    momentum,

    odds,

    ai,

    scorePrediction,

    goalTimeline:
      extractGoalTimeline(
        match.raw
      ),

    alertDecision
  };


  // ======================================================
  // SEND TELEGRAM
  // ======================================================

  result.telegramStatus = 'NO_SEND';
  if (ai.shouldSend && alertDecision.send) {
    const sent = await sendTelegramAlert(result, alertDecision);
    result.telegramStatus = sent ? 'SENT' : 'ERROR';
  } else if (ai.shouldSend && !alertDecision.send) {
    result.telegramStatus = 'DUPLICATE';
  }

  return result;
}


// ==========================================================
// 48. MAIN SCANNER
// ==========================================================

async function scanLiveMatches() {
  if (scanRunning) return [];
  scanRunning = true;
  sofaStatsRequestsThisScan = 0;
  const startedAt = Date.now();

  try {
    cleanupState();
    const vn = getVietnamTime();
    const liveMatches = await fetchAllLiveMatches();
    const uniqueMatches = deduplicateMatches(liveMatches);
    const eligibleMatches = [];
    const skip = { under46: 0, over92: 0, ir: 0, htft: 0, unknown: 0, league: 0 };

    for (const match of uniqueMatches) {
      if (isPlaceholderMatch(match)) { skip.unknown++; continue; }
      const minuteRaw = calculateExactMinute(match.raw);
      const clock = classifyMatchClock(match.raw, minuteRaw);
      if (clock.kind === 'INTERRUPTED') { skip.ir++; continue; }
      if (clock.kind === 'HALFTIME' || clock.kind === 'FINISHED') { skip.htft++; continue; }
      if (clock.kind === 'UNKNOWN') { skip.unknown++; debugLog(`[Clock UNKNOWN] ${match.homeName} vs ${match.awayName} | ${compactClockDebug(match.raw)}`); continue; }
      if (clock.minute < 46) { skip.under46++; continue; }
      if (clock.minute > 92) { skip.over92++; continue; }
      if (isFilteredLeague(match.league, match.homeName, match.awayName)) { skip.league++; continue; }
      eligibleMatches.push(match);
    }

    console.log(`\n========== AUTO SCAN ${vn.timeStr} ==========`);
    console.log(`📡 Tổng hợp: ${uniqueMatches.length} live | H2 46-92: ${eligibleMatches.length}`);

    let allOdds = [];
    if (eligibleMatches.length > 0) allOdds = await fetchAllLiveOdds();

    const results = [];
    for (const match of eligibleMatches) {
      try {
        const result = await analyzeOneMatch(match, allOdds);
        if (!result) continue;
        results.push(result);
        const big = result.ai?.isBigBet ? ' 🔥 BIG BET' : '';
        let tg = '❌ KHÔNG GỬI';
        if (result.telegramStatus === 'SENT') tg = '📤 TELEGRAM ĐÃ GỬI';
        else if (result.telegramStatus === 'ERROR') tg = '⚠️ TELEGRAM LỖI';
        else if (result.telegramStatus === 'DUPLICATE') tg = '⏸ ĐÃ BÁO TRƯỚC ĐÓ';
        console.log(`⚽ ${result.minute}' ${result.homeName} ${result.homeScore}-${result.awayScore} ${result.awayName} | Rule ${result.ai.efficiency}%${big} | ${tg}`);
      } catch (e) {
        console.log(`⚠️ ${match.homeName} vs ${match.awayName} | lỗi phân tích`);
        debugLog(e.message);
      }
    }

    const ruleCount = results.filter(x => x.ai?.efficiency >= MIN_SEND_PERCENTAGE).length;
    const sentCount = results.filter(x => x.telegramStatus === 'SENT').length;
    console.log(`📊 Live: ${uniqueMatches.length} | H2: ${eligibleMatches.length} | Rule≥${MIN_SEND_PERCENTAGE}: ${ruleCount} | Telegram: ${sentCount}`);
    console.log(`↪ Bỏ qua: <46=${skip.under46} | >92=${skip.over92} | IR=${skip.ir} | HT/FT=${skip.htft} | Unknown=${skip.unknown}${skip.league ? ` | League=${skip.league}` : ''}`);
    console.log(`🧾 Sofa stats requests vòng này: ${sofaStatsRequestsThisScan}/${SOFA_STATS_PER_SCAN_LIMIT}`);
    console.log(`⏱ Hoàn tất: ${((Date.now()-startedAt)/1000).toFixed(1)}s`);
    console.log('=====================================');
    return results.slice().sort((a,b)=>(b.ai?.efficiency||0)-(a.ai?.efficiency||0));
  } catch (e) {
    console.error('[Auto-Scan Error]', e.response?.data || e.message);
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
        '46-92',

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
        'Blocked Shots',
        'Corners',
        'Yellow Cards',
        'Red Cards',
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
      'Scan minute: 46 -> 92'
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


    // Sau đó 7 phút / lần
    setInterval(
      () => {

        scanLiveMatches()
          .catch(
            e =>
              console.error(
                '[Interval Scan]',
                e.message
              )
          );

      },
      SCAN_INTERVAL_MS
    );
  }
);