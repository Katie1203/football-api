const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ==========================================
// CẤU HÌNH DỮ LIỆU & TELEGRAM (HỆ THỐNG XOAY VÒNG NHIỀU API KEY)
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

// Danh sách các RapidAPI Key tự động xoay vòng để tăng gấp đôi hạn mức và chống nghẽn
const RAPIDAPI_KEYS = [
  '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c',
  'f00cdf8303msh374792a917698bbp1f02cbjsn3bc6445978c1'
];

let currentKeyIndex = 0;

function getNextRapidApiKey() {
  const key = RAPIDAPI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % RAPIDAPI_KEYS.length;
  return key.trim();
}

// Nguồn 1: SofaScore
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

// Nguồn 2: Livescore6
const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

const sentAlerts = new Set();

function getVietnamTime() {
  const now = new Date();
  const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  return {
    dateStr: vnTime.toISOString().slice(0, 10),
    timeStr: vnTime.toISOString().slice(11, 19)
  };
}

// ==========================================
// 1. BẢNG DỊCH QUỐC GIA & GIẢI ĐẤU VIỆT HÓA
// ==========================================
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

const LEAGUE_NAME_MAP = {
  'UEFA Champions League': 'Cúp C1 Châu Âu',
  'UEFA Europa League': 'Cúp C2 Châu Âu',
  'UEFA Conference League': 'Cúp C3 Châu Âu',
  'UEFA Nations League': 'Nations League Châu Âu',
  'AFC Champions League Elite': 'Cúp C1 Châu Á',
  'AFC Champions League Two': 'Cúp C2 Châu Á',
  'AFC Asian Cup': 'Cúp Châu Á (Asian Cup)',
  'CONMEBOL Libertadores': 'Cúp C1 Nam Mỹ (Libertadores)',
  'CONMEBOL Sudamericana': 'Cúp C2 Nam Mỹ (Sudamericana)',
  'World Cup': 'Giải Vô Địch Thế Giới (World Cup)',
  'Club World Cup': 'Giải VĐQG Thế Giới Các CLB',
  'Friendlies': 'Giao Hữu Quốc Tế',
  'Club Friendly': 'Giao Hữu CLB',

  'Premier League': 'Ngoại Hạng Anh',
  'Championship': 'Hạng Nhất Anh',
  'League One': 'Hạng Hai Anh',
  'League Two': 'Hạng Ba Anh',
  'FA Cup': 'Cúp FA',
  'EFL Cup': 'Cúp Liên Đoàn Anh',

  'LaLiga': 'VĐQG Tây Ban Nha',
  'LaLiga 2': 'Hạng 2 Tây Ban Nha',
  'Copa del Rey': 'Cúp Nhà Vua Tây Ban Nha',

  'Serie A': 'VĐQG Ý',
  'Serie B': 'Hạng 2 Ý',
  'Serie C': 'Hạng 3 Ý (Serie C)',
  'Coppa Italia': 'Cúp Quốc Gia Ý',

  'Bundesliga': 'VĐQG Đức',
  '2. Bundesliga': 'Hạng 2 Đức',
  'DFB Pokal': 'Cúp Quốc Gia Đức',

  'Ligue 1': 'VĐQG Pháp',
  'Ligue 2': 'Hạng 2 Pháp',
  'Coupe de France': 'Cúp Quốc Gia Pháp',

  'J1 League': 'VĐQG Nhật Bản',
  'J2 League': 'Hạng 2 Nhật Bản',
  'J3 League': 'Hạng 3 Nhật Bản',
  'K League 1': 'VĐQG Hàn Quốc',
  'K League 2': 'Hạng 2 Hàn Quốc',
  'V-League 1': 'V-League Việt Nam',
  'Thai League 1': 'VĐQG Thái Lan',
  'Super League': 'VĐQG Trung Quốc'
};

function parseLeagueName(item, source) {
  if (!item) return 'Bóng Đá Quốc Tế';

  let category = '';
  let tournament = '';

  if (source === 'sofascore') {
    category = item.tournament?.category?.name || item.category?.name || '';
    tournament = item.tournament?.name || item.competitionName || '';
  } else {
    category = item._inheritedCategory || item.Cnm || item.categoryName || '';
    tournament = item._inheritedTournament || item.Snm || item.tournamentName || item.Tname || '';
  }

  if (LEAGUE_NAME_MAP[tournament]) {
    return LEAGUE_NAME_MAP[tournament];
  }

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
    return `${translatedTournament} (${translatedCategory})`.trim();
  }

  return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}

// ==========================================
// 2. BỘ LỌC THÔNG MINH
// ==========================================
function isFilteredLeague(leagueName, homeName, awayName) {
  const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
  
  const youthRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;
  if (youthRegex.test(textToTest)) return true;

  const filterKeywords = ['simulated', 'srl', 'esports', 'e-soccer'];
  return filterKeywords.some(kw => textToTest.includes(kw));
}

// ==========================================
// 3. TÍNH PHÚT TRẬN ĐẤU
// ==========================================
function calculateExactMinute(item, source) {
  if (!item) return 0;

  let statusType = '';
  let statusDesc = '';

  if (source === 'sofascore') {
    statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft')) return 999;
    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht') return 'HT';

    if (item.time && typeof item.time.played === 'number' && item.time.played > 0) {
      return item.time.played;
    }
  } else {
    if (typeof item.Tm === 'number' && item.Tm > 0) return item.Tm;
    if (typeof item.time === 'number' && item.time > 0) return item.time;
    if (typeof item.minute === 'number' && item.minute > 0) return item.minute;

    const rawStatusTexts = [
      item.Eps,
      item.status,
      item.matchStatus,
      item.statusText,
      item.statusDescription,
      item.Reason
    ];

    for (const rawText of rawStatusTexts) {
      if (!rawText) continue;
      const textStr = String(rawText).trim().toUpperCase();

      if (textStr.includes('FT') || textStr.includes('AET') || textStr.includes('PEN') || textStr.includes('FINISHED')) return 999;
      if (textStr.includes('HT') || textStr === '10' || textStr.includes('HALF TIME')) return 'HT';

      const matchNum = textStr.match(/(\d+)/);
      if (matchNum) {
        const val = parseInt(matchNum[1], 10);
        if (val > 0 && val <= 120) {
          return val;
        }
      }
    }
  }

  return 0;
}

// ==========================================
// 4. LẤY DỮ LIỆU KÉP (XOAY VÒNG KEY)
// ==========================================
async function fetchLiveMatchesDualSource() {
  const activeKey = getNextRapidApiKey();

  try {
    const response = await axios.get(SOFASCORE_LIVE_URL, {
      headers: {
        'x-rapidapi-key': activeKey,
        'x-rapidapi-host': SOFASCORE_HOST
      },
      timeout: 10000
    });
    const events = response.data?.events || response.data?.liveEvents || [];
    if (events.length > 0) {
      console.log(`[Source: SofaScore] ✅ Lấy thành công ${events.length} trận live.`);
      return { source: 'sofascore', matches: events };
    }
  } catch (err) {
    console.warn(`⚠️ [SofaScore Error]: ${err.message} -> Đang chuyển sang nguồn dự phòng Livescore6...`);
  }

  try {
    const currentVN = getVietnamTime();
    const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
    const dateUrl = `https://${LIVESCORE_HOST}/matches/v2/list-by-date?Category=soccer&Date=${currentVN.dateStr}&Timezone=-7`;

    const [resLive, resDate] = await Promise.all([
      axios.get(liveUrl, { headers: { 'x-rapidapi-key': activeKey, 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({ data: null })),
      axios.get(dateUrl, { headers: { 'x-rapidapi-key': activeKey, 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({ data: null }))
    ]);

    let rawData = [];
    const seenIds = new Set();

    function processMatchObject(obj, cat = '', tour = '') {
      if (!obj || typeof obj !== 'object') return;

      const matchId = String(obj.Eid || obj.id || obj.MatchId || '');
      const hasTeams = obj.T1 || obj.homeTeam || obj.T2 || obj.AwayTeam || (obj.Home && obj.Away);

      if (matchId && hasTeams && !seenIds.has(matchId)) {
        const eps = String(obj.Eps || obj.status || obj.Trh || obj.MatchStatus || '').toUpperCase();
        const tm = obj.Tm || obj.Minute || obj.time;
        
        const isLiveStatus = eps.includes("'") || eps.includes("LIVE") || eps.includes("1") || eps.includes("IN_PLAY") || (typeof tm === 'number' && tm > 0);

        if (isLiveStatus || (typeof tm === 'number' && tm >= 1 && tm <= 120)) {
          seenIds.add(matchId);
          rawData.push({
            ...obj,
            _inheritedCategory: obj.Cname || obj.categoryName || obj.country || obj.Cnm || cat,
            _inheritedTournament: obj.Snm || obj.Tname || obj.tournamentName || obj.LeagueName || tour
          });
        }
      }

      for (const key of Object.keys(obj)) {
        if (obj[key] !== null && typeof obj[key] === 'object') {
          processMatchObject(
            obj[key], 
            obj.Cname || obj.categoryName || cat, 
            obj.Snm || obj.Tname || tour
          );
        }
      }
    }

    if (resLive && resLive.data) processMatchObject(resLive.data);
    if (resDate && resDate.data) processMatchObject(resDate.data);

    console.log(`[Source: Livescore6 All-Scope] ✅ Quét vét cạn thành công tổng cộng ${rawData.length} trận live.`);
    return { source: 'livescore6', matches: rawData };
  } catch (err) {
    console.error(`❌ [Livescore6 Backup Error]:`, err.message);
    return { source: 'none', matches: [] };
  }
}

// ==========================================
// 5. DIỄN BIẾN BÀN THẮNG
// ==========================================
async function fetchMatchIncidents(matchId, source, homeScore = 0, awayScore = 0) {
  const activeKey = getNextRapidApiKey();

  if (source === 'sofascore') {
    try {
      const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
        headers: {
          'x-rapidapi-key': activeKey,
          'x-rapidapi-host': SOFASCORE_HOST
        },
        timeout: 6000
      });

      const incidents = response.data?.incidents || [];
      const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');

      if (goalEvents.length === 0) {
        const totalGoals = homeScore + awayScore;
        if (totalGoals > 0) {
          return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số hiện tại: ${homeScore}-${awayScore})`;
        }
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
      if (totalGoals > 0) {
        return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;
      }
      return '• Chưa có bàn thắng (Tỷ số: 0-0)';
    }
  } else {
    try {
      const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-incidents?Eid=${matchId}&Category=soccer`, {
        headers: {
          'x-rapidapi-key': activeKey,
          'x-rapidapi-host': LIVESCORE_HOST
        },
        timeout: 6000
      });

      const data = response.data;
      let incidents = [];
      if (Array.isArray(data)) incidents = data;
      else if (data?.incidents) incidents = data.incidents;
      else if (data?.events) incidents = data.events;

      const goalEvents = incidents.filter(inc => {
        const type = String(inc.type || inc.incidentType || '').toLowerCase();
        return type.includes('goal') || type === '1';
      });

      if (goalEvents.length === 0) {
        const totalGoals = homeScore + awayScore;
        if (totalGoals > 0) {
          return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số hiện tại: ${homeScore}-${awayScore})`;
        }
        return '• Chưa có bàn thắng (Tỷ số: 0-0)';
      }

      goalEvents.sort((a, b) => (a.time || a.minute || 0) - (b.time || b.minute || 0));

      const timeline = goalEvents.map(g => {
        const min = g.time || g.minute || 0;
        const player = g.player || g.playerName || g.player?.name || 'Cầu thủ';
        const teamSide = String(g.team || g.homeAway || '').toLowerCase();
        const isHome = teamSide.includes('home') || teamSide === 'h' ? '⚽ [Chủ]' : '⚽ [Khách]';
        const scoreStr = (g.homeScore !== undefined && g.awayScore !== undefined) ? `[${g.homeScore}-${g.awayScore}]` : '';
        return `• Phút ${min}': ${isHome} ${player} ${scoreStr}`;
      });

      return timeline.join('\n');
    } catch (err) {
      const totalGoals = homeScore + awayScore;
      if (totalGoals > 0) {
        return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;
      }
      return '• Chưa có bàn thắng (Tỷ số: 0-0)';
    }
  }
}

// ==========================================
// 6. KÈO ODDS
// ==========================================
async function fetchOddsData() {
  if (!ODDS_API_KEY) return [];
  try {
    const response = await axios.get(ODDS_API_URL, { timeout: 8000 });
    return response.data || [];
  } catch (err) {
    return [];
  }
}

// ==========================================
// 7. THỐNG KÊ CHI TIẾT TRẬN ĐẤU & SMART FALLBACK
// ==========================================
async function fetchMatchDetailStats(matchId, source, matchItem = null) {
  let stats = {
    shotsOnTarget: 0,
    totalShots: 0,
    corners: 0,
    redCards: 0,
    dangerousAttacks: 0,
    attacks: 0,
    possession: null
  };

  if (matchItem) {
    function scanObjectInline(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        const kLower = key.toLowerCase();
        if (typeof val === 'number' || (typeof val === 'string' && !isNaN(val))) {
          const num = parseInt(val, 10);
          if (kLower.includes('shotontarget') || kLower.includes('sot')) stats.shotsOnTarget = Math.max(stats.shotsOnTarget, num);
          if (kLower.includes('corner') || kLower.includes('rc')) stats.corners = Math.max(stats.corners, num);
          if (kLower.includes('redcard') || kLower.includes('red')) stats.redCards = Math.max(stats.redCards, num);
          if (kLower.includes('totalshot') || kLower.includes('shots')) stats.totalShots = Math.max(stats.totalShots, num);
        } else if (typeof val === 'object') {
          scanObjectInline(val);
        }
      }
    }
    scanObjectInline(matchItem);
  }

  const activeKey = getNextRapidApiKey();

  if (source === 'sofascore') {
    try {
      const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
        headers: {
          'x-rapidapi-key': activeKey,
          'x-rapidapi-host': SOFASCORE_HOST
        },
        timeout: 6000
      });

      let shotsOnTarget = stats.shotsOnTarget, corners = stats.corners, redCards = stats.redCards, totalShots = stats.totalShots, shotsOffTarget = 0, blockedShots = 0;
      let dangerousAttacks = stats.dangerousAttacks, attacks = stats.attacks;
      let possessionHome = null, possessionAway = null;
      
      const statistics = response.data?.statistics;

      if (Array.isArray(statistics)) {
        statistics.forEach(period => {
          const groups = period.groups || [];
          groups.forEach(group => {
            const items = group.statisticsItems || [];
            items.forEach(st => {
              const name = String(st.name || st.slug || '').toLowerCase();
              const homeVal = parseInt(st.home, 10);
              const awayVal = parseInt(st.away, 10);
              const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

              if (name.includes('shots on target') || name.includes('sút trúng đích')) {
                shotsOnTarget = Math.max(shotsOnTarget, sumVal);
              } else if (name.includes('shots off target') || name.includes('sút ra ngoài')) {
                shotsOffTarget = Math.max(shotsOffTarget, sumVal);
              } else if (name.includes('blocked shots') || name.includes('sút bị cản')) {
                blockedShots = Math.max(blockedShots, sumVal);
              } else if (name.includes('total shots') || name.includes('tổng số cú sút')) {
                totalShots = Math.max(totalShots, sumVal);
              } else if (name.includes('corner') || name.includes('phạt góc')) {
                corners = Math.max(corners, sumVal);
              } else if (name.includes('red card') || name.includes('thẻ đỏ')) {
                redCards = Math.max(redCards, sumVal);
              } else if (name.includes('dangerous attacks') || name.includes('tấn công nguy hiểm')) {
                dangerousAttacks = Math.max(dangerousAttacks, sumVal);
              } else if (name.includes('attacks') || name.includes('tấn công')) {
                attacks = Math.max(attacks, sumVal);
              } else if (name.includes('ball possession') || name.includes('possession') || name.includes('kiểm soát bóng')) {
                if (!isNaN(homeVal) && !isNaN(awayVal)) {
                  possessionHome = homeVal;
                  possessionAway = awayVal;
                }
              }
            });
          });
        });
      }

      let possessionStr = null;
      if (possessionHome !== null && possessionAway !== null) {
        possessionStr = `${possessionHome}% - ${possessionAway}%`;
      }

      stats = { 
        shotsOnTarget, 
        totalShots: totalShots || (shotsOnTarget + shotsOffTarget + blockedShots), 
        shotsOffTarget,
        blockedShots,
        corners, 
        redCards,
        dangerousAttacks,
        attacks,
        possession: possessionStr
      };
    } catch (err) {}
  } else {
    try {
      const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${matchId}`, {
        headers: {
          'x-rapidapi-key': activeKey,
          'x-rapidapi-host': LIVESCORE_HOST
        },
        timeout: 6000
      });

      let shotsOnTarget = stats.shotsOnTarget, corners = stats.corners, redCards = stats.redCards, totalShots = stats.totalShots, dangerousAttacks = stats.dangerousAttacks, attacks = stats.attacks;
      let possessionHome = null, possessionAway = null;
      
      const statsData = response.data;

      function extractStatsRecursive(obj) {
        if (!obj || typeof obj !== 'object') return;

        if (Array.isArray(obj)) {
          obj.forEach(item => extractStatsRecursive(item));
          return;
        }

        const name = String(obj.name || obj.type || obj.title || obj.Key || '').toLowerCase();
        const homeVal = parseInt(obj.home || obj.homeValue || obj.Value1 || obj.H, 10);
        const awayVal = parseInt(obj.away || obj.awayValue || obj.Value2 || obj.A, 10);

        if (name && (!isNaN(homeVal) || !isNaN(awayVal))) {
          const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

          if (name.includes('shot on target') || name.includes('sút trúng đích')) {
            shotsOnTarget = Math.max(shotsOnTarget, sumVal);
          } else if (name.includes('total shot') || name.includes('tổng cú sút')) {
            totalShots = Math.max(totalShots, sumVal);
          } else if (name.includes('corner') || name.includes('phạt góc')) {
            corners = Math.max(corners, sumVal);
          } else if (name.includes('red card') || name.includes('thẻ đỏ')) {
            redCards = Math.max(redCards, sumVal);
          } else if (name.includes('dangerous attack') || name.includes('tấn công nguy hiểm')) {
            dangerousAttacks = Math.max(dangerousAttacks, sumVal);
          } else if (name.includes('attack') || name.includes('tấn công')) {
            attacks = Math.max(attacks, sumVal);
          } else if (name.includes('possession') || name.includes('kiểm soát')) {
            if (!isNaN(homeVal) && !isNaN(awayVal)) {
              possessionHome = homeVal;
              possessionAway = awayVal;
            }
          }
        }

        Object.keys(obj).forEach(key => {
          if (obj[key] && typeof obj[key] === 'object') {
            extractStatsRecursive(obj[key]);
          }
        });
      }

      extractStatsRecursive(statsData);

      let possessionStr = null;
      if (possessionHome !== null && possessionAway !== null) {
        possessionStr = `${possessionHome}% - ${possessionAway}%`;
      }

      stats = { 
        shotsOnTarget, 
        totalShots: totalShots || shotsOnTarget, 
        corners, 
        redCards,
        dangerousAttacks,
        attacks,
        possession: possessionStr
      };
    } catch (err) {}
  }

  return { sofaStats: stats };
}

function cleanTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

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

// ==========================================
// 8. THUẬT TOÁN AI, ĐỌC VỊ & SMART FALLBACK
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis, matchInfo) {
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
        aiPercentage += 18.0;
        matchAnalysis.push(` └─> Thế trận áp đảo cực mạnh (${maxPoss}%)`);
        hasTacticalData = true;
      } else if (maxPoss >= 60) {
        aiPercentage += 12.0;
        matchAnalysis.push(` └─> Thế trận lấn lướt (${maxPoss}%)`);
        hasTacticalData = true;
      }
    }
  }

  if (stats.dangerousAttacks >= 30) {
    aiPercentage += 15.0;
    matchAnalysis.push(`⚡ Tấn công nguy hiểm dồn dập: ${stats.dangerousAttacks} lần`);
    hasTacticalData = true;
  }

  if (stats.redCards > 0) {
    aiPercentage += 15.0;
    matchAnalysis.push(`🟥 Thẻ đỏ xuất hiện (${stats.redCards} thẻ)`);
    hasTacticalData = true;
  }

  if (stats.shotsOnTarget >= 2) {
    aiPercentage += (stats.shotsOnTarget >= 4 ? 16.0 : 8.0);
    matchAnalysis.push(`🎯 Sút trúng đích: ${stats.shotsOnTarget} lần`);
    hasTacticalData = true;
  }

  if (stats.totalShots >= 8) {
    aiPercentage += 10.0;
    matchAnalysis.push(`⚽ Tổng sút: ${stats.totalShots} lần`);
    hasTacticalData = true;
  }

  if (stats.corners >= 4) {
    aiPercentage += 8.0;
    matchAnalysis.push(`🚩 Phạt góc: ${stats.corners} quả`);
    hasTacticalData = true;
  }

  if (oddsAnalysis) {
    aiPercentage += oddsAnalysis.oddsBonus;
    matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line}`);
    hasTacticalData = true;
  }

  // --- SMART FALLBACK CHO CÁC GIẢI HẠNG DƯỚI / SERIE C KHÔNG CÓ THỐNG KÊ SÚT/GÓC ---
  const currentElapsed = matchInfo.elapsed;
  const currentHome = matchInfo.homeScore;
  const currentAway = matchInfo.awayScore;
  const totalCurrentGoals = currentHome + currentAway;

  if (!hasTacticalData && currentElapsed >= 60) {
    if (totalCurrentGoals === 0 || Math.abs(currentHome - currentAway) === 1) {
      aiPercentage += 28.0; // Bổ sung điểm dự phòng thông minh dựa vào thời điểm và tỷ số sát nút
      matchAnalysis.push(`🛡️ [Smart Fallback]: Kích hoạt phân tích dự phòng (Phút ${currentElapsed}', Tỷ số ${currentHome}-${currentAway}) - Thế trận nhạy cảm Rung`);
      hasTacticalData = true;
    }
  }

  const finalPercentage = Math.min(aiPercentage, 98.0).toFixed(1);
  const MIN_SEND_PERCENTAGE = 60.0;
  const shouldSend = parseFloat(finalPercentage) >= MIN_SEND_PERCENTAGE && hasTacticalData;

  let predictionText = '';
  if (shouldSend && matchInfo) {
    if (totalCurrentGoals === 0) {
      predictionText = `🔮 [Đọc vị Rung]: Trận đấu 0-0 ở phút ${currentElapsed}'. Thế trận ép sân mạnh -> Dự đoán nổ ít nhất 1-2 bàn, khả năng kết thúc với tỷ số chung cuộc <b>1-1 hoặc 2-0</b>.`;
    } else if (Math.abs(currentHome - currentAway) === 1) {
      predictionText = `🔮 [Đọc vị Rung]: Thế trận giằng co sát nút -> Dự đoán có thêm bàn thắng, tỷ số chung cuộc khả năng dịch chuyển sang <b>${currentHome + 1}-${currentAway}</b> hoặc <b>${currentHome}-${currentAway + 1}</b>.`;
    } else {
      predictionText = `🔮 [Đọc vị Rung]: Khoảng cách an toàn nhưng nhịp độ tấn công không giảm -> Dự đoán sẽ có thêm bàn thắng muộn.`;
    }
  }

  return {
    efficiency: finalPercentage,
    detailText: matchAnalysis.length > 0 ? matchAnalysis.map(t => `• ${t}`).join('\n') : '• Đang cập nhật diễn biến trực tiếp',
    predictionText,
    shouldSend
  };
}

// ==========================================
// 9. THÔNG BÁO TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
  const timeDisplay = `Phút ${item.elapsed}'`;
  const message = 
`🔔 RUNG CHUỔNG VÀNGGGG (${item.source.toUpperCase()})
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: ${timeDisplay}

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

${item.predictionText}

🎯 Nhận định: Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG
📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log(` └─> [Telegram Success] Đã gửi thông báo: ${item.homeName} vs ${item.awayName} (${item.ruleEfficiency}%)`);
    sentAlerts.add(item.id);
  } catch (err) {
    console.error(' └─> [Telegram Error]:', err.message);
  }
}

// ==========================================
// 10. TIẾN TRÌNH QUÉT TỰ ĐỘNG
// ==========================================
async function scanLiveMatches() {
  const currentVN = getVietnamTime();
  console.log(`\n==================================================`);
  console.log(`[Auto-Scan AI Dual-Source] Đang quét trận đấu... (${currentVN.timeStr})`);

  try {
    const [allOdds, liveResult] = await Promise.all([
      fetchOddsData(),
      fetchLiveMatchesDualSource()
    ]);

    const { source, matches } = liveResult;
    if (matches.length === 0) {
      console.log(`[Thông báo]: Không thu thập được trận đấu nào từ cả SofaScore và Livescore6.`);
      return;
    }

    for (let index = 0; index < matches.length; index++) {
      const item = matches[index];
      
      let matchId, homeName, awayName, homeScore, actualAwayScore;

      if (source === 'sofascore') {
        matchId = String(item.id);
        homeName = item.homeTeam?.name || 'Đội nhà';
        awayName = item.awayTeam?.name || 'Đội khách';
        homeScore = item.homeScore?.current ?? 0;
        actualAwayScore = item.awayScore?.current ?? 0;
      } else {
        matchId = String(item.Eid || item.id || item.matchId || `ls6_${index}`);
        
        homeName = (item.T1 && item.T1[0] && (item.T1[0].Nm || item.T1[0].Name)) || item.homeTeam?.name || 'Đội nhà';
        awayName = (item.T2 && item.T2[0] && (item.T2[0].Nm || item.T2[0].Name)) || item.awayTeam?.name || 'Đội khách';

        homeScore = parseInt(item.Tr1 ?? item.homeScore ?? item.fs_h ?? 0, 10);
        actualAwayScore = parseInt(item.Tr2 ?? item.awayScore ?? item.fs_a ?? 0, 10);
      }

      if (isNaN(homeScore)) homeScore = 0;
      if (isNaN(actualAwayScore)) actualAwayScore = 0;

      const leagueName = parseLeagueName(item, source);

      if (isFilteredLeague(leagueName, homeName, awayName)) {
        console.log(`[Trận #${index + 1}] [${leagueName}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Giải trẻ/Phụ`);
        continue;
      }

      const elapsed = calculateExactMinute(item, source);
      const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

      if (isNaN(numericElapsed) || numericElapsed < 45 || numericElapsed > 92) {
        const timeLabel = (elapsed === 'HT' || elapsed === 999) ? elapsed : `${elapsed}'`;
        console.log(`[Trận #${index + 1}] [Phút: ${timeLabel}] [${leagueName}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Ngoài khung hiệp 2 (45-92') hoặc HT`);
        continue;
      }

      if (sentAlerts.has(matchId)) {
        console.log(`[Trận #${index + 1}] [ID: ${matchId}] └─> [Bỏ qua]: Đã gửi cảnh báo trận này trước đó.`);
        continue;
      }

      console.log(`[Đang Phân Tích (${source.toUpperCase()})] [ID: ${matchId}] [Phút: ${numericElapsed}'] [${leagueName}] ${homeName} ${homeScore}-${actualAwayScore} ${awayName}`);

      const metrics = await fetchMatchDetailStats(matchId, source, item);
      const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);
      
      const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis, {
        elapsed: numericElapsed,
        homeScore,
        awayScore: actualAwayScore
      });

      console.log(` 📊 [Chi tiết thế trận & Chỉ số]:`);
      console.log(aiAnalysis.detailText.split('\n').map(line => ` ${line}`).join('\n'));
      console.log(` 🎯 [Đọc vị tạm tính] -> Hiệu suất Rule: ${aiAnalysis.efficiency}%`);

      if (aiAnalysis.shouldSend) {
        const goalTimeline = await fetchMatchIncidents(matchId, source, homeScore, actualAwayScore);
        console.log(` ✅ [ĐẠT CHUẨN GỬI TELEGRAM] (${aiAnalysis.efficiency}%)`);

        const pickItem = {
          id: matchId,
          source,
          league: leagueName,
          homeName,
          awayName,
          homeScore,
          awayScore: actualAwayScore,
          elapsed: numericElapsed,
          goalTimeline,
          detailText: aiAnalysis.detailText,
          predictionText: aiAnalysis.predictionText,
          ruleEfficiency: aiAnalysis.efficiency
        };
        await sendTelegramAlert(pickItem);
      } else {
        console.log(` ❌ [Bỏ qua gửi Telegram]: Điểm AI chưa đạt ngưỡng yêu cầu >= 60%`);
      }
    }
  } catch (err) {
    console.error(`[API Fetch Error]:`, err.message);
  }
}

// ==========================================
// 11. KHỞI CHẠY SERVER EXPRESS
// ==========================================
app.get('/', (req, res) => {
  res.send('Football Dual-Source AI Scanner Service is Running!');
});

app.listen(PORT, () => {
  console.log(`==> Server running on port ${PORT}`);
  scanLiveMatches();
  setInterval(scanLiveMatches, 7 * 60 * 1000);
});