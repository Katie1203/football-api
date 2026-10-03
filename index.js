const express = require('express');
const axios = require('axios');
const path = require('path');

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
// BỘ LỌC GIẢI TRẺ (LOẠI BỎ U18 TRỞ XUỐNG)
// ==========================================
function isYouthOrUnder18League(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    
    // Pattern khớp U15, U16, U17, U18, Sub-15..18, Under-15..18
    const youthRegex = /\b(u-?1[0-8]|sub-?1[0-8]|under-?1[0-8])\b/i;
    
    if (youthRegex.test(textToTest)) return true;

    const keywords = [
        'youth', 'academy', 'cadete', 'juvenil', 'juniors', 'junior',
        'u15', 'u16', 'u17', 'u18', 'sub15', 'sub16', 'sub17', 'sub18'
    ];

    return keywords.some(kw => textToTest.includes(kw));
}

// ==========================================
// TÍNH PHÚT TRẬN ĐẤU CHUẨN XÁC
// ==========================================
function calculateExactMinute(item) {
    if (!item) return 0;

    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht') {
        return 45;
    }
    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft')) {
        return 90;
    }

    const matchDesc = statusDesc.match(/^(\d+)['\s]?$/);
    if (matchDesc) {
        return parseInt(matchDesc[1], 10);
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

        if (isSecondHalf) {
            return 45 + elapsedInPeriod;
        }
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
// 1. DIỄN BIẾN BÀN THẮNG THEO PHÚT
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
// 2. LẤY DỮ LIỆU & CHUẨN HÓA KÈO ODDS
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

// Chuẩn hóa tên đội bóng loại bỏ từ thừa
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
    const pointDiff = overOutcome.point - currentTotalGoals;

    if (pointDiff <= 0.75 && pointDiff > 0) scoreBoost += 20;
    if (overOutcome.price <= 1.85) scoreBoost += 15;

    return {
        bookmaker: foundMatch.bookmakers[0].title,
        line: overOutcome.point,
        odds: overOutcome.price,
        scoreBoost
    };
}

// ==========================================
// 3. THUẬT TOÁN ĐÁNH GIÁ AI ĐỘ CHÍNH XÁC CAO
// ==========================================
function evaluateMatchDynamicAI(metrics, elapsed, oddsAnalysis) {
    let matchAnalysis = [];
    let aiScore = 20.0; // Điểm cơ sở thấp để đảm bảo phải có chỉ số ép sân thực tế

    const sofaStats = metrics.sofaStats || { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0 };
    const rapidStats = metrics.rapidStats || { rapidShotsTarget: 0, rapidCorners: 0 };

    const maxShotsTarget = Math.max(sofaStats.shotsOnTarget, rapidStats.rapidShotsTarget);
    const maxCorners = Math.max(sofaStats.corners, rapidStats.rapidCorners);

    let hasAttackingData = false;

    // 1. Phân tích Sút trúng đích (Trọng số lớn nhất)
    if (maxShotsTarget >= 6) {
        aiScore += 30;
        matchAnalysis.push(`⚡ Tần suất hãm thành cực cao: ${maxShotsTarget} cú sút trúng khung thành`);
        hasAttackingData = true;
    } else if (maxShotsTarget >= 3) {
        aiScore += 18;
        matchAnalysis.push(`🎯 Sức ép dứt điểm tốt: ${maxShotsTarget} cú sút trúng đích`);
        hasAttackingData = true;
    } else if (maxShotsTarget > 0) {
        aiScore += 8;
        matchAnalysis.push(`🎯 Tổng số cú sút trúng đích: ${maxShotsTarget}`);
        hasAttackingData = true;
    }

    // 2. Phân tích Phạt góc
    if (maxCorners >= 7) {
        aiScore += 18;
        matchAnalysis.push(`🚩 Sức ép bóng chết lớn: ${maxCorners} quả phạt góc`);
        hasAttackingData = true;
    } else if (maxCorners >= 4) {
        aiScore += 10;
        matchAnalysis.push(`🚩 Phạt góc: ${maxCorners} quả`);
        hasAttackingData = true;
    }

    // 3. Biến động Thẻ đỏ
    if (sofaStats.redCards > 0) {
        aiScore += 15;
        matchAnalysis.push(`🟥 Thẻ đỏ (${sofaStats.redCards} thẻ) - Lợi thế xáo trộn hệ thống phòng ngự`);
        hasAttackingData = true;
    }

    // 4. Mốc thời gian bùng nổ (Phút 72 - 85)
    if (elapsed >= 72 && elapsed <= 85) {
        aiScore += 8;
        matchAnalysis.push(`⏱ Khung giờ vàng dồn ép bàn thắng (phút ${elapsed}')`);
    }

    // 5. Phân tích Kèo Odds Dòng tiền
    if (oddsAnalysis) {
        aiScore += oddsAnalysis.scoreBoost;
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds})`);
        hasAttackingData = true;
    }

    if (!hasAttackingData) {
        matchAnalysis.push(`⚠️ Giải đấu thiếu dữ liệu thống kê chi tiết`);
    }

    const finalScore = Math.min(Math.max(aiScore, 20.0), 96.0).toFixed(1);

    // Bắt buộc phải đạt ít nhất 60.0% VÀ có dữ liệu tấn công thực tế
    const shouldSend = parseFloat(finalScore) >= 60.0 && hasAttackingData;

    return {
        efficiency: finalScore,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend
    };
}

// ==========================================
// 4. MẪU THÔNG BÁO TELEGRAM
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

🎯 Nhận định: Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG
📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi cảnh báo: ${item.homeName} vs ${item.awayName} (${item.ruleEfficiency}%)`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.message);
    }
}

// ==========================================
// 5. TIẾN TRÌNH QUÉT TỰ ĐỘNG
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI] Đang phân tích các trận đấu live... (${currentVN.timeStr})`);

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
                console.log(`    └─> [Bỏ qua]: Đã gửi thông báo trước đó`);
                continue;
            }

            // BỘ LỌC GIẢI TRẺ U18 TRỞ XUỐNG
            if (isYouthOrUnder18League(league, homeName, awayName)) {
                console.log(`    └─> [Bỏ qua]: Giải đấu trẻ U18 trở xuống (${league})`);
                continue;
            }

            // MỐC THỜI GIAN PHÂN TÍCH
            if (elapsed < 65) {
                console.log(`    └─> [Bỏ qua]: Chưa đủ 65 phút (${elapsed}' < 65')`);
                continue;
            }

            if (elapsed > 88) {
                console.log(`    └─> [Bỏ qua]: Đã quá bù giờ/Gần hết giờ (${elapsed}' > 88')`);
                continue;
            }

            const metrics = await fetchMatchDetailStats(matchId);
            const goalTimeline = await fetchMatchIncidents(matchId, homeScore, awayScore);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, elapsed, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
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
                console.log(`    └─> [Bỏ qua]: Chỉ số ép sân thấp hoặc thiếu dữ liệu (${aiAnalysis.efficiency}%)`);
            }
        }
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
});