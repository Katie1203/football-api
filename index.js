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

// ==========================================
// HÀM TÍNH PHÚT TRẬN ĐẤU CHUẨN XÁC SOFASCORE
// ==========================================
function calculateExactMinute(item) {
    if (!item) return 0;

    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    // 1. Kiểm tra trạng thái Hết hiệp 1 / Hết trận
    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht') {
        return 45;
    }
    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft')) {
        return 90;
    }

    // 2. Ưu tiên lấy trực tiếp phút từ status.description (nếu API có sẵn dạng "62'", "35'")
    const matchDesc = statusDesc.match(/^(\d+)['\s]?$/);
    if (matchDesc) {
        return parseInt(matchDesc[1], 10);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    // 3. Tính dựa trên currentPeriodStartTimestamp (Mốc thời gian bắt đầu hiệp hiện tại)
    let periodStart = item.time?.currentPeriodStartTimestamp || item.statusTime?.currentPeriodStartTimestamp;
    
    if (periodStart) {
        // Chuẩn hóa millisecond về second nếu timestamp > 10 chữ số
        if (periodStart > 9999999999) {
            periodStart = Math.floor(periodStart / 1000);
        }

        let elapsedInPeriod = Math.floor((nowSeconds - periodStart) / 60);
        if (elapsedInPeriod < 0) elapsedInPeriod = 0;

        // Xử lý Hiệp 2 (cộng thêm 45 phút của Hiệp 1)
        const isSecondHalf = statusType.includes('second') || 
                             statusDesc.includes('2nd') || 
                             item.time?.period === 2 || 
                             item.time?.currentPeriod === 2 ||
                             statusType === 'inprogress_2nd';

        if (isSecondHalf) {
            return 45 + elapsedInPeriod;
        }
        return elapsedInPeriod;
    }

    // 4. Fallback: Tính theo initial timestamp
    let initialTime = item.statusTime?.initial || item.time?.initial;
    if (initialTime) {
        if (initialTime > 9999999999) initialTime = Math.floor(initialTime / 1000);
        const elapsed = Math.floor((nowSeconds - initialTime) / 60);
        if (elapsed > 0 && elapsed <= 120) return elapsed;
    }

    // 5. Trích xuất số bất kỳ trong status.description
    const anyNum = statusDesc.match(/\d+/);
    if (anyNum) {
        return parseInt(anyNum[0], 10);
    }

    return 0;
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
// 1. DIỄN BIẾN BÀN THẮNG THEO PHÚT (INCIDENTS)
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
        const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');

        if (goalEvents.length === 0) {
            return 'Chưa có bàn thắng (0-0)';
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
        return 'Chưa cập nhật được diễn biến bàn thắng';
    }
}

// ==========================================
// 2. LẤY DỮ LIỆU & THỐNG KÊ CHI TIẾT
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

async function fetchMatchDetailStats(matchId) {
    const [sofaStats, rapidStats] = await Promise.all([
        fetchSofaScoreStats(matchId),
        fetchRapidApiMatchStats(matchId)
    ]);
    return { sofaStats, rapidStats };
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

function evaluateMatchDynamicAI(metrics, elapsed, oddsAnalysis) {
    let matchAnalysis = [];
    let aiScore = 50.0;

    const sofaStats = metrics.sofaStats || { shotsOnTarget: 0, corners: 0, redCards: 0 };
    const rapidStats = metrics.rapidStats || { rapidShotsTarget: 0, rapidCorners: 0 };

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

    if (elapsed >= 70 && elapsed <= 85) {
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

// ==========================================
// 3. MẪU THÔNG BÁO TELEGRAM
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

        for (let index = 0; index < sofaMatches.length; index++) {
            const item = sofaMatches[index];
            const matchId = String(item.id);
            const elapsed = calculateExactMinute(item);
            const homeName = item.homeTeam?.name || 'Đội nhà';
            const awayName = item.awayTeam?.name || 'Đội khách';
            const homeScore = item.homeScore?.current ?? 0;
            const awayScore = item.awayScore?.current ?? 0;
            const league = parseLeagueName(item);

            console.log(`[Trận #${index + 1}] [ID: ${matchId}] [Phút: ${elapsed}'] [${league}] ${homeName} ${homeScore}-${awayScore} ${awayName}`);

            if (!matchId) continue;

            if (sentAlerts.has(matchId)) {
                console.log(`    └─> [Bỏ qua]: Đã gửi thông báo Telegram trước đó`);
                continue;
            }

            if (elapsed < 70) {
                console.log(`    └─> [Bỏ qua]: Chưa đủ 70 phút (${elapsed}' < 70')`);
                continue;
            }

            if (elapsed > 90) {
                console.log(`    └─> [Bỏ qua]: Đã hết trận (${elapsed}' > 90')`);
                continue;
            }

            const metrics = await fetchMatchDetailStats(matchId);
            const goalTimeline = await fetchMatchIncidents(matchId);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, elapsed, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
                console.log(`    └─> [AI CHỌN: NỔ BÀN H2] (${aiAnalysis.efficiency}%)`);
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
                console.log(`    └─> [Bỏ qua]: Độ tin cậy chưa đủ (${aiAnalysis.efficiency}% < 55%)`);
            }
        }
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