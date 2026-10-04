const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());


// ==========================================================
// 1. CẤU HÌNH API & TELEGRAM
// ==========================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;


// ==========================================================
// 2. SOFASCORE
// ==========================================================

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';

const SOFASCORE_LIVE_URL =
  `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;


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
// 6. ODDS API
// ==========================================================

const ODDS_API_KEY = process.env.ODDS_API_KEY;

const ODDS_API_URL = ODDS_API_KEY
  ? `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`
  : '';


// ==========================================================
// 7. ALERT STATE
// ==========================================================

const alertState = new Map();

const ALERT_INCREASE_THRESHOLD = 10.0;
const MAX_ALERTS_PER_MATCH = 3;


// ==========================================================
// 8. MATCH STATE
// Lưu dữ liệu các lần quét để đánh giá nhịp độ tăng
// ==========================================================

const matchState = new Map();

const STATS_CACHE_TTL = 90 * 1000;
const MATCH_STATE_TTL = 6 * 60 * 60 * 1000;


// ==========================================================
// 9. HTTP CONFIG
// ==========================================================

function rapidHeaders(host) {
  return {
    'x-rapidapi-key': PAID_RAPIDAPI_KEY
      ? PAID_RAPIDAPI_KEY.trim()
      : '',
    'x-rapidapi-host': host
  };
}


// ==========================================================
// 10. TIME VIETNAM
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
  if (!item) return 'Bóng Đá Quốc Tế';

  const category =
    item.tournament?.category?.name ||
    item.category?.name ||
    item.country?.name ||
    '';

  const tournament =
    item.tournament?.name ||
    item.competitionName ||
    item.league ||
    item.leagueName ||
    item.competition?.name ||
    '';

  if (LEAGUE_NAME_MAP[tournament]) {
    return LEAGUE_NAME_MAP[tournament];
  }

  const translatedCategory =
    COUNTRY_MAP[category] || category;

  let translatedTournament = String(tournament)
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
// 14. FILTER LEAGUES
// ==========================================================

function isFilteredLeague(
  leagueName,
  homeName,
  awayName
) {
  const textToTest =
    `${leagueName} ${homeName} ${awayName}`.toLowerCase();

  const leagueLower =
    String(leagueName || '').toLowerCase();

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
    'university',
    'u19',
    'u20',
    'u21',
    'u23'
  ];

  return filterKeywords.some(
    kw => textToTest.includes(kw)
  );
}


// ==========================================================
// 15. NORMALIZE TEAM NAME
// ==========================================================

function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk|fk)\b/gi, '')
    .replace(/football club/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}


function tokenizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk|fk)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}


// ==========================================================
// 16. TEAM MATCH SCORE
// ==========================================================

function teamSimilarity(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);

  if (!na || !nb) return 0;

  if (na === nb) return 1;

  if (
    na.includes(nb) ||
    nb.includes(na)
  ) {
    return 0.90;
  }

  const ta = tokenizeTeamName(a);
  const tb = tokenizeTeamName(b);

  if (!ta.length || !tb.length) return 0;

  let common = 0;

  for (const token of ta) {
    if (
      tb.some(
        x =>
          x === token ||
          x.includes(token) ||
          token.includes(x)
      )
    ) {
      common++;
    }
  }

  return common /
    Math.max(ta.length, tb.length);
}


function matchSimilarity(
  homeA,
  awayA,
  homeB,
  awayB
) {
  const direct =
    teamSimilarity(homeA, homeB) *
    0.5 +
    teamSimilarity(awayA, awayB) *
    0.5;

  const reversed =
    teamSimilarity(homeA, awayB) *
    0.5 +
    teamSimilarity(awayA, homeB) *
    0.5;

  return Math.max(direct, reversed);
}


// ==========================================================
// 17. EXTRACT TEAM NAME FROM UNKNOWN API OBJECT
// ==========================================================

function extractHomeName(item) {
  return (
    item.homeTeam?.name ||
    item.homeTeam?.shortName ||
    item.homeName ||
    item.home_team ||
    item.team1?.name ||
    item.T1?.[0]?.Nm ||
    item.teams?.home?.name ||
    item.home?.name ||
    ''
  );
}


function extractAwayName(item) {
  return (
    item.awayTeam?.name ||
    item.awayTeam?.shortName ||
    item.awayName ||
    item.away_team ||
    item.team2?.name ||
    item.T2?.[0]?.Nm ||
    item.teams?.away?.name ||
    item.away?.name ||
    ''
  );
}


function extractMatchId(item) {
  return String(
    item.id ||
    item.matchId ||
    item.eventId ||
    item.Eid ||
    item.event_id ||
    ''
  );
}


// ==========================================================
// 18. EXTRACT SCORE
// ==========================================================

function extractHomeScore(item) {
  const direct =
    item.homeScore?.current ??
    item.homeScore?.display ??
    item.homeGoals ??
    item.home_score ??
    item.home?.score ??
    item.scoreHome;

  if (
    direct !== undefined &&
    direct !== null &&
    !isNaN(Number(direct))
  ) {
    return Number(direct);
  }

  const score =
    String(
      item.score ||
      item.result ||
      ''
    );

  const parts =
    score.split(/[-:]/);

  return parseInt(parts[0], 10) || 0;
}


function extractAwayScore(item) {
  const direct =
    item.awayScore?.current ??
    item.awayScore?.display ??
    item.awayGoals ??
    item.away_score ??
    item.away?.score ??
    item.scoreAway;

  if (
    direct !== undefined &&
    direct !== null &&
    !isNaN(Number(direct))
  ) {
    return Number(direct);
  }

  const score =
    String(
      item.score ||
      item.result ||
      ''
    );

  const parts =
    score.split(/[-:]/);

  return parseInt(parts[1], 10) || 0;
}


// ==========================================================
// 19. CALCULATE EXACT MINUTE
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
      item.status?.name ||
      item.statusDescription ||
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
    item.time?.currentMinute,
    item.elapsed,
    item.matchMinute,
    item.currentMinute
  ];

  for (
    const value of directMinuteCandidates
  ) {
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
    Number.isFinite(
      currentPeriodStartTimestamp
    ) &&
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
      let calculatedMinute =
        Math.floor(elapsedSeconds / 60) + 1;

      const secondHalf =
        statusDescription.includes('2nd half') ||
        statusDescription.includes('second half') ||
        statusDescription.includes('2nd') ||
        statusDescription.includes('hiệp 2');

      if (secondHalf) {
        calculatedMinute =
          45 +
          Math.floor(elapsedSeconds / 60) +
          1;
      }

      return calculatedMinute;
    }
  }

  const startTimestamp =
    Number(
      item.startTimestamp ||
      item.start_timestamp ||
      item.startTime ||
      item.start_time
    );

  if (
    Number.isFinite(startTimestamp) &&
    startTimestamp > 0 &&
    (
      statusType === 'inprogress' ||
      statusType === 'live' ||
      statusType === 'ongoing' ||
      statusType === '1'
    )
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
        Math.floor(
          elapsedSeconds / 60
        ) + 1
      );
    }
  }

  return 0;
}


// ==========================================================
// 20. FETCH SOFASCORE LIVE
// ==========================================================

async function fetchLiveMatchesFromSofaScore() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];

    const response = await axios.get(
      SOFASCORE_LIVE_URL,
      {
        headers: rapidHeaders(SOFASCORE_HOST),
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
// 21. FETCH FLASHSCORE LIVE
// ==========================================================

async function fetchLiveMatchesFromFlashScore() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];

    const response = await axios.get(
      FLASHSCORE_LIVE_URL,
      {
        headers: rapidHeaders(FLASHSCORE_HOST),
        timeout: 10000
      }
    );

    const data = response.data;

    return Array.isArray(data)
      ? data
      : (
        data?.data ||
        data?.matches ||
        data?.events ||
        []
      );
  } catch (err) {
    console.error(
      '[FlashScore Live Error]:',
      err.message
    );

    return [];
  }
}


// ==========================================================
// 22. FETCH LIVE FOOTBALL
// ==========================================================

async function fetchLiveMatchesFromLiveFootball() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];

    const response = await axios.get(
      LIVE_FOOTBALL_URL,
      {
        params: {
          status: 'live'
        },
        headers: rapidHeaders(
          LIVE_FOOTBALL_HOST
        ),
        timeout: 10000
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
// 23. FORMAT LIVE MATCH
// ==========================================================

function formatLiveMatch(item, source) {
  return {
    id: extractMatchId(item),

    homeName:
      extractHomeName(item) ||
      'Đội nhà',

    awayName:
      extractAwayName(item) ||
      'Đội khách',

    homeScore:
      extractHomeScore(item),

    awayScore:
      extractAwayScore(item),

    leagueName:
      parseLeagueName(item),

    source,

    raw: item,

    elapsed:
      calculateExactMinute(item)
  };
}


// ==========================================================
// 24. FIND MATCH IN OTHER SOURCE
// ==========================================================

function findCorrespondingMatch(
  target,
  candidates
) {
  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (
      !candidate.homeName ||
      !candidate.awayName
    ) {
      continue;
    }

    const score =
      matchSimilarity(
        target.homeName,
        target.awayName,
        candidate.homeName,
        candidate.awayName
      );

    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  if (
    bestMatch &&
    bestScore >= 0.72
  ) {
    return {
      match: bestMatch,
      score: bestScore
    };
  }

  return null;
}


// ==========================================================
// 25. GENERIC STAT VALUE
// ==========================================================

function numericValue(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return value;
  }

  const str =
    String(value)
      .replace('%', '')
      .trim();

  const n = parseFloat(str);

  return Number.isFinite(n)
    ? n
    : null;
}


// ==========================================================
// 26. EMPTY STATS
// ==========================================================

function createEmptyStats() {
  return {
    possessionHome: null,
    possessionAway: null,

    shotsOnTarget: null,
    totalShots: null,
    shotsOffTarget: null,
    blockedShots: null,

    corners: null,
    redCards: null,

    sourceCount: 0,
    sources: [],

    qualityScore: 0
  };
}


// ==========================================================
// 27. NORMALIZE STATISTICS
// ==========================================================

function mergeStat(
  target,
  key,
  value
) {
  const n = numericValue(value);

  if (n === null) return;

  // Không ghi đè dữ liệu thật bằng 0
  if (
    target[key] === null ||
    target[key] === undefined
  ) {
    target[key] = n;
  }
}


// ==========================================================
// 28. PARSE GENERIC STATISTICS ARRAY
// ==========================================================

function parseStatisticsArray(
  statsList,
  result
) {
  if (!Array.isArray(statsList)) {
    return;
  }

  for (const st of statsList) {
    const name =
      String(
        st.name ||
        st.type ||
        st.title ||
        st.slug ||
        ''
      ).toLowerCase();

    const homeVal =
      numericValue(
        st.home ??
        st.homeValue ??
        st.valueHome ??
        st.home_value
      );

    const awayVal =
      numericValue(
        st.away ??
        st.awayValue ??
        st.valueAway ??
        st.away_value
      );

    const total =
      (
        homeVal !== null
          ? homeVal
          : 0
      ) +
      (
        awayVal !== null
          ? awayVal
          : 0
      );

    if (
      name.includes('possession') ||
      name.includes('kiểm soát')
    ) {
      if (
        homeVal !== null &&
        awayVal !== null
      ) {
        mergeStat(
          result,
          'possessionHome',
          homeVal
        );

        mergeStat(
          result,
          'possessionAway',
          awayVal
        );
      }

      continue;
    }

    if (
      name.includes('shots on target') ||
      name.includes('shot on target') ||
      name.includes('ontarget') ||
      name.includes('sút trúng đích')
    ) {
      mergeStat(
        result,
        'shotsOnTarget',
        total
      );

      continue;
    }

    if (
      name.includes('shots off target') ||
      name.includes('shot off target') ||
      name.includes('sút không trúng đích')
    ) {
      mergeStat(
        result,
        'shotsOffTarget',
        total
      );

      continue;
    }

    if (
      name.includes('blocked shots') ||
      name.includes('blocked shot') ||
      name.includes('cú sút bị chặn')
    ) {
      mergeStat(
        result,
        'blockedShots',
        total
      );

      continue;
    }

    if (
      name.includes('total shots') ||
      name.includes('total shot') ||
      name === 'shots' ||
      name.includes('tổng cú sút')
    ) {
      mergeStat(
        result,
        'totalShots',
        total
      );

      continue;
    }

    if (
      name.includes('corner') ||
      name.includes('phạt góc')
    ) {
      mergeStat(
        result,
        'corners',
        total
      );

      continue;
    }

    if (
      name.includes('red card') ||
      name.includes('red cards') ||
      name.includes('thẻ đỏ')
    ) {
      mergeStat(
        result,
        'redCards',
        total
      );
    }
  }
}


// ==========================================================
// 29. SOFASCORE STATISTICS
// ==========================================================

async function fetchSofaStatistics(
  match
) {
  const result = createEmptyStats();

  if (!PAID_RAPIDAPI_KEY) {
    return result;
  }

  try {
    const response =
      await axios.get(
        `https://${SOFASCORE_HOST}/events/get-statistics?eventId=${encodeURIComponent(match.id)}`,
        {
          headers:
            rapidHeaders(SOFASCORE_HOST),
          timeout: 7000
        }
      );

    const statistics =
      response.data?.statistics;

    if (Array.isArray(statistics)) {
      for (const period of statistics) {
        if (
          Array.isArray(
            period.groups
          )
        ) {
          for (const group of period.groups) {
            parseStatisticsArray(
              group.statisticsItems,
              result
            );
          }
        }

        // Một số response có statisticsItems trực tiếp
        parseStatisticsArray(
          period.statisticsItems,
          result
        );
      }
    }

    const hasData =
      Object.values(result)
        .some(
          v =>
            typeof v === 'number' &&
            v > 0
        );

    if (hasData) {
      result.sources.push(
        'SofaScore'
      );
    }

  } catch (err) {
    console.log(
      `   └─ SofaScore Stats: lỗi`
    );
  }

  return result;
}


// ==========================================================
// 30. FLASHSCORE STATISTICS
// ==========================================================

async function fetchFlashScoreStatistics(
  match
) {
  const result = createEmptyStats();

  if (!PAID_RAPIDAPI_KEY) {
    return result;
  }

  try {
    const response =
      await axios.get(
        `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/details?matchId=${encodeURIComponent(match.id)}`,
        {
          headers:
            rapidHeaders(FLASHSCORE_HOST),
          timeout: 7000
        }
      );

    const data =
      response.data;

    const possibleArrays = [
      data?.data?.statistics,
      data?.statistics,
      data?.data?.stats,
      data?.stats
    ];

    for (
      const list of possibleArrays
    ) {
      parseStatisticsArray(
        list,
        result
      );
    }

    // Một số API trả statistics theo object
    const groups =
      data?.data?.statistics?.groups ||
      data?.statistics?.groups;

    if (Array.isArray(groups)) {
      for (const group of groups) {
        parseStatisticsArray(
          group.statisticsItems ||
          group.items ||
          group.stats,
          result
        );
      }
    }

    const hasData =
      Object.values(result)
        .some(
          v =>
            typeof v === 'number' &&
            v > 0
        );

    if (hasData) {
      result.sources.push(
        'FlashScore'
      );
    }

  } catch (err) {
    console.log(
      `   └─ FlashScore Stats: lỗi`
    );
  }

  return result;
}


// ==========================================================
// 31. LIVESCORE FIND EVENT ID
// ==========================================================

function findLiveScoreEventId(
  data,
  homeName,
  awayName
) {
  let bestId = null;
  let bestScore = 0;

  function walk(obj) {
    if (!obj || typeof obj !== 'object') {
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        walk(item);
      }
      return;
    }

    const eid =
      String(
        obj.Eid ||
        obj.eid ||
        obj.id ||
        obj.eventId ||
        ''
      );

    const h =
      obj.T1?.[0]?.Nm ||
      obj.homeTeam?.name ||
      obj.homeName ||
      obj.home_team ||
      '';

    const a =
      obj.T2?.[0]?.Nm ||
      obj.awayTeam?.name ||
      obj.awayName ||
      obj.away_team ||
      '';

    if (
      eid &&
      h &&
      a
    ) {
      const score =
        matchSimilarity(
          homeName,
          awayName,
          h,
          a
        );

      if (
        score > bestScore
      ) {
        bestScore = score;
        bestId = eid;
      }
    }

    for (
      const key of Object.keys(obj)
    ) {
      if (
        key !== 'T1' &&
        key !== 'T2'
      ) {
        walk(obj[key]);
      }
    }
  }

  walk(data);

  if (
    bestId &&
    bestScore >= 0.72
  ) {
    return bestId;
  }

  return null;
}


// ==========================================================
// 32. LIVESCORE STATISTICS
// ==========================================================

async function fetchLiveScoreStatistics(
  match
) {
  const result = createEmptyStats();

  if (!PAID_RAPIDAPI_KEY) {
    return result;
  }

  try {
    const liveUrl =
      `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;

    const response =
      await axios.get(
        liveUrl,
        {
          headers:
            rapidHeaders(LIVESCORE_HOST),
          timeout: 7000
        }
      );

    const eid =
      findLiveScoreEventId(
        response.data,
        match.homeName,
        match.awayName
      );

    if (!eid) {
      console.log(
        `   └─ LiveScore: không ghép được trận`
      );

      return result;
    }

    const statsResponse =
      await axios.get(
        `https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${encodeURIComponent(eid)}`,
        {
          headers:
            rapidHeaders(LIVESCORE_HOST),
          timeout: 7000
        }
      );

    const data =
      statsResponse.data;

    const lists = [
      data,
      data?.statistics,
      data?.stats,
      data?.data,
      data?.data?.statistics,
      data?.data?.stats
    ];

    for (
      const list of lists
    ) {
      parseStatisticsArray(
        list,
        result
      );
    }

    const hasData =
      Object.values(result)
        .some(
          v =>
            typeof v === 'number' &&
            v > 0
        );

    if (hasData) {
      result.sources.push(
        'LiveScore'
      );
    }

  } catch (err) {
    console.log(
      `   └─ LiveScore Stats: lỗi`
    );
  }

  return result;
}


// ==========================================================
// 33. MERGE MULTI SOURCE STATISTICS
// ==========================================================

function mergeStatistics(
  sourceResults
) {
  const finalStats =
    createEmptyStats();

  const statKeys = [
    'possessionHome',
    'possessionAway',
    'shotsOnTarget',
    'totalShots',
    'shotsOffTarget',
    'blockedShots',
    'corners',
    'redCards'
  ];

  const sourceNames = [];

  for (
    const source of sourceResults
  ) {
    if (!source) continue;

    for (
      const key of statKeys
    ) {
      /*
       * Quan trọng:
       * Chỉ lấy giá trị nếu nguồn thực sự có dữ liệu.
       *
       * Nếu nguồn A = 0 vì API thiếu,
       * không dùng 0 để ghi đè nguồn B.
       */
      if (
        source[key] !== null &&
        source[key] !== undefined
      ) {
        const value =
          Number(source[key]);

        if (
          Number.isFinite(value)
        ) {
          /*
           * Với thống kê tích lũy,
           * chọn giá trị cao nhất hợp lý.
           *
           * Ví dụ:
           * SofaScore = 12 shots
           * FlashScore = 12 shots
           * LiveScore = 10 shots
           *
           * => 12
           */
          if (
            finalStats[key] === null ||
            value > finalStats[key]
          ) {
            finalStats[key] = value;
          }
        }
      }
    }

    if (
      Array.isArray(
        source.sources
      )
    ) {
      for (
        const s of source.sources
      ) {
        if (
          !sourceNames.includes(s)
        ) {
          sourceNames.push(s);
        }
      }
    }
  }

  finalStats.sources =
    sourceNames;

  finalStats.sourceCount =
    sourceNames.length;

  /*
   * Total shots có thể bị API thiếu.
   * Nếu có thành phần chi tiết,
   * tự dựng tổng tối thiểu.
   */
  const componentSum =
    (
      finalStats.shotsOnTarget || 0
    ) +
    (
      finalStats.shotsOffTarget || 0
    ) +
    (
      finalStats.blockedShots || 0
    );

  if (
    (
      finalStats.totalShots === null ||
      finalStats.totalShots === 0
    ) &&
    componentSum > 0
  ) {
    finalStats.totalShots =
      componentSum;
  }

  // Tính chất lượng dữ liệu
  let available = 0;

  const importantFields = [
    'possessionHome',
    'possessionAway',
    'shotsOnTarget',
    'totalShots',
    'corners',
    'redCards'
  ];

  for (
    const key of importantFields
  ) {
    if (
      finalStats[key] !== null &&
      finalStats[key] !== undefined
    ) {
      available++;
    }
  }

  finalStats.qualityScore =
    Math.round(
      (
        available /
        importantFields.length
      ) * 100
    );

  return finalStats;
}


// ==========================================================
// 34. FETCH ALL STATISTICS
// ==========================================================

async function fetchMatchDetailStats(
  match,
  allSourceMatches
) {
  /*
   * Cache theo cặp đội thay vì chỉ ID.
   * Điều này tránh lỗi khi ID giữa các API khác nhau.
   */
  const cacheKey =
    `${normalizeTeamName(match.homeName)}__${normalizeTeamName(match.awayName)}`;

  const cached =
    matchState.get(
      `stats_${cacheKey}`
    );

  if (
    cached &&
    Date.now() - cached.timestamp <
      STATS_CACHE_TTL
  ) {
    return cached.stats;
  }

  console.log(
    `   └─ [STATS] Bắt đầu lấy dữ liệu đa nguồn...`
  );

  const sourceMatches =
    allSourceMatches || {};

  const sofaMatch =
    match.source === 'sofascore'
      ? match
      : findCorrespondingMatch(
          match,
          sourceMatches.sofaMatches || []
        )?.match;

  const flashMatch =
    match.source === 'flashscore'
      ? match
      : findCorrespondingMatch(
          match,
          sourceMatches.flashMatches || []
        )?.match;

  /*
   * LiveScore không dùng ID của SofaScore.
   * Hàm bên dưới tự tìm Eid bằng tên đội.
   */

  const requests = [];

  if (
    sofaMatch &&
    sofaMatch.id
  ) {
    requests.push(
      fetchSofaStatistics(
        sofaMatch
      )
    );
  }

  if (
    flashMatch &&
    flashMatch.id
  ) {
    requests.push(
      fetchFlashScoreStatistics(
        flashMatch
      )
    );
  }

  requests.push(
    fetchLiveScoreStatistics(
      match
    )
  );

  const results =
    await Promise.all(
      requests
    );

  const finalStats =
    mergeStatistics(
      results
    );

  /*
   * Nếu vẫn thiếu total shots,
   * không tự gán số giả.
   */

  console.log(
    `   └─ [STATS] Sources: ${
      finalStats.sources.join(', ') ||
      'Không có'
    }`
  );

  console.log(
    `   └─ [STATS] Quality: ${
      finalStats.qualityScore
    }%`
  );

  console.log(
    `   └─ [STATS] Possession: ${
      finalStats.possessionHome !== null
        ? `${finalStats.possessionHome}% - ${finalStats.possessionAway}%`
        : 'N/A'
    }`
  );

  console.log(
    `   └─ [STATS] Shots: ${
      finalStats.totalShots ??
      'N/A'
    } | SOT: ${
      finalStats.shotsOnTarget ??
      'N/A'
    } | Corners: ${
      finalStats.corners ??
      'N/A'
    } | Red: ${
      finalStats.redCards ??
      'N/A'
    }`
  );

  matchState.set(
    `stats_${cacheKey}`,
    {
      timestamp: Date.now(),
      stats: finalStats
    }
  );

  return finalStats;
}


// ==========================================================
// 35. GOAL INCIDENTS
// ==========================================================

async function fetchMatchIncidents(
  match
) {
  if (
    !match ||
    match.source !== 'sofascore'
  ) {
    const totalGoals =
      match.homeScore +
      match.awayScore;

    if (totalGoals > 0) {
      return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${match.homeScore}-${match.awayScore})`;
    }

    return '• Chưa có bàn thắng (Tỷ số: 0-0)';
  }

  try {
    const response =
      await axios.get(
        `https://${SOFASCORE_HOST}/events/get-incidents?eventId=${encodeURIComponent(match.id)}`,
        {
          headers:
            rapidHeaders(SOFASCORE_HOST),
          timeout: 6000
        }
      );

    const incidents =
      response.data?.incidents || [];

    const goalEvents =
      incidents.filter(
        inc =>
          inc.incidentType === 'goal'
      );

    if (!goalEvents.length) {
      const totalGoals =
        match.homeScore +
        match.awayScore;

      if (totalGoals > 0) {
        return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số hiện tại: ${match.homeScore}-${match.awayScore})`;
      }

      return '• Chưa có bàn thắng (Tỷ số: 0-0)';
    }

    goalEvents.sort(
      (a, b) =>
        (a.time || 0) -
        (b.time || 0)
    );

    return goalEvents
      .map(g => {
        const min =
          g.time || 0;

        const extra =
          g.addedTime
            ? `+${g.addedTime}`
            : '';

        const player =
          g.player?.shortName ||
          g.player?.name ||
          'Cầu thủ';

        const isHome =
          g.isHome
            ? '⚽ [Chủ]'
            : '⚽ [Khách]';

        const scoreStr =
          (
            g.homeScore !== undefined &&
            g.awayScore !== undefined
          )
            ? `[${g.homeScore}-${g.awayScore}]`
            : '';

        return `• Phút ${min}'${extra}: ${isHome} ${player} ${scoreStr}`;
      })
      .join('\n');

  } catch (err) {
    const totalGoals =
      match.homeScore +
      match.awayScore;

    if (totalGoals > 0) {
      return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${match.homeScore}-${match.awayScore})`;
    }

    return '• Chưa có bàn thắng (Tỷ số: 0-0)';
  }
}


// ==========================================================
// 36. ODDS
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

    return response.data || [];

  } catch (err) {
    console.error(
      '[Odds API Error]:',
      err.message
    );

    return [];
  }
}


// ==========================================================
// 37. ODDS ANALYSIS
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

  const foundMatch =
    allOdds.find(m => {
      const score =
        matchSimilarity(
          homeName,
          awayName,
          m.home_team,
          m.away_team
        );

      return score >= 0.72;
    });

  if (
    !foundMatch ||
    !foundMatch.bookmakers?.length
  ) {
    return null;
  }

  /*
   * Chọn bookmaker có totals market.
   */
  let selectedBookmaker = null;
  let totalsMarket = null;

  for (
    const bookmaker of
      foundMatch.bookmakers
  ) {
    const market =
      bookmaker.markets?.find(
        mk =>
          mk.key === 'totals'
      );

    if (market) {
      selectedBookmaker =
        bookmaker;

      totalsMarket =
        market;

      break;
    }
  }

  if (
    !selectedBookmaker ||
    !totalsMarket
  ) {
    return null;
  }

  const overOutcome =
    totalsMarket.outcomes?.find(
      o =>
        String(o.name)
          .toLowerCase() ===
        'over'
    );

  if (!overOutcome) {
    return null;
  }

  let oddsBonus = 0;

  const oddsNotes = [];

  const overLine =
    Number(overOutcome.point);

  const price =
    Number(overOutcome.price);

  if (
    !Number.isFinite(overLine) ||
    !Number.isFinite(price)
  ) {
    return null;
  }

  const pointDiff =
    overLine -
    currentTotalGoals;

  if (
    pointDiff >= 0.75
  ) {
    oddsBonus = 16.0;

    oddsNotes.push(
      `Line Over cao (${overLine}) so với tổng ${currentTotalGoals} bàn`
    );

  } else if (
    pointDiff > 0
  ) {
    oddsBonus = 10.0;

    oddsNotes.push(
      `Line Over (${overLine}) gần mốc tổng bàn hiện tại`
    );
  }

  if (price <= 1.40) {
    oddsBonus += 18.0;

    oddsNotes.push(
      `Odds Over rất thấp (${price})`
    );

  } else if (price <= 1.60) {
    oddsBonus += 13.0;

    oddsNotes.push(
      `Odds Over thấp (${price})`
    );

  } else if (price <= 1.85) {
    oddsBonus += 8.0;

    oddsNotes.push(
      `Odds Over tương đối tốt (${price})`
    );

  } else {
    oddsBonus += 4.0;

    oddsNotes.push(
      `Odds Over (${price})`
    );
  }

  return {
    bookmaker:
      selectedBookmaker.title,

    line:
      overLine,

    odds:
      price,

    oddsBonus,

    oddsNoteText:
      oddsNotes.join(' | ')
  };
}


// ==========================================================
// 38. SECOND-HALF MOMENTUM
// ==========================================================

function calculateMomentum(
  match,
  stats
) {
  const key =
    `${normalizeTeamName(match.homeName)}__${normalizeTeamName(match.awayName)}`;

  const previous =
    matchState.get(
      `momentum_${key}`
    );

  const current = {
    minute: match.elapsed,
    shots:
      stats.totalShots,
    shotsOnTarget:
      stats.shotsOnTarget,
    corners:
      stats.corners,
    timestamp:
      Date.now()
  };

  let momentumBonus = 0;
  const notes = [];

  if (previous) {
    const elapsedMinutes =
      match.elapsed -
      previous.minute;

    if (
      elapsedMinutes > 0 &&
      elapsedMinutes <= 15
    ) {
      if (
        stats.totalShots !== null &&
        previous.shots !== null &&
        previous.shots !== undefined
      ) {
        const shotIncrease =
          stats.totalShots -
          previous.shots;

        if (
          shotIncrease >= 5
        ) {
          momentumBonus += 10;

          notes.push(
            `Nhịp sút tăng mạnh +${shotIncrease} trong ${elapsedMinutes} phút`
          );
        } else if (
          shotIncrease >= 3
        ) {
          momentumBonus += 6;

          notes.push(
            `Nhịp sút tăng +${shotIncrease} trong ${elapsedMinutes} phút`
          );
        }
      }

      if (
        stats.shotsOnTarget !== null &&
        previous.shotsOnTarget !== null &&
        previous.shotsOnTarget !== undefined
      ) {
        const sotIncrease =
          stats.shotsOnTarget -
          previous.shotsOnTarget;

        if (
          sotIncrease >= 2
        ) {
          momentumBonus += 8;

          notes.push(
            `Sút trúng đích tăng +${sotIncrease}`
          );
        }
      }

      if (
        stats.corners !== null &&
        previous.corners !== null &&
        previous.corners !== undefined
      ) {
        const cornerIncrease =
          stats.corners -
          previous.corners;

        if (
          cornerIncrease >= 2
        ) {
          momentumBonus += 5;

          notes.push(
            `Phạt góc tăng +${cornerIncrease}`
          );
        }
      }
    }
  }

  matchState.set(
    `momentum_${key}`,
    current
  );

  return {
    momentumBonus,
    notes
  };
}


// ==========================================================
// 39. AI DATA QUALITY
// ==========================================================

function calculateDataQuality(
  stats
) {
  let score = 0;

  if (
    stats.possessionHome !== null &&
    stats.possessionAway !== null
  ) {
    score += 20;
  }

  if (
    stats.totalShots !== null
  ) {
    score += 20;
  }

  if (
    stats.shotsOnTarget !== null
  ) {
    score += 20;
  }

  if (
    stats.corners !== null
  ) {
    score += 15;
  }

  if (
    stats.redCards !== null
  ) {
    score += 10;
  }

  if (
    stats.shotsOffTarget !== null
  ) {
    score += 5;
  }

  if (
    stats.blockedShots !== null
  ) {
    score += 5;
  }

  if (
    stats.sourceCount >= 2
  ) {
    score += 5;
  }

  return Math.min(
    score,
    100
  );
}


// ==========================================================
// 40. AI EVALUATION
// ==========================================================

function evaluateMatchDynamicAI(
  match,
  metrics,
  oddsAnalysis
) {
  const stats =
    metrics || createEmptyStats();

  const matchAnalysis = [];

  /*
   * Điểm nền thấp hơn để tránh:
   * trận thiếu data vẫn tự nhiên lên 60-70%.
   */
  let aiPercentage = 30.0;

  let hasTacticalData = false;

  // --------------------------------------------------------
  // DATA QUALITY
  // --------------------------------------------------------

  const dataQuality =
    calculateDataQuality(stats);

  if (
    dataQuality >= 70
  ) {
    aiPercentage += 4;

    matchAnalysis.push(
      `🟢 Chất lượng dữ liệu tốt: ${dataQuality}%`
    );

    hasTacticalData = true;

  } else if (
    dataQuality >= 45
  ) {
    aiPercentage += 1;

    matchAnalysis.push(
      `🟡 Dữ liệu tương đối đầy đủ: ${dataQuality}%`
    );

    hasTacticalData = true;

  } else {
    matchAnalysis.push(
      `🔴 Dữ liệu hạn chế: ${dataQuality}%`
    );
  }


  // --------------------------------------------------------
  // POSSESSION
  // --------------------------------------------------------

  if (
    stats.possessionHome !== null &&
    stats.possessionAway !== null
  ) {
    const homePoss =
      stats.possessionHome;

    const awayPoss =
      stats.possessionAway;

    const maxPoss =
      Math.max(
        homePoss,
        awayPoss
      );

    matchAnalysis.push(
      `📊 Kiểm soát bóng: ${homePoss}% - ${awayPoss}%`
    );

    if (
      maxPoss >= 70
    ) {
      aiPercentage += 12;

      matchAnalysis.push(
        ` └─> Một đội kiểm soát cực mạnh (+12.0%)`
      );

    } else if (
      maxPoss >= 60
    ) {
      aiPercentage += 8;

      matchAnalysis.push(
        ` └─> Thế trận lấn lướt (+8.0%)`
      );

    } else if (
      maxPoss >= 55
    ) {
      aiPercentage += 4;

      matchAnalysis.push(
        ` └─> Có lợi thế kiểm soát nhẹ (+4.0%)`
      );
    }

    hasTacticalData = true;
  }


  // --------------------------------------------------------
  // RED CARDS
  // --------------------------------------------------------

  if (
    stats.redCards !== null &&
    stats.redCards > 0
  ) {
    const redBonus =
      Math.min(
        stats.redCards * 10,
        20
      );

    aiPercentage +=
      redBonus;

    matchAnalysis.push(
      `🟥 Thẻ đỏ: ${stats.redCards} (+${redBonus.toFixed(1)}%)`
    );

    hasTacticalData = true;
  }


  // --------------------------------------------------------
  // SHOTS ON TARGET
  // --------------------------------------------------------

  if (
    stats.shotsOnTarget !== null
  ) {
    const sot =
      stats.shotsOnTarget;

    if (sot >= 7) {
      aiPercentage += 20;

      matchAnalysis.push(
        `⚡ Sút trúng đích rất cao: ${sot} (+20.0%)`
      );

    } else if (sot >= 5) {
      aiPercentage += 15;

      matchAnalysis.push(
        `⚡ Sút trúng đích cao: ${sot} (+15.0%)`
      );

    } else if (sot >= 3) {
      aiPercentage += 9;

      matchAnalysis.push(
        `🎯 Sút trúng đích: ${sot} (+9.0%)`
      );

    } else if (sot >= 2) {
      aiPercentage += 4;

      matchAnalysis.push(
        `🎯 Sút trúng đích: ${sot} (+4.0%)`
      );
    }

    hasTacticalData = true;
  }


  // --------------------------------------------------------
  // TOTAL SHOTS
  // --------------------------------------------------------

  if (
    stats.totalShots !== null
  ) {
    const shots =
      stats.totalShots;

    if (shots >= 18) {
      aiPercentage += 16;

      matchAnalysis.push(
        `🔥 Tổng cú sút rất cao: ${shots} (+16.0%)`
      );

    } else if (shots >= 14) {
      aiPercentage += 12;

      matchAnalysis.push(
        `🔥 Thế trận cởi mở: ${shots} cú sút (+12.0%)`
      );

    } else if (shots >= 10) {
      aiPercentage += 8;

      matchAnalysis.push(
        `⚽ Hai đội tích cực dứt điểm: ${shots} (+8.0%)`
      );

    } else if (shots >= 7) {
      aiPercentage += 4;

      matchAnalysis.push(
        `⚽ Tổng cú sút: ${shots} (+4.0%)`
      );
    }

    hasTacticalData = true;
  }


  // --------------------------------------------------------
  // SHOT QUALITY
  // --------------------------------------------------------

  if (
    stats.totalShots !== null &&
    stats.shotsOnTarget !== null &&
    stats.totalShots > 0
  ) {
    const accuracy =
      (
        stats.shotsOnTarget /
        stats.totalShots
      ) * 100;

    if (
      accuracy >= 45
    ) {
      aiPercentage += 8;

      matchAnalysis.push(
        `🎯 Chất lượng dứt điểm cao: ${accuracy.toFixed(0)}% (+8.0%)`
      );

    } else if (
      accuracy >= 30
    ) {
      aiPercentage += 4;

      matchAnalysis.push(
        `🎯 Tỷ lệ sút trúng đích: ${accuracy.toFixed(0)}% (+4.0%)`
      );
    }
  }


  // --------------------------------------------------------
  // CORNERS
  // --------------------------------------------------------

  if (
    stats.corners !== null
  ) {
    if (
      stats.corners >= 10
    ) {
      aiPercentage += 14;

      matchAnalysis.push(
        `🚩 Sức ép phạt góc rất lớn: ${stats.corners} (+14.0%)`
      );

    } else if (
      stats.corners >= 7
    ) {
      aiPercentage += 10;

      matchAnalysis.push(
        `🚩 Phạt góc cao: ${stats.corners} (+10.0%)`
      );

    } else if (
      stats.corners >= 4
    ) {
      aiPercentage += 5;

      matchAnalysis.push(
        `🚩 Phạt góc ổn định: ${stats.corners} (+5.0%)`
      );
    }

    hasTacticalData = true;
  }


  // --------------------------------------------------------
  // SECOND HALF MOMENTUM
  // --------------------------------------------------------

  const momentum =
    calculateMomentum(
      match,
      stats
    );

  if (
    momentum.momentumBonus > 0
  ) {
    aiPercentage +=
      momentum.momentumBonus;

    for (
      const note of momentum.notes
    ) {
      matchAnalysis.push(
        `📈 ${note} (+${momentum.momentumBonus.toFixed(1)}%)`
      );
    }
  }


  // --------------------------------------------------------
  // ODDS
  // --------------------------------------------------------

  if (
    oddsAnalysis
  ) {
    aiPercentage +=
      oddsAnalysis.oddsBonus;

    matchAnalysis.push(
      `💰 Kèo Over ${oddsAnalysis.line} | Odds ${oddsAnalysis.odds} | +${oddsAnalysis.oddsBonus.toFixed(1)}%`
    );

    if (
      oddsAnalysis.oddsNoteText
    ) {
      matchAnalysis.push(
        ` └─> ${oddsAnalysis.oddsNoteText}`
      );
    }

    /*
     * Odds chỉ là tín hiệu phụ,
     * không được thay thế dữ liệu live.
     */
  }


  // --------------------------------------------------------
  // SCORE CONTEXT
  // --------------------------------------------------------

  const totalGoals =
    match.homeScore +
    match.awayScore;

  if (
    totalGoals === 0
  ) {
    matchAnalysis.push(
      `⚽ Tỷ số 0-0: cần ưu tiên chất lượng cơ hội và nhịp tấn công`
    );
  } else if (
    totalGoals >= 4
  ) {
    matchAnalysis.push(
      `⚽ Trận đã có ${totalGoals} bàn`
    );
  }


  // --------------------------------------------------------
  // DATA PENALTY
  // --------------------------------------------------------

  /*
   * Nếu dữ liệu quá thiếu,
   * giảm điểm để tránh AI "ảo".
   */
  if (
    dataQuality < 30
  ) {
    aiPercentage -= 12;

    matchAnalysis.push(
      `⚠️ Thiếu nhiều dữ liệu thống kê: giảm độ tin cậy`
    );

  } else if (
    dataQuality < 45
  ) {
    aiPercentage -= 6;

    matchAnalysis.push(
      `⚠️ Dữ liệu chưa đầy đủ: giảm độ tin cậy`
    );
  }


  // --------------------------------------------------------
  // FINAL
  // --------------------------------------------------------

  const finalPercentage =
    Math.min(
      Math.max(
        aiPercentage,
        5
      ),
      98
    ).toFixed(1);

  /*
   * Chỉ gửi khi:
   * 1. >= 60%
   * 2. Có dữ liệu chiến thuật
   * 3. Data quality >= 30%
   */
  const MIN_SEND_PERCENTAGE =
    60.0;

  const shouldSend =
    parseFloat(
      finalPercentage
    ) > MIN_SEND_PERCENTAGE &&
    hasTacticalData &&
    dataQuality >= 30;

  return {
    efficiency:
      finalPercentage,

    dataQuality,

    detailText:
      matchAnalysis
        .map(
          t => `• ${t}`
        )
        .join('\n'),

    shouldSend
  };
}


// ==========================================================
// 41. ALERT DECISION
// ==========================================================

function shouldSendAlert(
  matchKey,
  currentPercentage
) {
  const previous =
    alertState.get(
      matchKey
    );

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
      `AI tăng +${increase.toFixed(1)}%, chưa đủ +${ALERT_INCREASE_THRESHOLD}%`
  };
}


// ==========================================================
// 42. TELEGRAM
// ==========================================================

async function sendTelegramAlert(
  item
) {
  const timeDisplay =
    `Phút ${item.elapsed}'`;

  const message = `
🔔 RUNG CHUÔNG VÀNGGGG #${item.alertNumber}

🏆 Giải đấu:
${item.league}

⚔️ Trận đấu:
${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}

⏱ Thời gian:
${timeDisplay}

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 THỐNG KÊ LIVE:
${item.statsSummary}

🧠 PHÂN TÍCH AI:
${item.detailText}

🎯 Nhận định:
Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG

📈 Hiệu suất Rule:
${item.ruleEfficiency}%

📊 Chất lượng dữ liệu:
${item.dataQuality}%

🚨 Lần cảnh báo:
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
      alertState.get(
        item.id
      );

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
      `   └─> [Telegram Success] #${item.alertNumber} ${item.homeName} vs ${item.awayName} (${item.ruleEfficiency}%)`
    );

  } catch (err) {
    console.error(
      '   └─> [Telegram Error]:',
      err.message
    );
  }
}


// ==========================================================
// 43. MATCH UNIQUE KEY
// ==========================================================

function getStableMatchKey(
  match
) {
  return (
    `${normalizeTeamName(match.homeName)}_vs_${normalizeTeamName(match.awayName)}`
  );
}


// ==========================================================
// 44. CLEAN OLD STATE
// ==========================================================

function cleanupOldState() {
  const now =
    Date.now();

  for (
    const [key, value]
      of matchState.entries()
  ) {
    if (
      value?.timestamp &&
      now - value.timestamp >
        MATCH_STATE_TTL
    ) {
      matchState.delete(
        key
      );
    }
  }
}


// ==========================================================
// 45. FORMAT STATS SUMMARY
// ==========================================================

function formatStatsSummary(
  stats
) {
  const possession =
    stats.possessionHome !== null &&
    stats.possessionAway !== null
      ? `${stats.possessionHome}% - ${stats.possessionAway}%`
      : 'N/A';

  return [
    `• Kiểm soát bóng: ${possession}`,
    `• Tổng cú sút: ${stats.totalShots ?? 'N/A'}`,
    `• Sút trúng đích: ${stats.shotsOnTarget ?? 'N/A'}`,
    `• Sút không trúng đích: ${stats.shotsOffTarget ?? 'N/A'}`,
    `• Sút bị chặn: ${stats.blockedShots ?? 'N/A'}`,
    `• Phạt góc: ${stats.corners ?? 'N/A'}`,
    `• Thẻ đỏ: ${stats.redCards ?? 'N/A'}`,
    `• Nguồn dữ liệu: ${stats.sources.join(', ') || 'N/A'}`
  ].join('\n');
}


// ==========================================================
// 46. SCAN LIVE MATCHES
// ==========================================================

async function scanLiveMatches() {
  const currentVN =
    getVietnamTime();

  cleanupOldState();

  console.log(
    `\n==================================================`
  );

  console.log(
    `[Auto-Scan AI] ${currentVN.timeStr} - Đang quét đa nguồn...`
  );

  try {
    const [
      allOdds,
      sofaRaw,
      flashRaw,
      liveFootballRaw
    ] = await Promise.all([
      fetchOddsData(),

      fetchLiveMatchesFromSofaScore(),

      fetchLiveMatchesFromFlashScore(),

      fetchLiveMatchesFromLiveFootball()
    ]);


    // --------------------------------------------------------
    // FORMAT SOURCES
    // --------------------------------------------------------

    const sofaMatches =
      sofaRaw
        .map(
          i =>
            formatLiveMatch(
              i,
              'sofascore'
            )
        )
        .filter(
          m =>
            m.homeName !== 'Đội nhà' &&
            m.awayName !== 'Đội khách'
        );

    const flashMatches =
      flashRaw
        .map(
          i =>
            formatLiveMatch(
              i,
              'flashscore'
            )
        )
        .filter(
          m =>
            m.homeName !== 'Đội nhà' &&
            m.awayName !== 'Đội khách'
        );

    const liveFootballMatches =
      liveFootballRaw
        .map(
          i =>
            formatLiveMatch(
              i,
              'live-football'
            )
        )
        .filter(
          m =>
            m.homeName !== 'Đội nhà' &&
            m.awayName !== 'Đội khách'
        );


    console.log(
      `[Sources] SofaScore: ${sofaMatches.length} | FlashScore: ${flashMatches.length} | LiveFootball: ${liveFootballMatches.length}`
    );


    // --------------------------------------------------------
    // MERGE LIVE MATCHES
    // --------------------------------------------------------

    const allSourceMatches = {
      sofaMatches,
      flashMatches,
      liveFootballMatches
    };

    const allCandidates = [
      ...sofaMatches,
      ...flashMatches,
      ...liveFootballMatches
    ];

    const uniqueMatches = [];

    for (
      const candidate
        of allCandidates
    ) {
      let existing = null;

      for (
        const m
          of uniqueMatches
      ) {
        const similarity =
          matchSimilarity(
            candidate.homeName,
            candidate.awayName,
            m.homeName,
            m.awayName
          );

        if (
          similarity >= 0.86
        ) {
          existing = m;
          break;
        }
      }

      if (!existing) {
        uniqueMatches.push(
          candidate
        );
      } else {
        /*
         * Ưu tiên SofaScore làm match chính
         * vì thường có statistics/incidents tốt hơn.
         */
        if (
          candidate.source ===
          'sofascore'
        ) {
          existing.id =
            candidate.id;

          existing.source =
            candidate.source;

          existing.raw =
            candidate.raw;

          existing.elapsed =
            candidate.elapsed;

          existing.leagueName =
            candidate.leagueName;

          existing.homeScore =
            candidate.homeScore;

          existing.awayScore =
            candidate.awayScore;
        }
      }
    }


    // --------------------------------------------------------
    // LIVE FILTER
    // --------------------------------------------------------

    const liveMatches =
      uniqueMatches.filter(
        match => {
          const item =
            match.raw;

          const statusType =
            String(
              item.status?.type ||
              item.status ||
              ''
            ).toLowerCase();

          const statusCode =
            item.status?.code;

          const isLive =
            statusType ===
              'inprogress' ||
            statusType ===
              'live' ||
            statusType ===
              'ongoing' ||
            statusCode === 1 ||
            match.source ===
              'flashscore' ||
            match.source ===
              'live-football';

          if (!isLive) {
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
      `[Bộ lọc] Tổng unique: ${uniqueMatches.length} | Live hợp lệ: ${liveMatches.length}`
    );


    if (
      liveMatches.length === 0
    ) {
      console.log(
        '[Thông báo] Không có trận hợp lệ đang Live.'
      );

      return;
    }


    // --------------------------------------------------------
    // SCAN EACH MATCH
    // --------------------------------------------------------

    for (
      let index = 0;
      index <
      liveMatches.length;
      index++
    ) {
      const match =
        liveMatches[index];

      const elapsed =
        calculateExactMinute(
          match.raw
        );

      const numericElapsed =
        typeof elapsed ===
          'number'
          ? elapsed
          : parseInt(
              elapsed,
              10
            );


      // ------------------------------------------------------
      // MINUTE FILTER
      // ------------------------------------------------------

      if (
        isNaN(numericElapsed) ||
        numericElapsed < 46 ||
        numericElapsed > 92
      ) {
        const timeLabel =
          elapsed === 'HT' ||
          elapsed === 999
            ? elapsed
            : `${elapsed}'`;

        console.log(
          `[${index + 1}] [${timeLabel}] ${match.homeName} vs ${match.awayName} -> BỎ QUA`
        );

        continue;
      }


      /*
       * Cập nhật phút sau khi xác định chính xác.
       */
      match.elapsed =
        numericElapsed;


      console.log(
        `\n[ĐANG PHÂN TÍCH #${index + 1}]`
      );

      console.log(
        `[${match.source.toUpperCase()}] ${match.homeName} ${match.homeScore}-${match.awayScore} ${match.awayName}`
      );

      console.log(
        `[PHÚT] ${numericElapsed}'`
      );

      console.log(
        `[GIẢI] ${match.leagueName}`
      );


      // ------------------------------------------------------
      // STATISTICS MULTI-SOURCE
      // ------------------------------------------------------

      const metrics =
        await fetchMatchDetailStats(
          match,
          allSourceMatches
        );


      // ------------------------------------------------------
      // ODDS
      // ------------------------------------------------------

      const oddsAnalysis =
        analyzeOddsGoalProbability(
          allOdds,

          match.homeName,

          match.awayName,

          match.homeScore +
            match.awayScore
        );


      // ------------------------------------------------------
      // AI
      // ------------------------------------------------------

      const aiAnalysis =
        evaluateMatchDynamicAI(
          match,
          metrics,
          oddsAnalysis
        );


      console.log(
        `   └─> AI: ${aiAnalysis.efficiency}%`
      );

      console.log(
        `   └─> Data Quality: ${aiAnalysis.dataQuality}%`
      );


      // ------------------------------------------------------
      // ALERT KEY
      // ------------------------------------------------------

      const matchKey =
        getStableMatchKey(
          match
        );


      const alertDecision =
        shouldSendAlert(
          matchKey,
          parseFloat(
            aiAnalysis.efficiency
          )
        );


      // ------------------------------------------------------
      // SEND
      // ------------------------------------------------------

      if (
        aiAnalysis.shouldSend &&
        alertDecision.send
      ) {
        const goalTimeline =
          await fetchMatchIncidents(
            match
          );

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

          goalTimeline,

          statsSummary:
            formatStatsSummary(
              metrics
            ),

          detailText:
            aiAnalysis.detailText,

          ruleEfficiency:
            aiAnalysis.efficiency,

          dataQuality:
            aiAnalysis.dataQuality,

          alertNumber
        };


        console.log(
          `   └─> 🔔 [ALERT] ${alertDecision.reason}`
        );

        console.log(
          `   └─> 🚨 GỬI TELEGRAM #${alertNumber}`
        );


        await sendTelegramAlert(
          pickItem
        );

      } else {
        console.log(
          `   └─> [BỎ QUA] AI ${aiAnalysis.efficiency}% | ${alertDecision.reason}`
        );
      }


      /*
       * Không chạy quá nhanh giữa từng trận.
       * Giúp giảm nguy cơ burst API.
       */
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            250
          )
      );
    }

  } catch (err) {
    console.error(
      '[SCAN ERROR]:',
      err.message
    );

    if (
      err.response
    ) {
      console.error(
        'Status:',
        err.response.status
      );
    }
  }
}


// ==========================================================
// 47. SERVER
// ==========================================================

app.get(
  '/',
  (req, res) => {
    res.json({
      status: 'running',

      service:
        'Football AI Scanner',

      version:
        'Multi-Source Statistics v2',

      minuteFilter:
        '46-92',

      statisticsSources: [
        'SofaScore',
        'FlashScore',
        'LiveScore'
      ],

      alertSystem: {
        firstAlert: true,
        increaseThreshold:
          ALERT_INCREASE_THRESHOLD,
        maxAlerts:
          MAX_ALERTS_PER_MATCH
      }
    });
  }
);


// ==========================================================
// 48. HEALTH CHECK
// ==========================================================

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,

      time:
        getVietnamTime(),

      matchStates:
        matchState.size,

      alertStates:
        alertState.size
    });
  }
);


// ==========================================================
// 49. START SERVER
// ==========================================================

app.listen(
  PORT,
  () => {
    console.log(
      `==> Server running on port ${PORT}`
    );

    console.log(
      `==> Football AI Scanner Multi-Source v2`
    );

    console.log(
      `==> Live filter: 46' - 92'`
    );

    console.log(
      `==> Statistics: SofaScore + FlashScore + LiveScore`
    );

    console.log(
      `==> Alert: first alert + AI increase >= ${ALERT_INCREASE_THRESHOLD}%`
    );

    /*
     * Quét lần đầu.
     */
    scanLiveMatches();

    /*
     * Giữ chu kỳ 7 phút như code cũ.
     */
    setInterval(
      scanLiveMatches,
      7 * 60 * 1000
    );
  }
);