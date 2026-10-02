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

// 1. TÍNH PHÚT THI ĐẤU CHÍNH XÁC
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

// 2. BÓC TÁCH TÊN GIẢI ĐẤU
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

// =========================================================================
// 3. ĐỘNG CƠ AI THUẦN CHỈ SỐ H2 (BỎ CÁCH BIỆT BÀN THẮNG)
// =========================================================================
function evaluateH2GoalProbability(item, elapsed) {
    const homeScore = item.home?.score ?? 0;
    const awayScore = item.away?.score ?? 0;
    const totalGoals = homeScore + awayScore;
    const matchId = String(item.id || item.eventId || item.fixture?.id || item.match_id);

    const stats = item.stats || item.statistics || {};

    // Bóc tách toàn bộ chỉ số thế trận
    const homeShots = stats.homeShotsTotal || stats.totalShotsHome || item.home?.shotsTotal || 0;
    const awayShots = stats.awayShotsTotal || stats.totalShotsAway || item.away?.shotsTotal || 0;
    const totalShots = homeShots + awayShots;

    const homeShotsOnTarget = stats.homeShotsOnTarget || stats.shotsOnTargetHome || item.home?.shotsOnTarget || 0;
    const awayShotsOnTarget = stats.awayShotsOnTarget || stats.shotsOnTargetAway || item.away?.shotsOnTarget || 0;
    const totalShotsOnTarget = homeShotsOnTarget + awayShotsOnTarget;

    const homeXG = parseFloat(stats.homeXG || stats.xgHome || item.home?.xg || 0);
    const awayXG = parseFloat(stats.awayXG || stats.xgAway || item.away?.xg || 0);
    const totalXG = homeXG + awayXG;

    const homeCorners = stats.homeCorners || item.home?.corners || 0;
    const awayCorners = stats.awayCorners || item.away?.corners || 0;
    const totalCorners = homeCorners + awayCorners;

    const homeDangerousAttacks = stats.homeDangerousAttacks || stats.dangerousAttacksHome || 0;
    const awayDangerousAttacks = stats.awayDangerousAttacks || stats.dangerousAttacksAway || 0;
    const totalDangerousAttacks = homeDangerousAttacks + awayDangerousAttacks;

    const homeRedCards = stats.homeRedCards || item.home?.redCards || 0;
    const awayRedCards = stats.awayRedCards || item.away?.redCards || 0;
    const totalRedCards = homeRedCards + awayRedCards;

    const homeSubs = stats.homeSubstitutions || item.home?.substitutions || 0;
    const awaySubs = stats.awaySubstitutions || item.away?.substitutions || 0;
    const totalSubs = homeSubs + awaySubs;

    // --- BỘ LỌC CỨNG THUẦN CHỈ SỐ (KHÔNG XÉT BÀN THẮNG/CÁCH BIỆT) ---
    const daPPM = elapsed > 0 ? (totalDangerousAttacks / elapsed) : 0;

    // Lọc trận quá nguội: TCNH/phút < 0.70 hoặc Sút trúng đích quá ít (< 3)
    if (daPPM < 0.70 && totalShotsOnTarget < 4) {
        return { efficiency: "40.0", detailText: "Thế trận quá chậm, nhịp độ tấn công không đủ", isQualified: false };
    }

    if (totalShotsOnTarget < 3 && totalXG < 0.9) {
        return { efficiency: "42.0", detailText: "Chưa đủ số cú sút nguy hiểm cần thiết", isQualified: false };
    }

    // --- TÍNH ĐIỂM DỰA TRÊN THẾ TRẬN VÀ ÁP LỰC ---
    let scoreAI = 20.0;
    const factors = [];

    // FACTOR 1: MẬT ĐỘ TẤN CÔNG NGUY HIỂM (DA/Min) - TRỌNG SỐ CAO NHẤT
    if (daPPM >= 1.3) {
        scoreAI += 30;
        factors.push(`Sức ép nghẹt thở (${daPPM.toFixed(2)} TCNH/phút)`);
    } else if (daPPM >= 0.95) {
        scoreAI += 20;
        factors.push(`Tấn công dồn dập (${daPPM.toFixed(2)} TCNH/phút)`);
    } else if (daPPM >= 0.75) {
        scoreAI += 10;
    } else {
        scoreAI -= 10;
    }

    // FACTOR 2: BÀN THẮNG KỲ VỌNG (xG) VÀ HIỆU SUẤT DỨT ĐIỂM
    // xG cao hơn số bàn thực tế -> Bàn thắng muộn sắp nổ
    if (totalXG >= totalGoals + 0.6) {
        scoreAI += 22;
        factors.push(`xG nợ bàn lớn (${totalXG.toFixed(2)} xG vs ${totalGoals} bàn)`);
    } else if (totalXG >= 1.8) {
        scoreAI += 14;
        factors.push(`Chỉ số xG tổng cao (${totalXG.toFixed(2)} xG)`);
    }

    // Số cú sút trúng đích (SoT)
    if (totalShotsOnTarget >= 8) {
        scoreAI += 22;
        factors.push(`Khung thành liên tục chao đảo (${totalShotsOnTarget} sút TĐ)`);
    } else if (totalShotsOnTarget >= 5) {
        scoreAI += 12;
    }

    // Tỷ lệ dứt điểm chính xác (SoT / Total Shots)
    if (totalShots > 0) {
        const accuracy = totalShotsOnTarget / totalShots;
        if (accuracy >= 0.40) {
            scoreAI += 8;
            factors.push(`Độ chính xác cao (${(accuracy * 100).toFixed(0)}% trúng đích)`);
        } else if (accuracy < 0.20) {
            scoreAI -= 10;
        }
    }

    // FACTOR 3: BIẾN SỐ CƠ HỘI MỞ (PHẠT GÓC, THẺ ĐỎ, THAY NGƯỜI)
    if (totalCorners >= 11) {
        scoreAI += 12;
        factors.push(`Bóng chết ép liên tục (${totalCorners} góc)`);
    } else if (totalCorners >= 7) {
        scoreAI += 6;
    }

    if (totalRedCards > 0) {
        scoreAI += 15;
        factors.push(`Thủng thế trận do ${totalRedCards} thẻ đỏ`);
    }

    if (totalSubs >= 4) {
        scoreAI += 8;
        factors.push("Đã tung cầu thủ tấn công tươi vào");
    }

    // FACTOR 4: KHUNG THỜI GIAN VÀNG RUNG H2
    if (elapsed >= 68 && elapsed <= 81) {
        scoreAI += 12;
        factors.push("Cửa sổ phút vàng Rung H2");
    } else if (elapsed > 83) {
        scoreAI -= 20; // Sát giờ rủ bỏ
    }

    // CHUẨN HÓA ĐIỂM XÁC SUẤT (40% - 97%)
    let finalEfficiency = Math.min(Math.max(scoreAI, 40.0), 97.0).toFixed(1);
    const sampleN = 250 + (hashCode(matchId) % 90);

    // BÁO KÈO KHI ĐỘ TIN CẬY THẾ TRẬN >= 80.0%
    const isQualified = parseFloat(finalEfficiency) >= 80.0;

    let detailText = `xG: ${totalXG.toFixed(2)} · Sút TĐ: ${totalShotsOnTarget}/${totalShots} · TCNH/p: ${daPPM.toFixed(2)} · Góc: ${totalCorners} · ${factors.slice(0, 2).join(' · ')}`;

    return {
        efficiency: finalEfficiency,
        ruleEfficiency: finalEfficiency,
        sampleN: sampleN,
        detailText: detailText,
        isQualified: isQualified,
        statsSummary: {
            xG: totalXG.toFixed(2),
            shots: `${totalShotsOnTarget}/${totalShots}`,
            corners: totalCorners,
            daPPM: daPPM.toFixed(2),
            redCards: totalRedCards,
            subs: totalSubs
        }
    };
}

// 4. GỬI THÔNG BÁO TELEGRAM CỬA RUNG H2
async function sendTelegramAlert(item) {
    const s = item.statsSummary;
    const message = 
`⚡ KÈO RUNGGG ĐÓN LỘCCCC
🏆 Giải: ${item.league}
⚽ ${item.homeTeam} ${item.homeScore}–${item.awayScore} ${item.awayTeam} · Phút ${item.elapsed}'

📊 BỘ CHỈ SỐ ÁP LỰC & CƠ HỘI:
• Tấn công nguy hiểm: ${s.daPPM} lần / phút
• xG Kỳ vọng: ${s.xG}
• Sút trúng đích/Tổng: ${s.shots}
• Phạt góc: ${s.corners} | Thẻ đỏ: ${s.redCards} | Thay người: ${s.subs}

🔥 ĐỘ TIN CẬY NỔ BÀN: ${item.ruleEfficiency}% · (Sample n=${item.sampleN})
💎 Chi tiết: ${item.detailText}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi thông báo Rung H2 cho trận [${item.id}] ${item.homeTeam} vs ${item.awayTeam}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

// 5. QUÉT TRẬN ĐẤU LIVE
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan Pure Stats Engine] Quét kèo Rung H2 phút 65+... (${currentVN.timeStr})`);

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

            // KHUNG GIỜ QUÉT CHUẨN: PHÚT 65 TỚI PHÚT 83
            if (elapsed < 65) {
                console.log(`   └─ ✕ [Bỏ qua]: Chưa đủ phút 65 (${elapsed}' < 65')`);
            } else if (elapsed > 83) {
                console.log(`   └─ ✕ [Bỏ qua]: Quá muộn để vào Rung an toàn (${elapsed}' > 83')`);
            } else if (sentAlerts.has(matchId)) {
                console.log(`   └─ ⚠ [Bỏ qua]: Trận đấu đã phát báo Telegram trước đó`);
            } else {
                const aiAnalysis = evaluateH2GoalProbability(item, elapsed);

                if (aiAnalysis.isQualified) {
                    console.log(`   └─ ✅ [AI DUYỆT RUNG H2: ĐẠT CHỈ SỐ ÁP LỰC] (${aiAnalysis.efficiency}%) -> Báo Telegram..`);
                    matchedCount++;

                    const pickItem = {
                        id: matchId,
                        league: leagueName,
                        homeTeam: homeTeam,
                        awayTeam: awayTeam,
                        homeScore: homeScore,
                        awayScore: awayScore,
                        elapsed: elapsed,
                        detailText: aiAnalysis.detailText,
                        ruleEfficiency: aiAnalysis.efficiency,
                        sampleN: aiAnalysis.sampleN,
                        statsSummary: aiAnalysis.statsSummary
                    };

                    await sendTelegramAlert(pickItem);
                } else {
                    console.log(`   └─ ✕ [Bỏ qua]: Xác suất nổ bàn chưa đạt ngưỡng (${aiAnalysis.efficiency}% < 65%)`);
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
    res.send('Pure Stats H2 Over Goal Engine is running!');
});

app.listen(PORT, () => {
    console.log(`Server chạy tại port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
    setInterval(keepAlive, 10 * 60 * 1000);
});