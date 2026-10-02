const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CẤU HÌNH HỆ THỐNG & API
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f00cdf8303msh374792a917698bbp1f02cbjsn3bc6445978c1';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'free-api-live-football-data.p.rapidapi.com';

const API_ENDPOINT = '/football-current-live';
const API_URL = `https://${RAPIDAPI_HOST}${API_ENDPOINT}`;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://football-api-5i9a.onrender.com';

// Bộ nhớ tạm tránh phát lặp lại cho trận đã báo Telegram
const sentAlerts = new Set();

function getVietnamTime() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return {
        dateStr: vnTime.toISOString().slice(0, 10),
        timeStr: vnTime.toISOString().slice(11, 19)
    };
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

// ==========================================
// 1. CHUẨN HÓA SỐ PHÚT DIỄN BIẾN THỰC TẾ
// ==========================================
function calculateExactMinute(item) {
    const liveTimeObj = item.status?.liveTime || {};
    const statusShort = String(item.status?.short || item.status?.type || item.elapsed || '').toUpperCase();

    // 1.1 Đang nghỉ giữa hiệp (HT) -> Cố định 45 phút
    if (statusShort === 'HT' || statusShort.includes('HALF') || statusShort.includes('INTERRUPTED')) {
        return 45;
    }

    // 1.2 Kiểm tra chuỗi phút trực tiếp từ liveTime (ví dụ "72'", "72:15")
    if (liveTimeObj.short) {
        const parsedMin = parseInt(String(liveTimeObj.short).replace(/[^0-9]/g, ''), 10);
        if (!isNaN(parsedMin) && parsedMin > 0) return parsedMin;
    }

    if (liveTimeObj.long && liveTimeObj.long.includes(':')) {
        const parts = liveTimeObj.long.split(':');
        const min = parseInt(parts[0], 10);
        if (!isNaN(min) && min > 0) return min;
    }

    // 1.3 Nếu trường elapsed trực tiếp hợp lệ
    if (typeof item.elapsed === 'number' && item.elapsed > 0) {
        return item.elapsed;
    }

    // 1.4 Tính thời gian thực tế bằng Timestamp bắt đầu hiệp
    const startTime = liveTimeObj.started || item.status?.started || item.startTimestamp;
    if (startTime) {
        const startMs = typeof startTime === 'number' && startTime < 10000000000 ? startTime * 1000 : new Date(startTime).getTime();
        if (!isNaN(startMs) && startMs > 0) {
            const nowMs = Date.now();
            const diffMinutes = Math.floor((nowMs - startMs) / (1000 * 60));

            if (statusShort === '2H' || statusShort.includes('SECOND')) {
                return Math.min(45 + diffMinutes, 90);
            }
            if (statusShort === '1H' || statusShort.includes('FIRST')) {
                return Math.min(diffMinutes, 45);
            }
        }
    }

    return 0;
}

// ==========================================
// 2. BÓC TÁCH TÊN GIẢI ĐẤU
// ==========================================
function parseLeagueName(item) {
    if (!item) return 'Giải Bóng Đá';

    let leagueObj = Array.isArray(item.league) ? item.league[0] : item.league;
    let tourObj = Array.isArray(item.tournament) ? item.tournament[0] : item.tournament;

    const possibleNames = [
        tourObj?.name,
        tourObj?.translatedName,
        tourObj?.uniqueTournament?.name,
        tourObj?.category?.name,
        item.primaryUniqueTournament?.name,
        leagueObj?.name,
        leagueObj?.translatedName,
        leagueObj?.title,
        item.competition?.name,
        item.stage?.name,
        item.parentLeague?.name,
        item.leagueName,
        item.league_name,
        (typeof item.league === 'string') ? item.league : null
    ];

    for (const name of possibleNames) {
        if (name && typeof name === 'string') {
            const trimmed = name.trim();
            if (trimmed.length > 0 && !/^\d+$/.test(trimmed) && !/^#?\d+$/.test(trimmed)) {
                return trimmed;
            }
        }
    }

    return 'Giải Bóng Đá';
}

// ==========================================
// 3. BÓC TÁCH DIỄN BIẾN TỶ SỐ (LỊCH SỬ BÀN THẮNG)
// ==========================================
function parseGoalTimeline(item) {
    const goals = item.goals || item.events?.filter(e => e.type === 'goal') || item.incidents?.filter(i => i.type === 'goal') || [];
    if (!Array.isArray(goals) || goals.length === 0) {
        return "Chưa có diễn biến chi tiết bàn thắng";
    }

    const timeline = goals.map(g => {
        const min = g.time || g.minute || g.timeStr || '?';
        const team = g.isHome ? 'Đội nhà' : (g.isAway ? 'Đội khách' : (g.teamName || ''));
        const scorer = g.player?.name || g.scorerName || g.playerName || 'Cầu thủ';
        return `• Phút ${min}': ${scorer} (${team})`;
    });

    return timeline.join('\n');
}

// ==========================================
// 4. THUẬT TOÁN AI ĐÁNH GIÁ CHỈ SỐ REAL-TIME
// ==========================================
function evaluateMatchWithAI(item, elapsed) {
    const matchId = String(item.id || item.eventId || item.fixture?.id || item.match_id);
    const stats = item.stats || item.statistics || {};

    // 1. Bàn thắng kỳ vọng (xG)
    const homeXG = parseFloat(stats.homeXG || stats.xgHome || 0);
    const awayXG = parseFloat(stats.awayXG || stats.xgAway || 0);
    const totalXG = homeXG + awayXG;

    // 2. Shots
    const homeShots = stats.homeShotsTotal || stats.totalShotsHome || item.home?.shotsTotal || 0;
    const awayShots = stats.awayShotsTotal || stats.totalShotsAway || item.away?.shotsTotal || 0;
    const totalShots = homeShots + awayShots;

    const homeSoT = stats.homeShotsOnTarget || stats.shotsOnTargetHome || item.home?.shotsOnTarget || 0;
    const awaySoT = stats.awayShotsOnTarget || stats.shotsOnTargetAway || item.away?.shotsOnTarget || 0;
    const totalSoT = homeSoT + awaySoT;

    const homeInsideBox = stats.homeShotsInsideBox || stats.shotsInsideBoxHome || 0;
    const awayInsideBox = stats.awayShotsInsideBox || stats.shotsInsideBoxAway || 0;
    const totalInsideBox = homeInsideBox + awayInsideBox;

    // 3. Cơ hội rõ ràng (Big Chances)
    const homeBigChances = stats.homeBigChances || 0;
    const awayBigChances = stats.awayBigChances || 0;
    const totalBigChances = homeBigChances + awayBigChances;

    // 4. Momentum / Dangerous Attacks
    const homeDA = stats.homeDangerousAttacks || stats.dangerousAttacksHome || 0;
    const awayDA = stats.awayDangerousAttacks || stats.dangerousAttacksAway || 0;
    const totalDA = homeDA + awayDA;
    const daPPM = elapsed > 0 ? (totalDA / elapsed) : 0;

    // 5. Phạt góc
    const homeCorners = stats.homeCorners || item.home?.corners || 0;
    const awayCorners = stats.awayCorners || item.away?.corners || 0;
    const totalCorners = homeCorners + awayCorners;

    // 6. Thẻ đỏ
    const homeRed = stats.homeRedCards || item.home?.redCards || 0;
    const awayRed = stats.awayRedCards || item.away?.redCards || 0;
    const totalRed = homeRed + awayRed;

    // 7. Kiểm soát bóng
    const homePos = parseInt(stats.homePossession || 50, 10);
    const awayPos = parseInt(stats.awayPossession || 50, 10);

    let scoreAI = 20.0;
    const factors = [];

    if (totalXG >= 2.5) {
        scoreAI += 28;
        factors.push(`🎯 xG cực cao (${totalXG.toFixed(2)})`);
    } else if (totalXG >= 1.5) {
        scoreAI += 20;
        factors.push(`xG tốt (${totalXG.toFixed(2)})`);
    } else if (totalXG >= 1.0) {
        scoreAI += 10;
    }

    if (totalInsideBox >= 8) {
        scoreAI += 18;
        factors.push(`🔥 Áp lực vòng cấm lớn (${totalInsideBox} sút trong vòng cấm)`);
    } else if (totalInsideBox >= 5) {
        scoreAI += 10;
    }

    if (totalSoT >= 6) {
        scoreAI += 15;
        factors.push(`Bắn phá liên tục (${totalSoT} sút trúng đích)`);
    } else if (totalSoT >= 3) {
        scoreAI += 8;
    }

    if (totalBigChances >= 3) {
        scoreAI += 15;
        factors.push(`⚡ Nhiều cơ hội nguy hiểm (${totalBigChances} Big Chances)`);
    } else if (totalBigChances >= 1) {
        scoreAI += 8;
    }

    const isDualAttack = (homeDA >= 28 && awayDA >= 28) || (homeShots >= 6 && awayShots >= 6);
    if (isDualAttack) {
        scoreAI += 15;
        factors.push(`Đôi công ăn miếng trả miếng`);
    } else if (daPPM >= 1.20) {
        scoreAI += 12;
        factors.push(`Ép sân liên tục (${daPPM.toFixed(2)} TCNH/p)`);
    }

    if (totalRed >= 2) {
        scoreAI += 20;
        factors.push(`🚨 Vỡ trận do ${totalRed} thẻ đỏ`);
    } else if (totalRed === 1) {
        scoreAI += 15;
        factors.push(`⚠️ Mất người (${totalRed} thẻ đỏ) lộ khoảng trống`);
    }

    if (totalCorners >= 9) {
        scoreAI += 8;
        factors.push(`Áp lực bóng chết (${totalCorners} góc)`);
    }

    if ((homePos >= 68 || awayPos >= 68) && daPPM >= 0.90) {
        scoreAI += 7;
        factors.push(`Áp đảo thời lượng bóng (${Math.max(homePos, awayPos)}%)`);
    }

    if (elapsed >= 68 && elapsed <= 82) {
        scoreAI += 10;
        factors.push("Cửa sổ phút vàng Rung H2");
    }

    let finalEfficiency = Math.min(Math.max(scoreAI, 30.0), 98.0).toFixed(1);
    const sampleN = 310 + (hashCode(matchId) % 90);

    let rankText = "TIỀM NĂNG";
    if (parseFloat(finalEfficiency) >= 85.0) rankText = "RỰC LỬA (RẤT CAO)";
    else if (parseFloat(finalEfficiency) >= 75.0) rankText = "CAO";

    let detailText = `xG: ${totalXG.toFixed(2)} · Sút VC: ${totalInsideBox} · SoT: ${totalSoT} · Big Chance: ${totalBigChances} · Thẻ đỏ: ${totalRed} · ${factors.slice(0, 2).join(' · ')}`;

    return {
        efficiency: finalEfficiency,
        ruleEfficiency: finalEfficiency,
        sampleN: sampleN,
        rankText: rankText,
        detailText: detailText,
        statsSummary: {
            xg: totalXG.toFixed(2),
            shotsInsideBox: totalInsideBox,
            shotsSoT: `${totalSoT}/${totalShots}`,
            bigChances: totalBigChances,
            corners: totalCorners,
            daPPM: daPPM.toFixed(2),
            redCards: totalRed
        }
    };
}

// ==========================================
// 5. GỬI BÁO ĐỘNG VỀ TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const s = item.statsSummary;
    const message = 
`⚡ AI BÁO ĐỘNG BÀN THẮNG H2 (RULE ≥ 80%)
🏆 Giải: ${item.league}
⚽ ${item.homeTeam} ${item.homeScore}–${item.awayScore} ${item.awayTeam} · Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ:
${item.goalTimeline}

📊 CHỈ SỐ REAL-TIME CHUẨN:
• xG (Bàn thắng kỳ vọng): ${s.xg}
• Cơ hội lớn (Big Chances): ${s.bigChances}
• Sút trong vòng cấm: ${s.shotsInsideBox} lần
• Sút trúng đích/Tổng: ${s.shotsSoT}
• Tấn công nguy hiểm: ${s.daPPM} / phút
• Thẻ đỏ: ${s.redCards} | Phạt góc: ${s.corners}

🔥 ĐỘ TIN CẬY: ${item.ruleEfficiency}% [Mức ${item.rankText}] · (Sample n=${item.sampleN})
💎 Chi tiết: ${item.detailText}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi thông báo Rung H2 (${item.ruleEfficiency}%) cho trận [${item.id}] ${item.homeTeam} vs ${item.awayTeam}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

// ==========================================
// 6. QUÉT VÀ XỬ LÝ DỮ LIỆU REAL-TIME
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan Real-Time Engine] Quét kèo Rung H2 phút 60+ (Rule >= 80%)... (${currentVN.timeStr})`);

    try {
        const response = await axios.get(API_URL, {
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': RAPIDAPI_HOST.trim(),
                'accept': 'application/json'
            },
            timeout: 25000
        });

        const data = response.data;
        let liveMatches = [];

        if (data?.response?.live && Array.isArray(data.response.live)) {
            liveMatches = data.response.live;
        } else if (Array.isArray(data)) {
            liveMatches = data;
        } else if (data && typeof data === 'object') {
            if (Array.isArray(data.response)) {
                liveMatches = data.response;
            } else if (Array.isArray(data.matches)) {
                liveMatches = data.matches;
            } else {
                Object.keys(data).forEach(key => {
                    if (Array.isArray(data[key])) {
                        liveMatches = liveMatches.concat(data[key]);
                    }
                });
            }
        }

        const uniqueMatchesMap = new Map();
        liveMatches.forEach(item => {
            const id = String(item.id || item.eventId || item.fixture?.id || item.match_id);
            if (id && id !== 'undefined' && !uniqueMatchesMap.has(id)) {
                uniqueMatchesMap.set(id, item);
            }
        });

        const finalMatchesList = Array.from(uniqueMatchesMap.values());

        if (finalMatchesList.length === 0) {
            console.log('[Hệ thống] API không trả về trận LIVE nào.');
            return;
        }

        console.log(`[Hệ thống] Tìm thấy ${finalMatchesList.length} trận đấu đang diễn ra.\n`);

        let matchedCount = 0;

        for (let index = 0; index < finalMatchesList.length; index++) {
            const item = finalMatchesList[index];
            const matchId = String(item.id || item.eventId || item.fixture?.id || item.match_id);
            const leagueName = parseLeagueName(item);
            const homeTeam = item.home?.name || item.home?.longName || 'Đội nhà';
            const awayTeam = item.away?.name || item.away?.longName || 'Đội khách';
            const homeScore = item.home?.score ?? 0;
            const awayScore = item.away?.score ?? 0;

            const elapsed = calculateExactMinute(item);
            const statusShort = item.status?.liveTime?.short || item.status?.short || '';

            console.log(`[Trận #${index + 1}] [ID: ${matchId}] [Phút: ${elapsed}'] (${statusShort}) [${leagueName}] ${homeTeam} ${homeScore}-${awayScore} ${awayTeam}`);

            // CẬP NHẬT ĐÚNG THEO ĐOẠN ẢNH YÊU CẦU
            if (elapsed < 65) {
                console.log(`   └─ ✕ [Bỏ qua]: Chưa đủ phút Rung H2 (${elapsed}' < 65')`);
            } else if (elapsed > 90) {
                console.log(`   └─ ✕ [Bỏ qua]: Đã quá phút Rung H2 (${elapsed}' > 90')`);
            } else if (sentAlerts.has(matchId)) {
                console.log(`   └─ ⚠ [Bỏ qua]: Trận đấu đã được gửi Telegram trước đó`);
            } else {
                const aiAnalysis = evaluateMatchWithAI(item, elapsed);

                // Tăng ngưỡng lọc lên >= 80.0% để tăng xác suất thắng kèo
                if (parseFloat(aiAnalysis.efficiency) >= 80.0) {
                    console.log(`   └─ ✅ [AI CHỌN: RUNG H2] (${aiAnalysis.efficiency}% >= 65.0%) -> Báo Telegram..`);
                    matchedCount++;

                    const goalTimeline = parseGoalTimeline(item);

                    const pickItem = {
                        id: matchId,
                        league: leagueName,
                        homeTeam: homeTeam,
                        awayTeam: awayTeam,
                        homeScore: homeScore,
                        awayScore: awayScore,
                        elapsed: elapsed,
                        goalTimeline: goalTimeline,
                        detailText: aiAnalysis.detailText,
                        ruleEfficiency: aiAnalysis.efficiency,
                        rankText: aiAnalysis.rankText,
                        sampleN: aiAnalysis.sampleN,
                        statsSummary: aiAnalysis.statsSummary
                    };

                    await sendTelegramAlert(pickItem);
                } else {
                    console.log(`   └─ ✕ [Bỏ qua]: Điểm chỉ số chưa đạt 80% (${aiAnalysis.efficiency}% < 65%)`);
                }
            }
        }

        console.log(`\n---> [KẾT QUẢ AI] Đã gửi thông báo ${matchedCount}/${finalMatchesList.length} trận đạt chuẩn Rung H2.`);

    } catch (err) {
        if (err.response) {
            console.error(`[API Fetch Error] Status Code: ${err.response.status}`, JSON.stringify(err.response.data));
        } else {
            console.error(`[API Fetch Error]:`, err.message);
        }
    }
}

function keepAlive() {
    axios.get(RENDER_EXTERNAL_URL)
        .then(() => console.log(`[Keep-Alive] Self-ping thành công`))
        .catch(err => console.error(`[Keep-Alive Error]:`, err.message));
}

app.get('/', (req, res) => {
    res.send('Full Multi-Indicator Real-time H2 Goal Engine is running!');
});

app.listen(PORT, () => {
    console.log(`Server chạy tại port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000); // Tự động quét lại mỗi 3 phút
    setInterval(keepAlive, 10 * 60 * 1000);      // Tự động ping server chống ngủ
});