
const express = require('express');
const axios = require('axios');
const audit = require('./audit');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

// ==========================================================
// 1. CONFIG
// ==========================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const FLASHSCORE_API_KEY = process.env.FLASHSCORE_API_KEY || process.env.RAPIDAPI_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

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

const ODDS_API_URL = ODDS_API_KEY
  ? `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`
  : '';


// ==========================================================
// 2. ALERT / CACHE CONFIG
// ==========================================================

// >= 58% gửi Telegram
const MIN_SEND_PERCENTAGE = 60.0;

// >= 75% BIG BET
const BIG_BET_PERCENTAGE = 75.0;

// Sau cảnh báo đầu tiên:
// AI phải tăng ít nhất +10% mới cảnh báo lại
const ALERT_INCREASE_THRESHOLD = 10.0;

// Tối đa 3 cảnh báo / trận
const MAX_ALERTS_PER_MATCH = 3;

// Khoảng cách tối thiểu giữa 2 cảnh báo
const MIN_ALERT_GAP_MINUTES = 5;
const MIN_TELEGRAM_MINUTE = 65;
const FOLLOWUP_WINDOW_MINUTES = 10;

// Xóa trạng thái trận cũ sau 4 giờ
const ALERT_STATE_TTL =
  4 * 60 * 60 * 1000;

// Cache statistics 90 giây
const STATS_CACHE_TTL =
  90 * 1000;

// Quét 7 phút / lần
const SCAN_INTERVAL_MS =
  7 * 60 * 1000;


const alertState = new Map();

const statsCache = new Map();

// Lưu snapshot để tính Momentum
const snapshotState = new Map();

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

async function fetchLiveMatchesFromSofaScore() {

  try {

    if (!PAID_RAPIDAPI_KEY) {
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


    return (
      r.data?.events ||
      r.data?.liveEvents ||
      []
    );

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


    return (
      Array.isArray(r.data)
        ? r.data
        : (
            r.data?.data ||
            r.data?.matches ||
            r.data?.events ||
            []
          )
    );

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


    return (
      r.data?.result ||
      r.data?.matches ||
      []
    );

  } catch (e) {

    logSourceError('LiveFootball', 'LIVE', e);
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
      key === 'source'
    ) {
      continue;
    }

    const value =
      safeNumber(source[key]);

    if (value > 0) {
      target[key] = value;
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


  const urls = [

    `https://${FLASHSCORE_HOST}/api/flashscore/v2/match/${matchId}/statistics`,

    `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/${matchId}/statistics`,

    `https://${FLASHSCORE_HOST}/api/flashscore/v2/match/statistics?match_id=${matchId}`

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

        return stats;
      }

    } catch (e) {
      lastError = e;

      // thử endpoint tiếp
    }
  }


  if (lastError) logSourceError('FlashScore', `STATS matchId=${matchId}`, lastError);
  else console.log(`[Source FlashScore] STATS matchId=${matchId} | Không có chỉ số`);
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

// ==========================================================
// CROSS-SOURCE PARTIAL STATS
// 5 chỉ số ưu tiên để quyết định có cần fallback thêm hay không:
// ATT / Dangerous Attack / Total Shots / SOT / Corners.
// Mục tiêu: ít nhất 4/5; nếu dữ liệu raw của 3 nguồn ghép được 5/5 thì giữ 5/5.
// Chỉ gọi detail API khi sau khi ghép raw vẫn < 4/5 để tránh lãng phí API.
// ==========================================================

function getCoreStatsCoverage(stats) {

  if (!stats) {
    return 0;
  }

  const checks = [
    safeNumber(stats.homeAttacks) + safeNumber(stats.awayAttacks) > 0,
    safeNumber(stats.homeDangerousAttacks) + safeNumber(stats.awayDangerousAttacks) > 0,
    safeNumber(stats.homeTotalShots) + safeNumber(stats.awayTotalShots) > 0,
    safeNumber(stats.homeShotsOnTarget) + safeNumber(stats.awayShotsOnTarget) > 0,
    safeNumber(stats.homeCorners) + safeNumber(stats.awayCorners) > 0
  ];

  return checks.filter(Boolean).length;
}


function mergeMissingStats(target, source) {

  if (!target || !source) {
    return target;
  }

  const keys = Object.keys(createEmptyStats());

  for (const key of keys) {

    if (key === 'hasData' || key === 'source') {
      continue;
    }

    const oldValue = safeNumber(target[key]);
    const newValue = safeNumber(source[key]);

    // Chỉ bổ sung ô còn thiếu; không ghi đè dữ liệu nguồn ưu tiên.
    if (oldValue <= 0 && newValue > 0) {
      target[key] = newValue;
    }
  }

  if (source.hasData) {
    target.hasData = true;
  }

  return target;
}


async function fetchStatsForSourceMatch(sourceMatch) {

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
    return parseStatsFromRawMatch(sourceMatch.raw);
  }

  return createEmptyStats();
}


async function fetchMatchDetailStats(
  match
) {

  // Cache theo tên trận để 3 nguồn dùng chung kết quả đã ghép.
  const matchKey = createMatchKey(
    match.homeName,
    match.awayName
  );

  const cacheKey =
    `cross:${matchKey || `${match.source}:${match.id}`}`;

  const cached = statsCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < STATS_CACHE_TTL
  ) {
    return cached.data;
  }


  // Danh sách cùng một trận từ cả 3 nguồn đã được deduplicateMatches giữ lại.
  const sourceMatches = Array.isArray(match.crossSourceMatches)
    ? match.crossSourceMatches
    : [match];


  // BƯỚC 1: ghép RAW của tất cả nguồn trước — không tốn thêm API call.
  let stats = parseStatsFromRawMatch(match.raw);

  for (const sourceMatch of sourceMatches) {

    if (
      sourceMatch.source === match.source &&
      String(sourceMatch.id) === String(match.id)
    ) {
      continue;
    }

    const rawStats = parseStatsFromRawMatch(sourceMatch.raw);
    mergeMissingStats(stats, rawStats);
  }


  // BƯỚC 2: nếu vẫn chưa đủ 4/5 mới gọi detail API theo từng nguồn.
  // Ưu tiên SofaScore -> FlashScore -> Live Football.
  const sourcePriority = {
    sofascore: 3,
    flashscore: 2,
    'live-football': 1
  };

  const orderedSources = [...sourceMatches].sort(
    (a, b) =>
      (sourcePriority[b.source] || 0) -
      (sourcePriority[a.source] || 0)
  );

  if (getCoreStatsCoverage(stats) < 4) {

    for (const sourceMatch of orderedSources) {

      if (getCoreStatsCoverage(stats) >= 4) {
        break;
      }

      const extraStats =
        await fetchStatsForSourceMatch(sourceMatch);

      mergeMissingStats(stats, extraStats);
    }
  }


  // BƯỚC 3: Total Shots fallback như logic cũ.
  if (stats.homeTotalShots <= 0) {
    stats.homeTotalShots =
      stats.homeShotsOnTarget +
      stats.homeShotsOffTarget +
      stats.homeBlockedShots;
  }

  if (stats.awayTotalShots <= 0) {
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


  console.log(`[Stats 3 nguồn] ${match.homeName} vs ${match.awayName} | ${sourceMatches.map(x => x.source).join(' + ')} | ${getCoreStatsCoverage(stats)}/5 | ATT=${stats.homeAttacks}-${stats.awayAttacks} DA=${stats.homeDangerousAttacks}-${stats.awayDangerousAttacks} SH=${stats.homeTotalShots}-${stats.awayTotalShots} SOT=${stats.homeShotsOnTarget}-${stats.awayShotsOnTarget} COR=${stats.homeCorners}-${stats.awayCorners}`);

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
    `🎯 SÚT: Shots ${stats.homeTotalShots}-${stats.awayTotalShots} | SOT ${stats.homeShotsOnTarget}-${stats.awayShotsOnTarget} | Off ${stats.homeShotsOffTarget}-${stats.awayShotsOffTarget} | Blocked ${stats.homeBlockedShots}-${stats.awayBlockedShots}`,
    `🚩 KHÁC: Corner ${stats.homeCorners}-${stats.awayCorners}${bigChanceText} | Yellow ${stats.homeYellowCards}-${stats.awayYellowCards} | Red ${stats.homeRedCards}-${stats.awayRedCards}`,
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
      stats.awayCorners
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

function evaluateMatchDynamicAI(
  stats,
  oddsAnalysis,
  momentum,
  minute,
  homeScore,
  awayScore
) {

  const attackScore =
    calculateAttackScore(
      stats,
      minute
    );


  const dangerousScore =
    calculateDangerousAttackScore(
      stats,
      minute
    );


  const sotScore =
    calculateSOTScore(
      stats,
      minute
    );


  const blockedScore =
    calculateBlockedScore(
      stats
    );


  const cornerScore =
    calculateCornerScore(
      stats
    );


  const possessionScore =
    calculatePossessionPressureScore(
      stats
    );


  const cardScore =
    calculateCardScore(
      stats
    );


  const style =
    calculateMatchStyleScore(
      stats
    );


  const scoreState =
    calculateScoreStateScore(
      homeScore,
      awayScore,
      minute
    );


  const timeScore =
    calculateTimeScore(
      minute
    );


  // Momentum lần scan đầu chưa có
  // dùng 50 = trung tính
  const momentumScore =
    momentum?.available
      ? momentum.score
      : 50;


  // Không có odds => trung tính 50
  const oddsScore =
    oddsAnalysis?.found
      ? oddsAnalysis.score
      : 50;


  // ======================================================
  // WEIGHTED SCORE
  // ======================================================

  let finalScore =

    dangerousScore * 0.18 +

    momentumScore * 0.16 +

    sotScore * 0.14 +

    style.score * 0.11 +

    attackScore * 0.10 +

    possessionScore * 0.08 +

    blockedScore * 0.06 +

    cornerScore * 0.06 +

    cardScore * 0.02 +

    scoreState * 0.01 +

    timeScore * 0.01;

  // Odds chi de tham khao; chuan hoa 93% trong so con lai ve 100%.
  finalScore /= 0.93;


  // ======================================================
  // EXTRA LOGIC / PENALTIES
  // ======================================================

  const totals =
    calculateTotals(
      stats
    );


  const notes = [];


  // Rất ít SOT cuối trận
  if (
    minute >= 70 &&
    totals.totalShotsOnTarget <= 1
  ) {

    finalScore -= 8;

    notes.push(
      '⚠️ SOT quá thấp sau phút 70'
    );
  }


  // Ít Dangerous Attack
  if (
    totals.totalDangerousAttacks > 0 &&
    totals.totalDangerousAttacks < 30 &&
    minute >= 65
  ) {

    finalScore -= 5;

    notes.push(
      '⚠️ Dangerous Attack thấp'
    );
  }


  // Momentum cực mạnh
  if (
    momentum?.available &&
    momentum.score >= 85
  ) {

    finalScore += 4;

    notes.push(
      '🔥 Momentum cực mạnh'
    );
  }


  // Nhiều SOT + Dangerous
  if (
    totals.totalShotsOnTarget >= 8 &&
    totals.totalDangerousAttacks >= 70
  ) {

    finalScore += 3;

    notes.push(
      '🔥 SOT + Dangerous Attack cao'
    );
  }


  // Đôi công mạnh
  if (
    style.type ===
    'END_TO_END'
  ) {

    finalScore += 3;

    notes.push(
      '⚔️ Hai đội đang đôi công'
    );
  }


  // Một đội ép sân rõ
  if (
    style.type ===
      'HOME_PRESSURE' ||
    style.type ===
      'AWAY_PRESSURE'
  ) {

    finalScore += 2;

    notes.push(
      '🔥 Có đội ép sân rõ rệt'
    );
  }


  // Odds rất mạnh
  if (
    oddsAnalysis?.found &&
    oddsAnalysis.score >= 85
  ) {

    // Odds chỉ tham khảo; không cộng điểm Rule.
    notes.push(
      '💰 Kèo Over đang mạnh'
    );
  }


  // Clamp
  finalScore =
    clamp(
      finalScore,
      5,
      95
    );


  finalScore =
    round1(
      finalScore
    );


  // ======================================================
  // LEVEL
  // ======================================================

  let level =
    'KHÔNG ĐỦ ĐIỀU KIỆN';


  if (
    finalScore >= 85
  ) {

    level =
      '🔥🔥 BIG BET RẤT MẠNH';

  } else if (
    finalScore >=
    BIG_BET_PERCENTAGE
  ) {

    level =
      '🔥 BIG BET';

  } else if (
    finalScore >= 68
  ) {

    level =
      '⚡ TÍN HIỆU MẠNH';

  } else if (
    finalScore >=
    MIN_SEND_PERCENTAGE
  ) {

    level =
      '🔔 CÓ TÍN HIỆU';
  }


  // ======================================================
  // DETAIL TEXT
  // ======================================================

  const detailLines = [

    `🔥 Dangerous Attack Score: ${round1(dangerousScore)}%`,

    `⚡ Momentum Score: ${round1(momentumScore)}%`,

    `🎯 SOT Score: ${round1(sotScore)}%`,

    `⚔️ Đôi công/Ép sân: ${round1(style.score)}%`,

    `🚀 Attack Score: ${round1(attackScore)}%`,

    `📊 Possession Pressure: ${round1(possessionScore)}%`,

    `🧱 Blocked Score: ${round1(blockedScore)}%`,

    `🚩 Corner Score: ${round1(cornerScore)}%`,

    `💰 Odds Score: ${round1(oddsScore)}%`,

    `🟨🟥 Card Score: ${round1(cardScore)}%`
  ];


  if (notes.length) {

    detailLines.push('');

    detailLines.push(
      ...notes
    );
  }


  return {

    efficiency:
      finalScore,

    shouldSend:
      finalScore >=
      MIN_SEND_PERCENTAGE,

    isBigBet:
      finalScore >=
      BIG_BET_PERCENTAGE,

    level,

    attackScore:
      round1(attackScore),

    dangerousScore:
      round1(
        dangerousScore
      ),

    momentumScore:
      round1(
        momentumScore
      ),

    sotScore:
      round1(
        sotScore
      ),

    blockedScore:
      round1(
        blockedScore
      ),

    cornerScore:
      round1(
        cornerScore
      ),

    possessionScore:
      round1(
        possessionScore
      ),

    cardScore:
      round1(
        cardScore
      ),

    styleScore:
      round1(
        style.score
      ),

    oddsScore:
      round1(
        oddsScore
      ),

    scoreState:
      round1(
        scoreState
      ),

    timeScore:
      round1(
        timeScore
      ),

    styleType:
      style.type,

    styleText:
      style.text,

    detailText:
      detailLines.join('\n')
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
    homeScore: safeNumber(homeScore),
    awayScore: safeNumber(awayScore)
  };
}

// Kiểm tra biến động MỚI kể từ cảnh báo gần nhất, không dùng momentum cũ.
function detectTenMinuteSpike(previous, current) {
  if (!previous || !current) return { confirmed: false, reason: 'NO_SNAPSHOT' };
  const delta = (home, away) => {
    const h = safeNumber(current[home]) - safeNumber(previous[home]);
    const a = safeNumber(current[away]) - safeNumber(previous[away]);
    // Dữ liệu bị reset/thiếu: không xem như một đột biến.
    return h < 0 || a < 0 ? null : h + a;
  };
  const sot = delta('homeShotsOnTarget', 'awayShotsOnTarget');
  const shots = delta('homeTotalShots', 'awayTotalShots');
  const dangerous = delta('homeDangerousAttacks', 'awayDangerousAttacks');
  const attacks = delta('homeAttacks', 'awayAttacks');
  const blocked = delta('homeBlockedShots', 'awayBlockedShots');
  const corners = delta('homeCorners', 'awayCorners');
  const confirmed = (sot !== null && sot >= 2) ||
    (dangerous !== null && dangerous >= 9) ||
    (attacks !== null && attacks >= 25) ||
    (blocked !== null && blocked >= 2) ||
    (corners !== null && corners >= 2) ||
    (shots !== null && shots >= 4 && sot !== null && sot >= 1);
  return { confirmed, reason: `NEW_SOT=${sot ?? 'NA'} SH=${shots ?? 'NA'} DA=${dangerous ?? 'NA'} ATT=${attacks ?? 'NA'} BLK=${blocked ?? 'NA'} COR=${corners ?? 'NA'}` };
}

function shouldSendAlert(matchId, currentPercentage, currentMinute, momentum, stats, homeScore, awayScore) {
  const current = safeNumber(currentPercentage);
  if (!Number.isFinite(currentMinute) || currentMinute < MIN_TELEGRAM_MINUTE || currentMinute > 92)
    return { send: false, bigBet: false, reason: 'OUTSIDE_ALERT_MINUTES' };
  if (current < MIN_SEND_PERCENTAGE)
    return { send: false, bigBet: false, reason: `Rule ${current}% < ${MIN_SEND_PERCENTAGE}%` };
  const previous = alertState.get(matchId);
  if (!previous) return { send: true, bigBet: false, reason: 'Cảnh báo đầu tiên' };
  if (previous.alertCount >= MAX_ALERTS_PER_MATCH)
    return { send: false, bigBet: false, reason: 'MAX_3_ALERTS' };
  const minuteGap = currentMinute - previous.lastMinute;
  if (minuteGap < MIN_ALERT_GAP_MINUTES)
    return { send: false, bigBet: false, reason: `WAIT_${minuteGap}_MIN` };
  if (minuteGap > FOLLOWUP_WINDOW_MINUTES)
    return { send: false, bigBet: false, reason: `WINDOW_EXPIRED_${minuteGap}_MIN` };
  const snapshot = makeMatchSnapshot(stats, currentMinute, homeScore, awayScore);
  const spike = detectTenMinuteSpike(previous.alertSnapshot, snapshot);
  if (!spike.confirmed)
    return { send: false, bigBet: false, reason: `NO_NEW_SPIKE ${spike.reason}` };
  return { send: true, bigBet: current >= BIG_BET_PERCENTAGE, reason: `Đột biến mới | ${spike.reason}` };
}
// ==========================================================
// 36. SCORE HELPERS
// ==========================================================

function extractScores(raw) {

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


      const rawMinute =
        event?.time ??
        event?.minute ??
        event?.elapsed ??
        event?.matchTime;


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

        event?.score?.home;


      const awayScore =

        event?.awayScore ??

        event?.score?.away;


      if (
        homeScore === undefined ||
        awayScore === undefined
      ) {
        continue;
      }


      goals.push(
        `P${minuteText}: ${homeScore}-${awayScore}`
      );
    }
  }


  if (
    !goals.length
  ) {

    return (
      'Chưa lấy được dữ liệu'
    );
  }


  return [...new Set(goals)].sort((a, b) => {
    const minute = text => {
      const m = text.match(/^P(\d+)(?:\+(\d+))?/);
      return m ? Number(m[1]) + Number(m[2] || 0) / 100 : Infinity;
    };
    return minute(a) - minute(b);
  }).join(' | ');
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

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {

    console.log(
      '[Telegram] Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
    );

    return false;
  }


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


  const isBigBet = alertNumber >= 2 && percentage >= BIG_BET_PERCENTAGE && alertDecision?.bigBet === true;


  let title =
    '🔔 RUNG CHUÔNG VÀNG';


  if (
    isBigBet &&
    percentage >= 85
  ) {

    title =
      '🔥🔥🔥 BIG BET RẤT MẠNH 🔥🔥🔥';

  } else if (
    isBigBet
  ) {

    title =
      '🔥🔥 BIG BET 🔥🔥';
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
  if (hasPair('homeRedCards', 'awayRedCards')) statLines.push(`🟥 Thẻ đỏ ${pair('homeRedCards', 'awayRedCards')}`);
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
    ? `💰 Kèo nhà cái (${cleanTelegramText(bookmaker)}): Odds Over ${Number(odd.price).toFixed(2)} — chỉ tham khảo, KHÔNG cộng Rule`
    : null;
  const oddNote = oddLine ? ` └─> Odds Over ${Number(odd.price) <= 1.85 ? 'ổn định' : 'tham khảo'} (${Number(odd.price).toFixed(2)})` : null;
  const compactStats = [
    (hasPair('homeAttacks','awayAttacks') || hasPair('homeDangerousAttacks','awayDangerousAttacks') || hasPair('homePossession','awayPossession'))
      ? `📊 LIVE: Attack ${pair('homeAttacks','awayAttacks')} | Danger ${pair('homeDangerousAttacks','awayDangerousAttacks')} | Poss ${pair('homePossession','awayPossession')}%` : null,
    (hasPair('homeTotalShots','awayTotalShots') || hasPair('homeShotsOnTarget','awayShotsOnTarget'))
      ? `🎯 SÚT: Shots ${pair('homeTotalShots','awayTotalShots')} | SOT ${pair('homeShotsOnTarget','awayShotsOnTarget')} | Off ${pair('homeShotsOffTarget','awayShotsOffTarget')} | Blocked ${pair('homeBlockedShots','awayBlockedShots')}` : null,
    `🚩 KHÁC: Corner ${pair('homeCorners','awayCorners')} | Big Chance ${pair('homeBigChances','awayBigChances')} | Yellow ${pair('homeYellowCards','awayYellowCards')} | Red ${pair('homeRedCards','awayRedCards')}`,
    `🔥 THẾ TRẬN: ${prediction.likelyScorer ? cleanTelegramText(prediction.likelyScorer) : 'Đang phân tích'} | Pressure ${prediction.homeShare ?? '?'}%-${prediction.awayShare ?? '?'}%`,
    `📈 RULE: ${percentage.toFixed(1)}% | Còn bàn: +${prediction.expectedExtraGoals ?? '?'} | Dự đoán FT: ${prediction.text || 'N/A'}`
  ];
  const messageLines = [
    `${title} | #${alertNumber}`,
    `🏆 Giải đấu: ${cleanTelegramText(item.league)}`,
    `⚽ Trận: ${cleanTelegramText(item.homeName)} vs ${cleanTelegramText(item.awayName)}`,
    `⏱ Phút: ${item.minute}' | Tỷ số: ${item.homeScore}-${item.awayScore}`,
    item.goalTimeline && item.goalTimeline !== 'Không có dữ liệu' && item.goalTimeline !== 'Chưa lấy được dữ liệu'
      ? `⚽ BÀN THẮNG: ${item.goalTimeline}` : null,
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
  }
}


// ==========================================================
// 44. FETCH ALL LIVE SOURCES
// ==========================================================

async function fetchAllLiveMatches() {

  const [
    sofa,
    flash,
    football
  ] = await Promise.allSettled([

    fetchLiveMatchesFromSofaScore(),

    fetchLiveMatchesFromFlashScore(),

    fetchLiveMatchesFromLiveFootball()

  ]);


  const all = [];
  for (const [name, result] of [['SofaScore', sofa], ['FlashScore', flash], ['LiveFootball', football]]) {
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

  const grouped = new Map();

  const SOURCE_PRIORITY = {
    sofascore: 3,
    flashscore: 2,
    'live-football': 1
  };

  // Gom cùng một trận theo tên đội, nhưng KHÔNG vứt các nguồn phụ.
  for (const match of matches) {

    const key = createMatchKey(
      match.homeName,
      match.awayName
    );

    if (!key || key === '_') {
      continue;
    }

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(match);
  }


  const result = [];

  for (const sourceMatches of grouped.values()) {

    sourceMatches.sort(
      (a, b) =>
        (SOURCE_PRIORITY[b.source] || 0) -
        (SOURCE_PRIORITY[a.source] || 0)
    );

    // Vẫn giữ SofaScore làm match chính như logic cũ,
    // nhưng gắn các bản cùng trận từ FlashScore/Live Football
    // để fetchMatchDetailStats bổ sung chỉ số còn thiếu.
    const primary = sourceMatches[0];

    primary.crossSourceMatches = sourceMatches;

    result.push(primary);
  }

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

  const ai =
    evaluateMatchDynamicAI(
      stats,
      odds,
      momentum,
      minute,
      match.homeScore,
      match.awayScore
    );


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
    `📊 ATT ${stats.homeAttacks}-${stats.awayAttacks} | DA ${stats.homeDangerousAttacks}-${stats.awayDangerousAttacks} | SH ${stats.homeTotalShots}-${stats.awayTotalShots} | SOT ${stats.homeShotsOnTarget}-${stats.awayShotsOnTarget} | BLK ${stats.homeBlockedShots}-${stats.awayBlockedShots} | COR ${stats.homeCorners}-${stats.awayCorners} | POSS ${stats.homePossession}-${stats.awayPossession}${compactBigChance} | 🧠 Rule ${ai.efficiency}% | FT ${scorePrediction.text} | Alert ${alertDecision.send ? 'YES' : 'NO'}`
  );


  const result = {

    ...match,

    alertKey,

    minute,

    stats,

    momentum,

    odds,

    ai,

    scorePrediction,

    goalTimeline:
      compactGoalTimeline,

    alertDecision
  };


  // ======================================================
  // SEND TELEGRAM
  // ======================================================

  if (alertDecision.send && minute >= MIN_TELEGRAM_MINUTE) {

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


  const startedAt =
    Date.now();


  try {

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
    // PRE FILTER 46 -> 92
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
        minute > 92
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
      `[Live] Đủ điều kiện phút 46-92: ${eligibleMatches.length}`
    );


    // ====================================================
    // ANALYZE
    //
    // Chạy từng trận để tránh spam RapidAPI.
    // ====================================================

    const results = [];


    for (
      const match of
      eligibleMatches
    ) {

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


    for (
      const item of
      ranked.slice(0, 10)
    ) {

      console.log(
        `${item.minute}' | ${item.ai.efficiency}% | ${item.homeName} ${item.homeScore}-${item.awayScore} ${item.awayName}`
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
            '[Auto Scan]',
            e.message
          )
      );
  },
  SCAN_INTERVAL_MS
);

  }
);
