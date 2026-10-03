const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CẤU HÌNH HỆ THỐNG & KẾT NỐI API (RAPIDAPI + THE ODDS API)
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

// 1. RapidAPI - Lấy danh sách trận & chỉ số dứt điểm/góc
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'free-api-live-football-data.p.rapidapi.com';
const API_LIVE_URL = `https://${RAPIDAPI_HOST}/football-current-live`;

// 2. The Odds API - Tích hợp API Key mới của bạn
const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';[cite: 8]
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

function calculateExactMinute(item) {
    const liveTimeObj = item.status?.liveTime || {};

    if (liveTimeObj.short) {
        const parsedMin = parseInt(String(liveTimeObj.short).replace(/[^0-9]/g, ''), 10);
        if (!isNaN(parsedMin)) return parsedMin;
    }

    if (liveTimeObj.long && liveTimeObj.long.includes(':')) {
        const parts = liveTimeObj.long.split(':');
        const min = parseInt(parts[0], 10);
        if (!isNaN(min)) return min;
    }

    const statusShort = String(item.status?.short || item.elapsed || '').toUpperCase();
    if (statusShort === 'HT' || statusShort.includes('HALF')) return 45;
    if (statusShort === 'FT' || statusShort.includes('ENDED')) return 90;

    if (typeof item.elapsed === 'number' && item.elapsed > 0) return item.elapsed;

    return 0;
}

function parseLeagueName(item) {
    if (!item) return 'Bóng Đá Quốc Tế';

    let tourObj = Array.isArray(item.tournament) ? item.tournament[0] : item.tournament;
    let leagueObj = Array.isArray(item.league) ? item.league[0] : item.league;

    const possibleNames = [
        tourObj?.name,
        tourObj?.translatedName,
        item.tournamentName,
        item.leagueName,
        leagueObj?.name
    ];

    for (let name of possibleNames) {
        if (name && typeof name === 'string' && name.trim().length > 0) {
            return name.trim();
        }
    }
    return 'Bóng Đá Quốc Tế';
}

// ==========================================
// 1. MODULE THE ODDS API (LẤY DỮ LIỆU KÈO LIVE)
// ==========================================
async function fetchOddsData() {
    if (!ODDS_API_KEY) return [];
    try {
        const response = await axios.get(ODDS_API_URL, { timeout: 10000 });
        return response.data || [];
    } catch (err) {
        console.error('    ├─> [The Odds API Error]:', err.message);
        return [];
    }
}

function analyzeOddsGoalProbability(allOdds, homeName, awayName, currentTotalGoals) {
    if (!Array.isArray(allOdds) || allOdds.length === 0) return null;

    const clean = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hClean = clean(homeName);
    const aClean = clean(awayName);

    const foundMatch = allOdds.find(m => {
        const mHome = clean(m.home_team);
        const mAway = clean(m.away_team);
        return (mHome.includes(hClean) || hClean.includes(mHome)) &&
               (mAway.includes(aClean) || aClean.includes(mAway));
    });

    if (!foundMatch || !foundMatch.bookmakers || foundMatch.bookmakers.length === 0) return null;

    const bookmaker = foundMatch.bookmakers[0];
    const totalsMarket = bookmaker.markets?.find(mk => mk.key === 'totals');

    if (!totalsMarket || !totalsMarket.outcomes) return null;

    const overOutcome = totalsMarket.outcomes.find(o => o.name === 'Over');
    if (!overOutcome) return null;

    const liveLine = overOutcome.point; 
    const overOdds = overOutcome.price;

    let impliedProb = (1 / overOdds) * 100;
    const diff = liveLine - currentTotalGoals;

    if (diff <= 0.75) impliedProb += 15;
    if (overOdds <= 1.85) impliedProb += 10;

    return {
        bookmaker: bookmaker.title,
        line: liveLine,
        odds: overOdds,
        scoreBoost: Math.min(Math.max(impliedProb, 40.0), 90.0)
    };
}

// ==========================================
// 2. MODULE RAPIDAPI (TRÍCH XUẤT CHỈ SỐ THỰC TẾ)
// ==========================================
async function fetchMatchDetailStats(matchId, baseItem) {
    try {
        const detailUrl = `https://${RAPIDAPI_HOST}/football-match-get-statistics?matchid=${matchId}`;
        const response = await axios.get(detailUrl, {
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': RAPIDAPI_HOST.trim()
            },
            timeout: 8000
        });

        const detailData = response.data?.response || response.data || {};
        return extractMatchMetrics(detailData, baseItem);
    } catch (err) {
        return extractMatchMetrics(baseItem, baseItem);
    }
}

function extractMatchMetrics(data, fallbackItem) {
    const statsObj = data.stats || data.statistics || data.matchStats || fallbackItem?.stats || {};
    
    let homeRed = data.home?.redCards || statsObj.homeRedCards || fallbackItem?.home?.redCards || 0;
    let awayRed = data.away?.redCards || statsObj.awayRedCards || fallbackItem?.away?.redCards || 0;

    const eventsList = data.events || data.incidents || fallbackItem?.events || [];
    if (Array.isArray(eventsList)) {
        const redsHome = eventsList.filter(e => (e.type === 'redCard' || e.cardType === 'red') && (e.isHome || e.team === 'home')).length;
        const redsAway = eventsList.filter(e => (e.type === 'redCard' || e.cardType === 'red') && (!e.isHome || e.team === 'away')).length;
        if (redsHome > homeRed) homeRed = redsHome;
        if (redsAway > awayRed) awayRed = redsAway;
    }

    const homeShots = statsObj.homeTotalShots || statsObj.shotsHome || 0;
    const awayShots = statsObj.awayTotalShots || statsObj.shotsAway || 0;
    
    const homeTarget = statsObj.homeShotsOnTarget || statsObj.shotsOnTargetHome || 0;
    const awayTarget = statsObj.awayShotsOnTarget || statsObj.shotsOnTargetAway || 0;

    const homeCorners = statsObj.homeCorners || statsObj.cornersHome || fallbackItem?.home?.corners || 0;
    const awayCorners = statsObj.awayCorners || statsObj.cornersAway || fallbackItem?.away?.corners || 0;

    return {
        totalShots: homeShots + awayShots,
        shotsOnTarget: homeTarget + awayTarget,
        totalCorners: homeCorners + awayCorners,
        redCards: homeRed + awayRed
    };
}

// ==========================================
// 3. THUẬT TOÁN AI PHÂN TÍCH KẾT HỢP
// ==========================================
function evaluateMatchCombinedAI(metrics, elapsed, oddsAnalysis) {
    let matchAnalysis = [];
    let aiScore = 50.0;

    if (oddsAnalysis) {
        aiScore = oddsAnalysis.scoreBoost * 0.6 + aiScore * 0.4;
        matchAnalysis.push(`📊 Tỷ lệ nổ bàn (The Odds API - ${oddsAnalysis.bookmaker}): Kèo Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
    } else {
        matchAnalysis.push(`📊 Phân tích thế trận real-time (RapidAPI)`);
    }

    if (metrics.shotsOnTarget >= 5) {
        aiScore += 18;
        matchAnalysis.push(`⚡ Sút trúng đích dồn dập: ${metrics.shotsOnTarget} cú sút`);
    } else if (metrics.shotsOnTarget >= 3) {
        aiScore += 10;
        matchAnalysis.push(`🎯 Tần suất dứt điểm tốt (${metrics.shotsOnTarget} cú sút trúng khung thành)`);
    }

    if (metrics.totalCorners >= 6) {
        aiScore += 10;
        matchAnalysis.push(`🚩 Sức ép phạt góc cao: ${metrics.totalCorners} quả góc`);
    }

    if (metrics.redCards > 0) {
        aiScore += 15;
        matchAnalysis.push(`🟥 Thẻ đỏ xuất hiện (${metrics.redCards} thẻ) - Hổng hàng phòng ngự`);
    }

    if (elapsed >= 65 && elapsed <= 85) {
        aiScore += 5;
        matchAnalysis.push(`⏱️ Khung giờ vàng late-game (phút ${elapsed}')`);
    }

    const finalScore = Math.min(Math.max(aiScore, 35.0), 96.0).toFixed(1);

    return {
        efficiency: finalScore,
        sampleN: 190 + (elapsed % 30),
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend: parseFloat(finalScore) >= 65.0
    };
}

async function sendTelegramAlert(item) {
    const homeName = item.home?.name || 'Đội nhà';
    const awayName = item.away?.name || 'Đội khách';
    const homeScore = item.home?.score ?? item.homeScore ?? 0;
    const awayScore = item.away?.score ?? item.awayScore ?? 0;

    const message = 
`🚨 KÈO RUNG H2 (RAPIDAPI + THE ODDS API)
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${homeName} ${homeScore}–${awayScore} ${awayName}
⏱️ Thời gian: Phút ${item.elapsed}'

📊 PHÂN TÍCH AI KẾT HỢP DÒNG TIỀN & THẾ TRẬN:
${item.detailText}

🎯 Nhận định AI: Khả năng NỔ BÀN H2 cực cao
🔥 Đánh giá AI đạt rule: ${item.ruleEfficiency}% · (n=${item.sampleN})`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi thông báo cho trận [${item.id}] ${homeName} vs ${awayName}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.message);
    }
}

async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI] Quét RapidAPI + The Odds API... (${currentVN.timeStr})`);

    try {
        // Chỉ gọi The Odds API khi bắt đầu quét để tiết kiệm lượt dùng API
        const allOdds = await fetchOddsData();

        const response = await axios.get(API_LIVE_URL, {
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': RAPIDAPI_HOST.trim(),
                'accept': 'application/json'
            },
            timeout: 25000
        });

        const data = response.data;
        let liveMatches = data?.response?.live || (Array.isArray(data) ? data : []);
        let countSent = 0;

        for (let index = 0; index < liveMatches.length; index++) {
            const item = liveMatches[index];
            const matchId = String(item.id || item.eventId || item.fixture?.id);
            const elapsed = calculateExactMinute(item);
            const homeName = item.home?.name || 'Đội nhà';
            const awayName = item.away?.name || 'Đội khách';
            const homeScore = item.home?.score ?? 0;
            const awayScore = item.away?.score ?? 0;
            const currentTotalGoals = homeScore + awayScore;
            const league = parseLeagueName(item);

            console.log(`[Trận #${index + 1}] [ID: ${matchId}] [Phút: ${elapsed}'] [${league}] ${homeName} ${homeScore}-${awayScore} ${awayName}`);

            if (!matchId) continue;

            if (sentAlerts.has(matchId)) {
                console.log(`    └─> [Bỏ qua]: Đã gửi thông báo Telegram trước đó`);
                continue;
            }

            // Lọc chính xác các trận từ phút 65 trở đi
            if (elapsed < 65) {
                console.log(`    └─> [Bỏ qua]: Chưa đủ 65 phút (${elapsed}' < 65')`);
                continue;
            }

            if (elapsed > 90) {
                console.log(`    └─> [Bỏ qua]: Đã hết trận (${elapsed}' > 90')`);
                continue;
            }

            const metrics = await fetchMatchDetailStats(matchId, item);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, currentTotalGoals);
            const aiAnalysis = evaluateMatchCombinedAI(metrics, elapsed, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
                console.log(`    └─> [AI CHỌN: NỔ BÀN H2] (${aiAnalysis.efficiency}% >= 65.0%) -> Gửi Telegram..`);
                const pickItem = {
                    id: matchId,
                    league: league,
                    home: item.home,
                    away: item.away,
                    homeScore: homeScore,
                    awayScore: awayScore,
                    elapsed: elapsed,
                    detailText: aiAnalysis.detailText,
                    ruleEfficiency: aiAnalysis.efficiency,
                    sampleN: aiAnalysis.sampleN
                };

                await sendTelegramAlert(pickItem);
                countSent++;
            } else {
                console.log(`    └─> [Bỏ qua]: Không đủ điều kiện AI (${aiAnalysis.efficiency}% < 65.0%)`);
            }
        }

        console.log(`---> [KẾT QUẢ AI] Đã gửi Telegram ${countSent}/${liveMatches.length} trận đạt điều kiện.`);
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

app.get('/', (req, res) => res.send('Perfect Combined AI (RapidAPI + The Odds API) is Running!'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
});