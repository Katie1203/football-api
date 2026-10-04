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
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;


// ==========================================================
// 3. LIVESCORE
// ==========================================================

const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';


// ==========================================================
// 4. ODDS API & CÁC NGUỒN MỚI (FLASHSCORE, LIVE FOOTBALL)
// ==========================================================

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_URL = ODDS_API_KEY
  ? `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`
  : '';

// Nguồn mới bổ sung: FlashScore API
const FLASHSCORE_HOST = 'flashscore-api1.p.rapidapi.com';
const FLASHSCORE_LIVE_URL = `https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/live?sport_id=1`;

// Nguồn mới bổ sung: Live Football Stream API
const LIVE_FOOTBALL_HOST = 'football-live-stream-api.p.rapidapi.com';
const LIVE_FOOTBALL_URL = `https://${LIVE_FOOTBALL_HOST}/matches`;


// ==========================================================
// 5. QUẢN LÝ CẢNH BÁO
// ==========================================================

const alertState = new Map();
const ALERT_INCREASE_THRESHOLD = 10.0;
const MAX_ALERTS_PER_MATCH = 3;


// ==========================================================
// 6. THỜI GIAN VIỆT NAM
// ==========================================================

function getVietnamTime() {
  const now = new Date();
  const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  return {
    dateStr: vnTime.toISOString().slice(0, 10),
    timeStr: vnTime.toISOString().slice(11, 19)
  };
}


// ==========================================================
// 7. BẢNG DỊCH QUỐC GIA
// ==========================================================

const COUNTRY_MAP = {
  'England': 'Anh', 'Spain': 'Tây Ban Nha', 'Italy': 'Ý', 'Germany': 'Đức', 'France': 'Pháp',
  'Japan': 'Nhật Bản', 'South Korea': 'Hàn Quốc', 'Vietnam': 'Việt Nam', 'Brazil': 'Brazil',
  'Argentina': 'Argentina', 'Netherlands': 'Hà Lan', 'Portugal': 'Bồ Đào Nha', 'Turkey': 'Thổ Nhĩ Kỳ',
  'Saudi Arabia': 'Ả Rập Xê Út', 'China': 'Trung Quốc', 'Thailand': 'Thái Lan', 'Australia': 'Úc',
  'USA': 'Mỹ', 'Norway': 'Na Uy', 'Czech Republic': 'Cộng hòa Séc', 'Denmark': 'Đan Mạch',
  'Croatia': 'Croatia', 'Poland': 'Ba Lan', 'Austria': 'Áo', 'World': 'Quốc Tế', 'Europe': 'Châu Âu',
  'Asia': 'Châu Á', 'South America': 'Nam Mỹ'
};


// ==========================================================
// 8. TÊN GIẢI ĐẤU
// ==========================================================

const LEAGUE_NAME_MAP = {
  'UEFA Champions League': 'Cúp C1 Châu Âu', 'UEFA Europa League': 'Cúp C2 Châu Âu',
  'UEFA Conference League': 'Cúp C3 Châu Âu', 'UEFA Nations League': 'Nations League Châu Âu',
  'AFC Champions League Elite': 'Cúp C1 Châu Á', 'AFC Champions League Two': 'Cúp C2 Châu Á',
  'AFC Asian Cup': 'Cúp Châu Á (Asian Cup)', 'CONMEBOL Libertadores': 'Cúp C1 Nam Mỹ (Libertadores)',
  'CONMEBOL Sudamericana': 'Cúp C2 Nam Mỹ (Sudamericana)', 'World Cup': 'Giải Vô Địch Thế Giới (World Cup)',
  'Club World Cup': 'Giải VĐQG Thế Giới Các CLB', 'Friendlies': 'Giao Hữu Quốc Tế', 'Club Friendly': 'Giao Hữu CLB',
  'Premier League': 'Ngoại Hạng Anh', 'Championship': 'Hạng Nhất Anh', 'League One': 'Hạng Hai Anh', 'League Two': 'Hạng Ba Anh',
  'FA Cup': 'Cúp FA', 'EFL Cup': 'Cúp Liên Đoàn Anh', 'LaLiga': 'VĐQG Tây Ban Nha', 'LaLiga 2': 'Hạng 2 Tây Ban Nha',
  'Copa del Rey': 'Cúp Nhà Vua Tây Ban Nha', 'Serie A': 'VĐQG Ý', 'Serie B': 'Hạng 2 Ý', 'Coppa Italia': 'Cúp Quốc Gia Ý',
  'Bundesliga': 'VĐQG Đức', '2. Bundesliga': 'Hạng 2 Đức', 'DFB Pokal': 'Cúp Quốc Gia Đức',
  'Ligue 1': 'VĐQG Pháp', 'Ligue 2': 'Hạng 2 Pháp', 'Coupe de France': 'Cúp Quốc Gia Pháp',
  'J1 League': 'VĐQG Nhật Bản', 'J2 League': 'Hạng 2 Nhật Bản', 'J3 League': 'Hạng 3 Nhật Bản',
  'K League 1': 'VĐQG Hàn Quốc', 'K League 2': 'Hạng 2 Hàn Quốc', 'V-League 1': 'V-League Việt Nam',
  'Thai League 1': 'VĐQG Thái Lan', 'Super League': 'VĐQG Trung Quốc'
};


// ==========================================================
// 9. PHÂN TÍCH TÊN GIẢI
// ==========================================================

function parseLeagueName(item) {
  if (!item) return 'Bóng Đá Quốc Tế';
  const category = item.tournament?.category?.name || item.category?.name || '';
  const tournament = item.tournament?.name || item.competitionName || item.league || '';

  if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];

  const translatedCategory = COUNTRY_MAP[category] || category;
  let translatedTournament = tournament
    .replace(/\bPremier League\b/gi, 'Giải VĐQG')
    .replace(/\bDivision 1\b/gi, 'Hạng 1')
    .replace(/\bDivision 2\b/gi, 'Hạng 2')
    .replace(/\bSuper League\b/gi, 'VĐQG')
    .replace(/\bCup\b/gi, 'Cúp');

  if (translatedCategory && translatedTournament) {
    if (translatedTournament.toLowerCase().includes(translatedCategory.toLowerCase())) {
      return translatedTournament;
    }
    return `${translatedTournament} (${translatedCategory})`;
  }
  return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}


// ==========================================================
// 10. BỘ LỌC GIẢI TRẺ / GIẢI PHỤ / GIẢI CỎ / SINH VIÊN
// ==========================================================

function isFilteredLeague(leagueName, homeName, awayName) {
  const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
  const leagueLower = leagueName.toLowerCase();

  const professionalWomenKeywords = [
    'womens champions league', 'uefa women', 'afc women', 'conmebol libertadores femenina',
    'nwsl', 'womens super league', 'd1 arkema', 'frauen-bundesliga', 'liga f', 'serie a fem',
    'a-league women', 'world cup women', 'olympic women', 'shebelieves cup'
  ];

  if (professionalWomenKeywords.some(kw => leagueLower.includes(kw))) return false;

  const youthRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;
  if (youthRegex.test(textToTest)) return true;

  const filterKeywords = [
    'simulated', 'srl', 'esports', 'e-soccer', 'ncaa', 'amateur', 'semi-pro',
    'regional', 'reserve', 'state league', 'local', 'college', 'university'
  ];

  return filterKeywords.some(kw => textToTest.includes(kw));
}


// ==========================================================
// 11. TÍNH PHÚT TRẬN ĐẤU
// ==========================================================

function calculateExactMinute(item) {
  if (!item) return 0;
  const statusType = String(item.status?.type || '').toLowerCase();
  const statusDescription = String(item.status?.description || '').toLowerCase();

  if (statusType === 'finished' || statusType === 'ended' || statusType === 'cancelled' || statusType === 'canceled') return 999;
  if (statusDescription.includes('halftime') || statusDescription === 'ht' || statusType === 'halftime') return 'HT';

  const directMinuteCandidates = [
    item.minute, item.liveMinute, item.live?.minute, item.status?.minute,
    item.status?.current, item.time?.current, item.time?.minute, item.time?.currentMinute
  ];

  for (const value of directMinuteCandidates) {
    const minute = Number(value);
    if (Number.isFinite(minute) && minute > 0 && minute <= 130) return Math.floor(minute);
  }

  const currentPeriodStartTimestamp = Number(item.time?.currentPeriodStartTimestamp || item.currentPeriodStartTimestamp || item.time?.currentPeriodStart);
  if (Number.isFinite(currentPeriodStartTimestamp) && currentPeriodStartTimestamp > 0) {
    const now = Math.floor(Date.now() / 1000);
    const elapsedSeconds = now - currentPeriodStartTimestamp;
    if (elapsedSeconds >= 0 && elapsedSeconds < 7200) {
      let calculatedMinute = Math.floor(elapsedSeconds / 60) + 1;
      const isSecondHalf = statusDescription.includes('2nd half') || statusDescription.includes('second half') || statusDescription.includes('hiệp 2');
      if (isSecondHalf) calculatedMinute = 45 + Math.floor(elapsedSeconds / 60) + 1;
      return calculatedMinute;
    }
  }

  const startTimestamp = Number(item.startTimestamp || item.start_timestamp);
  if (Number.isFinite(startTimestamp) && startTimestamp > 0 && statusType === 'inprogress') {
    const now = Math.floor(Date.now() / 1000);
    const elapsedSeconds = now - startTimestamp;
    if (elapsedSeconds >= 0 && elapsedSeconds < 7200) {
      return Math.floor(elapsedSeconds / 60) + 1;
    }
  }

  return 0;
}


// ==========================================================
// 12. CÁC HÀM LẤY TRẬN LIVE TỪ ĐA NGUỒN (SOFASCORE + FLASHSCORE + LIVE FOOTBALL)
// ==========================================================

async function fetchLiveMatchesFromSofaScore() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];
    const response = await axios.get(SOFASCORE_LIVE_URL, {
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
      timeout: 10000
    });
    return response.data?.events || response.data?.liveEvents || [];
  } catch (err) {
    console.error(`❌ [SofaScore Live Error]:`, err.message);
    return [];
  }
}

async function fetchLiveMatchesFromFlashScore() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];
    const response = await axios.get(FLASHSCORE_LIVE_URL, {
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': FLASHSCORE_HOST },
      timeout: 8000
    });
    const resData = response.data;
    return Array.isArray(resData) ? resData : (resData?.data || resData?.matches || resData?.events || []);
  } catch (err) {
    return [];
  }
}

async function fetchLiveMatchesFromLiveFootball() {
  try {
    if (!PAID_RAPIDAPI_KEY) return [];
    const response = await axios.get(LIVE_FOOTBALL_URL, {
      params: { status: 'live' },
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVE_FOOTBALL_HOST },
      timeout: 8000
    });
    return response.data?.result || response.data?.matches || [];
  } catch (err) {
    return [];
  }
}


// ==========================================================
// 13. LẤY DIỄN BIẾN BÀN THẮNG
// ==========================================================

async function fetchMatchIncidents(matchId, homeScore = 0, awayScore = 0, sourceFlag = 'sofascore') {
  if (sourceFlag !== 'sofascore') {
    const totalGoals = homeScore + awayScore;
    if (totalGoals > 0) return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;
    return '• Chưa có bàn thắng (Tỷ số: 0-0)';
  }

  try {
    const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
      timeout: 6000
    });
    const incidents = response.data?.incidents || [];
    const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');

    if (goalEvents.length === 0) {
      const totalGoals = homeScore + awayScore;
      if (totalGoals > 0) return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số hiện tại: ${homeScore}-${awayScore})`;
      return '• Chưa có bàn thắng (Tỷ số: 0-0)';
    }

    goalEvents.sort((a, b) => (a.time || 0) - (b.time || 0));
    const timeline = goalEvents.map(g => {
      const min = g.time || 0;
      const extra = g.addedTime ? `+${g.addedTime}` : '';
      const player = g.player?.shortName || g.player?.name || 'Cầu thủ';
      const isHome = g.isHome ? '⚽ [Chủ]' : '⚽ [Khách]';
      const scoreStr = (g.homeScore !== undefined && g.awayScore !== undefined) ? `[${g.homeScore}-${g.awayScore}]` : '';
      return `• Phút ${min}'${extra}: ${isHome} ${player} ${scoreStr}`;
    });
    return timeline.join('\n');
  } catch (err) {
    const totalGoals = homeScore + awayScore;
    if (totalGoals > 0) return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;
    return '• Chưa có bàn thắng (Tỷ số: 0-0)';
  }
}


// ==========================================================
// 14. LẤY KÈO NHÀ CÁI
// ==========================================================

async function fetchOddsData() {
  if (!ODDS_API_KEY || !ODDS_API_URL) return [];
  try {
    const response = await axios.get(ODDS_API_URL, { timeout: 8000 });
    return response.data || [];
  } catch (err) {
    console.error('[Odds API Error]:', err.message);
    return [];
  }
}


// ==========================================================
// 15. LẤY THỐNG KÊ TRẬN ĐẤU (HỖ TRỢ ĐA NGUỒN: LIVESCORE -> SOFASCORE -> FLASHSCORE)
// ==========================================================

async function fetchMatchDetailStats(matchId, homeName, awayName, sourceFlag = 'sofascore') {
  // Nếu trận thuộc nguồn FlashScore
  if (sourceFlag === 'flashscore') {
    try {
      const res = await axios.get(`https://${FLASHSCORE_HOST}/api/flashscore/v2/matches/details?matchId=${matchId}`, {
        headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': FLASHSCORE_HOST },
        timeout: 6000
      });
      const statsList = res.data?.data?.statistics || res.data?.statistics || [];
      let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
      let possessionHome = null, possessionAway = null;

      if (Array.isArray(statsList)) {
        statsList.forEach(st => {
          const name = String(st.name || st.type || '').toLowerCase();
          const homeVal = parseInt(st.home || st.homeValue, 10);
          const awayVal = parseInt(st.away || st.awayValue, 10);
          const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

          if (name.includes('shots on target') || name.includes('ontarget')) shotsOnTarget = Math.max(shotsOnTarget, sumVal);
          else if (name.includes('shots') || name.includes('total shots')) totalShots = Math.max(totalShots, sumVal);
          else if (name.includes('corner')) corners = Math.max(corners, sumVal);
          else if (name.includes('red card')) redCards = Math.max(redCards, sumVal);
          else if (name.includes('possession') && !isNaN(homeVal)) {
            possessionHome = homeVal;
            possessionAway = awayVal;
          }
        });
      }

      return {
        sofaStats: {
          shotsOnTarget,
          totalShots: totalShots || shotsOnTarget,
          corners,
          redCards,
          possession: possessionHome !== null ? `${possessionHome}% - ${possessionAway}%` : null
        }
      };
    } catch (e) {}
  }

  // Thử Livescore
  try {
    const searchUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
    const resLive = await axios.get(searchUrl, {
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST },
      timeout: 6000
    });

    let foundEid = null;
    function scanForEid(obj) {
      if (!obj || foundEid) return;
      if (typeof obj === 'object') {
        const mId = String(obj.Eid || obj.id || '');
        const t1 = String(obj.T1?.[0]?.Nm || obj.homeTeam?.name || '').toLowerCase();
        const t2 = String(obj.T2?.[0]?.Nm || obj.awayTeam?.name || '').toLowerCase();

        if (mId && (t1.includes(homeName.toLowerCase().slice(0, 4)) || t2.includes(awayName.toLowerCase().slice(0, 4)))) {
          foundEid = mId;
          return;
        }
        for (const k of Object.keys(obj)) scanForEid(obj[k]);
      }
    }
    scanForEid(resLive.data);

    if (foundEid) {
      const statsRes = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${foundEid}`, {
        headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST },
        timeout: 6000
      });

      let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
      let possessionHome = null, possessionAway = null;
      const statList = Array.isArray(statsRes.data) ? statsRes.data : (statsRes.data?.statistics || statsRes.data?.stats || []);

      statList.forEach(st => {
        const name = String(st.name || st.type || st.title || '').toLowerCase();
        const homeVal = parseInt(st.home || st.homeValue, 10);
        const awayVal = parseInt(st.away || st.awayValue, 10);
        const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

        if (name.includes('shot on target') || name.includes('sút trúng đích')) shotsOnTarget = Math.max(shotsOnTarget, sumVal);
        else if (name.includes('total shot') || name.includes('tổng cú sút')) totalShots = Math.max(totalShots, sumVal);
        else if (name.includes('corner') || name.includes('phạt góc')) corners = Math.max(corners, sumVal);
        else if (name.includes('red card') || name.includes('thẻ đỏ')) redCards = Math.max(redCards, sumVal);
        else if (name.includes('possession') || name.includes('kiểm soát')) {
          if (!isNaN(homeVal) && !isNaN(awayVal)) { possessionHome = homeVal; possessionAway = awayVal; }
        }
      });

      let possessionStr = possessionHome !== null ? `${possessionHome}% - ${possessionAway}%` : null;
      if (shotsOnTarget > 0 || totalShots > 0 || corners > 0 || possessionStr) {
        return { sofaStats: { shotsOnTarget, totalShots: totalShots || shotsOnTarget, corners, redCards, possession: possessionStr } };
      }
    }
  } catch (err) {}

  // SofaScore Fallback
  try {
    const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
      headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
      timeout: 6000
    });

    let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
    let shotsOffTarget = 0, blockedShots = 0;
    let possessionHome = null, possessionAway = null;
    const statistics = response.data?.statistics;

    if (Array.isArray(statistics)) {
      statistics.forEach(period => {
        (period.groups || []).forEach(group => {
          (group.statisticsItems || []).forEach(st => {
            const name = String(st.name || st.slug || '').toLowerCase();
            const homeVal = parseInt(st.home, 10);
            const awayVal = parseInt(st.away, 10);
            const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

            if (name.includes('shots on target')) shotsOnTarget = Math.max(shotsOnTarget, sumVal);
            else if (name.includes('shots off target')) shotsOffTarget = Math.max(shotsOffTarget, sumVal);
            else if (name.includes('blocked shots')) blockedShots = Math.max(blockedShots, sumVal);
            else if (name.includes('total shots')) totalShots = Math.max(totalShots, sumVal);
            else if (name.includes('corner')) corners = Math.max(corners, sumVal);
            else if (name.includes('red card')) redCards = Math.max(redCards, sumVal);
            else if (name.includes('possession') && !isNaN(homeVal)) { possessionHome = homeVal; possessionAway = awayVal; }
          });
        });
      });
    }

    let possessionStr = possessionHome !== null ? `${possessionHome}% - ${possessionAway}%` : null;
    return {
      sofaStats: {
        shotsOnTarget,
        totalShots: totalShots || (shotsOnTarget + shotsOffTarget + blockedShots),
        shotsOffTarget,
        blockedShots,
        corners,
        redCards,
        possession: possessionStr
      }
    };
  } catch (err) {
    return { sofaStats: { shotsOnTarget: 0, totalShots: 0, shotsOffTarget: 0, blockedShots: 0, corners: 0, redCards: 0, possession: null } };
  }
}


// ==========================================================
// 16. CLEAN TÊN ĐỘI
// ==========================================================

function cleanTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}


// ==========================================================
// 17. PHÂN TÍCH ODDS
// ==========================================================

function analyzeOddsGoalProbability(allOdds, homeName, awayName, currentTotalGoals) {
  if (!Array.isArray(allOdds) || allOdds.length === 0) return null;

  const hClean = cleanTeamName(homeName);
  const aClean = cleanTeamName(awayName);

  const foundMatch = allOdds.find(m => {
    const mHome = cleanTeamName(m.home_team);
    const mAway = cleanTeamName(m.away_team);
    return (mHome.includes(hClean) || hClean.includes(mHome)) && (mAway.includes(aClean) || aClean.includes(mAway));
  });

  if (!foundMatch || !foundMatch.bookmakers?.[0]) return null;

  const totalsMarket = foundMatch.bookmakers[0].markets?.find(mk => mk.key === 'totals');
  const overOutcome = totalsMarket?.outcomes?.find(o => o.name === 'Over');
  if (!overOutcome) return null;

  let oddsBonus = 0;
  let oddsNotes = [];
  const overLine = overOutcome.point;
  const price = overOutcome.price;
  const pointDiff = overLine - currentTotalGoals;

  if (pointDiff >= 0.75) {
    oddsBonus = 16.0;
    oddsNotes.push(`Line Over giữ mức cao (${overLine}) so với tổng ${currentTotalGoals} bàn`);
  } else if (pointDiff > 0) {
    oddsBonus = 10.0;
    oddsNotes.push(`Line Over (${overLine}) sát mốc nổ bàn`);
  }

  if (price <= 1.40) {
    oddsBonus += 18.0;
    oddsNotes.push(`Odds Over cực thấp (${price}) - Dòng tiền kết tài mạnh`);
  } else if (price <= 1.60) {
    oddsBonus += 13.0;
    oddsNotes.push(`Odds Over giảm sâu (${price})`);
  } else if (price <= 1.85) {
    oddsBonus += 8.0;
    oddsNotes.push(`Odds Over ổn định (${price})`);
  } else {
    oddsBonus += 4.0;
    oddsNotes.push(`Odds Over (${price})`);
  }

  return {
    bookmaker: foundMatch.bookmakers[0].title,
    line: overLine,
    odds: price,
    oddsBonus,
    oddsNoteText: oddsNotes.join(' | ')
  };
}


// ==========================================================
// 18. THUẬT TOÁN AI ĐÁNH GIÁ TRẬN
// ==========================================================

function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
  let matchAnalysis = [];
  let aiPercentage = 35.0;
  const stats = metrics.sofaStats || {};
  let hasTacticalData = false;

  if (stats.possession) {
    matchAnalysis.push(`📊 Tỷ lệ kiểm soát bóng: ${stats.possession}`);
    const possParts = stats.possession.split('-');
    if (possParts.length === 2) {
      const homePoss = parseInt(possParts[0].trim(), 10) || 50;
      const awayPoss = parseInt(possParts[1].trim(), 10) || 50;
      const maxPoss = Math.max(homePoss, awayPoss);

      if (maxPoss >= 70) {
        aiPercentage += 15.0;
        matchAnalysis.push(` └─> Thế trận áp đảo cực mạnh (${maxPoss}% - cộng thêm 15.0%)`);
        hasTacticalData = true;
      } else if (maxPoss >= 60) {
        aiPercentage += 10.0;
        matchAnalysis.push(` └─> Thế trận lấn lướt (${maxPoss}% - cộng thêm 10.0%)`);
        hasTacticalData = true;
      }
    }
  }

  if (stats.redCards > 0) {
    aiPercentage += 15.0;
    matchAnalysis.push(`🟥 Thẻ đỏ (${stats.redCards} thẻ - cộng thêm 15.0%)`);
    hasTacticalData = true;
  }

  if (stats.shotsOnTarget >= 6) {
    aiPercentage += 18.0;
    matchAnalysis.push(`⚡ Sút trúng đích dồn dập: ${stats.shotsOnTarget} lần (Cộng thêm 18.0%)`);
    hasTacticalData = true;
  } else if (stats.shotsOnTarget >= 4) {
    aiPercentage += 12.0;
    matchAnalysis.push(`⚡ Sút trúng đích dồn dập: ${stats.shotsOnTarget} lần (Cộng thêm 12.0%)`);
    hasTacticalData = true;
  } else if (stats.shotsOnTarget >= 2) {
    aiPercentage += 6.0;
    matchAnalysis.push(`🎯 Sút trúng đích: ${stats.shotsOnTarget} lần (Cộng thêm 6.0%)`);
    hasTacticalData = true;
  }

  if (stats.totalShots >= 15) {
    aiPercentage += 15.0;
    matchAnalysis.push(`🔥 Thế trận cực kỳ cởi mở, tổng sút: ${stats.totalShots} (Cộng thêm 15.0%)`);
    hasTacticalData = true;
  } else if (stats.totalShots >= 10) {
    aiPercentage += 10.0;
    matchAnalysis.push(`⚽ Hai đội tích cực bắn phá, tổng sút: ${stats.totalShots} (Cộng thêm 10.0%)`);
    hasTacticalData = true;
  } else if (stats.totalShots >= 6) {
    aiPercentage += 5.0;
    matchAnalysis.push(`⚽ Tổng sút: ${stats.totalShots} (Cộng thêm 5.0%)`);
    hasTacticalData = true;
  }

  if (stats.corners >= 8) {
    aiPercentage += 12.0;
    matchAnalysis.push(`🚩 Sức ép phạt góc lớn: ${stats.corners} quả (Cộng thêm 12.0%)`);
    hasTacticalData = true;
  } else if (stats.corners >= 4) {
    aiPercentage += 6.0;
    matchAnalysis.push(`🚩 Phạt góc ổn định: ${stats.corners} quả (Cộng thêm 6.0%)`);
    hasTacticalData = true;
  }

  if (oddsAnalysis) {
    aiPercentage += oddsAnalysis.oddsBonus;
    matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds} - Cộng thêm ${oddsAnalysis.oddsBonus.toFixed(1)}%)`);
    if (oddsAnalysis.oddsNoteText) matchAnalysis.push(` └─> ${oddsAnalysis.oddsNoteText}`);
    hasTacticalData = true;
  }

  const finalPercentage = Math.min(aiPercentage, 98.0).toFixed(1);
  const MIN_SEND_PERCENTAGE = 60.0;
  const shouldSend = parseFloat(finalPercentage) > MIN_SEND_PERCENTAGE && hasTacticalData;

  return {
    efficiency: finalPercentage,
    detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
    shouldSend
  };
}


// ==========================================================
// 19. QUYẾT ĐỊNH CÓ GỬI LẠI HAY KHÔNG
// ==========================================================

function shouldSendAlert(matchId, currentPercentage, currentMinute) {
  const previous = alertState.get(matchId);
  if (!previous) return { send: true, reason: 'Cảnh báo đầu tiên của trận' };
  if (previous.alertCount >= MAX_ALERTS_PER_MATCH) return { send: false, reason: `Đã đạt tối đa ${MAX_ALERTS_PER_MATCH} lần cảnh báo` };

  const increase = currentPercentage - previous.lastPercentage;
  if (increase >= ALERT_INCREASE_THRESHOLD) return { send: true, reason: `AI tăng mạnh +${increase.toFixed(1)}%` };
  return { send: false, reason: `AI chỉ tăng +${increase.toFixed(1)}%, chưa đủ +${ALERT_INCREASE_THRESHOLD}%` };
}


// ==========================================================
// 20. GỬI TELEGRAM
// ==========================================================

async function sendTelegramAlert(item) {
  const timeDisplay = `Phút ${item.elapsed}'`;
  const message = `🔔 RUNG CHUÔNG VÀNGGGG #${item.alertNumber}

🏆 Giải đấu: ${item.league}

⚔️ Trận đấu:
${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}

⏱ Thời gian:
${timeDisplay}

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🎯 Nhận định:
Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG

📈 Hiệu suất Rule:
${item.ruleEfficiency}%

🚨 Lần cảnh báo:
#${item.alertNumber}`;

  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    });

    const previous = alertState.get(item.id);
    alertState.set(item.id, {
      lastPercentage: parseFloat(item.ruleEfficiency),
      lastMinute: item.elapsed,
      alertCount: previous ? previous.alertCount + 1 : 1
    });

    console.log(` └─> [Telegram Success] Đã gửi cảnh báo #${item.alertNumber}: ${item.homeName} vs ${item.awayName} (${item.ruleEfficiency}%)`);
  } catch (err) {
    console.error(' └─> [Telegram Error]:', err.message);
  }
}


// ==========================================================
// 21. QUÉT LIVE MATCHES TỪ TẤT CẢ CÁC NGUỒN
// ==========================================================

async function scanLiveMatches() {
  const currentVN = getVietnamTime();
  console.log(`\n==================================================`);
  console.log(`[Auto-Scan AI] Đang quét đồng thời SofaScore, FlashScore, Live Football & Odds... (${currentVN.timeStr})`);

  try {
    const [allOdds, sofaMatches, flashMatches, liveFootballMatches] = await Promise.all([
      fetchOddsData(),
      fetchLiveMatchesFromSofaScore(),
      fetchLiveMatchesFromFlashScore(),
      fetchLiveMatchesFromLiveFootball()
    ]);

    // Chuẩn hóa và gộp danh sách trận đấu từ mọi nguồn không bị trùng lặp ID
    const formattedMatches = [];

    sofaMatches.forEach(i => {
      formattedMatches.push({
        id: String(i.id),
        homeName: i.homeTeam?.name || 'Đội nhà',
        awayName: i.awayTeam?.name || 'Đội khách',
        homeScore: i.homeScore?.current ?? 0,
        awayScore: i.awayScore?.current ?? 0,
        leagueName: parseLeagueName(i),
        source: 'sofascore',
        raw: i
      });
    });

    flashMatches.forEach(i => {
      formattedMatches.push({
        id: String(i.id || i.matchId),
        homeName: i.homeTeam?.name || i.homeName || 'Đội nhà',
        awayName: i.awayTeam?.name || i.awayName || 'Đội khách',
        homeScore: i.homeScore ?? i.homeGoals ?? 0,
        awayScore: i.awayScore ?? i.awayGoals ?? 0,
        leagueName: parseLeagueName(i),
        source: 'flashscore',
        raw: i
      });
    });

    liveFootballMatches.forEach(i => {
      formattedMatches.push({
        id: String(i.id || i.matchId || Math.random()),
        homeName: i.home_name || i.homeName || 'Đội nhà',
        awayName: i.away_name || i.awayName || 'Đội khách',
        homeScore: parseInt(String(i.score || '0-0').split('-')[0]) || 0,
        awayScore: parseInt(String(i.score || '0-0').split('-')[1]) || 0,
        leagueName: parseLeagueName(i),
        source: 'live-football',
        raw: i
      });
    });

    const uniqueMap = new Map();
    formattedMatches.forEach(m => {
      if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m);
    });

    const allMatches = Array.from(uniqueMap.values());
    if (allMatches.length === 0) {
      console.log(`[Thông báo]: Không thu thập được trận nào từ các nguồn.`);
      return;
    }

    // Chỉ lọc các trận đang diễn ra thực tế
    const liveMatches = allMatches.filter(match => {
      const item = match.raw;
      const statusType = String(item.status?.type || item.status || '').toLowerCase();
      const statusCode = item.status?.code;
      return statusType === 'inprogress' || statusCode === 1 || match.source === 'flashscore' || match.source === 'live-football';
    });

    console.log(`[Bộ lọc Live] Tổng số trận trả về: ${allMatches.length} | Trận đang đá thực tế: ${liveMatches.length}`);

    if (liveMatches.length === 0) {
      console.log(`[Thông báo]: Hiện tại không có trận đấu nào đang trong trạng thái Live.`);
      return;
    }

    for (let index = 0; index < liveMatches.length; index++) {
      const match = liveMatches[index];
      const matchId = match.id;
      const homeName = match.homeName;
      const awayName = match.awayName;
      const homeScore = match.homeScore;
      const actualAwayScore = match.awayScore;
      const leagueName = match.leagueName;

      if (isFilteredLeague(leagueName, homeName, awayName)) {
        console.log(`[Trận #${index + 1}] [${leagueName}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Giải trẻ/Phụ/Cỏ/Sinh viên`);
        continue;
      }

      const elapsed = calculateExactMinute(match.raw);
      const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

      if (isNaN(numericElapsed) || numericElapsed < 46 || numericElapsed > 92) {
        const timeLabel = (elapsed === 'HT' || elapsed === 999) ? elapsed : `${elapsed}'`;
        console.log(`[Trận #${index + 1}] [Phút: ${timeLabel}] [${leagueName}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Ngoài khung 46'-92'`);
        continue;
      }

      console.log(`[Đang Phân Tích] [${match.source.toUpperCase()}] [ID: ${matchId}] [Phút: ${numericElapsed}'] [${leagueName}] ${homeName} ${homeScore}-${actualAwayScore} ${awayName}`);

      const metrics = await fetchMatchDetailStats(matchId, homeName, awayName, match.source);
      const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);
      const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis);
      const alertDecision = shouldSendAlert(matchId, parseFloat(aiAnalysis.efficiency), numericElapsed);

      if (aiAnalysis.shouldSend && alertDecision.send) {
        const goalTimeline = await fetchMatchIncidents(matchId, homeScore, actualAwayScore, match.source);

        console.log(` └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%)`);
        console.log(` └─> [ALERT] ${alertDecision.reason}`);

        const previous = alertState.get(matchId);
        const alertNumber = previous ? previous.alertCount + 1 : 1;

        const pickItem = {
          id: matchId,
          league: leagueName,
          homeName,
          awayName,
          homeScore,
          awayScore: actualAwayScore,
          elapsed: numericElapsed,
          goalTimeline,
          detailText: aiAnalysis.detailText,
          ruleEfficiency: aiAnalysis.efficiency,
          alertNumber
        };

        await sendTelegramAlert(pickItem);
      } else {
        console.log(` └─> [Bỏ qua] AI: ${aiAnalysis.efficiency}% | ${alertDecision.reason}`);
      }
    }
  } catch (err) {
    console.error(`[API Fetch Error]:`, err.message);
  }
}


// ==========================================================
// 22. ROUTE TEST SERVER
// ==========================================================

app.get('/', (req, res) => {
  res.send('Football AI Scanner (SofaScore + Livescore + FlashScore + LiveFootball + Odds) is Running!');
});


// ==========================================================
// 23. KHỞI ĐỘNG SERVER
// ==========================================================

app.listen(PORT, () => {
  console.log(`==> Server running on port ${PORT}`);
  scanLiveMatches();
  setInterval(scanLiveMatches, 7 * 60 * 1000);
});