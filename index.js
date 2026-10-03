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

// Cấu hình Nguồn RapidAPI Football Stats bổ sung
const FOOTBALL_RAPID_HOST = 'api-football-v1.p.rapidapi.com'; 

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
    'World': 'Quốc Tế',
    'Europe': 'Châu Âu',
    'Asia': 'Châu Á'
};

const LEAGUE_NAME_MAP = {
    'UEFA Champions League': 'Cúp C1 Châu Âu',
    'UEFA Europa League': 'Cúp C2 Châu Âu',
    'Premier League': 'Ngoại Hạng Anh',
    'LaLiga': 'VĐQG Tây Ban Nha',
    'Serie A': 'VĐQG Ý',
    'Bundesliga': 'VĐQG Đức',
    'Ligue 1': 'VĐQG Pháp',
    'J1 League': 'VĐQG Nhật Bản'
};

function parseLeagueName(item) {
    if (!item) return 'Bóng Đá Quốc Tế';
    let category = item.tournament?.category?.name || item.category?.name || '';
    let tournament = item.tournament?.name || item.competitionName || '';

    if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];
    const translatedCategory = COUNTRY_MAP[category] || category;
    return `${tournament} (${translatedCategory})`.trim();
}

function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    const youthRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;
    if (youthRegex.test(textToTest)) return true;

    const filterKeywords = ['simulated', 'srl', 'esports', 'e-soccer'];
    return filterKeywords.some(kw => textToTest.includes(kw));
}

function calculateExactMinute(item) {
    if (!item) return 0;
    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft') || statusType === 'ft') return 999;
    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht') return 45;

    if (item.time && typeof item.time.played === 'number' && item.time.played > 0) {
        return item.time.played;
    }

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

        if (isSecondHalf) return Math.min(45 + elapsedInPeriod, 90);
        return Math.min(elapsedInPeriod, 45);
    }
    return 0;
}

// ==========================================
// 2. DIỄN BIẾN BÀN THẮNG
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
            return totalGoals > 0 ? `• Tỷ số hiện tại: ${homeScore}-${awayScore}` : '• Chưa có bàn thắng (0-0)';
        }

        goalEvents.sort((a, b) => (a.time || 0) - (b.time || 0));
        return goalEvents.map(g => {
            const min = g.time || 0;
            const player = g.player?.shortName || g.player?.name || 'Cầu thủ';
            const isHome = g.isHome ? '⚽ [Chủ]' : '⚽ [Khách]';
            return `• Phút ${min}': ${isHome} ${player} [${g.homeScore}-${g.awayScore}]`;
        }).join('\n');
    } catch (err) {
        return `• Tỷ số hiện tại: ${homeScore}-${awayScore}`;
    }
}

// ==========================================
// 3. ĐỒNG BỘ 3 NGUỒN: SOFASCORE + ODDS + RAPIDAPI STATS
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

// Hàm lấy thống kê kết hợp SofaScore và dò ID bù trừ từ RapidAPI Football
async function fetchMatchDetailStats(matchId, homeName, awayName) {
    let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;

    // Nguồn 1: Quét trực tiếp SofaScore
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 5000
        });

        const statistics = response.data?.statistics;
        if (Array.isArray(statistics)) {
            statistics.forEach(period => {
                const groups = period.groups || [];
                groups.forEach(group => {
                    const items = group.statisticsItems || [];
                    items.forEach(st => {
                        const name = String(st.name || st.slug || '').toLowerCase();
                        const homeVal = parseInt(st.home, 10) || 0;
                        const awayVal = parseInt(st.away, 10) || 0;
                        const sumVal = homeVal + awayVal;

                        if (name.includes('shotontarget') || name.includes('sút trúng đích')) shotsOnTarget = Math.max(shotsOnTarget, sumVal);
                        else if (name.includes('totalshots') || name.includes('tổng số cú sút') || name.includes('shots')) totalShots = Math.max(totalShots, sumVal);
                        else if (name.includes('corner') || name.includes('phạt góc')) corners = Math.max(corners, sumVal);
                        else if (name.includes('redcard') || name.includes('thẻ đỏ')) redCards = Math.max(redCards, sumVal);
                    });
                });
            });
        }
    } catch (e) {}

    // Nguồn 2: Nếu SofaScore chưa trả đủ số liệu, gọi bổ sung RapidAPI Football dựa theo tên đội
    if (shotsOnTarget === 0 && corners === 0) {
        try {
            const todayStr = new Date().toISOString().slice(0, 10);
            const rapidRes = await axios.get(`https://${FOOTBALL_RAPID_HOST}/v3/fixtures`, {
                params: { date: todayStr, live: 'all' },
                headers: {
                    'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                    'x-rapidapi-host': FOOTBALL_RAPID_HOST
                },
                timeout: 5000
            });

            const fixtures = rapidRes.data?.response || [];
            const cleanTargetHome = homeName.toLowerCase().replace(/[^a-z0-9]/g, '');
            const cleanTargetAway = awayName.toLowerCase().replace(/[^a-z0-9]/g, '');

            const matchedFixture = fixtures.find(f => {
                const fHome = f.teams.home.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                const fAway = f.teams.away.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                return (fHome.includes(cleanTargetHome) || cleanTargetHome.includes(fHome)) &&
                       (fAway.includes(cleanTargetAway) || cleanTargetAway.includes(fAway));
            });

            if (matchedFixture && matchedFixture.fixture?.id) {
                const statRes = await axios.get(`https://${FOOTBALL_RAPID_HOST}/v3/fixtures/statistics`, {
                    params: { fixture: matchedFixture.fixture.id },
                    headers: {
                        'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                        'x-rapidapi-host': FOOTBALL_RAPID_HOST
                    },
                    timeout: 5000
                });

                const statData = statRes.data?.response || [];
                statData.forEach(teamStat => {
                    const statsList = teamStat.statistics || [];
                    statsList.forEach(st => {
                        const type = String(st.type || '').toLowerCase();
                        const val = parseInt(st.value, 10) || 0;
                        if (type.includes('shots on goal')) shotsOnTarget += val;
                        else if (type.includes('total shots')) totalShots += val;
                        else if (type.includes('corner')) corners += val;
                        else if (type.includes('red card')) redCards += val;
                    });
                });
            }
        } catch (err) {}
    }

    return { sofaStats: { shotsOnTarget, totalShots, corners, redCards } };
}

function cleanTeamName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
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
        scoreBoost += 22;
        oddsNotes.push(`Line Over giữ mức cao (${overLine}) so với tổng ${currentTotalGoals} bàn`);
    } else if (pointDiff > 0) {
        scoreBoost += 12;
        oddsNotes.push(`Line Over (${overLine}) sát mốc nổ bàn`);
    }

    if (price <= 1.80) {
        scoreBoost += 20;
        oddsNotes.push(`Odds Over giảm sâu (${price}) - Dòng tiền đè mạnh cửa Tài`);
    } else if (price <= 1.95) {
        scoreBoost += 12;
        oddsNotes.push(`Odds Over đẹp (${price})`);
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
// 4. THUẬT TOÁN AI CHẤM ĐIỂM (BASE 40%, RULE >= 65%)
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis, homeScore, awayScore, elapsed) {
    let matchAnalysis = [];
    let aiScore = 40.0; // Điểm cơ sở 40.0%

    const sofaStats = metrics.sofaStats || { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0 };
    const maxShotsTarget = sofaStats.shotsOnTarget;
    const maxCorners = sofaStats.corners;
    const totalShots = sofaStats.totalShots;

    let hasTacticalData = false;

    // Đánh giá thời điểm vàng cuối trận
    const totalGoals = homeScore + awayScore;
    if (elapsed >= 65 && elapsed <= 88) {
        if (totalGoals === 0) {
            aiScore += 24;
            matchAnalysis.push(`⏱ Thời điểm vàng (${elapsed}'): Chưa có bàn thắng, áp lực dâng cao`);
            hasTacticalData = true;
        } else if (totalGoals > 0) {
            aiScore += 20;
            matchAnalysis.push(`⏱ Thời điểm nhạy cảm (${elapsed}'): Tỷ số ${homeScore}-${awayScore}, khả năng cao nổ thêm bàn`);
            hasTacticalData = true;
        }
    }

    if (sofaStats.redCards > 0) {
        aiScore += 20;
        matchAnalysis.push(`🟥 Thẻ đỏ (${sofaStats.redCards} thẻ) - Hổng vị trí phòng ngự`);
        hasTacticalData = true;
    }

    if (maxShotsTarget >= 3) {
        aiScore += 25;
        matchAnalysis.push(`🎯 Sút trúng đích dồn dập: ${maxShotsTarget}`);
        hasTacticalData = true;
    }

    if (maxCorners >= 5) {
        aiScore += 18;
        matchAnalysis.push(`🚩 Phạt góc liên tục: ${maxCorners} quả`);
        hasTacticalData = true;
    }

    if (oddsAnalysis) {
        aiScore += oddsAnalysis.scoreBoost;
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
        if (oddsAnalysis.oddsNoteText) matchAnalysis.push(`   └─> ${oddsAnalysis.oddsNoteText}`);
        hasTacticalData = true;
    }

    const finalScore = Math.min(Math.max(aiScore, 40.0), 96.0).toFixed(1);
    const shouldSend = parseFloat(finalScore) >= 65.0 && hasTacticalData;

    return {
        efficiency: finalScore,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend
    };
}

// ==========================================
// 5. THÔNG BÁO TELEGRAM & TIẾN TRÌNH QUÉT
// ==========================================
async function sendTelegramAlert(item) {
    const message = 
`🔔 RUNG CHUỔNG VÀNGGGG
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ:
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
        sentAlerts.add(item.id);
    } catch (err) {}
}

async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n[Auto-Scan AI] Đang quét trận đấu... (${currentVN.timeStr})`);

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

            if (!matchId || sentAlerts.has(matchId)) continue;
            if (isFilteredLeague(league, homeName, awayName)) continue;
            if (elapsed === 999 || elapsed < 65 || elapsed > 90) continue;

            console.log(`[Phân Tích] [Phút: ${elapsed}'] [${league}] ${homeName} ${homeScore}-${awayScore} ${awayName}`);

            const metrics = await fetchMatchDetailStats(matchId, homeName, awayName);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis, homeScore, awayScore, elapsed);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, homeScore, awayScore);
                console.log(`    └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%)`);
                
                await sendTelegramAlert({
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
                });
            } else {
                console.log(`    └─> [Bỏ qua]: Điểm AI chưa đủ (${aiAnalysis.efficiency}%)`);
            }
        }
    } catch (err) {}
}

app.get('/', (req, res) => res.send('Football Live AI Scanner Service is Running!'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
});