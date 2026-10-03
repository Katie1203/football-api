const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
// Đổi sang endpoint tổng để quét toàn bộ trận live trên thế giới
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/sport/football/events/live`;
const RAPIDAPI_HOST = 'free-api-live-football-data.p.rapidapi.com';

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
    'World': 'Quốc Tế',
    'Europe': 'Châu Âu',
    'Asia': 'Châu Á',
    'South America': 'Nam Mỹ',
    'Africa': 'Châu Phi'
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
    'LaLiga': 'VĐQG Tây Ban Nha',
    'Serie A': 'VĐQG Ý',
    'Bundesliga': 'VĐQG Đức',
    'Ligue 1': 'VĐQG Pháp',
    'J1 League': 'VĐQG Nhật Bản',
    'K League 1': 'VĐQG Hàn Quốc',
    'V-League 1': 'V-League Việt Nam'
};

function parseLeagueName(item) {
    if (!item) return 'Bóng Đá Quốc Tế';
    let category = item.tournament?.category?.name || item.category?.name || '';
    let tournament = item.tournament?.name || item.competitionName || '';
    if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];
    const translatedCategory = COUNTRY_MAP[category] || category;
    return `${tournament} ${translatedCategory}`.trim();
}

function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    const youthUnder19Regex = /\b(u-?1[0-9]|sub-?1[0-9]|under-?1[0-9])\b/i;
    if (youthUnder19Regex.test(textToTest)) return true;

    const filterKeywords = ['academy', 'cadete', 'juvenil', 'juniors', 'junior', 'reserves', 'reserve', 'amateur', 'simulated', 'srl'];
    return filterKeywords.some(kw => textToTest.includes(kw));
}

function calculateExactMinute(item) {
    if (!item) return 0;
    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft') || statusType === 'ft' || statusType === 'aet' || statusType === 'pen') {
        return 999; 
    }
    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht') return 45;

    if (item.time && typeof item.time.played === 'number' && item.time.played > 0) {
        return item.time.played;
    }

    const matchDesc = statusDesc.match(/^(\d+)['\s]?$/);
    if (matchDesc) {
        return parseInt(matchDesc[1], 10);
    }

    if (statusDesc.includes('ft') || statusDesc.includes('ended')) return 999;
    return 0;
}

async function fetchMatchIncidents(matchId, homeScore = 0, awayScore = 0) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 6000
        });
        const incidents = response.data?.incidents || [];
        const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');
        if (goalEvents.length === 0) {
            const totalGoals = homeScore + awayScore;
            return totalGoals > 0 ? `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})` : '• Chưa có bàn thắng (Tỷ số: 0-0)';
        }
        goalEvents.sort((a, b) => (a.time || 0) - (b.time || 0));
        return goalEvents.map(g => {
            const min = g.time || 0;
            const extra = g.addedTime ? `+${g.addedTime}` : '';
            const player = g.player?.shortName || g.player?.name || 'Cầu thủ';
            const isHome = g.isHome ? '⚽ [Chủ]' : '⚽ [Khách]';
            return `• Phút ${min}'${extra}: ${isHome} ${player}`;
        }).join('\n');
    } catch (err) {
        const totalGoals = homeScore + awayScore;
        return totalGoals > 0 ? `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})` : '• Chưa có bàn thắng (Tỷ số: 0-0)';
    }
}

async function fetchOddsData() {
    if (!ODDS_API_KEY) return [];
    try {
        const response = await axios.get(ODDS_API_URL, { timeout: 8000 });
        return response.data || [];
    } catch (err) { return []; }
}

async function fetchSofaScoreLive() {
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 15000
        });
        return response.data?.events || response.data?.liveEvents || [];
    } catch (err) { return []; }
}

async function fetchSofaScoreStats(matchId) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 6000
        });
        const statisticsGroup = response.data?.statistics || [];
        let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
        if (Array.isArray(statisticsGroup) && statisticsGroup.length > 0) {
            const allStats = statisticsGroup[0]?.groups || [];
            allStats.forEach(group => {
                (group.statisticsItems || []).forEach(st => {
                    const name = String(st.name || '').toLowerCase();
                    const val = (parseInt(st.home, 10) || 0) + (parseInt(st.away, 10) || 0);
                    if (name.includes('shots on target')) shotsOnTarget = val;
                    if (name.includes('total shots') || name.includes('shots')) totalShots = val;
                    if (name.includes('corner')) corners = val;
                    if (name.includes('red card')) redCards = val;
                });
            });
        }
        return { shotsOnTarget, totalShots, corners, redCards };
    } catch (err) { return { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0 }; }
}

async function fetchRapidApiMatchStats(matchId) {
    try {
        const response = await axios.get(`https://${RAPIDAPI_HOST}/football-match-get-statistics?matchid=${matchId}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': RAPIDAPI_HOST },
            timeout: 6000
        });
        const statsObj = response.data?.stats || response.data?.statistics || {};
        return {
            rapidShotsTarget: (statsObj.homeShotsOnTarget || 0) + (statsObj.awayShotsOnTarget || 0),
            rapidCorners: (statsObj.homeCorners || 0) + (statsObj.awayCorners || 0)
        };
    } catch (err) { return { rapidShotsTarget: 0, rapidCorners: 0 }; }
}

async function fetchMatchDetailStats(matchId) {
    const [sofaStats, rapidStats] = await Promise.all([
        fetchSofaScoreStats(matchId),
        fetchRapidApiMatchStats(matchId)
    ]);
    return { sofaStats, rapidStats };
}

function cleanTeamName(name) {
    return String(name || '').toLowerCase().replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk)\b/g, '').replace(/[^a-z0-9]/g, '').trim();
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

    let scoreBoost = 0;
    let oddsNotes = [];
    const overLine = overOutcome.point;
    const price = overOutcome.price;
    const pointDiff = overLine - currentTotalGoals;

    if (pointDiff >= 0.75) { scoreBoost += 20; oddsNotes.push(`Line Over giữ mức cao (${overLine})`); }
    else if (pointDiff > 0) { scoreBoost += 10; oddsNotes.push(`Line Over (${overLine}) sát mốc`); }

    if (price <= 1.80) { scoreBoost += 18; oddsNotes.push(`Odds Over giảm sâu (${price})`); }
    else if (price <= 1.95) { scoreBoost += 10; oddsNotes.push(`Odds Over đẹp (${price})`); }

    return { bookmaker: foundMatch.bookmakers[0].title, line: overLine, odds: price, scoreBoost, oddsNoteText: oddsNotes.join(' | ') };
}

function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
    let matchAnalysis = [];
    let aiScore = 35.0; 

    const sofaStats = metrics.sofaStats || { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0 };
    const rapidStats = metrics.rapidStats || { rapidShotsTarget: 0, rapidCorners: 0 };

    const maxShotsTarget = Math.max(sofaStats.shotsOnTarget, rapidStats.rapidShotsTarget);
    const maxCorners = Math.max(sofaStats.corners, rapidStats.rapidCorners);
    const totalShots = sofaStats.totalShots || 0;
    let hasTacticalData = false;

    if (sofaStats.redCards > 0) {
        aiScore += 20;
        matchAnalysis.push(`🟥 Thẻ đỏ (${sofaStats.redCards} thẻ) - Hổng phòng ngự`);
        hasTacticalData = true;
    }

    if (maxShotsTarget >= 5) {
        aiScore += 30;
        matchAnalysis.push(`⚡ Sức ép cực cao: ${maxShotsTarget} sút trúng đích`);
        hasTacticalData = true;
    } else if (maxShotsTarget >= 2) {
        aiScore += 20;
        matchAnalysis.push(`🎯 Sút trúng đích nguy hiểm: ${maxShotsTarget}`);
        hasTacticalData = true;
    } else if (maxShotsTarget === 1) {
        aiScore += 12;
        matchAnalysis.push(`🎯 Sút trúng cầu môn: 1`);
        hasTacticalData = true;
    }

    if (totalShots >= 12) {
        aiScore += 20;
        matchAnalysis.push(`🔥 Đôi công cởi mở: Tổng ${totalShots} cú sút`);
        hasTacticalData = true;
    } else if (totalShots >= 6) {
        aiScore += 12;
        matchAnalysis.push(`⚽ Tích cực dứt điểm: Tổng ${totalShots} cú sút`);
        hasTacticalData = true;
    }

    if (maxCorners >= 6) {
        aiScore += 22;
        matchAnalysis.push(`🚩 Phạt góc dồn dập: ${maxCorners} quả`);
        hasTacticalData = true;
    } else if (maxCorners >= 2) {
        aiScore += 12;
        matchAnalysis.push(`🚩 Tần suất phạt góc: ${maxCorners} quả`);
        hasTacticalData = true;
    }

    if (oddsAnalysis) {
        aiScore += oddsAnalysis.scoreBoost;
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
        if (oddsAnalysis.oddsNoteText) matchAnalysis.push(`   └─> ${oddsAnalysis.oddsNoteText}`);
        hasTacticalData = true;
    }

    const finalScore = Math.min(Math.max(aiScore, 35.0), 96.0).toFixed(1);
    const shouldSend = parseFloat(finalScore) >= 60.0 && hasTacticalData;

    return { efficiency: finalScore, detailText: matchAnalysis.map(t => `• ${t}`).join('\n'), shouldSend };
}

async function sendTelegramAlert(item) {
    const message = 
`🔔 RUNG CHUỔNG VÀNGGGG
🏆 Giải đấu: ${item.league}
⚔ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🎯 Nhận định: Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG
📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi thông báo: ${item.homeName} vs ${item.awayName} (${item.ruleEfficiency}%)`);
        sentAlerts.add(item.id);
    } catch (err) { console.error('        └─> [Telegram Error]:', err.message); }
}

async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI] Đang quét trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, sofaMatches] = await Promise.all([
            fetchOddsData(),
            fetchSofaScoreLive()
        ]);

        console.log(`    └─> Tổng số trận đang live trên toàn cầu: ${sofaMatches.length}`);

        for (let index = 0; index < sofaMatches.length; index++) {
            const item = sofaMatches[index];
            const matchId = String(item.id);
            const elapsed = calculateExactMinute(item);
            const homeName = item.homeTeam?.name || 'Đội nhà';
            const awayName = item.awayTeam?.name || 'Đội khách';
            const homeScore = item.homeScore?.current ?? 0;
            const awayScore = item.awayScore?.current ?? 0;
            const league = parseLeagueName(item);

            if (!matchId) continue;
            if (sentAlerts.has(matchId)) continue;

            if (isFilteredLeague(league, homeName, awayName)) continue;

            if (elapsed === 999 || elapsed < 65 || elapsed > 90) continue;

            console.log(`[Đang Phân Tích AI] [ID: ${matchId}] [Phút: ${elapsed}'] [${league}] ${homeName} ${homeScore}-${awayScore} ${awayName}`);

            const metrics = await fetchMatchDetailStats(matchId);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, homeScore, awayScore);
                console.log(`    └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%)`);
                
                const pickItem = {
                    id: matchId, league, homeName, awayName, homeScore, awayScore,
                    elapsed, goalTimeline, detailText: aiAnalysis.detailText, ruleEfficiency: aiAnalysis.efficiency
                };
                await sendTelegramAlert(pickItem);
            } else {
                console.log(`    └─> [Bỏ qua]: Điểm AI chưa đủ (${aiAnalysis.efficiency}%) - Yêu cầu Rule >= 60%`);
            }
        }
    } catch (err) { console.error(`[API Fetch Error]:`, err.message); }
}

app.get('/', (req, res) => { res.send('Football Live AI Scanner Service is Running!'); });

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
});