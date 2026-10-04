const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());


// ==========================================================
// 1. CẤU HÌNH
// ==========================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const ODDS_API_KEY = process.env.ODDS_API_KEY;


// ==========================================================
// 2. SOFASCORE
// ==========================================================

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';

const SOFASCORE_LIVE_URL =
  `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;


// SofaScore public API fallback.
// Dùng khi RapidAPI SofaScore không trả statistics/incidents.
const SOFASCORE_PUBLIC_HOST = 'api.sofascore.com';


// ==========================================================
// 3. LIVESCORE
// ==========================================================

const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';


// ==========================================================
// 4. FLASHSCORE
// ==========================================================

const FLASHSCORE_HOST = 'flashscore-api1.p.rapidapi.com';

const FLASHSCORE_LIVE_URL =
  `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/live?sport_id=1`;


// ==========================================================
// 5. LIVE FOOTBALL
// ==========================================================

const LIVE_FOOTBALL_HOST =
  'football-live-stream-api.p.rapidapi.com';

const LIVE_FOOTBALL_URL =
  `https://${LIVE_FOOTBALL_HOST}/matches`;


// ==========================================================
// 6. ODDS
// ==========================================================

const ODDS_API_URL = ODDS_API_KEY
  ? `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`
  : '';


// ==========================================================
// 7. ALERT
// ==========================================================

const alertState = new Map();

const ALERT_INCREASE_THRESHOLD = 10.0;

const MAX_ALERTS_PER_MATCH = 3;


// ==========================================================
// 8. CACHE
// ==========================================================

const statsCache = new Map();
const incidentsCache = new Map();
const graphCache = new Map();

const CACHE_TTL = 45 * 1000;


// ==========================================================
// 9. HTTP HELPER
// ==========================================================

async function rapidGet(url, options = {}) {
  if (!PAID_RAPIDAPI_KEY) {
    throw new Error('RAPIDAPI_KEY chưa được cấu hình');
  }

  return axios.get(url, {
    timeout: options.timeout || 8000,
    headers: {
      'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
      'x-rapidapi-host': options.host || ''
    },
    params: options.params || undefined
  });
}


async function publicSofaGet(path) {
  return axios.get(`https://${SOFASCORE_PUBLIC_HOST}${path}`, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
}


// ==========================================================
// 10. THỜI GIAN VIỆT NAM
// ==========================================================

function getVietnamTime() {
  const now = new Date();

  const vnTime = new Date(
    now.getTime() + (7 * 60 * 60 * 1000)
  );

  return {
    dateStr: vnTime.toISOString().slice(0, 10),
    timeStr: vnTime.toISOString().slice(11, 19)
  };
}


// ==========================================================
// 11. COUNTRY MAP
// ==========================================================

const COUNTRY_MAP = {
  'England': 'Anh',
  'Spain': 'Tây Ban Nha',
  'Italy': 'Ý',
  'Germany': 'Đức',
  'France': 'Pháp',
  'Japan': 'Nhật Bản',
  'South Korea': 'Hàn Quốc',
  'Vietnam': 'Việt Nam',
  'Brazil': 'Brazil',
  'Argentina': 'Argentina',
  'Netherlands': 'Hà Lan',
  'Portugal': 'Bồ Đào Nha',
  'Turkey': 'Thổ Nhĩ Kỳ',
  'Saudi Arabia': 'Ả Rập Xê Út',
  'China': 'Trung Quốc',
  'Thailand': 'Thái Lan',
  'Australia': 'Úc',
  'USA': 'Mỹ',
  'Norway': 'Na Uy',
  'Czech Republic': 'Cộng hòa Séc',
  'Denmark': 'Đan Mạch',
  'Croatia': 'Croatia',
  'Poland': 'Ba Lan',
  'Austria': 'Áo',
  'World': 'Quốc Tế',
  'Europe': 'Châu Âu',
  'Asia': 'Châu Á',
  'South America': 'Nam Mỹ'
};


// ==========================================================
// 12. LEAGUE MAP
// ==========================================================

const LEAGUE_NAME_MAP = {
  'UEFA Champions League': 'Cúp C1 Châu Âu',
  'UEFA Europa League': 'Cúp C2 Châu Âu',
  'UEFA Conference League': 'Cúp C3 Châu Âu',
  'UEFA Nations League': 'Nations League Châu Âu',

  'AFC Champions League Elite': 'Cúp C1 Châu Á',
  'AFC Champions League Two': 'Cúp C2 Châu Á',

  'AFC Asian Cup': 'Cúp Châu Á (Asian Cup)',

  'CONMEBOL Libertadores':
    'Cúp C1 Nam Mỹ (Libertadores)',

  'CONMEBOL Sudamericana':
    'Cúp C2 Nam Mỹ (Sudamericana)',

  'World Cup':
    'Giải Vô Địch Thế Giới (World Cup)',

  'Club World Cup':
    'Giải VĐQG Thế Giới Các CLB',

  'Friendlies':
    'Giao Hữu Quốc Tế',

  'Club Friendly':
    'Giao Hữu CLB',

  'Premier League':
    'Ngoại Hạng Anh',

  'Championship':
    'Hạng Nhất Anh',

  'League One':
    'Hạng Hai Anh',

  'League Two':
    'Hạng Ba Anh',

  'FA Cup':
    'Cúp FA',

  'EFL Cup':
    'Cúp Liên Đoàn Anh',

  'LaLiga':
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

  'Bundesliga':
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
// 13. PARSE LEAGUE
// ==========================================================

function parseLeagueName(item) {

  if (!item) {
    return 'Bóng Đá Quốc Tế';
  }

  const category =
    item.tournament?.category?.name ||
    item.category?.name ||
    item.competition?.category?.name ||
    '';

  const tournament =
    item.tournament?.name ||
    item.competitionName ||
    item.competition?.name ||
    item.league ||
    item.leagueName ||
    '';

  if (LEAGUE_NAME_MAP[tournament]) {
    return LEAGUE_NAME_MAP[tournament];
  }

  const translatedCategory =
    COUNTRY_MAP[category] || category;

  let translatedTournament = tournament
    .replace(/\bPremier League\b/gi, 'Giải VĐQG')
    .replace(/\bDivision 1\b/gi, 'Hạng 1')
    .replace(/\bDivision 2\b/gi, 'Hạng 2')
    .replace(/\bSuper League\b/gi, 'VĐQG')
    .replace(/\bCup\b/gi, 'Cúp');

  if (
    translatedCategory &&
    translatedTournament
  ) {

    if (
      translatedTournament
        .toLowerCase()
        .includes(translatedCategory.toLowerCase())
    ) {
      return translatedTournament;
    }

    return `${translatedTournament} (${translatedCategory})`;
  }

  return (
    translatedTournament ||
    translatedCategory ||
    'Bóng Đá Quốc Tế'
  );
}


// ==========================================================
// 14. FILTER GIẢI
// ==========================================================

function isFilteredLeague(
  leagueName,
  homeName,
  awayName
) {

  const textToTest =
    `${leagueName} ${homeName} ${awayName}`.toLowerCase();

  const leagueLower =
    leagueName.toLowerCase();

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
    professionalWomenKeywords.some(
      kw => leagueLower.includes(kw)
    )
  ) {
    return false;
  }

  const youthRegex =
    /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;

  if (youthRegex.test(textToTest)) {
    return true;
  }

  const filterKeywords = [
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

  return filterKeywords.some(
    kw => textToTest.includes(kw)
  );
}


// ==========================================================
// 15. CLEAN TEAM NAME
// ==========================================================

function cleanTeamName(name) {

  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(
      /\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk|fk|sk)\b/g,
      ''
    )
    .replace(/[^a-z0-9]/g, '')
    .trim();
}


function teamSimilarity(a, b) {

  const x = cleanTeamName(a);
  const y = cleanTeamName(b);

  if (!x || !y) return 0;

  if (x === y) return 1;

  if (x.includes(y) || y.includes(x)) {
    return 0.9;
  }

  const minLength = Math.min(x.length, y.length);

  let same = 0;

  for (let i = 0; i < minLength; i++) {
    if (x[i] === y[i]) same++;
  }

  return same / Math.max(x.length, y.length);
}


// ==========================================================
// 16. TÍNH PHÚT
// ==========================================================

function calculateExactMinute(item) {

  if (!item) return 0;

  const statusType =
    String(
      item.status?.type ||
      item.status ||
      ''
    ).toLowerCase();

  const statusDescription =
    String(
      item.status?.description ||
      ''
    ).toLowerCase();

  if (
    statusType === 'finished' ||
    statusType === 'ended' ||
    statusType === 'cancelled' ||
    statusType === 'canceled'
  ) {
    return 999;
  }

  if (
    statusDescription.includes('halftime') ||
    statusDescription === 'ht' ||
    statusType === 'halftime'
  ) {
    return 'HT';
  }

  const directMinuteCandidates = [
    item.minute,
    item.liveMinute,
    item.live?.minute,
    item.status?.minute,
    item.status?.current,
    item.time?.current,
    item.time?.minute,
    item.time?.currentMinute
  ];

  for (const value of directMinuteCandidates) {

    const minute = Number(value);

    if (
      Number.isFinite(minute) &&
      minute > 0 &&
      minute <= 130
    ) {
      return Math.floor(minute);
    }
  }

  const currentPeriodStartTimestamp =
    Number(
      item.time?.currentPeriodStartTimestamp ||
      item.currentPeriodStartTimestamp ||
      item.time?.currentPeriodStart
    );

  if (
    Number.isFinite(currentPeriodStartTimestamp) &&
    currentPeriodStartTimestamp > 0
  ) {

    const now =
      Math.floor(Date.now() / 1000);

    const elapsedSeconds =
      now - currentPeriodStartTimestamp;

    if (
      elapsedSeconds >= 0 &&
      elapsedSeconds < 7200
    ) {

      let minute =
        Math.floor(elapsedSeconds / 60) + 1;

      const isSecondHalf =
        statusDescription.includes('2nd half') ||
        statusDescription.includes('second half') ||
        statusDescription.includes('hiệp 2');

      if (isSecondHalf) {
        minute =
          45 +
          Math.floor(elapsedSeconds / 60) +
          1;
      }

      return minute;
    }
  }

  const startTimestamp =
    Number(
      item.startTimestamp ||
      item.start_timestamp
    );

  if (
    Number.isFinite(startTimestamp) &&
    startTimestamp > 0 &&
    statusType === 'inprogress'
  ) {

    const now =
      Math.floor(Date.now() / 1000);

    const elapsedSeconds =
      now - startTimestamp;

    if (
      elapsedSeconds >= 0 &&
      elapsedSeconds < 7200
    ) {
      return (
        Math.floor(elapsedSeconds / 60) + 1
      );
    }
  }

  return 0;
}


// ==========================================================
// 17. FETCH LIVE SOFASCORE
// ==========================================================

async function fetchLiveMatchesFromSofaScore() {

  try {

    if (!PAID_RAPIDAPI_KEY) {
      return [];
    }

    const response =
      await axios.get(
        SOFASCORE_LIVE_URL,
        {
          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              SOFASCORE_HOST
          },

          timeout: 10000
        }
      );

    return (
      response.data?.events ||
      response.data?.liveEvents ||
      response.data?.data ||
      []
    );

  } catch (err) {

    console.error(
      '[SofaScore Live Error]:',
      err.message
    );

    return [];
  }
}


// ==========================================================
// 18. FETCH FLASHSCORE
// ==========================================================

async function fetchLiveMatchesFromFlashScore() {

  try {

    if (!PAID_RAPIDAPI_KEY) {
      return [];
    }

    const response =
      await axios.get(
        FLASHSCORE_LIVE_URL,
        {
          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              FLASHSCORE_HOST
          },

          timeout: 8000
        }
      );

    const data =
      response.data;

    return (
      Array.isArray(data)
        ? data
        : (
          data?.data ||
          data?.matches ||
          data?.events ||
          []
        )
    );

  } catch (err) {

    console.error(
      '[FlashScore Error]:',
      err.message
    );

    return [];
  }
}


// ==========================================================
// 19. FETCH LIVE FOOTBALL
// ==========================================================

async function fetchLiveMatchesFromLiveFootball() {

  try {

    if (!PAID_RAPIDAPI_KEY) {
      return [];
    }

    const response =
      await axios.get(
        LIVE_FOOTBALL_URL,
        {
          params: {
            status: 'live'
          },

          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              LIVE_FOOTBALL_HOST
          },

          timeout: 8000
        }
      );

    return (
      response.data?.result ||
      response.data?.matches ||
      response.data?.data ||
      []
    );

  } catch (err) {

    console.error(
      '[Live Football Error]:',
      err.message
    );

    return [];
  }
}


// ==========================================================
// 20. SOFASCORE EVENT DETAIL
// ==========================================================

async function fetchSofaEvent(eventId) {

  if (!eventId) {
    return null;
  }

  const id =
    String(eventId);

  // RapidAPI
  try {

    const response =
      await axios.get(
        `https://${SOFASCORE_HOST}/events/get-event`,
        {
          params: {
            eventId: id
          },

          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              SOFASCORE_HOST
          },

          timeout: 6000
        }
      );

    const event =
      response.data?.event ||
      response.data?.data ||
      response.data;

    if (event) {
      return event;
    }

  } catch (err) {
    console.log(
      `   └─ Sofa event lookup RapidAPI lỗi: ${err.response?.status || err.message}`
    );
  }


  // Public SofaScore fallback
  try {

    const response =
      await publicSofaGet(
        `/api/v1/event/${id}`
      );

    return (
      response.data?.event ||
      response.data?.data ||
      response.data
    );

  } catch (err) {

    console.log(
      `   └─ Sofa public event lỗi: ${err.response?.status || err.message}`
    );

    return null;
  }
}


// ==========================================================
// 21. TÌM SOFASCORE EVENT ID BẰNG TÊN ĐỘI
// ==========================================================

async function resolveSofaEventId(
  match,
  sofaLiveMatches
) {

  // Nếu chính SofaScore thì ID hiện tại chính là event ID.
  if (
    match.source === 'sofascore' &&
    match.id &&
    /^\d+$/.test(String(match.id))
  ) {
    return String(match.id);
  }


  // Kiểm tra trong danh sách SofaScore live hiện tại.
  let best = null;
  let bestScore = 0;

  for (const event of sofaLiveMatches) {

    const sofaHome =
      event.homeTeam?.name ||
      event.homeTeam?.shortName ||
      '';

    const sofaAway =
      event.awayTeam?.name ||
      event.awayTeam?.shortName ||
      '';

    const homeScore =
      teamSimilarity(
        match.homeName,
        sofaHome
      );

    const awayScore =
      teamSimilarity(
        match.awayName,
        sofaAway
      );

    const combined =
      (homeScore + awayScore) / 2;

    if (combined > bestScore) {

      bestScore = combined;

      best = event;
    }
  }

  if (
    best &&
    bestScore >= 0.70
  ) {

    console.log(
      `   └─ [MATCH LINK] ${match.homeName} vs ${match.awayName} -> SofaEvent ${best.id} (${(bestScore * 100).toFixed(0)}%)`
    );

    return String(best.id);
  }


  return null;
}


// ==========================================================
// 22. PARSE STATS OBJECT
// ==========================================================

function parseStatisticsObject(
  data
) {

  const result = {

    possessionHome: null,
    possessionAway: null,

    totalShots: 0,
    shotsOnTarget: 0,
    shotsOffTarget: 0,
    blockedShots: 0,

    corners: 0,
    redCards: 0,

    fouls: 0,

    sources: []
  };


  function processItem(item) {

    if (!item || typeof item !== 'object') {
      return;
    }

    const name =
      String(
        item.name ||
        item.key ||
        item.slug ||
        item.type ||
        item.title ||
        ''
      ).toLowerCase();

    let home =
      parseFloat(
        String(
          item.home ??
          item.homeValue ??
          ''
        ).replace('%', '')
      );

    let away =
      parseFloat(
        String(
          item.away ??
          item.awayValue ??
          ''
        ).replace('%', '')
      );

    if (!Number.isFinite(home)) {
      home = null;
    }

    if (!Number.isFinite(away)) {
      away = null;
    }

    if (
      name.includes('possession') ||
      name.includes('ball possession') ||
      name.includes('kiểm soát')
    ) {

      if (
        home !== null &&
        away !== null
      ) {

        result.possessionHome =
          home;

        result.possessionAway =
          away;
      }
    }


    if (
      name.includes('shots on target') ||
      name.includes('shot on target') ||
      name.includes('ontarget') ||
      name.includes('sút trúng đích')
    ) {

      result.shotsOnTarget =
        Math.max(
          result.shotsOnTarget,
          (home || 0) + (away || 0)
        );
    }


    else if (
      name === 'shots' ||
      name === 'total shots' ||
      name.includes('total shots') ||
      name.includes('sút')
    ) {

      result.totalShots =
        Math.max(
          result.totalShots,
          (home || 0) + (away || 0)
        );
    }


    else if (
      name.includes('shots off target') ||
      name.includes('shot off target')
    ) {

      result.shotsOffTarget =
        Math.max(
          result.shotsOffTarget,
          (home || 0) + (away || 0)
        );
    }


    else if (
      name.includes('blocked shots') ||
      name.includes('blocked')
    ) {

      result.blockedShots =
        Math.max(
          result.blockedShots,
          (home || 0) + (away || 0)
        );
    }


    else if (
      name.includes('corner') ||
      name.includes('phạt góc')
    ) {

      result.corners =
        Math.max(
          result.corners,
          (home || 0) + (away || 0)
        );
    }


    else if (
      name.includes('red card') ||
      name.includes('red cards') ||
      name.includes('thẻ đỏ')
    ) {

      result.redCards =
        Math.max(
          result.redCards,
          (home || 0) + (away || 0)
        );
    }


    else if (
      name.includes('foul') ||
      name.includes('phạm lỗi')
    ) {

      result.fouls =
        Math.max(
          result.fouls,
          (home || 0) + (away || 0)
        );
    }
  }


  function recursiveScan(obj) {

    if (!obj) return;

    if (Array.isArray(obj)) {

      for (const item of obj) {
        recursiveScan(item);
      }

      return;
    }


    if (
      typeof obj !== 'object'
    ) {
      return;
    }


    // Statistics item
    if (
      obj.name ||
      obj.key ||
      obj.slug
    ) {
      processItem(obj);
    }


    for (
      const value of Object.values(obj)
    ) {

      if (
        value &&
        typeof value === 'object'
      ) {
        recursiveScan(value);
      }
    }
  }


  recursiveScan(data);


  if (
    result.totalShots === 0 &&
    (
      result.shotsOnTarget > 0 ||
      result.shotsOffTarget > 0 ||
      result.blockedShots > 0
    )
  ) {

    result.totalShots =
      result.shotsOnTarget +
      result.shotsOffTarget +
      result.blockedShots;
  }


  if (
    result.possessionHome !== null &&
    result.possessionAway !== null
  ) {

    result.possession =
      `${result.possessionHome}% - ${result.possessionAway}%`;
  } else {

    result.possession =
      null;
  }


  return result;
}


// ==========================================================
// 23. LẤY STATS SOFASCORE
// ==========================================================

async function fetchSofaStatistics(
  sofaEventId
) {

  if (!sofaEventId) {
    return null;
  }

  const cacheKey =
    String(sofaEventId);

  const cached =
    statsCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < CACHE_TTL
  ) {
    return cached.data;
  }


  console.log(
    `   └─ [SOFA STATS] Event ${sofaEventId}`
  );


  // --------------------------------------------------------
  // 1. RapidAPI endpoint 1
  // --------------------------------------------------------

  try {

    const response =
      await axios.get(
        `https://${SOFASCORE_HOST}/events/get-statistics`,
        {
          params: {
            eventId: sofaEventId
          },

          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              SOFASCORE_HOST
          },

          timeout: 7000
        }
      );

    const parsed =
      parseStatisticsObject(
        response.data
      );

    if (
      parsed.totalShots > 0 ||
      parsed.shotsOnTarget > 0 ||
      parsed.corners > 0 ||
      parsed.possession
    ) {

      parsed.sources.push(
        'SofaScore-RapidAPI'
      );

      statsCache.set(
        cacheKey,
        {
          time: Date.now(),
          data: parsed
        }
      );

      return parsed;
    }

  } catch (err) {

    console.log(
      `   └─ SofaScore RapidAPI stats 1 lỗi: ${err.response?.status || err.message}`
    );
  }


  // --------------------------------------------------------
  // 2. RapidAPI endpoint 2
  // --------------------------------------------------------

  try {

    const response =
      await axios.get(
        `https://${SOFASCORE_HOST}/events/statistics`,
        {
          params: {
            eventId: sofaEventId
          },

          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              SOFASCORE_HOST
          },

          timeout: 7000
        }
      );

    const parsed =
      parseStatisticsObject(
        response.data
      );

    if (
      parsed.totalShots > 0 ||
      parsed.shotsOnTarget > 0 ||
      parsed.corners > 0 ||
      parsed.possession
    ) {

      parsed.sources.push(
        'SofaScore-RapidAPI-2'
      );

      statsCache.set(
        cacheKey,
        {
          time: Date.now(),
          data: parsed
        }
      );

      return parsed;
    }

  } catch (err) {

    console.log(
      `   └─ SofaScore RapidAPI stats 2 lỗi: ${err.response?.status || err.message}`
    );
  }


  // --------------------------------------------------------
  // 3. PUBLIC SOFASCORE
  // --------------------------------------------------------

  try {

    const response =
      await publicSofaGet(
        `/api/v1/event/${sofaEventId}/statistics`
      );

    const parsed =
      parseStatisticsObject(
        response.data
      );

    if (
      parsed.totalShots > 0 ||
      parsed.shotsOnTarget > 0 ||
      parsed.corners > 0 ||
      parsed.possession
    ) {

      parsed.sources.push(
        'SofaScore-Public'
      );

      statsCache.set(
        cacheKey,
        {
          time: Date.now(),
          data: parsed
        }
      );

      return parsed;
    }

  } catch (err) {

    console.log(
      `   └─ SofaScore Public stats lỗi: ${err.response?.status || err.message}`
    );
  }


  return null;
}


// ==========================================================
// 24. LIVESCORE STATS
// ==========================================================

async function fetchLiveScoreStatistics(
  homeName,
  awayName
) {

  try {

    const searchUrl =
      `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;

    const resLive =
      await axios.get(
        searchUrl,
        {
          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              LIVESCORE_HOST
          },

          timeout: 7000
        }
      );


    let foundEid = null;


    function scanForEid(obj) {

      if (
        !obj ||
        foundEid
      ) {
        return;
      }

      if (
        typeof obj !== 'object'
      ) {
        return;
      }


      const mId =
        String(
          obj.Eid ||
          obj.eid ||
          obj.id ||
          ''
        );


      const t1 =
        String(
          obj.T1?.[0]?.Nm ||
          obj.homeTeam?.name ||
          obj.home?.name ||
          ''
        );


      const t2 =
        String(
          obj.T2?.[0]?.Nm ||
          obj.awayTeam?.name ||
          obj.away?.name ||
          ''
        );


      const homeSimilarity =
        teamSimilarity(
          homeName,
          t1
        );

      const awaySimilarity =
        teamSimilarity(
          awayName,
          t2
        );


      if (
        mId &&
        homeSimilarity >= 0.65 &&
        awaySimilarity >= 0.65
      ) {

        foundEid =
          mId;

        return;
      }


      for (
        const value of Object.values(obj)
      ) {

        if (
          value &&
          typeof value === 'object'
        ) {
          scanForEid(value);
        }
      }
    }


    scanForEid(
      resLive.data
    );


    if (!foundEid) {
      return null;
    }


    const statsRes =
      await axios.get(
        `https://${LIVESCORE_HOST}/matches/v2/get-statistics`,
        {
          params: {
            Category: 'soccer',
            Eid: foundEid
          },

          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              LIVESCORE_HOST
          },

          timeout: 7000
        }
      );


    const parsed =
      parseStatisticsObject(
        statsRes.data
      );


    if (
      parsed.totalShots > 0 ||
      parsed.shotsOnTarget > 0 ||
      parsed.corners > 0 ||
      parsed.possession
    ) {

      parsed.sources.push(
        'LiveScore'
      );

      return parsed;
    }


  } catch (err) {

    console.log(
      `   └─ LiveScore Stats lỗi: ${err.response?.status || err.message}`
    );
  }


  return null;
}


// ==========================================================
// 25. FLASHSCORE STATS
// ==========================================================

async function fetchFlashScoreStatistics(
  matchId
) {

  if (!matchId) {
    return null;
  }


  try {

    const urls = [

      `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/details`,

      `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/match`

    ];


    for (const url of urls) {

      try {

        const response =
          await axios.get(
            url,
            {
              params: {
                matchId
              },

              headers: {
                'x-rapidapi-key':
                  PAID_RAPIDAPI_KEY.trim(),

                'x-rapidapi-host':
                  FLASHSCORE_HOST
              },

              timeout: 6000
            }
          );


        const parsed =
          parseStatisticsObject(
            response.data
          );


        if (
          parsed.totalShots > 0 ||
          parsed.shotsOnTarget > 0 ||
          parsed.corners > 0 ||
          parsed.possession
        ) {

          parsed.sources.push(
            'FlashScore'
          );

          return parsed;
        }

      } catch (err) {}
    }

  } catch (err) {}

  return null;
}


// ==========================================================
// 26. MERGE STATS
// ==========================================================

function mergeStats(
  statsList
) {

  const finalStats = {

    possessionHome: null,
    possessionAway: null,
    possession: null,

    totalShots: 0,
    shotsOnTarget: 0,
    shotsOffTarget: 0,
    blockedShots: 0,

    corners: 0,
    redCards: 0,
    fouls: 0,

    sources: []
  };


  for (const stats of statsList) {

    if (!stats) continue;


    if (
      stats.possessionHome !== null &&
      stats.possessionAway !== null
    ) {

      if (
        finalStats.possession === null
      ) {

        finalStats.possessionHome =
          stats.possessionHome;

        finalStats.possessionAway =
          stats.possessionAway;

        finalStats.possession =
          stats.possession;
      }
    }


    finalStats.totalShots =
      Math.max(
        finalStats.totalShots,
        stats.totalShots || 0
      );


    finalStats.shotsOnTarget =
      Math.max(
        finalStats.shotsOnTarget,
        stats.shotsOnTarget || 0
      );


    finalStats.shotsOffTarget =
      Math.max(
        finalStats.shotsOffTarget,
        stats.shotsOffTarget || 0
      );


    finalStats.blockedShots =
      Math.max(
        finalStats.blockedShots,
        stats.blockedShots || 0
      );


    finalStats.corners =
      Math.max(
        finalStats.corners,
        stats.corners || 0
      );


    finalStats.redCards =
      Math.max(
        finalStats.redCards,
        stats.redCards || 0
      );


    finalStats.fouls =
      Math.max(
        finalStats.fouls,
        stats.fouls || 0
      );


    if (
      Array.isArray(stats.sources)
    ) {

      finalStats.sources.push(
        ...stats.sources
      );
    }
  }


  finalStats.sources =
    [...new Set(finalStats.sources)];


  if (
    finalStats.totalShots === 0 &&
    (
      finalStats.shotsOnTarget > 0 ||
      finalStats.shotsOffTarget > 0 ||
      finalStats.blockedShots > 0
    )
  ) {

    finalStats.totalShots =
      finalStats.shotsOnTarget +
      finalStats.shotsOffTarget +
      finalStats.blockedShots;
  }


  return finalStats;
}


// ==========================================================
// 27. LẤY STATS ĐA NGUỒN
// ==========================================================

async function fetchMatchDetailStats(
  match,
  sofaEventId
) {

  console.log(
    `   └─ [STATS] Bắt đầu lấy dữ liệu đa nguồn...`
  );


  const results = await Promise.allSettled([

    sofaEventId
      ? fetchSofaStatistics(sofaEventId)
      : Promise.resolve(null),

    fetchLiveScoreStatistics(
      match.homeName,
      match.awayName
    ),

    match.source === 'flashscore'
      ? fetchFlashScoreStatistics(match.id)
      : Promise.resolve(null)

  ]);


  const statsList =
    results.map(
      result =>
        result.status === 'fulfilled'
          ? result.value
          : null
    );


  const merged =
    mergeStats(statsList);


  const quality =
    calculateDataQuality(
      merged
    );


  console.log(
    `   └─ [STATS] Sources: ${
      merged.sources.length
        ? merged.sources.join(', ')
        : 'Không có'
    }`
  );


  console.log(
    `   └─ [STATS] Quality: ${quality}%`
  );


  console.log(
    `   └─ [STATS] Possession: ${
      merged.possession || 'N/A'
    }`
  );


  console.log(
    `   └─ [STATS] Shots: ${
      merged.totalShots || 'N/A'
    } | SOT: ${
      merged.shotsOnTarget || 'N/A'
    } | Corners: ${
      merged.corners || 'N/A'
    } | Red: ${
      merged.redCards || 'N/A'
    }`
  );


  return {
    sofaStats: merged,
    dataQuality: quality
  };
}


// ==========================================================
// 28. DATA QUALITY
// ==========================================================

function calculateDataQuality(stats) {

  let quality = 0;

  if (
    stats.possession
  ) quality += 25;

  if (
    stats.totalShots > 0
  ) quality += 20;

  if (
    stats.shotsOnTarget > 0
  ) quality += 25;

  if (
    stats.corners > 0
  ) quality += 15;

  if (
    stats.redCards > 0
  ) quality += 10;

  if (
    stats.sources.length > 1
  ) quality += 5;

  return Math.min(
    quality,
    100
  );
}


// ==========================================================
// 29. FETCH INCIDENTS SOFASCORE
// ==========================================================

async function fetchSofaIncidents(
  sofaEventId
) {

  if (!sofaEventId) {
    return [];
  }


  const cacheKey =
    String(sofaEventId);


  const cached =
    incidentsCache.get(cacheKey);


  if (
    cached &&
    Date.now() - cached.time < CACHE_TTL
  ) {
    return cached.data;
  }


  // RapidAPI
  try {

    const response =
      await axios.get(
        `https://${SOFASCORE_HOST}/events/get-incidents`,
        {
          params: {
            eventId: sofaEventId
          },

          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              SOFASCORE_HOST
          },

          timeout: 7000
        }
      );


    const incidents =
      response.data?.incidents ||
      response.data?.data?.incidents ||
      [];


    if (Array.isArray(incidents)) {

      incidentsCache.set(
        cacheKey,
        {
          time: Date.now(),
          data: incidents
        }
      );

      return incidents;
    }

  } catch (err) {

    console.log(
      `   └─ SofaScore RapidAPI incidents lỗi: ${err.response?.status || err.message}`
    );
  }


  // Public SofaScore
  try {

    const response =
      await publicSofaGet(
        `/api/v1/event/${sofaEventId}/incidents`
      );


    const incidents =
      response.data?.incidents ||
      [];


    if (Array.isArray(incidents)) {

      incidentsCache.set(
        cacheKey,
        {
          time: Date.now(),
          data: incidents
        }
      );

      return incidents;
    }

  } catch (err) {

    console.log(
      `   └─ SofaScore Public incidents lỗi: ${err.response?.status || err.message}`
    );
  }


  return [];
}


// ==========================================================
// 30. PARSE GOAL INCIDENTS
// ==========================================================

function parseGoalTimeline(
  incidents,
  currentMinute,
  homeScore,
  awayScore
) {

  if (
    !Array.isArray(incidents)
  ) {

    return {
      goals: [],
      totalGoals: homeScore + awayScore,
      secondHalfGoals: 0,
      goalsLast15: 0,
      goalsLast30: 0,
      minutesSinceLastGoal: null,
      lastGoalMinute: null
    };
  }


  const goals =
    incidents
      .filter(
        inc =>
          String(
            inc.incidentType || ''
          ).toLowerCase() === 'goal'
      )
      .map(
        goal => {

          const minute =
            Number(
              goal.time ??
              goal.minute ??
              0
            );


          return {

            minute,

            addedTime:
              goal.addedTime ||
              goal.timeAdded ||
              0,

            isHome:
              Boolean(
                goal.isHome
              ),

            player:
              goal.player?.shortName ||
              goal.player?.name ||
              goal.playerName ||
              'Cầu thủ',

            homeScore:
              goal.homeScore,

            awayScore:
              goal.awayScore
          };
        }
      )
      .filter(
        goal =>
          Number.isFinite(
            goal.minute
          )
      )
      .sort(
        (a, b) =>
          a.minute - b.minute
      );


  const totalGoals =
    goals.length > 0
      ? goals.length
      : homeScore + awayScore;


  const secondHalfGoals =
    goals.filter(
      goal =>
        goal.minute >= 46
    ).length;


  const goalsLast15 =
    goals.filter(
      goal =>
        goal.minute >=
        currentMinute - 15
    ).length;


  const goalsLast30 =
    goals.filter(
      goal =>
        goal.minute >=
        currentMinute - 30
    ).length;


  const lastGoal =
    goals.length
      ? goals[goals.length - 1]
      : null;


  const minutesSinceLastGoal =
    lastGoal
      ? Math.max(
          0,
          currentMinute -
          lastGoal.minute
        )
      : null;


  return {

    goals,

    totalGoals,

    secondHalfGoals,

    goalsLast15,

    goalsLast30,

    minutesSinceLastGoal,

    lastGoalMinute:
      lastGoal?.minute ?? null
  };
}


// ==========================================================
// 31. FETCH GOAL TIMELINE
// ==========================================================

async function fetchMatchIncidents(
  sofaEventId,
  homeScore,
  awayScore,
  currentMinute
) {

  const incidents =
    await fetchSofaIncidents(
      sofaEventId
    );


  const goalData =
    parseGoalTimeline(
      incidents,
      currentMinute,
      homeScore,
      awayScore
    );


  if (
    goalData.goals.length === 0
  ) {

    if (
      homeScore +
      awayScore > 0
    ) {

      return {
        text:
          `• Đã có ${
            homeScore +
            awayScore
          } bàn thắng được ghi (Tỷ số hiện tại: ${homeScore}-${awayScore})`,

        data: goalData
      };
    }


    return {
      text:
        '• Chưa có bàn thắng (Tỷ số: 0-0)',

      data: goalData
    };
  }


  const timeline =
    goalData.goals
      .map(
        goal => {

          const extra =
            goal.addedTime
              ? `+${goal.addedTime}`
              : '';

          const side =
            goal.isHome
              ? '🏠 Chủ'
              : '✈️ Khách';

          const score =
            goal.homeScore !== undefined &&
            goal.awayScore !== undefined
              ? ` [${goal.homeScore}-${goal.awayScore}]`
              : '';

          return (
            `• Phút ${goal.minute}'${extra}: ⚽ ${side} ${goal.player}${score}`
          );
        }
      )
      .join('\n');


  return {
    text: timeline,
    data: goalData
  };
}


// ==========================================================
// 32. MOMENTUM GRAPH
// ==========================================================

async function fetchSofaMomentum(
  sofaEventId
) {

  if (!sofaEventId) {
    return null;
  }


  const cacheKey =
    String(sofaEventId);


  const cached =
    graphCache.get(cacheKey);


  if (
    cached &&
    Date.now() - cached.time < CACHE_TTL
  ) {

    return cached.data;
  }


  // Public SofaScore
  try {

    const response =
      await publicSofaGet(
        `/api/v1/event/${sofaEventId}/graph`
      );


    const points =
      response.data?.graphPoints ||
      [];


    if (
      Array.isArray(points) &&
      points.length
    ) {

      const data = {
        points
      };


      graphCache.set(
        cacheKey,
        {
          time: Date.now(),
          data
        }
      );


      return data;
    }

  } catch (err) {}


  // RapidAPI fallback
  try {

    const response =
      await axios.get(
        `https://${SOFASCORE_HOST}/events/get-graph`,
        {
          params: {
            eventId: sofaEventId
          },

          headers: {
            'x-rapidapi-key':
              PAID_RAPIDAPI_KEY.trim(),

            'x-rapidapi-host':
              SOFASCORE_HOST
          },

          timeout: 6000
        }
      );


    const points =
      response.data?.graphPoints ||
      response.data?.points ||
      [];


    if (
      Array.isArray(points) &&
      points.length
    ) {

      return {
        points
      };
    }

  } catch (err) {}


  return null;
}


// ==========================================================
// 33. PHÂN TÍCH MOMENTUM
// ==========================================================

function analyzeMomentum(
  graph,
  currentMinute
) {

  if (
    !graph ||
    !Array.isArray(graph.points) ||
    graph.points.length < 2
  ) {

    return {
      score: 0,
      note: '',
      available: false
    };
  }


  const recent =
    graph.points.filter(
      p =>
        Number(p.minute) >=
        currentMinute - 10
    );


  if (
    recent.length < 2
  ) {

    return {
      score: 0,
      note: '',
      available: false
    };
  }


  const values =
    recent.map(
      p =>
        Number(
          p.value || 0
        )
    );


  const first =
    values[0];

  const last =
    values[values.length - 1];


  const delta =
    last - first;


  let score = 0;
  let note = '';


  if (
    Math.abs(delta) >= 25
  ) {

    score = 12;

    note =
      `Momentum tăng mạnh trong 10 phút gần nhất (${delta > 0 ? '+' : ''}${delta.toFixed(0)})`;
  }

  else if (
    Math.abs(delta) >= 15
  ) {

    score = 8;

    note =
      `Momentum tăng rõ trong 10 phút gần nhất (${delta > 0 ? '+' : ''}${delta.toFixed(0)})`;
  }

  else if (
    Math.abs(delta) >= 8
  ) {

    score = 4;

    note =
      `Momentum có biến động (${delta > 0 ? '+' : ''}${delta.toFixed(0)})`;
  }


  return {
    score,
    note,
    available: true
  };
}


// ==========================================================
// 34. ODDS
// ==========================================================

async function fetchOddsData() {

  if (
    !ODDS_API_KEY ||
    !ODDS_API_URL
  ) {
    return [];
  }


  try {

    const response =
      await axios.get(
        ODDS_API_URL,
        {
          timeout: 8000
        }
      );

    return (
      response.data || []
    );

  } catch (err) {

    console.error(
      '[Odds API Error]:',
      err.message
    );

    return [];
  }
}


// ==========================================================
// 35. ANALYZE ODDS
// ==========================================================

function analyzeOddsGoalProbability(
  allOdds,
  homeName,
  awayName,
  currentTotalGoals
) {

  if (
    !Array.isArray(allOdds) ||
    allOdds.length === 0
  ) {
    return null;
  }


  const hClean =
    cleanTeamName(homeName);

  const aClean =
    cleanTeamName(awayName);


  const foundMatch =
    allOdds.find(
      match => {

        const mHome =
          cleanTeamName(
            match.home_team
          );

        const mAway =
          cleanTeamName(
            match.away_team
          );


        return (
          (
            mHome.includes(hClean) ||
            hClean.includes(mHome)
          ) &&
          (
            mAway.includes(aClean) ||
            aClean.includes(mAway)
          )
        );
      }
    );


  if (
    !foundMatch ||
    !foundMatch.bookmakers?.length
  ) {
    return null;
  }


  let best = null;


  for (
    const bookmaker of foundMatch.bookmakers
  ) {

    const market =
      bookmaker.markets?.find(
        m =>
          m.key === 'totals'
      );


    if (!market) continue;


    const over =
      market.outcomes?.find(
        o =>
          o.name === 'Over'
      );


    if (!over) continue;


    if (
      !best ||
      Number(over.price) <
      Number(best.odds)
    ) {

      best = {

        bookmaker:
          bookmaker.title,

        line:
          Number(over.point),

        odds:
          Number(over.price)
      };
    }
  }


  if (!best) {
    return null;
  }


  let oddsBonus = 0;

  const notes = [];


  const pointDiff =
    best.line -
    currentTotalGoals;


  if (
    pointDiff >= 0.75
  ) {

    oddsBonus += 16;

    notes.push(
      `Line Over cao (${best.line})`
    );

  } else if (
    pointDiff > 0
  ) {

    oddsBonus += 10;

    notes.push(
      `Line Over sát mốc (${best.line})`
    );
  }


  if (
    best.odds <= 1.40
  ) {

    oddsBonus += 18;

  } else if (
    best.odds <= 1.60
  ) {

    oddsBonus += 13;

  } else if (
    best.odds <= 1.85
  ) {

    oddsBonus += 8;

  } else {

    oddsBonus += 4;
  }


  return {

    bookmaker:
      best.bookmaker,

    line:
      best.line,

    odds:
      best.odds,

    oddsBonus,

    oddsNoteText:
      notes.join(' | ')
  };
}


// ==========================================================
// 36. AI PHÂN TÍCH
// ==========================================================

function evaluateMatchDynamicAI(
  metrics,
  goalData,
  momentumData,
  oddsAnalysis
) {

  const stats =
    metrics.sofaStats || {};


  let aiPercentage = 18.0;

  const analysis = [];

  let dataPoints = 0;


  // ========================================================
  // A. DIỄN BIẾN TỶ SỐ
  // ========================================================

  const totalGoals =
    goalData.totalGoals || 0;


  const secondHalfGoals =
    goalData.secondHalfGoals || 0;


  const goalsLast15 =
    goalData.goalsLast15 || 0;


  const goalsLast30 =
    goalData.goalsLast30 || 0;


  if (
    totalGoals > 0
  ) {

    dataPoints += 1;

    aiPercentage +=
      Math.min(
        totalGoals * 2,
        8
      );


    analysis.push(
      `⚽ Đã có ${totalGoals} bàn trong trận`
    );
  }


  if (
    secondHalfGoals >= 1
  ) {

    dataPoints += 1;

    aiPercentage +=
      Math.min(
        secondHalfGoals * 5,
        10
      );


    analysis.push(
      `🔥 Hiệp 2 đã có ${secondHalfGoals} bàn`
    );
  }


  if (
    goalsLast15 >= 1
  ) {

    aiPercentage += 10;

    dataPoints += 1;

    analysis.push(
      `🚨 Có bàn thắng trong 15 phút gần nhất`
    );
  }


  if (
    goalsLast15 >= 2
  ) {

    aiPercentage += 8;

    analysis.push(
      `🔥 Nhịp bàn thắng cực cao: ${goalsLast15} bàn/15 phút`
    );
  }


  if (
    goalsLast30 >= 2
  ) {

    aiPercentage += 6;

    analysis.push(
      `⚡ Có ${goalsLast30} bàn trong 30 phút gần nhất`
    );
  }


  if (
    goalData.minutesSinceLastGoal !== null
  ) {

    const since =
      goalData.minutesSinceLastGoal;


    if (
      since <= 10
    ) {

      aiPercentage += 6;

      analysis.push(
        `⚡ Bàn gần nhất chỉ cách ${since} phút`
      );

    } else if (
      since <= 20
    ) {

      aiPercentage += 4;

      analysis.push(
        `🎯 Bàn gần nhất cách ${since} phút`
      );
    }
  }


  // ========================================================
  // B. POSSESSION
  // ========================================================

  if (
    stats.possession
  ) {

    dataPoints += 1;

    analysis.push(
      `📊 Kiểm soát bóng: ${stats.possession}`
    );


    const parts =
      stats.possession.split('-');


    if (
      parts.length === 2
    ) {

      const homePoss =
        parseInt(
          parts[0],
          10
        ) || 50;

      const awayPoss =
        parseInt(
          parts[1],
          10
        ) || 50;


      const maxPoss =
        Math.max(
          homePoss,
          awayPoss
        );


      if (
        maxPoss >= 70
      ) {

        aiPercentage += 12;

        analysis.push(
          `└─> Áp đảo cực mạnh (${maxPoss}%)`
        );

      } else if (
        maxPoss >= 60
      ) {

        aiPercentage += 7;

        analysis.push(
          `└─> Thế trận lấn lướt (${maxPoss}%)`
        );
      }
    }
  }


  // ========================================================
  // C. SOT
  // ========================================================

  if (
    stats.shotsOnTarget >= 6
  ) {

    aiPercentage += 18;

    dataPoints += 1;

    analysis.push(
      `🎯 SOT rất cao: ${stats.shotsOnTarget}`
    );

  } else if (
    stats.shotsOnTarget >= 4
  ) {

    aiPercentage += 12;

    dataPoints += 1;

    analysis.push(
      `🎯 SOT tốt: ${stats.shotsOnTarget}`
    );

  } else if (
    stats.shotsOnTarget >= 2
  ) {

    aiPercentage += 6;

    dataPoints += 1;

    analysis.push(
      `🎯 SOT: ${stats.shotsOnTarget}`
    );
  }


  // ========================================================
  // D. TOTAL SHOTS
  // ========================================================

  if (
    stats.totalShots >= 15
  ) {

    aiPercentage += 15;

    dataPoints += 1;

    analysis.push(
      `🔥 Tổng cú sút rất cao: ${stats.totalShots}`
    );

  } else if (
    stats.totalShots >= 10
  ) {

    aiPercentage += 10;

    dataPoints += 1;

    analysis.push(
      `⚽ Tổng cú sút: ${stats.totalShots}`
    );

  } else if (
    stats.totalShots >= 6
  ) {

    aiPercentage += 5;

    dataPoints += 1;

    analysis.push(
      `⚽ Tổng cú sút: ${stats.totalShots}`
    );
  }


  // ========================================================
  // E. CORNERS
  // ========================================================

  if (
    stats.corners >= 8
  ) {

    aiPercentage += 12;

    dataPoints += 1;

    analysis.push(
      `🚩 Phạt góc rất cao: ${stats.corners}`
    );

  } else if (
    stats.corners >= 4
  ) {

    aiPercentage += 6;

    dataPoints += 1;

    analysis.push(
      `🚩 Phạt góc: ${stats.corners}`
    );
  }


  // ========================================================
  // F. RED CARD
  // ========================================================

  if (
    stats.redCards > 0
  ) {

    aiPercentage +=
      Math.min(
        stats.redCards * 8,
        16
      );

    dataPoints += 1;

    analysis.push(
      `🟥 Thẻ đỏ: ${stats.redCards}`
    );
  }


  // ========================================================
  // G. MOMENTUM
  // ========================================================

  if (
    momentumData?.available
  ) {

    aiPercentage +=
      momentumData.score;

    dataPoints += 1;

    if (
      momentumData.note
    ) {

      analysis.push(
        `📈 ${momentumData.note}`
      );
    }
  }


  // ========================================================
  // H. ODDS
  // ========================================================

  if (
    oddsAnalysis
  ) {

    aiPercentage +=
      oddsAnalysis.oddsBonus;

    dataPoints += 1;

    analysis.push(
      `💰 Over ${oddsAnalysis.line} @ ${oddsAnalysis.odds}`
    );
  }


  // ========================================================
  // I. DATA QUALITY
  // ========================================================

  const dataQuality =
    metrics.dataQuality || 0;


  if (
    dataQuality >= 70
  ) {

    aiPercentage += 4;

  } else if (
    dataQuality >= 40
  ) {

    aiPercentage += 2;
  }


  // ========================================================
  // J. GIỚI HẠN
  // ========================================================

  const finalPercentage =
    Math.min(
      aiPercentage,
      98
    ).toFixed(1);


  // Không cho trận thiếu toàn bộ dữ liệu
  // tự nhiên nhảy lên xác suất cao.
  const shouldSend =
    parseFloat(finalPercentage) >= 60 &&
    (
      dataPoints >= 2
    );


  return {

    efficiency:
      finalPercentage,

    dataQuality,

    detailText:
      analysis
        .map(
          x => `• ${x}`
        )
        .join('\n'),

    shouldSend,

    dataPoints
  };
}


// ==========================================================
// 37. ALERT DECISION
// ==========================================================

function shouldSendAlert(
  matchId,
  currentPercentage,
  currentMinute
) {

  const previous =
    alertState.get(matchId);


  if (!previous) {

    return {
      send: true,
      reason:
        'Cảnh báo đầu tiên của trận'
    };
  }


  if (
    previous.alertCount >=
    MAX_ALERTS_PER_MATCH
  ) {

    return {
      send: false,
      reason:
        `Đã đạt tối đa ${MAX_ALERTS_PER_MATCH} lần cảnh báo`
    };
  }


  const increase =
    currentPercentage -
    previous.lastPercentage;


  if (
    increase >=
    ALERT_INCREASE_THRESHOLD
  ) {

    return {
      send: true,
      reason:
        `AI tăng mạnh +${increase.toFixed(1)}%`
    };
  }


  return {
    send: false,
    reason:
      `AI chỉ tăng +${increase.toFixed(1)}%`
  };
}


// ==========================================================
// 38. TELEGRAM
// ==========================================================

async function sendTelegramAlert(
  item
) {

  const message = `
🔔 RUNG CHUÔNG VÀNGGGG #${item.alertNumber}

🏆 Giải đấu:
${item.league}

⚔️ Trận đấu:
${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}

⏱ Thời gian:
Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ:
${item.goalTimeline}

📊 THỐNG KÊ THẾ TRẬN:
${item.detailText}

📈 CHẤT LƯỢNG DỮ LIỆU:
${item.dataQuality}%

🎯 NHẬN ĐỊNH:
Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG

📈 HIỆU SUẤT RULE:
${item.ruleEfficiency}%

🚨 LẦN CẢNH BÁO:
#${item.alertNumber}
`.trim();


  try {

    if (
      !TELEGRAM_BOT_TOKEN ||
      !TELEGRAM_CHAT_ID
    ) {
      return;
    }


    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          message
      }
    );


    const previous =
      alertState.get(item.id);


    alertState.set(
      item.id,
      {

        lastPercentage:
          parseFloat(
            item.ruleEfficiency
          ),

        lastMinute:
          item.elapsed,

        alertCount:
          previous
            ? previous.alertCount + 1
            : 1
      }
    );


    console.log(
      `   └─> [Telegram] ALERT #${item.alertNumber} | ${item.homeName} vs ${item.awayName} | ${item.ruleEfficiency}%`
    );

  } catch (err) {

    console.error(
      '[Telegram Error]:',
      err.message
    );
  }
}


// ==========================================================
// 39. FORMAT MATCH
// ==========================================================

function formatSofaMatch(i) {

  return {

    id:
      String(i.id),

    homeName:
      i.homeTeam?.name ||
      'Đội nhà',

    awayName:
      i.awayTeam?.name ||
      'Đội khách',

    homeScore:
      i.homeScore?.current ??
      i.homeScore?.display ??
      0,

    awayScore:
      i.awayScore?.current ??
      i.awayScore?.display ??
      0,

    leagueName:
      parseLeagueName(i),

    source:
      'sofascore',

    sofaEventId:
      String(i.id),

    raw:
      i
  };
}


function formatFlashMatch(i) {

  return {

    id:
      String(
        i.id ||
        i.matchId ||
        i.eventId ||
        ''
      ),

    homeName:
      i.homeTeam?.name ||
      i.homeName ||
      i.home?.name ||
      'Đội nhà',

    awayName:
      i.awayTeam?.name ||
      i.awayName ||
      i.away?.name ||
      'Đội khách',

    homeScore:
      i.homeScore ??
      i.homeGoals ??
      i.home?.score ??
      0,

    awayScore:
      i.awayScore ??
      i.awayGoals ??
      i.away?.score ??
      0,

    leagueName:
      parseLeagueName(i),

    source:
      'flashscore',

    sofaEventId:
      null,

    raw:
      i
  };
}


function formatLiveFootballMatch(i) {

  const score =
    String(
      i.score ||
      '0-0'
    ).split('-');


  return {

    id:
      String(
        i.id ||
        i.matchId ||
        ''
      ),

    homeName:
      i.home_name ||
      i.homeName ||
      i.home?.name ||
      'Đội nhà',

    awayName:
      i.away_name ||
      i.awayName ||
      i.away?.name ||
      'Đội khách',

    homeScore:
      parseInt(
        score[0]
      ) || 0,

    awayScore:
      parseInt(
        score[1]
      ) || 0,

    leagueName:
      parseLeagueName(i),

    source:
      'live-football',

    sofaEventId:
      null,

    raw:
      i
  };
}


// ==========================================================
// 40. CHECK LIVE
// ==========================================================

function isMatchLive(
  match
) {

  const item =
    match.raw || {};


  const statusType =
    String(
      item.status?.type ||
      item.status ||
      item.state ||
      ''
    ).toLowerCase();


  const statusCode =
    item.status?.code;


  return (
    statusType === 'inprogress' ||
    statusType === 'live' ||
    statusType === 'in-play' ||
    statusType === 'playing' ||
    statusCode === 1 ||
    match.source === 'flashscore' ||
    match.source === 'live-football'
  );
}


// ==========================================================
// 41. DEDUPE TRẬN
// ==========================================================

function getMatchKey(
  match
) {

  return (
    `${cleanTeamName(match.homeName)}__` +
    `${cleanTeamName(match.awayName)}`
  );
}


// ==========================================================
// 42. SCAN
// ==========================================================

async function scanLiveMatches() {

  const currentVN =
    getVietnamTime();


  console.log(
    '\n=================================================='
  );

  console.log(
    `[AUTO-SCAN] ${currentVN.timeStr}`
  );


  try {

    const [
      allOdds,
      sofaMatches,
      flashMatches,
      liveFootballMatches
    ] =
      await Promise.all([

        fetchOddsData(),

        fetchLiveMatchesFromSofaScore(),

        fetchLiveMatchesFromFlashScore(),

        fetchLiveMatchesFromLiveFootball()

      ]);


    const formattedMatches = [];


    sofaMatches.forEach(
      item => {

        const match =
          formatSofaMatch(item);

        if (
          match.id &&
          match.homeName !== 'Đội nhà'
        ) {
          formattedMatches.push(match);
        }
      }
    );


    flashMatches.forEach(
      item => {

        const match =
          formatFlashMatch(item);

        if (
          match.id &&
          match.homeName !== 'Đội nhà'
        ) {
          formattedMatches.push(match);
        }
      }
    );


    liveFootballMatches.forEach(
      item => {

        const match =
          formatLiveFootballMatch(item);

        if (
          match.id &&
          match.homeName !== 'Đội nhà'
        ) {
          formattedMatches.push(match);
        }
      }
    );


    // ======================================================
    // DEDUPE BẰNG TÊN ĐỘI
    // ======================================================

    const uniqueMap =
      new Map();


    for (
      const match of formattedMatches
    ) {

      const key =
        getMatchKey(match);


      const old =
        uniqueMap.get(key);


      // Ưu tiên SofaScore
      if (
        !old ||
        (
          match.source === 'sofascore' &&
          old.source !== 'sofascore'
        )
      ) {

        uniqueMap.set(
          key,
          match
        );
      }
    }


    const allMatches =
      Array.from(
        uniqueMap.values()
      );


    console.log(
      `[DATA] Tổng match unique: ${allMatches.length}`
    );


    // ======================================================
    // LIVE + FILTER
    // ======================================================

    const liveMatches =
      allMatches.filter(
        match => {

          if (
            !isMatchLive(match)
          ) {
            return false;
          }


          if (
            isFilteredLeague(
              match.leagueName,
              match.homeName,
              match.awayName
            )
          ) {
            return false;
          }


          return true;
        }
      );


    console.log(
      `[FILTER] Live hợp lệ: ${liveMatches.length}`
    );


    // ======================================================
    // PHÂN TÍCH TỪNG TRẬN
    // ======================================================

    for (
      let index = 0;
      index < liveMatches.length;
      index++
    ) {

      const match =
        liveMatches[index];


      const elapsed =
        calculateExactMinute(
          match.raw
        );


      const numericElapsed =
        typeof elapsed === 'number'
          ? elapsed
          : parseInt(
              elapsed,
              10
            );


      // ----------------------------------------------------
      // LỌC PHÚT
      // ----------------------------------------------------

      if (
        isNaN(numericElapsed) ||
        numericElapsed < 46 ||
        numericElapsed > 92
      ) {

        console.log(
          `[SKIP TIME] ${match.homeName} vs ${match.awayName} | ${elapsed}'`
        );

        continue;
      }


      console.log(
        `\n--------------------------------------------------`
      );


      console.log(
        `[TRẬN ${index + 1}] ${match.homeName} ${match.homeScore}-${match.awayScore} ${match.awayName}`
      );


      console.log(
        `[GIẢI] ${match.leagueName}`
      );


      console.log(
        `[PHÚT] ${numericElapsed}'`
      );


      // ====================================================
      // RESOLVE SOFASCORE EVENT
      // ====================================================

      const sofaEventId =
        await resolveSofaEventId(
          match,
          sofaMatches
        );


      if (sofaEventId) {

        console.log(
          `   └─ [SOFA EVENT ID] ${sofaEventId}`
        );

      } else {

        console.log(
          `   └─ [SOFA EVENT ID] Không tìm thấy`
        );
      }


      // ====================================================
      // LẤY INCIDENTS + STATS + MOMENTUM SONG SONG
      // ====================================================

      const [
        incidentResult,
        metrics,
        momentum
      ] =
        await Promise.all([

          sofaEventId
            ? fetchMatchIncidents(
                sofaEventId,
                match.homeScore,
                match.awayScore,
                numericElapsed
              )
            : Promise.resolve({
                text:
                  `• Tỷ số hiện tại: ${match.homeScore}-${match.awayScore}`,

                data:
                  parseGoalTimeline(
                    [],
                    numericElapsed,
                    match.homeScore,
                    match.awayScore
                  )
              }),

          fetchMatchDetailStats(
            match,
            sofaEventId
          ),

          sofaEventId
            ? fetchSofaMomentum(
                sofaEventId
              )
            : Promise.resolve(null)

        ]);


      // ====================================================
      // IN DIỄN BIẾN TỶ SỐ
      // ====================================================

      const goalData =
        incidentResult.data;


      console.log(
        `   └─ [GOALS] Tổng bàn: ${goalData.totalGoals}`
      );


      console.log(
        `   └─ [GOALS] Hiệp 2: ${goalData.secondHalfGoals}`
      );


      console.log(
        `   └─ [GOALS] 15 phút gần nhất: ${goalData.goalsLast15}`
      );


      console.log(
        `   └─ [GOALS] 30 phút gần nhất: ${goalData.goalsLast30}`
      );


      console.log(
        `   └─ [GOALS] Bàn gần nhất: ${
          goalData.lastGoalMinute !== null
            ? goalData.lastGoalMinute + "'"
            : 'N/A'
        }`
      );


      // ====================================================
      // MOMENTUM
      // ====================================================

      const momentumAnalysis =
        analyzeMomentum(
          momentum,
          numericElapsed
        );


      if (
        momentumAnalysis.available
      ) {

        console.log(
          `   └─ [MOMENTUM] ${momentumAnalysis.note}`
        );
      }


      // ====================================================
      // ODDS
      // ====================================================

      const oddsAnalysis =
        analyzeOddsGoalProbability(
          allOdds,
          match.homeName,
          match.awayName,
          match.homeScore +
          match.awayScore
        );


      // ====================================================
      // AI
      // ====================================================

      const aiAnalysis =
        evaluateMatchDynamicAI(
          metrics,
          goalData,
          momentumAnalysis,
          oddsAnalysis
        );


      console.log(
        `   └─> AI: ${aiAnalysis.efficiency}%`
      );


      console.log(
        `   └─> Data Quality: ${aiAnalysis.dataQuality}%`
      );


      // ====================================================
      // ALERT
      // ====================================================

      const alertDecision =
        shouldSendAlert(
          getMatchKey(match),
          parseFloat(
            aiAnalysis.efficiency
          ),
          numericElapsed
        );


      if (
        aiAnalysis.shouldSend &&
        alertDecision.send
      ) {

        const matchKey =
          getMatchKey(match);


        const previous =
          alertState.get(
            matchKey
          );


        const alertNumber =
          previous
            ? previous.alertCount + 1
            : 1;


        const pickItem = {

          id:
            matchKey,

          league:
            match.leagueName,

          homeName:
            match.homeName,

          awayName:
            match.awayName,

          homeScore:
            match.homeScore,

          awayScore:
            match.awayScore,

          elapsed:
            numericElapsed,

          goalTimeline:
            incidentResult.text,

          detailText:
            aiAnalysis.detailText,

          ruleEfficiency:
            aiAnalysis.efficiency,

          dataQuality:
            aiAnalysis.dataQuality,

          alertNumber
        };


        console.log(
          `   └─> 🔥 [AI CHỌN NỔ BÀN] ${aiAnalysis.efficiency}%`
        );


        console.log(
          `   └─> 🚨 [ALERT] ${alertDecision.reason}`
        );


        await sendTelegramAlert(
          pickItem
        );

      } else {

        console.log(
          `   └─> [BỎ QUA] AI ${aiAnalysis.efficiency}% | ${alertDecision.reason}`
        );
      }
    }


  } catch (err) {

    console.error(
      '[SCAN ERROR]:',
      err.message
    );
  }
}


// ==========================================================
// 43. ROUTE
// ==========================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      status:
        'running',

      service:
        'Football AI Scanner',

      version:
        '3.0 Multi-Source Stats + Goal Timeline + Momentum',

      time:
        getVietnamTime()
    });
  }
);


// ==========================================================
// 44. TEST API
// ==========================================================

app.get(
  '/health',
  (req, res) => {

    res.json({

      ok:
        true,

      timestamp:
        new Date().toISOString(),

      alertState:
        alertState.size,

      statsCache:
        statsCache.size,

      incidentsCache:
        incidentsCache.size,

      graphCache:
        graphCache.size
    });
  }
);


// ==========================================================
// 45. START
// ==========================================================

app.listen(
  PORT,
  () => {

    console.log(
      `==> Server running on port ${PORT}`
    );


    console.log(
      `==> Scanner: phút 46-92`
    );


    console.log(
      `==> Stats: SofaScore + LiveScore + FlashScore`
    );


    console.log(
      `==> Goal Timeline: SofaScore Incidents`
    );


    console.log(
      `==> Momentum: SofaScore Graph`
    );


    console.log(
      `==> Alert: tối đa ${MAX_ALERTS_PER_MATCH}/trận`
    );


    scanLiveMatches();


    // 7 phút/lần
    setInterval(
      scanLiveMatches,
      7 * 60 * 1000
    );
  }
);