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
    'LaLiga 2': 'Hạng 2 Tây Ban Nha',
    'Serie A': 'VĐQG Ý',
    'Serie B': 'Hạng 2 Ý',
    'Bundesliga': 'VĐQG Đức',
    '2. Bundesliga': 'Hạng 2 Đức',
    'Ligue 1': 'VĐQG Pháp',
    'Ligue 2': 'Hạng 2 Pháp',
    'J.League 1': 'VĐQG Nhật Bản',
    'J1 League': 'VĐQG Nhật Bản',
    'J.League 2': 'Hạng 2 Nhật Bản',
    'J2 League': 'Hạng 2 Nhật Bản',
    'J.League 3': 'Hạng 3 Nhật Bản',
    'J3 League': 'Hạng 3 Nhật Bản',
    'K League 1': 'VĐQG Hàn Quốc',
    'K League 2': 'Hạng 2 Hàn Quốc',
    'V-League 1': 'V-League Việt Nam',

    'U20 World Cup': 'World Cup U20',
    'U19 European Championship': 'Vô Địch U19 Châu Âu',
    'U21 European Championship': 'Vô Địch U21 Châu Âu',
    'AFC U20 Asian Cup': 'Cúp U20 Châu Á'
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
        .replace(/\bDivision 3\b/gi, 'Hạng 3')
        .replace(/\b1st Division\b/gi, 'Hạng 1')
        .replace(/\b2nd Division\b/gi, 'Hạng 2')
        .replace(/\bSuper League\b/gi, 'VĐQG')
        .replace(/\bPro League\b/gi, 'VĐQG')
        .replace(/\bCup\b/gi, 'Cúp')
        .replace(/\bU21\b/gi, 'Giải U21')
        .replace(/\bU20\b/gi, 'Giải U20')
        .replace(/\bU19\b/gi, 'Giải U19');

    if (translatedCategory && translatedTournament) {
        if (translatedTournament.toLowerCase().includes(translatedCategory.toLowerCase())) {
            return translatedTournament;
        }
        return `${translatedTournament} ${translatedCategory}`.trim();
    }

    return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}

// ==========================================
// 2. BỘ LỌC CÁC GIẢI TRẺ TỪ U18 TRỞ XUỐNG (U10 ĐẾN U18)
// ==========================================
function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    
    // Lọc bỏ tất cả các giải từ U10 đến U18 (U18, U17, U16, U15...)
    const youthUnder18Regex = /\b(u-?1[0-8]|sub-?1[0-8]|under-?1[0-8])\b/i;
    if (youthUnder18Regex.test(textToTest)) return true;

    const filterKeywords = [
        'academy', 'cadete', 'juvenil', 'juniors', 'junior',
        'reserves', 'reserve', 'amateur', 'simulated', 'srl'
    ];

    return filterKeywords.some(kw => textToTest.includes(kw));
}

// ==========================================
// 3. TÍNH PHÚT TRẬN ĐẤU CHUẨN XÁC SOFASCORE
// ==========================================
function calculateExactMinute(item) {
    if (!item) return 0;

    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht') return 45;
    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft')) return 90;

    const matchDesc = statusDesc.match(/^(\d+)['\s]?$/);
    if (matchDesc) return parseInt(matchDesc[1], 10);

    const nowSeconds = Math.floor(Date.now() / 1000);
    let periodStart = item.time?.currentPeriodStartTimestamp || item.statusTime?.currentPeriodStartTimestamp;
    
    if (periodStart) {
        if (periodStart > 9999999999) periodStart = Math.floor(periodStart / 1000);

        let elapsedInPeriod = Math.floor((nowSeconds - periodStart) / 60);
        if (elapsedInPeriod < 0) elapsedInPeriod = 0;

        const isSecondHalf = statusType.includes('second') || 
                             statusDesc.includes('2nd') || 
                             item.time?.period === 2 || 
                             item.time?.currentPeriod === 2 ||
                             statusType === 'inprogress_2nd';

        if (isSecondHalf) return 45 + elapsedInPeriod;
        return elapsedInPeriod;
    }

    let initialTime = item.statusTime?.initial || item.time?.initial;
    if (initialTime) {
        if (initialTime > 9999999999) initialTime = Math.floor(initialTime / 1000);
        const elapsed = Math.floor((nowSeconds - initialTime) / 60);
        if (elapsed > 0 && elapsed <= 120) return elapsed;
    }

    const anyNum = statusDesc.match(/\d+/);
    if (anyNum) return parseInt(anyNum[0], 10);

    return 0;
}

// ==========================================
// 4. DIỄN BIẾN BÀN THẮNG THEO PHÚT
// ==========================================
async function fetchMatchIncidents(matchId, homeScore = 0, awayScore = 0) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
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
}

// ==========================================
// 5. LẤY DỮ LIỆU & PHÂN TÍCH KÈO BIẾN ĐỘNG
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
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 15000
        });
        return response.data?.events || response.data?.liveEvents || [];
    } catch (err) {
        return [];
    }
}

async function fetchSofaScoreStats(matchId) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
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
    } catch (err) {
        return { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0 };
    }
}

async function fetchRapidApiMatchStats(matchId) {
    try {
        const response = await axios.get(`https://${RAPIDAPI_HOST}/football-match-get-statistics?matchid=${matchId}`, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': RAPIDAPI_HOST
            },
            timeout: 6000
        });
        const statsObj = response.data?.stats || response.data?.statistics || {};
        return {
            rapidShotsTarget: (statsObj.homeShotsOnTarget || 0) + (statsObj.awayShotsOnTarget || 0),
            rapidCorners: (statsObj.homeCorners || 0) + (statsObj.awayCorners || 0)
        };
    } catch (err) {
        return { rapidShotsTarget: 0, rapidCorners: 0 };
    }
}

async function fetchMatchDetailStats(matchId) {
    const [sofaStats, rapidStats] = await Promise.all([
        fetchSofaScoreStats(matchId),
        fetchRapidApiMatchStats(matchId)
    ]);
    return { sofaStats, rapidStats };
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

    let scoreBoost = 0;
    let oddsNotes = [];
    const overLine = overOutcome.point;
    const price = overOutcome.price;
    const pointDiff = overLine - currentTotalGoals;

    if (pointDiff >= 0.75) {
        scoreBoost += 20;
        oddsNotes.push(`Line Over giữ mức cao (${overLine}) so với tổng ${currentTotalGoals} bàn`);
    } else if (pointDiff > 0) {
        scoreBoost += 10;
        oddsNotes.push(`Line Over (${overLine}) sát mốc nổ bàn`);
    }

    if (price <= 1.80) {
        scoreBoost += 18;
        oddsNotes.push(`Odds Over giảm sâu (${price}) - Dòng tiền đè mạnh cửa Tài`);
    } else if (price <= 1.95) {
        scoreBoost += 10;
        oddsNotes.push(`Odds Over đẹp (${price})`);
    } else if (price > 2.20) {
        scoreBoost -= 12;
        oddsNotes.push(`Odds Over cao (${price}) - Dấu hiệu nặng xỉu`);
    }

    return {
        bookmaker: foundMatch.bookmakers[0].title,
        line: overLine,
        odds: price,
        scoreBoost,
        oddsNoteText: oddsNotes.join(' | ')
    };
}

// ==========================================
// 6. THUẬT TOÁN AI CHẤM ĐIỂM CHUYÊN MÔN (RULE >= 60.0%)
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
    let matchAnalysis = [];
    let aiScore = 40.0;

    const sofaStats = metrics.sofaStats || { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0 };
    const rapidStats = metrics.rapidStats || { rapidShotsTarget: 0, rapidCorners: 0 };

    const maxShotsTarget = Math.max(sofaStats.shotsOnTarget, rapidStats.rapidShotsTarget);
    const maxCorners = Math.max(sofaStats.corners, rapidStats.rapidCorners);
    const totalShots = sofaStats.totalShots || 0;

    let hasTacticalData = false;

    // 1. Thẻ đỏ
    if (sofaStats.redCards > 0) {
        aiScore += 20;
        matchAnalysis.push(`🟥 Thẻ đỏ (${sofaStats.redCards} thẻ) - Hổng vị trí phòng ngự`);
        hasTacticalData = true;
    }

    // 2. Cú sút trúng đích
    if (maxShotsTarget >= 5) {
        aiScore += 25;
        matchAnalysis.push(`⚡ Sức ép sát thương cao: ${maxShotsTarget} cú sút trúng khung thành`);
        hasTacticalData = true;
    } else if (maxShotsTarget >= 1) {
        aiScore += 15;
        matchAnalysis.push(`🎯 Tần suất hãm thành tốt: ${maxShotsTarget} cú sút trúng đích`);
        hasTacticalData = true;
    }

    // 3. Đôi công (Tổng số cú sút)
    if (totalShots >= 12) {
        aiScore += 18;
        matchAnalysis.push(`🔥 Thế trận đôi công cởi mở: Tổng ${totalShots} cú sút hãm thành`);
        hasTacticalData = true;
    } else if (totalShots >= 6) {
        aiScore += 10;
        matchAnalysis.push(`⚽ Hai đội tích cực dứt điểm: Tổng ${totalShots} cú sút`);
        hasTacticalData = true;
    }

    // 4. Phạt góc
    if (maxCorners >= 6) {
        aiScore += 18;
        matchAnalysis.push(`🚩 Sức ép phạt góc dồn dập: ${maxCorners} quả`);
        hasTacticalData = true;
    } else if (maxCorners >= 2) {
        aiScore += 10;
        matchAnalysis.push(`🚩 Tần suất phạt góc: ${maxCorners} quả`);
        hasTacticalData = true;
    }

    // 5. Kèo biến động
    if (oddsAnalysis) {
        aiScore += oddsAnalysis.scoreBoost;
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
        if (oddsAnalysis.oddsNoteText) {
            matchAnalysis.push(`   └─> ${oddsAnalysis.oddsNoteText}`);
        }
        hasTacticalData = true;
    }

    const finalScore = Math.min(Math.max(aiScore, 40.0), 96.0).toFixed(1);

    // BÁO ĐỘNG KHI ĐIỂM AI đạt từ 60.0% trở lên
    const shouldSend = parseFloat(finalScore) >= 60.0 && hasTacticalData;

    return {
        efficiency: finalScore,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend
    };
}

// ==========================================
// 7. THÔNG BÁO TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const message = 
`🔔 RUNG CHUỔNG VÀNGGGG
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
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
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.message);
    }
}

// ==========================================
// 8. TIẾN TRÌNH QUÉT TỰ ĐỘNG (LOẠI BỎ CẢ U18 - HIỂN THỊ LOG QUÉT)
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI] Đang quét trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, sofaMatches] = await Promise.all([
            fetchOddsData(),
            fetchSofaScoreLive()
        ]);

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

            // 1. Lọc giải U18 trở xuống (U10..U18)
            if (isFilteredLeague(league, homeName, awayName)) {
                console.log(`[Trận #${index + 1}] [${league}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Giải trẻ U18 trở xuống`);
                continue;
            }

            // 2. Lọc mốc thời gian ngoài 65-88'
            if (elapsed < 65 || elapsed > 88) {
                console.log(`[Trận #${index + 1}] [Phút: ${elapsed}'] ${homeName} vs ${awayName} └─> [Bỏ qua]: Thời gian ngoài mốc 65-88'`);
                continue;
            }

            console.log(`[Đang Phân Tích AI] [ID: ${matchId}] [Phút: ${elapsed}'] [${league}] ${homeName} ${homeScore}-${awayScore} ${awayName}`);

            const metrics = await fetchMatchDetailStats(matchId);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, homeScore, awayScore);
                console.log(`    └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%)`);
                
                const pickItem = {
                    id: matchId,
                    league,
                    homeName,
                    awayName,
                    homeScore,
                    awayScore,
                    elapsed,
                    goalTimeline,
                    detailText: aiAnalysis.detailText,
                    ruleEfficiency: aiAnalysis.efficiency
                };
                await sendTelegramAlert(pickItem);
            } else {
                console.log(`    └─> [Bỏ qua]: chỉ số chuyên môn chưa đủ (${aiAnalysis.efficiency}%)`);
            }
        }
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

app.get('/', (req, res) => {
    res.send('Football Live AI Scanner Service is Running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
});