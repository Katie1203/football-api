const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

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

function calculateExactMinute(item) {
    if (!item) return 0;
    const statusType = String(item.status?.type || item.status?.description || '').toLowerCase();
    if (statusType.includes('halftime') || statusType === 'ht') return 45;
    if (statusType.includes('ended') || statusType === 'ft') return 90;

    const timeObj = item.statusTime || item.time || {};
    if (typeof timeObj.initial === 'number') {
        const elapsedMinutes = Math.floor((Math.floor(Date.now() / 1000) - timeObj.initial) / 60);
        if (elapsedMinutes > 0 && elapsedMinutes <= 120) return elapsedMinutes;
    }

    const match = String(item.status?.description || '').match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
}

function parseLeagueName(item) {
    if (!item) return 'Bóng Đá Quốc Tế';
    const category = item.tournament?.category?.name || item.category?.name || '';
    const tournament = item.tournament?.name || item.competitionName || '';
    if (category && tournament) {
        return tournament.toLowerCase().includes(category.toLowerCase()) ? tournament : `${category}: ${tournament}`;
    }
    return tournament || category || 'Bóng Đá Quốc Tế';
}

// ==========================================
// 1. LẤY DIỄN BIẾN BÀN THẮNG THEO PHÚT (INCIDENTS)
// ==========================================
async function fetchMatchIncidents(matchId) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 6000
        });

        const incidents = response.data?.incidents || [];
        // Lọc các sự kiện bàn thắng (goal, penalty, ownGoal)
        const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');

        if (goalEvents.length === 0) {
            return 'Chưa có bàn thắng (0-0)';
        }

        // Sắp xếp theo thứ tự thời gian tăng dần
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
        return 'Chưa cập nhật được diễn biến bàn thắng';
    }
}

// ==========================================
// 2. LẤY THỐNG KÊ & DỮ LIỆU NGUỒN
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
        let shotsOnTarget = 0, corners = 0, redCards = 0;
        if (Array.isArray(statisticsGroup) && statisticsGroup.length > 0) {
            const allStats = statisticsGroup[0]?.groups || [];
            allStats.forEach(group => {
                (group.statisticsItems || []).forEach(st => {
                    const name = String(st.name || '').toLowerCase();
                    const val = (parseInt(st.home, 10) || 0) + (parseInt(st.away, 10) || 0);
                    if (name.includes('shots on target')) shotsOnTarget = val;
                    if (name.includes('corner')) corners = val;
                    if (name.includes('red card')) redCards = val;
                });
            });
        }
        return { shotsOnTarget, corners, redCards };
    } catch (err) {
        return { shotsOnTarget: 0, corners: 0, redCards: 0 };
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

function evaluateTripleSourceAI(sofaStats, rapidStats, oddsAnalysis, elapsed) {
    let matchAnalysis = [];
    let aiScore = 50.0;

    const maxShotsTarget = Math.max(sofaStats.shotsOnTarget, rapidStats.rapidShotsTarget);
    const maxCorners = Math.max(sofaStats.corners, rapidStats.rapidCorners);

    if (oddsAnalysis) {
        aiScore = oddsAnalysis.scoreBoost * 0.5 + aiScore * 0.5;
        matchAnalysis.push(`💰 Tỷ lệ nhà cái (${oddsAnalysis.bookmaker}): Kèo Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
    }

    if (maxShotsTarget >= 5) {
        aiScore += 18;
        matchAnalysis.push(`⚡ Áp lực dứt điểm liên tục: ${maxShotsTarget} cú sút trúng khung thành`);
    } else if (maxShotsTarget >= 3) {
        aiScore += 10;
        matchAnalysis.push(`🎯 Tần suất hãm thành tốt: ${maxShotsTarget} cú sút trúng đích`);
    }

    if (maxCorners >= 6) {
        aiScore += 10;
        matchAnalysis.push(`🚩 Sức ép bóng chết cao: ${maxCorners} quả phạt góc`);
    }

    if (sofaStats.redCards > 0) {
        aiScore += 15;
        matchAnalysis.push(`🟥 Xuất hiện thẻ đỏ (${sofaStats.redCards} thẻ) - Hổng vị trí phòng ngự`);
    }

    if (elapsed >= 65 && elapsed <= 85) {
        aiScore += 5;
        matchAnalysis.push(`⏱ Thời điểm bùng nổ bàn thắng cuối trận (phút ${elapsed}')`);
    }

    const finalScore = Math.min(Math.max(aiScore, 35.0), 96.0).toFixed(1);
    const isHighProbability = parseFloat(finalScore) >= 65.0;

    return {
        efficiency: finalScore,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend: isHighProbability
    };
}

function analyzeOddsGoalProbability(allOdds, homeName, awayName, currentTotalGoals) {
    if (!Array.isArray(allOdds) || allOdds.length === 0) return null;
    const clean = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hClean = clean(homeName), aClean = clean(awayName);

    const foundMatch = allOdds.find(m => {
        const mHome = clean(m.home_team), mAway = clean(m.away_team);
        return (mHome.includes(hClean) || hClean.includes(mHome)) && (mAway.includes(aClean) || aClean.includes(mAway));
    });

    if (!foundMatch || !foundMatch.bookmakers?.[0]) return null;
    const totalsMarket = foundMatch.bookmakers[0].markets?.find(mk => mk.key === 'totals');
    const overOutcome = totalsMarket?.outcomes?.find(o => o.name === 'Over');
    if (!overOutcome) return null;

    let impliedProb = (1 / overOutcome.price) * 100;
    if (overOutcome.point - currentTotalGoals <= 0.75) impliedProb += 15;
    if (overOutcome.price <= 1.85) impliedProb += 10;

    return {
        bookmaker: foundMatch.bookmakers[0].title,
        line: overOutcome.point,
        odds: overOutcome.price,
        scoreBoost: Math.min(Math.max(impliedProb, 40.0), 90.0)
    };
}

// ==========================================
// 3. MẪU THÔNG BÁO TELEGRAM (BỔ SUNG DIỄN BIẾN TỶ SỐ)
// ==========================================
async function sendTelegramAlert(item) {
    const message = 
`🔔 RUNG CHUỔNG VÀNGGGG
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱️ Thời gian: Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🎯 Nhận định: Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG H2
📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi thông báo trận [${item.id}] ${item.homeName} vs ${item.awayName}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.message);
    }
}

// ==========================================
// 4. TIẾN TRÌNH QUÉT TỰ ĐỘNG
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI] Đang quét phân tích trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, sofaMatches] = await Promise.all([
            fetchOddsData(),
            fetchSofaScoreLive()
        ]);

        let countSent = 0;

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
            if (elapsed < 65 || elapsed > 90) continue;

            const [sofaStats, rapidStats, goalTimeline] = await Promise.all([
                fetchSofaScoreStats(matchId),
                fetchRapidApiMatchStats(matchId),
                fetchMatchIncidents(matchId) // Gọi thêm dữ liệu diễn biến bàn thắng
            ]);

            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateTripleSourceAI(sofaStats, rapidStats, oddsAnalysis, elapsed);

            if (aiAnalysis.shouldSend) {
                console.log(`    └─> [ĐẠT RULE ${aiAnalysis.efficiency}% >= 65%] Gửi Telegram...`);
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
                countSent++;
            }
        }
        console.log(`---> [KẾT QUẢ QUÉT] Hoàn tất quét. Đã gửi Telegram ${countSent} trận.`);
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

app.get('/', (req, res) => res.send('Football AI Service is Running!'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
});