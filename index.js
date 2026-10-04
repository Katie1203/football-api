const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ==========================================
// CẤU HÌNH DỮ LIỆU & TELEGRAM
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;
const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

const getVietnamDateStr = () => {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return vnTime.toISOString().slice(0, 10).replace(/-/g, '');
};

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
    'England': 'Anh', 'Spain': 'Tây Ban Nha', 'Italy': 'Ý', 'Germany': 'Đức', 'France': 'Pháp',
    'Japan': 'Nhật Bản', 'South Korea': 'Hàn Quốc', 'Vietnam': 'Việt Nam', 'Brazil': 'Brazil',
    'Argentina': 'Argentina', 'Netherlands': 'Hà Lan', 'Portugal': 'Bồ Đào Nha', 'Turkey': 'Thổ Nhĩ Kỳ',
    'Saudi Arabia': 'Ả Rập Xê Út', 'China': 'Trung Quốc', 'Thailand': 'Thái Lan', 'Australia': 'Úc',
    'USA': 'Mỹ', 'Norway': 'Na Uy', 'World': 'Quốc Tế', 'Europe': 'Châu Âu', 'Asia': 'Châu Á'
};

const LEAGUE_NAME_MAP = {
    'UEFA Champions League': 'Cúp C1 Châu Âu', 'UEFA Europa League': 'Cúp C2 Châu Âu',
    'Premier League': 'Ngoại Hạng Anh', 'LaLiga': 'VĐQG Tây Ban Nha', 'Serie A': 'VĐQG Ý',
    'Bundesliga': 'VĐQG Đức', 'Ligue 1': 'VĐQG Pháp', 'J1 League': 'VĐQG Nhật Bản'
};

function parseLeagueName(item, source) {
    if (!item) return 'Bóng Đá Quốc Tế';
    let category = '';
    let tournament = '';

    if (source === 'sofascore') {
        category = item.tournament?.category?.name || item.category?.name || '';
        tournament = item.tournament?.name || '';
    } else {
        category = item._inheritedCategory || item.Cnm || '';
        tournament = item._inheritedTournament || item.Snm || item.Tname || '';
    }

    if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];
    const translatedCategory = COUNTRY_MAP[category] || category;
    return tournament ? (translatedCategory ? `${tournament} (${translatedCategory})` : tournament) : 'Bóng Đá Quốc Tế';
}

function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    const youthRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;
    if (youthRegex.test(textToTest)) return true;
    const filterKeywords = ['simulated', 'srl', 'esports', 'e-soccer'];
    return filterKeywords.some(kw => textToTest.includes(kw));
}

function calculateExactMinute(item, source) {
    if (!item) return 0;
    try {
        if (source === 'sofascore') {
            const statusType = String(item.status?.type || '').toLowerCase();
            if (statusType.includes('ended') || statusType.includes('finished')) return 999;
            if (statusType.includes('halftime') || statusType === 'ht') return 'HT';
            if (item.time && typeof item.time.played === 'number' && item.time.played > 0) {
                return item.time.played;
            }
        } else {
            const rawEps = item.Eps || item.status || item.matchStatus || '';
            const epsStr = String(rawEps).trim().toUpperCase();
            
            if (epsStr.includes('FT') || epsStr.includes('AET') || epsStr.includes('PEN')) return 999;
            if (epsStr.includes('HT') || eps === '10' || epsStr.includes('HALF')) return 'HT';

            const matchNum = epsStr.match(/(\d+)/);
            if (matchNum) {
                const val = parseInt(matchNum[1], 10);
                if (val > 0 && val <= 120) return val;
            }
        }
    } catch (e) {
        return 0;
    }
    return 0;
}

async function fetchLiveMatchesDualSource() {
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 8000
        });
        const events = response.data?.events || response.data?.liveEvents || [];
        if (events.length > 0) {
            console.log(`[Source: SofaScore] ✅ Lấy thành công ${events.length} trận live.`);
            return { source: 'sofascore', matches: events };
        }
    } catch (err) {
        console.warn(`⚠️ [SofaScore Bị Chặn/Lỗi]: ${err.message} -> Đang chuyển sang Livescore6...`);
    }

    try {
        const dateStr = getVietnamDateStr();
        const LIVESCORE_BY_DATE_URL = `https://${LIVESCORE_HOST}/matches/v2/list-by-date?Category=soccer&Date=${dateStr}&Timezone=-7`;

        const response = await axios.get(LIVESCORE_BY_DATE_URL, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST },
            timeout: 15000
        });

        let activeMatches = [];
        const data = response.data;

        function deepExtractMatches(obj, parentCategory = '', parentTournament = '') {
            if (!obj) return;
            if (Array.isArray(obj)) {
                obj.forEach(item => deepExtractMatches(item, parentCategory, parentTournament));
                return;
            }
            if (typeof obj === 'object') {
                const currentCat = obj.Cname || obj.categoryName || obj.country || parentCategory;
                const currentTourn = obj.Snm || obj.Tname || obj.tournamentName || parentTournament;

                const hasId = obj.Eid || obj.id || obj.matchId;
                const hasTeams = (obj.T1 && obj.T2) || (obj.homeTeam && obj.awayTeam);

                if (hasId && hasTeams) {
                    const eps = String(obj.Eps || obj.status || '').trim().toUpperCase();
                    const isFinished = eps.includes('FT') || eps.includes('AET') || eps.includes('PEN') || eps.includes('NS');
                    if (!isFinished) {
                        activeMatches.push({ ...obj, _inheritedCategory: currentCat, _inheritedTournament: currentTourn });
                    }
                } else {
                    for (const key of Object.keys(obj)) {
                        if (typeof obj[key] === 'object' && obj[key] !== null) {
                            deepExtractMatches(obj[key], currentCat, currentTourn);
                        }
                    }
                }
            }
        }

        deepExtractMatches(data);
        const uniqueMatches = Array.from(new Map(activeMatches.map(m => [String(m.Eid || m.id), m])).values());
        console.log(`[Source: Livescore6 Backup] ✅ Vét cạn thành công ${uniqueMatches.length} trận live.`);
        return { source: 'livescore6', matches: uniqueMatches };
    } catch (err) {
        console.error(`❌ [Livescore6 Backup Error]:`, err.message);
        return { source: 'none', matches: [] };
    }
}

async function fetchMatchIncidents(matchId, source, homeScore = 0, awayScore = 0) {
    const totalGoals = homeScore + awayScore;
    return totalGoals > 0 ? `• Đã có ${totalGoals} bàn thắng (Tỷ số: ${homeScore}-${awayScore})` : '• Chưa có bàn thắng (Tỷ số: 0-0)';
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
    return {
        sofaStats: { shotsOnTarget: 3, totalShots: 8, corners: 4, redCards: 0, possession: '50% - 50%' }
    };
}

function cleanTeamName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function analyzeOddsGoalProbability(allOdds, homeName, awayName, currentTotalGoals) {
    return null;
}

function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
    return { efficiency: '75.0', detailText: '• Thế trận dồn ép, sút nhiều', shouldSend: true };
}

async function sendTelegramAlert(item) {
    const message = `🔔 RUNG CHUỔNG VÀNGGGG\n🏆 Giải: ${item.league}\n⚔️ Trận: ${item.homeName} ${item.homeScore}-${item.awayScore} ${item.awayName}\n⏱ Phút: ${item.elapsed}'`;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: message });
        sentAlerts.add(item.id);
    } catch (err) {}
}

async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n[Auto-Scan AI Dual-Source] Đang quét trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, liveResult] = await Promise.all([fetchOddsData(), fetchLiveMatchesDualSource()]);
        const { source, matches } = liveResult;
        if (matches.length === 0) return;

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
                homeScore = parseInt(item.Tr1 ?? item.homeScore ?? 0, 10);
                actualAwayScore = parseInt(item.Tr2 ?? item.awayScore ?? 0, 10);
            }

            if (isNaN(homeScore)) homeScore = 0;
            if (isNaN(actualAwayScore)) actualAwayScore = 0;

            const leagueName = parseLeagueName(item, source);
            if (isFilteredLeague(leagueName, homeName, awayName)) continue;

            const elapsed = calculateExactMinute(item, source);
            const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

            if (isNaN(numericElapsed) || numericElapsed < 50 || numericElapsed > 92) continue;

            console.log(`[Phân tích] [ID: ${matchId}] [Phút: ${numericElapsed}'] ${homeName} ${homeScore}-${actualAwayScore} ${awayName}`);
            
            // Tạm thời gửi test cảnh báo khi match đúng khung phút để kiểm tra hệ thống thông báo
            const goalTimeline = await fetchMatchIncidents(matchId, source, homeScore, actualAwayScore);
            await sendTelegramAlert({
                id: matchId, source, league: leagueName, homeName, awayName,
                homeScore, awayScore: actualAwayScore, elapsed: numericElapsed,
                goalTimeline, detailText: '• Test thông báo tự động', ruleEfficiency: '75.0'
            });
        }
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

app.get('/', (req, res) => { res.send('Running!'); });
app.listen(PORT, () => {
    console.log(`==> Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 60000);
});