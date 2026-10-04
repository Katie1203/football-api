const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ==========================================
// CẤU HÌNH HỆ THỐNG & TELEGRAM
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';
const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';

// Nguồn 1: SofaScore API
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

// Nguồn 2: Livescore6 API
const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

// Nguồn Odds API
const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

const sentAlerts = new Set();

function getVietnamTime() {
 const now = new Date();
 const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
 return { timeStr: vnTime.toISOString().slice(11, 19) };
}

// ==========================================
// 1. DỊCH QUỐC GIA & GIẢI ĐẤU (VIỆT HÓA CHUẨN)
// ==========================================
const COUNTRY_MAP = {
 'England': 'Anh', 'Spain': 'Tây Ban Nha', 'Italy': 'Ý', 'Germany': 'Đức',
 'France': 'Pháp', 'Japan': 'Nhật Bản', 'South Korea': 'Hàn Quốc', 'Vietnam': 'Việt Nam',
 'Brazil': 'Brazil', 'Argentina': 'Argentina', 'Netherlands': 'Hà Lan', 'Portugal': 'Bồ Đào Nha',
 'Turkey': 'Thổ Nhĩ Kỳ', 'Saudi Arabia': 'Ả Rập Xê Út', 'China': 'Trung Quốc', 'Thailand': 'Thái Lan',
 'Australia': 'Úc', 'USA': 'Mỹ', 'Norway': 'Na Uy', 'Denmark': 'Đan Mạch', 'World': 'Quốc Tế'
};

const LEAGUE_NAME_MAP = {
 'UEFA Champions League': 'Cúp C1 Châu Âu', 'UEFA Europa League': 'Cúp C2 Châu Âu',
 'Premier League': 'Ngoại Hạng Anh', 'Championship': 'Hạng Nhất Anh',
 'LaLiga': 'VĐQG Tây Ban Nha', 'Serie A': 'VĐQG Ý', 'Bundesliga': 'VĐQG Đức',
 'Ligue 1': 'VĐQG Pháp', 'J1 League': 'VĐQG Nhật Bản', 'K League 1': 'VĐQG Hàn Quốc',
 'V-League 1': 'V-League Việt Nam'
};

function parseLeagueName(item, source) {
 if (!item) return 'Bóng Đá Quốc Tế';
 let category = '', tournament = '';

 if (source === 'sofascore') {
 category = item.tournament?.category?.name || item.category?.name || '';
 tournament = item.tournament?.name || item.competitionName || '';
 } else {
 category = item._inheritedCategory || item.Cnm || item.categoryName || '';
 tournament = item._inheritedTournament || item.Snm || item.tournamentName || item.Tname || '';
 }

 if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];
 const translatedCategory = COUNTRY_MAP[category] || category;
 let translatedTournament = tournament
 .replace(/\bPremier League\b/gi, 'Giải VĐQG')
 .replace(/\bSuper League\b/gi, 'VĐQG')
 .replace(/\bCup\b/gi, 'Cúp');

 if (translatedCategory && translatedTournament) {
 if (translatedTournament.toLowerCase().includes(translatedCategory.toLowerCase())) return translatedTournament;
 return `${translatedTournament} (${translatedCategory})`.trim();
 }
 return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}

// ==========================================
// 2. BỘ LỌC THÔNG MINH (LOẠI BỎ GIẢI TRẺ & BÓNG ĐÁ ẢO)
// ==========================================
function isFilteredLeague(leagueName, homeName, awayName) {
 const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
 const youthRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;
 if (youthRegex.test(textToTest)) return true;

 const filterKeywords = ['simulated', 'srl', 'esports', 'e-soccer', 'women', 'nữ'];
 // Có thể linh hoạt tắt từ khóa 'women' nếu bạn muốn bắt cả bóng đá nữ. Hiện tại giữ nguyên chuẩn lọc an toàn.
 return filterKeywords.some(kw => textToTest.includes(kw));
}

// ==========================================
// 3. XỬ LÝ PHÚT THI ĐẤU TRỰC TIẾP
// ==========================================
function calculateExactMinute(item, source) {
 if (!item) return 0;

 if (source === 'sofascore') {
 const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
 const statusDesc = String(item.status?.description || '').toLowerCase();

 if (statusType.includes('ended') || statusDesc.includes('ft')) return 999;
 if (statusType.includes('halftime') || statusDesc.includes('ht')) return 'HT';

 if (typeof item.time?.current === 'number' && item.time.current > 0) return item.time.current;
 if (typeof item.time?.played === 'number' && item.time.played > 0) return item.time.played;
 if (typeof item.minute === 'number' && item.minute > 0) return item.minute;
 } 

 const possibleMinuteFields = [item.Tm, item.minute, item.Minute, item.time, item.MatchTime];
 for (const val of possibleMinuteFields) {
 if (typeof val === 'number' && val > 0 && val <= 120) return val;
 if (typeof val === 'string' && !isNaN(val)) {
 const parsed = parseInt(val, 10);
 if (parsed > 0 && parsed <= 120) return parsed;
 }
 }

 const rawStatusTexts = [item.Eps, item.status, item.matchStatus, item.statusText];
 for (const rawText of rawStatusTexts) {
 if (!rawText) continue;
 const textStr = String(rawText).trim().toUpperCase();
 if (textStr.includes('FT')) return 999;
 if (textStr.includes('HT')) return 'HT';

 const matchNum = textStr.match(/(\d+)/);
 if (matchNum) {
 const val = parseInt(matchNum[1], 10);
 if (val > 0 && val <= 120) return val;
 }
 }
 return 0;
}

// ==========================================
// 4. QUÉT DANH SÁCH LIVE (DUAL-SOURCE)
// ==========================================
async function fetchLiveMatchesDualSource() {
 try {
 const response = await axios.get(SOFASCORE_LIVE_URL, {
 headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
 timeout: 10000
 });
 const events = response.data?.events || response.data?.liveEvents || [];
 if (events.length > 0) return { source: 'sofascore', matches: events };
 } catch (err) {
 console.warn(`⚠️ [SofaScore Error]: Chuyển sang nguồn Livescore6 dự phòng...`);
 }

 try {
 const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
 const resLive = await axios.get(liveUrl, { 
 headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, 
 timeout: 10000 
 });

 let rawData = [];
 const dataObj = resLive.data;
 let matchGroups = [];

 if (Array.isArray(dataObj)) matchGroups = dataObj;
 else if (dataObj?.Stages) matchGroups = dataObj.Stages;
 else if (dataObj?.events) matchGroups = dataObj.events;
 else if (dataObj?.matchList) matchGroups = dataObj.matchList;
 else {
 const foundKey = Object.keys(dataObj || {}).find(k => Array.isArray(dataObj[k]));
 if (foundKey) matchGroups = dataObj[foundKey];
 }

 matchGroups.forEach(group => {
 const matchesList = group.Matches || group.matches || group.events || [group];
 if (Array.isArray(matchesList)) {
 matchesList.forEach(m => {
 if (m && typeof m === 'object') {
 const matchId = String(m.Eid || m.id || m.MatchId || '');
 const hasTeams = m.T1 || m.homeTeam || m.T2 || m.AwayTeam;
 if (matchId && hasTeams) {
 const eps = String(m.Eps || m.status || '').toUpperCase();
 const tm = m.Tm || m.Minute || m.time;
 const isLive = eps.includes("'") || eps.includes("LIVE") || eps.includes("IN_PLAY") || (typeof tm === 'number' && tm > 0);
 
 if (isLive) {
 rawData.push({
 ...m,
 _inheritedCategory: group.Cname || group.categoryName || group.Cnm || '',
 _inheritedTournament: group.Snm || group.Tname || group.tournamentName || ''
 });
 }
 }
 }
 });
 }
 });

 return { source: 'livescore6', matches: rawData };
 } catch (err) {
 console.error(`❌ [Livescore6 Error]:`, err.message);
 return { source: 'none', matches: [] };
 }
}

// ==========================================
// 5. THỐNG KÊ CHI TIẾT & DIỄN BIẾN BÀN THẮNG
// ==========================================
async function fetchMatchIncidents(matchId, source, homeScore = 0, awayScore = 0) {
 try {
 const url = source === 'sofascore' 
 ? `https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`
 : `https://${LIVESCORE_HOST}/matches/v2/get-incidents?Eid=${matchId}&Category=soccer`;

 const response = await axios.get(url, {
 headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': source === 'sofascore' ? SOFASCORE_HOST : LIVESCORE_HOST },
 timeout: 6000
 });

 const data = response.data;
 let incidents = data?.incidents || (Array.isArray(data) ? data : data?.events) || [];
 const goalEvents = incidents.filter(inc => {
 const type = String(inc.incidentType || inc.type || '').toLowerCase();
 return type.includes('goal') || type === '1';
 });

 if (goalEvents.length === 0) {
 const totalGoals = homeScore + awayScore;
 return totalGoals > 0 ? `• Tỷ số hiện tại: ${homeScore}-${awayScore}` : '• Chưa có bàn thắng (0-0)';
 }

 goalEvents.sort((a, b) => (a.time || a.minute || 0) - (b.time || b.minute || 0));
 return goalEvents.map(g => {
 const min = g.time || g.minute || 0;
 const player = g.player?.shortName || g.player?.name || 'Cầu thủ';
 const isHome = (g.isHome !== undefined ? g.isHome : (String(g.team || '').toLowerCase().includes('home'))) ? '⚽ [Chủ]' : '⚽ [Khách]';
 const scoreStr = (g.homeScore !== undefined && g.awayScore !== undefined) ? `[${g.homeScore}-${g.awayScore}]` : '';
 return `• Phút ${min}': ${isHome} ${player} ${scoreStr}`;
 }).join('\n');
 } catch (err) {
 const totalGoals = homeScore + awayScore;
 return totalGoals > 0 ? `• Tỷ số hiện tại: ${homeScore}-${awayScore}` : '• Chưa có bàn thắng (0-0)';
 }
}

async function fetchOddsData() {
 if (!ODDS_API_KEY) return [];
 try {
 const response = await axios.get(ODDS_API_URL, { timeout: 8000 });
 return response.data || [];
 } catch (err) {
 return [];
 }
}

async function fetchMatchDetailStats(matchId, source) {
 try {
 const url = source === 'sofascore'
 ? `https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`
 : `https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${matchId}`;

 const response = await axios.get(url, {
 headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': source === 'sofascore' ? SOFASCORE_HOST : LIVESCORE_HOST },
 timeout: 6000
 });

 let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
 let possessionHome = null, possessionAway = null;
 let statList = response.data?.statistics || response.data?.stats || (Array.isArray(response.data) ? response.data : []);

 if (Array.isArray(statList)) {
 statList.forEach(st => {
 const groups = st.groups || [st];
 groups.forEach(g => {
 const items = g.statisticsItems || [g];
 items.forEach(item => {
 const name = String(item.name || item.slug || item.type || '').toLowerCase();
 const homeVal = parseInt(item.home || item.homeValue, 10);
 const awayVal = parseInt(item.away || item.awayValue, 10);
 const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

 if (name.includes('shot on target')) shotsOnTarget = Math.max(shotsOnTarget, sumVal);
 if (name.includes('total shot')) totalShots = Math.max(totalShots, sumVal);
 if (name.includes('corner')) corners = Math.max(corners, sumVal);
 if (name.includes('red card')) redCards = Math.max(redCards, sumVal);
 if (name.includes('possession') && !isNaN(homeVal) && !isNaN(awayVal)) {
 possessionHome = homeVal;
 possessionAway = awayVal;
 }
 });
 });
 });
 }

 return {
 sofaStats: {
 shotsOnTarget,
 totalShots: totalShots || shotsOnTarget,
 corners,
 redCards,
 possession: (possessionHome !== null && possessionAway !== null) ? `${possessionHome}% - ${possessionAway}%` : null
 }
 };
 } catch (err) {
 return { sofaStats: { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0, possession: null } };
 }
}

function cleanTeamName(name) {
 return String(name || '').toLowerCase().replace(/\b(fc|cf|club|sc|sv|ac|afc)\b/g, '').replace(/[^a-z0-9]/g, '').trim();
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
 const overLine = overOutcome.point;
 const price = overOutcome.price;
 const pointDiff = overLine - currentTotalGoals;

 if (pointDiff >= 0.75) oddsBonus += 16.0;
 else if (pointDiff > 0) oddsBonus += 10.0;

 if (price <= 1.40) oddsBonus += 18.0;
 else if (price <= 1.60) oddsBonus += 13.0;

 return { bookmaker: foundMatch.bookmakers[0].title, line: overLine, odds: price, oddsBonus };
}

// ==========================================
// 6. THUẬT TOÁN ĐÁNH GIÁ AI & TELEGRAM ALERT
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
 let matchAnalysis = [];
 let aiPercentage = 35.0;
 const stats = metrics.sofaStats || {};
 let hasTacticalData = false;

 if (stats.possession) {
 matchAnalysis.push(`📊 Kiểm soát bóng: ${stats.possession}`);
 hasTacticalData = true;
 }
 if (stats.redCards > 0) {
 aiPercentage += 15.0;
 matchAnalysis.push(`🟥 Thẻ đỏ: ${stats.redCards}`);
 hasTacticalData = true;
 }
 if (stats.shotsOnTarget >= 4) {
 aiPercentage += 12.0;
 matchAnalysis.push(`🎯 Sút trúng đích: ${stats.shotsOnTarget}`);
 hasTacticalData = true;
 }
 if (stats.corners >= 4) {
 aiPercentage += 6.0;
 matchAnalysis.push(`🚩 Phạt góc: ${stats.corners}`);
 hasTacticalData = true;
 }
 if (oddsAnalysis) {
 aiPercentage += oddsAnalysis.oddsBonus;
 matchAnalysis.push(`💰 Kèo Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
 hasTacticalData = true;
 }

 const finalPercentage = Math.min(aiPercentage, 98.0).toFixed(1);
 const shouldSend = parseFloat(finalPercentage) > 60.0 && hasTacticalData;

 return { efficiency: finalPercentage, detailText: matchAnalysis.map(t => `• ${t}`).join('\n'), shouldSend };
}

async function sendTelegramAlert(item) {
 const message = 
`🔔 RUNG CHUỔNG VÀNGGGG (${item.source.toUpperCase()})
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Phút: ${item.elapsed}'

⚽ DIỄN BIẾN:
${item.goalTimeline}

📊 THẾ TRẬN:
${item.detailText}

📈 Hiệu suất: ${item.ruleEfficiency}%`;

 try {
 await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: message });
 sentAlerts.add(item.id);
 } catch (err) {
 console.error('Telegram Error:', err.message);
 }
}

// ==========================================
// 7. HÀM QUÉT CHÍNH (CHỈ LẤY PHÚT 46 -> 92)
// ==========================================
async function scanLiveMatches() {
 const currentVN = getVietnamTime();
 console.log(`\n[Auto-Scan AI] Đang quét trực tiếp các trận hiệp 2... (${currentVN.timeStr})`);

 try {
 const [allOdds, liveResult] = await Promise.all([fetchOddsData(), fetchLiveMatchesDualSource()]);
 const { source, matches } = liveResult;
 if (!matches || matches.length === 0) {
 console.log(`[Thông báo]: Không tìm thấy trận Live nào.`);
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
 matchId = String(item.Eid || item.id || `ls6_${index}`);
 homeName = (item.T1 && item.T1[0] && (item.T1[0].Nm || item.T1[0].Name)) || 'Đội nhà';
 awayName = (item.T2 && item.T2[0] && (item.T2[0].Nm || item.T2[0].Name)) || 'Đội khách';
 homeScore = parseInt(item.Tr1 ?? 0, 10);
 actualAwayScore = parseInt(item.Tr2 ?? 0, 10);
 }

 const leagueName = parseLeagueName(item, source);
 if (isFilteredLeague(leagueName, homeName, awayName)) continue;

 const elapsed = calculateExactMinute(item, source);
 const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

 // LỌC CHÍNH XÁC CÁC TRẬN TỪ PHÚT 46 ĐẾN 92
 if (isNaN(numericElapsed) || numericElapsed < 46 || numericElapsed > 92) continue;

 console.log(`[Phân Tích] [Phút: ${numericElapsed}'] [${leagueName}] ${homeName} vs ${awayName}`);

 const metrics = await fetchMatchDetailStats(matchId, source);
 const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);
 const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis);

 if (aiAnalysis.shouldSend && !sentAlerts.has(matchId)) {
 const goalTimeline = await fetchMatchIncidents(matchId, source, homeScore, actualAwayScore);
 await sendTelegramAlert({
 id: matchId, source, league: leagueName, homeName, awayName,
 homeScore, awayScore: actualAwayScore, elapsed: numericElapsed,
 goalTimeline, detailText: aiAnalysis.detailText, ruleEfficiency: aiAnalysis.efficiency
 });
 }
 }
 } catch (err) {
 console.error(`[Scan Error]:`, err.message);
 }
}

app.get('/', (req, res) => {
 res.send('Football Dual-Source AI Scanner Service is Running!');
});

app.listen(PORT, () => {
 console.log(`==> Server running on port ${PORT}`);
 scanLiveMatches();
 setInterval(scanLiveMatches, 7 * 60 * 1000); // Quét lại mỗi 5 phút
});