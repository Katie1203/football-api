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

// 1. SofaScore Host
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

// 2. Free API Live Football Data Host
const LIVE_FOOTBALL_HOST = 'free-api-live-football-data.p.rapidapi.com';

// 3. The Odds API
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
    'USA': 'Mỹ', 'Norway': 'Na Uy', 'Estonia': 'Estonia', 'India': 'Ấn Độ', 'South Africa': 'Nam Phi',
    'World': 'Quốc Tế', 'Europe': 'Châu Âu', 'Asia': 'Châu Á', 'South America': 'Nam Mỹ', 'Africa': 'Châu Phi'
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
    'International Friendly': 'Giao Hữu Quốc Tế',
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

function parseLeagueName(item) {
    if (!item) return 'Bóng Đá Quốc Tế';
    let category = item.tournament?.category?.name || item.category?.name || '';
    let tournament = item.tournament?.name || item.competitionName || '';

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
    const lNameLower = leagueName.toLowerCase();
    
    const youthRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;
    if (youthRegex.test(textToTest)) return true;

    const rejectKeywords = [
        'simulated', 'srl', 'esports', 'e-soccer', 'cyber', 
        'reserve', 'reserves', 'u21 reserve', 'amateur', 'phong trào', 
        'bán chuyên', 'nghiệp dư', 'regional', 'campionato primavera', 'academy',
        'state league', 'counties league', 'division one south', 'division one north',
        'npl', 'nsw', 'semi-professional', 'college', 'university', 'inter-university',
        'ncaa', '3rd division', '4th division',
        'sodra', 'svealand', 'promotion league', 'ligue 2 (tunisia)', 'tunisia league 2',
        'preferente', 'autonómica', 'gesigim', 'gelişim ligi', 'group 1', 'group 2'
    ];
    
    if (rejectKeywords.some(kw => textToTest.includes(kw))) return true;

    const isCupMatch = lNameLower.includes('cup') || lNameLower.includes('cúp') || lNameLower.includes('trophy');
    if (isCupMatch) {
        const allowedMajorCups = [
            'champions league', 'europa league', 'conference league', 'copa libertadores', 
            'copa sudamericana', 'world cup', 'fa cup', 'cúp fa', 'copa del rey', 
            'cúp nhà vua', 'coppa italia', 'dfb pokal', 'coupe de france', 'efl cup', 
            'league cup', 'super cup', 'siêu cúp'
        ];
        if (!allowedMajorCups.some(cup => lNameLower.includes(cup))) return true; 
    }
    return false;
}

// ==========================================
// 3. TÍNH PHÚT CHUẨN XÁC
// ==========================================
function calculateExactMinute(item) {
    if (!item) return 0;
    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft') || statusType === 'ft') return 999;
    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht' || statusDesc.includes('half time')) return 'HT';

    if (item.time && typeof item.time.played === 'number' && item.time.played > 0) {
        return item.time.played;
    }

    const matchDesc = statusDesc.match(/^(\d+)['\s]?$/);
    if (matchDesc) return parseInt(matchDesc[1], 10);

    const nowSeconds = Math.floor(Date.now() / 1000);
    let periodStart = item.time?.currentPeriodStartTimestamp || item.statusTime?.currentPeriodStartTimestamp;
    
    if (periodStart) {
        if (periodStart > 9999999999) periodStart = Math.floor(periodStart / 1000);
        let elapsedInPeriod = Math.floor((nowSeconds - periodStart) / 60);
        if (elapsedInPeriod < 0) elapsedInPeriod = 0;

        const isSecondHalf = statusType.includes('second') || statusDesc.includes('2nd') || item.time?.period === 2 || statusType === 'inprogress_2nd';
        if (isSecondHalf) return Math.min(45 + elapsedInPeriod, 92);
        return Math.min(elapsedInPeriod, 44);
    }
    return 0;
}

// ==========================================
// 4. DIỄN BIẾN BÀN THẮNG
// ==========================================
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
            const scoreStr = (g.homeScore !== undefined && g.awayScore !== undefined) ? `[${g.homeScore}-${g.awayScore}]` : '';
            return `• Phút ${min}'${extra}: ${isHome} ${player} ${scoreStr}`;
        }).join('\n');
    } catch (err) {
        const totalGoals = homeScore + awayScore;
        return totalGoals > 0 ? `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})` : '• Chưa có bàn thắng (Tỷ số: 0-0)';
    }
}

// ==========================================
// 5. LẤY KÈO TỪ THE ODDS API
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

async function fetchSofaScoreLive() {
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 15000
        });
        return response.data?.events || response.data?.liveEvents || [];
    } catch (err) {
        return [];
    }
}

// ==========================================
// 6. HÀM GỌI DỰ PHÒNG TỪ LIVE FOOTBALL API
// ==========================================
async function fetchLiveFootballStats(matchId) {
    try {
        const response = await axios.get(`https://${LIVE_FOOTBALL_HOST}/matches/statistics?matchId=${matchId}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVE_FOOTBALL_HOST },
            timeout: 6000
        });

        const data = response.data;
        if (!data) return null;

        // Xử lý bóc tách cấu trúc dữ liệu trả về từ Free API Live Football Data
        let statsContainer = {
            hasValidStats: false,
            shotsOnTarget: 0,
            shotsOffTarget: 0,
            blockedShots: 0,
            totalShots: 0,
            corners: 0,
            redCards: 0,
            possessionHome: null,
            possessionAway: null
        };

        const statsArray = Array.isArray(data) ? data : (data.statistics || data.response || [data]);
        
        statsArray.forEach(st => {
            const name = String(st.name || st.type || st.statisticName || '').toLowerCase();
            const homeVal = parseInt(st.home || st.homeValue || 0, 10);
            const awayVal = parseInt(st.away || st.awayValue || 0, 10);
            const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

            if (!isNaN(homeVal) || !isNaN(awayVal)) statsContainer.hasValidStats = true;

            if (name.includes('shot on target') || name.includes('sút trúng đích')) statsContainer.shotsOnTarget = Math.max(statsContainer.shotsOnTarget, sumVal);
            if (name.includes('shot off target') || name.includes('sút ra ngoài')) statsContainer.shotsOffTarget = Math.max(statsContainer.shotsOffTarget, sumVal);
            if (name.includes('total shot') || name.includes('tổng số cú sút')) statsContainer.totalShots = Math.max(statsContainer.totalShots, sumVal);
            if (name.includes('corner') || name.includes('phạt góc')) statsContainer.corners = Math.max(statsContainer.corners, sumVal);
            if (name.includes('red card') || name.includes('thẻ đỏ')) statsContainer.redCards = Math.max(statsContainer.redCards, sumVal);
            if (name.includes('possession') || name.includes('kiểm soát')) {
                statsContainer.possessionHome = homeVal;
                statsContainer.possessionAway = awayVal;
            }
        });

        if (!statsContainer.hasValidStats) return null;

        let possessionStr = (statsContainer.possessionHome !== null && statsContainer.possessionAway !== null) 
            ? `${statsContainer.possessionHome}% - ${statsContainer.possessionAway}%` 
            : null;

        const calculatedTotalShots = statsContainer.totalShots || (statsContainer.shotsOnTarget + statsContainer.shotsOffTarget + statsContainer.blockedShots);

        return {
            hasData: true,
            sofaStats: { 
                shotsOnTarget: statsContainer.shotsOnTarget, 
                totalShots: calculatedTotalShots, 
                shotsOffTarget: statsContainer.shotsOffTarget,
                blockedShots: statsContainer.blockedShots,
                corners: statsContainer.corners, 
                redCards: statsContainer.redCards,
                possession: possessionStr
            }
        };
    } catch (err) {
        return null;
    }
}

// ==========================================
// 7. BÓC TÁCH SOFASCORE & KẾT HỢP DỰ PHÒNG
// ==========================================
function parseMatchStatisticsGroups(groups, statsContainer) {
    if (!Array.isArray(groups)) return;
    groups.forEach(group => {
        const items = group.statisticsItems || group.items || group.stats || [];
        if (items.length > 0) statsContainer.hasValidStats = true;

        items.forEach(st => {
            const name = String(st.name || st.slug || st.key || '').toLowerCase();
            const homeVal = parseInt(st.home, 10);
            const awayVal = parseInt(st.away, 10);
            const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

            if (name.includes('shotsontarget') || name.includes('sút trúng đích') || name.includes('shots on target')) statsContainer.shotsOnTarget = Math.max(statsContainer.shotsOnTarget, sumVal);
            else if (name.includes('shotsofftarget') || name.includes('sút ra ngoài') || name.includes('shots off target')) statsContainer.shotsOffTarget = Math.max(statsContainer.shotsOffTarget, sumVal);
            else if (name.includes('blockedshots') || name.includes('sút bị cản') || name.includes('blocked shots')) statsContainer.blockedShots = Math.max(statsContainer.blockedShots, sumVal);
            else if (name.includes('totalshots') || name.includes('tổng số cú sút') || name.includes('total shots')) statsContainer.totalShots = Math.max(statsContainer.totalShots, sumVal);
            else if (name.includes('corner') || name.includes('phạt góc')) statsContainer.corners = Math.max(statsContainer.corners, sumVal);
            else if (name.includes('redcard') || name.includes('thẻ đỏ') || name.includes('red cards')) statsContainer.redCards = Math.max(statsContainer.redCards, sumVal);
            else if (name.includes('ballpossession') || name.includes('possession') || name.includes('kiểm soát bóng')) {
                if (!isNaN(homeVal) && !isNaN(awayVal)) {
                    statsContainer.possessionHome = homeVal;
                    statsContainer.possessionAway = awayVal;
                }
            }
        });
    });
}

async function fetchMatchDetailStats(matchId) {
    try {
        // Thử nguồn 1: SofaScore
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 6000
        });

        const data = response.data;
        if (data) {
            const statsContainer = {
                hasValidStats: false,
                shotsOnTarget: 0, shotsOffTarget: 0, blockedShots: 0, totalShots: 0,
                corners: 0, redCards: 0, possessionHome: null, possessionAway: null
            };

            const statistics = data.statistics || data.periods || data;
            const periodsArray = Array.isArray(statistics) ? statistics : [statistics];

            periodsArray.forEach(period => {
                const groups = period.groups || period.statGroups || period.statistics || [];
                parseMatchStatisticsGroups(groups, statsContainer);
                if (period.statisticsItems || period.items) {
                    parseMatchStatisticsGroups([{ statisticsItems: period.statisticsItems || period.items }], statsContainer);
                }
            });

            if (!statsContainer.hasValidStats && Array.isArray(data)) {
                parseMatchStatisticsGroups([{ statisticsItems: data }], statsContainer);
            }

            if (statsContainer.hasValidStats) {
                let possessionStr = (statsContainer.possessionHome !== null && statsContainer.possessionAway !== null) 
                    ? `${statsContainer.possessionHome}% - ${statsContainer.possessionAway}%` 
                    : null;
                const calculatedTotalShots = statsContainer.totalShots || (statsContainer.shotsOnTarget + statsContainer.shotsOffTarget + statsContainer.blockedShots);

                return {
                    hasData: true,
                    sofaStats: { 
                        shotsOnTarget: statsContainer.shotsOnTarget, 
                        totalShots: calculatedTotalShots, 
                        shotsOffTarget: statsContainer.shotsOffTarget,
                        blockedShots: statsContainer.blockedShots,
                        corners: statsContainer.corners, 
                        redCards: statsContainer.redCards,
                        possession: possessionStr
                    }
                };
            }
        }
    } catch (err) {
        // Bỏ qua lỗi SofaScore để chuyển sang gọi nguồn dự phòng
    }

    // Nguồn 2: Nếu SofaScore không có, tự động gọi Live Football API dự phòng
    console.log(`    └─> SofaScore trống dữ liệu, đang gọi Live Football API dự phòng cho trận #${matchId}...`);
    return await fetchLiveFootballStats(matchId);
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

    let oddsBonus = 0;
    let oddsNotes = [];
    const overLine = overOutcome.point;
    const price = overOutcome.price;
    const pointDiff = overLine - currentTotalGoals;

    if (pointDiff >= 0.75) { oddsBonus = 15.0; oddsNotes.push(`Line Over giữ mức cao (${overLine})`); }
    else if (pointDiff > 0) { oddsBonus = 9.0; oddsNotes.push(`Line Over (${overLine}) sát mốc`); }

    if (price <= 1.40) { oddsBonus += 15.0; oddsNotes.push(`Odds Over cực thấp (${price})`); }
    else if (price <= 1.60) { oddsBonus += 11.0; oddsNotes.push(`Odds Over giảm sâu (${price})`); }
    else if (price <= 1.85) { oddsBonus += 7.0; oddsNotes.push(`Odds Over ổn định (${price})`); }
    else { oddsBonus += 3.0; oddsNotes.push(`Odds Over (${price})`); }

    return {
        bookmaker: foundMatch.bookmakers[0].title,
        line: overLine,
        odds: price,
        oddsBonus,
        oddsNoteText: oddsNotes.join(' | ')
    };
}

// ==========================================
// 8. ĐÁNH GIÁ AI
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
    let matchAnalysis = [];
    let aiPercentage = 35.0; 
    const stats = metrics.sofaStats || {};
    let hasTacticalData = false;

    if (stats.possession) {
        matchAnalysis.push(`📊 Kiểm soát bóng: ${stats.possession}`);
        const possParts = stats.possession.split('-');
        if (possParts.length === 2) {
            const maxPoss = Math.max(parseInt(possParts[0], 10) || 50, parseInt(possParts[1], 10) || 50);
            if (maxPoss >= 70) { aiPercentage += 15.0; matchAnalysis.push(`    └─> Áp đảo cực mạnh (${maxPoss}%)`); hasTacticalData = true; }
            else if (maxPoss >= 60) { aiPercentage += 10.0; matchAnalysis.push(`    └─> Lấn lướt (${maxPoss}%)`); hasTacticalData = true; }
        }
    }

    if (stats.redCards > 0) { aiPercentage += 15.0; matchAnalysis.push(`🟥 Thẻ đỏ (${stats.redCards} thẻ)`); hasTacticalData = true; }
    if (stats.shotsOnTarget >= 5) { aiPercentage += 18.0; matchAnalysis.push(`⚡ Sút trúng đích dồn dập: ${stats.shotsOnTarget}`); hasTacticalData = true; }
    else if (stats.shotsOnTarget >= 3) { aiPercentage += 12.0; matchAnalysis.push(`⚡ Sút trúng đích: ${stats.shotsOnTarget}`); hasTacticalData = true; }
    else if (stats.shotsOnTarget === 2) { aiPercentage += 6.0; matchAnalysis.push(`🎯 Sút trúng đích: ${stats.shotsOnTarget}`); hasTacticalData = true; }

    if (stats.totalShots >= 12) { aiPercentage += 15.0; matchAnalysis.push(`🔥 Tổng sút: ${stats.totalShots}`); hasTacticalData = true; }
    else if (stats.totalShots >= 8) { aiPercentage += 10.0; matchAnalysis.push(`⚽ Tổng sút: ${stats.totalShots}`); hasTacticalData = true; }

    if (stats.corners >= 6) { aiPercentage += 12.0; matchAnalysis.push(`🚩 Phạt góc lớn: ${stats.corners}`); hasTacticalData = true; }
    else if (stats.corners >= 4) { aiPercentage += 6.0; matchAnalysis.push(`🚩 Phạt góc: ${stats.corners}`); hasTacticalData = true; }

    if (oddsAnalysis) {
        aiPercentage += oddsAnalysis.oddsBonus;
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
        if (oddsAnalysis.oddsNoteText) matchAnalysis.push(`    └─> ${oddsAnalysis.oddsNoteText}`);
        hasTacticalData = true;
    }

    const finalPercentage = Math.min(aiPercentage, 98.0).toFixed(1);
    const shouldSend = parseFloat(finalPercentage) >= 58.0 && hasTacticalData;

    return { efficiency: finalPercentage, detailText: matchAnalysis.map(t => `• ${t}`).join('\n'), shouldSend };
}

// ==========================================
// 9. GỬI TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const isBigBet = parseFloat(item.ruleEfficiency) >= 65.0;
    const headerTitle = isBigBet ? '🔥 BIGGG BET RUNG CHUỔNG VÀNG 🔥' : '🔔 RUNG CHUỔNG VÀNGGG';

    const message = 
`${headerTitle}
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ:
${item.goalTimeline}

📊 THẾ TRẬN & KÈO:
${item.detailText}

🎯 Nhận định: Xác suất cao có THÊM BÀN THẮNG
📈 Hiệu suất: ${item.ruleEfficiency}%${isBigBet ? ' (Tín hiệu Cực Mạnh)' : ''}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: message });
        sentAlerts.add(item.id);
    } catch (err) {}
}

// ==========================================
// 10. TIẾN TRÌNH QUÉT
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n[${currentVN.timeStr}] 🔄 Quét vòng mới (Kết hợp 3 nguồn)...`);
    
    try {
        const [allOdds, sofaMatches] = await Promise.all([fetchOddsData(), fetchSofaScoreLive()]);

        for (let index = 0; index < sofaMatches.length; index++) {
            const item = sofaMatches[index];
            const matchId = String(item.id);
            const homeName = item.homeTeam?.name || 'Đội nhà';
            const awayName = item.awayTeam?.name || 'Đội khách';
            const homeScore = item.homeScore?.current ?? 0;
            const actualAwayScore = item.awayScore?.current ?? 0;
            const league = parseLeagueName(item);

            if (!matchId || sentAlerts.has(matchId)) continue;
            if (isFilteredLeague(league, homeName, awayName)) continue;

            const elapsed = calculateExactMinute(item);
            if (elapsed === 'HT' || elapsed === 999 || typeof elapsed !== 'number' || elapsed < 46 || elapsed > 92) continue;

            // Gọi hàm check dữ liệu qua cơ chế 2 nguồn dự phòng
            const metrics = await fetchMatchDetailStats(matchId);
            if (!metrics || !metrics.hasData) continue;

            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, homeScore, actualAwayScore);
                await sendTelegramAlert({
                    id: matchId, league, homeName, awayName, homeScore, awayScore: actualAwayScore,
                    elapsed, goalTimeline, detailText: aiAnalysis.detailText, ruleEfficiency: aiAnalysis.efficiency
                });
            }
        }
    } catch (err) {}
}

app.get('/', (req, res) => res.send('Triple Source Football Bot is Running!'));
app.listen(PORT, () => {
    scanLiveMatches();
    setInterval(scanLiveMatches, 7 * 60 * 1000);
});