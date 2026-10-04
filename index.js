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

const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f69ce7a0d9msh6127bf346b0c7bfp114e2bjsnc9b5d55970ad';

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
    'England': 'Anh', 'Spain': 'Tây Ban Nha', 'Italy': 'Ý', 'Germany': 'Đức', 'France': 'Pháp',
    'Japan': 'Nhật Bản', 'South Korea': 'Hàn Quốc', 'Vietnam': 'Việt Nam', 'Brazil': 'Brazil',
    'Argentina': 'Argentina', 'Netherlands': 'Hà Lan', 'Portugal': 'Bồ Đào Nha', 'Turkey': 'Thổ Nhĩ Kỳ',
    'Saudi Arabia': 'Ả Rập Xê Út', 'China': 'Trung Quốc', 'Thailand': 'Thái Lan', 'Australia': 'Úc',
    'USA': 'Mỹ', 'Norway': 'Na Uy', 'Czech Republic': 'Cộng hòa Séc', 'Denmark': 'Đan Mạch',
    'Croatia': 'Croatia', 'Poland': 'Ba Lan', 'Austria': 'Áo', 'World': 'Quốc Tế', 'Europe': 'Châu Âu',
    'Asia': 'Châu Á', 'South America': 'Nam Mỹ', 'Belgium': 'Bỉ', 'Scotland': 'Scotland', 'Switzerland': 'Thụy Sĩ'
};

const LEAGUE_NAME_MAP = {
    'UEFA Champions League': 'Cúp C1 Châu Âu',
    'UEFA Europa League': 'Cúp C2 Châu Âu',
    'UEFA Conference League': 'Cúp C3 Châu Âu',
    'UEFA Nations League': 'Nations League Châu Âu',
    'AFC Champions League Elite': 'Cúp C1 Châu Á',
    'AFC Champions League Two': 'Cúp C2 Châu Á',
    'CONMEBOL Libertadores': 'Cúp C1 Nam Mỹ (Libertadores)',
    'CONMEBOL Sudamericana': 'Cúp C2 Nam Mỹ (Sudamericana)',
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
        .replace(/\bDivision 3\b/gi, 'Hạng 3')
        .replace(/\bDivision 4\b/gi, 'Hạng 4')
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
// 2. BỘ LỌC TỐI ƯU: GIỮ HẠNG 1 2 3 4 & LỨA U21+, LỌC BÁN CHUYÊN/PHONG TRÀO
// ==========================================
function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    
    // 1. CHẶN GIẢI TRẺ THẤP (U15-U20), DỰ BỊ, ESPORTS, BÁN CHUYÊN, NGHIỆP DƯ, PHONG TRÀO
    const strictRejectRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20|youth|juvenil|reserves|reserve|res\.|dự bị|esports|e-soccer|cyber|simulated|friendly|amateur|amateurs|academic|university|phong trào|bán chuyên|regional league|oberliga|tercera|gamma ethniki)\b/i;
    if (strictRejectRegex.test(textToTest)) return true;

    // 2. KIỂM TRA MỞ CHO PHÉP GIẢI HẠNG 2, 3, 4 QUỐC GIA (NAM & NỮ)
    const validDivisionRegex = /\b(hạng\s*[234]|league\s*[234]|liga\s*[234]|serie\s*[bcd]|division\s*[234]|2nd\s*division|3rd\s*division|4th\s*division|2\.\s*liga|3\.\s*liga|segunda|tercera|championship|1st\s*division|2nd\s*snl|3rd\s*snl)\b/i;
    if (validDivisionRegex.test(textToTest)) {
        return false;
    }

    // 3. KIỂM TRA MỞ CHO PHÉP U21, U22, U23 QUỐC GIA & QUỐC TẾ (NAM & NỮ)
    const u21PlusRegex = /\b(u-?21|u-?22|u-?23)\b/i;
    if (u21PlusRegex.test(textToTest)) {
        return false;
    }

    // 4. WHITELIST - CÁC GIẢI VĐQG / CÚP CHÂU LỤC / NỮ TOP
    const approvedLeagues = [
        // Cúp Châu Lục & Quốc Tế
        'champions league', 'europa league', 'conference league', 'nations league', 
        'libertadores', 'sudamericana', 'afc champions', 'world cup', 'euro', 'copa america',
        
        // Giải Nam VĐQG
        'premier league', 'ngoại hạng anh', 'laliga', 'tây ban nha', 'serie a', 'ý', 'bundesliga', 'đức', 'ligue 1', 'pháp',
        'eredivisie', 'hà lan', 'primeira liga', 'bồ đào nha', 'super lig', 'thổ nhĩ kỳ',
        'pro league', 'bỉ', 'premiership', 'scotland', 'super league', 'thụy sĩ',
        'eliteserien', 'na uy', 'superliga', 'đan mạch', 'brasileiro', 'brazil', 'liga profesional', 'argentina', 'mls', 'mỹ',
        'j1 league', 'nhật bản', 'k league 1', 'hàn quốc', 'super league (china)', 'trung quốc',
        'pro league (saudi)', 'ả rập', 'a-league', 'úc', 'thai league 1', 'thái lan', 'v-league 1', 'việt nam',
        
        // Giải Nữ Top
        'women\'s world cup', 'world cup women', 'olympic women', 'women\'s champions league',
        'wsl', 'women\'s super league', 'nwsl', 'liga f', 'frauen-bundesliga', 'première ligue', 'arkema', 
        'serie a femminile', 'eredivisie women', 'we league', 'damallsvenskan', 'a-league women', 'vđqg nữ'
    ];

    const isMatchApproved = approvedLeagues.some(keyword => textToTest.includes(keyword));

    return !isMatchApproved;
}

// ==========================================
// 3. HÀM TÍNH PHÚT CHUẨN XÁC
// ==========================================
function calculateExactMinute(item, source) {
    if (!item) return 0;

    if (source === 'sofascore') {
        const statusType = item.status?.type;
        if (statusType !== 'inprogress') return 0;

        const description = (item.status?.description || '').toLowerCase();
        const currentPeriodStart = item.time?.currentPeriodStartTimestamp;
        
        if (currentPeriodStart) {
            const nowInSeconds = Math.floor(Date.now() / 1000);
            const elapsedSeconds = nowInSeconds - currentPeriodStart;
            const elapsedMinutes = Math.floor(elapsedSeconds / 60);

            if (description.includes('2nd half') || description.includes('h2')) {
                return 45 + elapsedMinutes;
            }
            return elapsedMinutes;
        }

        const match = `${item.status?.description || ''} ${item.statusText || ''}`.match(/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    } else {
        const textToSearch = `${item.Eps || ''} ${item.status || ''} ${item.statusText || ''} ${item.Tm || ''} ${item.time || ''}`;
        if (textToSearch.toLowerCase().includes('ended') || textToSearch.toLowerCase().includes('ft')) return 0;

        const match = textToSearch.match(/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }
}

// ==========================================
// 4. LẤY DỮ LIỆU TRẬN ĐẤU LIVE
// ==========================================
async function fetchLiveMatchesDualSource() {
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
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
        console.warn(`⚠️ [SofaScore Error]: ${err.message}`);
    }

    try {
        const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
        const resLive = await axios.get(liveUrl, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 });

        let rawData = [];
        const seenIds = new Set();

        function processMatchObject(obj) {
            if (!obj || typeof obj !== 'object') return;
            const matchId = String(obj.Eid || obj.id || '');
            if (matchId && (obj.T1 || obj.homeTeam) && !seenIds.has(matchId)) {
                seenIds.add(matchId);
                rawData.push(obj);
            }
            for (const key of Object.keys(obj)) {
                if (obj[key] !== null && typeof obj[key] === 'object') processMatchObject(obj[key]);
            }
        }

        if (resLive?.data) processMatchObject(resLive.data);
        console.log(`[Source: Livescore6] ✅ Quét thành công ${rawData.length} trận live.`);
        return { source: 'livescore6', matches: rawData };
    } catch (err) {
        return { source: 'none', matches: [] };
    }
}

// ==========================================
// 5. CHI TIẾT THỐNG KÊ
// ==========================================
async function fetchMatchDetailStats(matchId, source) {
    if (source === 'sofascore') {
        try {
            const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
                headers: {
                    'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                    'x-rapidapi-host': SOFASCORE_HOST
                },
                timeout: 6000
            });

            let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
            let possessionHome = null, possessionAway = null;

            const statistics = response.data?.statistics;

            if (Array.isArray(statistics)) {
                const allPeriod = statistics.find(p => p.period === 'ALL') || statistics[0];
                if (allPeriod?.groups) {
                    allPeriod.groups.forEach(group => {
                        (group.statisticsItems || []).forEach(st => {
                            const key = String(st.key || st.name || '').toLowerCase();
                            const homeVal = parseInt(st.home, 10) || 0;
                            const awayVal = parseInt(st.away, 10) || 0;
                            const total = homeVal + awayVal;

                            if (key.includes('shotsontarget') || key.includes('shots on target')) shotsOnTarget = total;
                            else if (key.includes('totalshots') || key.includes('total shots')) totalShots = total;
                            else if (key.includes('corner') || key.includes('corners')) corners = total;
                            else if (key.includes('redcards') || key.includes('red cards')) redCards = total;
                            else if (key.includes('ballpossession') || key.includes('possession')) {
                                possessionHome = homeVal;
                                possessionAway = awayVal;
                            }
                        });
                    });
                }
            }

            let possessionStr = (possessionHome !== null && possessionAway !== null) ? `${possessionHome}% - ${possessionAway}%` : null;

            return {
                sofaStats: { shotsOnTarget, totalShots, corners, redCards, possession: possessionStr }
            };
        } catch (err) {
            return { sofaStats: { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0, possession: null } };
        }
    }
    return { sofaStats: { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0, possession: null } };
}

// ==========================================
// 6. TỶ LỆ ODDS & EVENT INCIDENTS
// ==========================================
async function fetchMatchIncidents(matchId, source, homeScore, awayScore) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 5000
        });
        const incidents = response.data?.incidents || [];
        const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');
        if (goalEvents.length === 0) return `• Đã có ${homeScore + awayScore} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;

        goalEvents.sort((a, b) => (a.time || 0) - (b.time || 0));
        return goalEvents.map(g => `• Phút ${g.time}': ${g.isHome ? '⚽ [Chủ]' : '⚽ [Khách]'} ${g.player?.shortName || 'Cầu thủ'}`).join('\n');
    } catch (err) {
        return `• Đã có ${homeScore + awayScore} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;
    }
}

async function fetchOddsData() {
    if (!ODDS_API_KEY) return [];
    try {
        const response = await axios.get(ODDS_API_URL, { timeout: 6000 });
        return response.data || [];
    } catch (err) {
        return [];
    }
}

function cleanTeamName(name) {
    return String(name || '').toLowerCase().replace(/\b(fc|cf|club|sc|ac|cd)\b/g, '').replace(/[^a-z0-9]/g, '').trim();
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
    if (!totalsMarket) return null;

    const overOutcome = totalsMarket.outcomes?.find(o => o.name === 'Over');
    if (!overOutcome) return null;

    const overPrice = overOutcome.price;
    const overLine = overOutcome.point;
    const pointDiff = overLine - currentTotalGoals;

    let oddsBonus = 0;
    let oddsNotes = [];

    if (pointDiff >= 0.75) { oddsBonus += 6.0; oddsNotes.push(`Mốc Over giữ cao (${overLine})`); }
    else if (pointDiff > 0) { oddsBonus += 3.0; oddsNotes.push(`Mốc Over (${overLine}) sát mốc nổ bàn`); }

    if (overPrice >= 1.70 && overPrice <= 1.95) { oddsBonus += 8.0; oddsNotes.push(`Odds Over đẹp (${overPrice})`); }
    else if (overPrice >= 1.96 && overPrice <= 2.10) { oddsBonus += 4.0; }

    return {
        bookmaker: foundMatch.bookmakers[0].title,
        line: overLine,
        odds: overPrice,
        oddsBonus: Math.min(oddsBonus, 12.0),
        oddsNoteText: oddsNotes.join(' | ')
    };
}

// ==========================================
// 7. THUẬT TOÁN ĐÁNH GIÁ AI
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
    let matchAnalysis = [];
    
    // CẤU HÌNH ĐIỂM CƠ SỞ = 35%
    let aiPercentage = 35.0;
    
    const stats = metrics.sofaStats || {};
    let hasTacticalData = false;

    if (stats.possession) {
        matchAnalysis.push(`📊 Kiểm soát bóng: ${stats.possession}`);
        hasTacticalData = true;
    }

    if (stats.shotsOnTarget > 0 || stats.totalShots > 0) {
        hasTacticalData = true;
        if (stats.shotsOnTarget >= 5) {
            aiPercentage += 20.0;
            matchAnalysis.push(`⚡ Sút trúng đích dồn dập: ${stats.shotsOnTarget} lần (+20.0%)`);
        } else if (stats.shotsOnTarget >= 2) {
            aiPercentage += 10.0;
            matchAnalysis.push(`🎯 Sút trúng đích: ${stats.shotsOnTarget} lần (+10.0%)`);
        }

        if (stats.totalShots >= 12) {
            aiPercentage += 15.0;
            matchAnalysis.push(`🔥 Thế trận cởi mở, tổng sút: ${stats.totalShots} (+15.0%)`);
        } else if (stats.totalShots >= 6) {
            aiPercentage += 8.0;
            matchAnalysis.push(`⚽ Tích cực bắn phá, tổng sút: ${stats.totalShots} (+8.0%)`);
        }
    }

    if (stats.corners >= 6) {
        aiPercentage += 10.0;
        matchAnalysis.push(`🚩 Phạt góc nhiều: ${stats.corners} quả (+10.0%)`);
        hasTacticalData = true;
    } else if (stats.corners >= 3) {
        aiPercentage += 5.0;
        matchAnalysis.push(`🚩 Phạt góc: ${stats.corners} quả (+5.0%)`);
        hasTacticalData = true;
    }

    if (stats.redCards > 0) {
        aiPercentage += 15.0;
        matchAnalysis.push(`🟥 Thẻ đỏ (${stats.redCards} thẻ - +15.0%)`);
        hasTacticalData = true;
    }

    if (oddsAnalysis) {
        aiPercentage += oddsAnalysis.oddsBonus;
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds} - Cộng ${oddsAnalysis.oddsBonus}%)`);
    }

    const finalPercentage = Math.min(aiPercentage, 98.0).toFixed(1);
    
    // ĐIỂM ĐẠT RULE TỪ 58%
    const MIN_SEND_PERCENTAGE = 58.0;
    const shouldSend = parseFloat(finalPercentage) >= MIN_SEND_PERCENTAGE && hasTacticalData;

    return {
        efficiency: finalPercentage,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend
    };
}

// ==========================================
// 8. TELEGRAM ALERT & AUTO SCANNER
// ==========================================
async function sendTelegramAlert(item) {
    if (sentAlerts.has(item.id)) return;

    // PHÂN LOẠI THÔNG BÁO: ĐẠT TỪ 65% BÁO "BIG BET"
    const isBigBet = parseFloat(item.ruleEfficiency) >= 65.0;
    const headerText = isBigBet 
        ? `🔥 BIG BET RUNG CHUỔNG VÀNGGG 🔥 (${item.source.toUpperCase()})` 
        : `🔔 RUNG CHUỔNG VÀNGGGG (${item.source.toUpperCase()})`;

    const message = 
`${headerText}
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🎯 Nhận định: Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG
📈 Hiệu suất Rule: ${item.ruleEfficiency}%${isBigBet ? ' (Tín hiệu Rất Mạnh)' : ''}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: message });
        console.log(`    └─> [Telegram Success] Đã gửi báo trận (${isBigBet ? 'BIG BET' : 'THƯỜNG'}): ${item.homeName} vs ${item.awayName}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('    └─> [Telegram Error]:', err.message);
    }
}

async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan Whitelist AI] Đang quét trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, liveResult] = await Promise.all([fetchOddsData(), fetchLiveMatchesDualSource()]);
        const { source, matches } = liveResult;
        if (matches.length === 0) return;

        let scannedCount = 0, skippedCount = 0;

        for (let index = 0; index < matches.length; index++) {
            const item = matches[index];
            let matchId = String(item.id || item.Eid || index);
            let homeName = item.homeTeam?.name || (item.T1 && item.T1[0]?.Nm) || 'Đội nhà';
            let awayName = item.awayTeam?.name || (item.T2 && item.T2[0]?.Nm) || 'Đội khách';
            let homeScore = item.homeScore?.current ?? parseInt(item.Tr1 || 0, 10);
            let awayScore = item.awayScore?.current ?? parseInt(item.Tr2 || 0, 10);

            const leagueName = parseLeagueName(item, source);

            if (isFilteredLeague(leagueName, homeName, awayName)) {
                skippedCount++;
                continue;
            }

            const minute = calculateExactMinute(item, source);
            if (minute < 46 || minute > 98) {
                skippedCount++;
                continue;
            }

            scannedCount++;
            console.log(`[Phân Tích (${source.toUpperCase()})] [ID: ${matchId}] [Phút: ${minute}'] [${leagueName}] ${homeName} ${homeScore}-${awayScore} ${awayName}`);

            const metrics = await fetchMatchDetailStats(matchId, source);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, source, homeScore, awayScore);
                await sendTelegramAlert({
                    id: matchId, source, league: leagueName, homeName, awayName,
                    homeScore, awayScore, elapsed: minute, goalTimeline,
                    detailText: aiAnalysis.detailText, ruleEfficiency: aiAnalysis.efficiency
                });
            } else {
                console.log(`    └─> [Bỏ qua]: Điểm AI (${aiAnalysis.efficiency}%) - Chưa đạt mốc 58% hoặc thiếu chỉ số`);
            }
        }
        console.log(`[Thống kê lượt quét]: Đã phân tích ${scannedCount} trận chất lượng (Đã chặn ${skippedCount} trận phụ/bán chuyên).`);
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

app.get('/', (req, res) => res.send('Football Dual-Source AI Scanner Service is Running!'));

app.listen(PORT, () => {
    console.log(`==> Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 7 * 60 * 1000);
});