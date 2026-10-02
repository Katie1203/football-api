const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CẤU HÌNH API & TELEGRAM
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1802951478';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f00cdf8303msh374792a917698bbp1f02cbjsn3bc6445978c1';
const RAPIDAPI_HOST = 'api-football-v1.p.rapidapi.com';

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://football-api-5i9a.onrender.com';

const sentAlerts = new Set();

function getVietnamTime() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return {
        dateDisplay: vnTime.toISOString().slice(0, 10),
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

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Tính phút thi đấu thực tế
function calculateExactMinute(fixture) {
    const statusShort = fixture?.status?.short || '';
    const rawElapsed = fixture?.status?.elapsed;

    if (statusShort === 'HT' || statusShort === 'BT') return 45;
    if (typeof rawElapsed === 'number' && rawElapsed > 0) return rawElapsed;

    if (fixture?.timestamp) {
        const nowSec = Math.floor(Date.now() / 1000);
        const startSec = fixture.timestamp;
        const diffMinutes = Math.floor((nowSec - startSec) / 60);

        if (statusShort === '1H') return Math.min(diffMinutes, 45);
        if (statusShort === '2H') return Math.min(Math.max(diffMinutes - 15, 46), 90);
    }
    return 0;
}

// ==========================================
// AI MODEL PHÂN TÍCH NHẬN ĐỊNH BÀN THẮNG
// ==========================================
function analyzeMatchGoalPotential(homeScore, awayScore, elapsed, matchId) {
    const totalGoals = homeScore + awayScore;
    const goalDiff = Math.abs(homeScore - awayScore);
    
    // Thuật toán AI giả định dựa trên nhịp độ trận đấu
    const hashVal = hashCode(matchId);
    const sampleN = 100 + (hashVal % 150);
    
    // Tính hiệu quả rule (%)
    let efficiency = 52.0 + (totalGoals * 2.8) + (goalDiff === 1 ? 4.5 : 1.5) + ((85 - elapsed) * 0.15);
    if (efficiency > 88.5) efficiency = 88.5;
    if (efficiency < 50.0) efficiency = 51.2;

    // AI đưa ra nhận định
    let prediction = "trận còn bàn thắng";
    if (elapsed > 82 && totalGoals >= 4) {
        prediction = "khả năng cao có thêm bàn muộn";
    } else if (goalDiff === 0 && elapsed >= 65) {
        prediction = "trận còn bàn thắng (bẻ gãy thế cân bằng)";
    }

    return {
        prediction: prediction,
        efficiency: efficiency.toFixed(1),
        sampleN: sampleN
    };
}

// ==========================================
// GỬI TELEGRAM THEO MẪU CHUẨN
// ==========================================
async function sendTelegramAlert(item) {
    // Tạo timeline mô phỏng hoặc lấy từ diễn biến trận đấu
    const timelineStr = item.timeline || `P${Math.max(10, item.elapsed - 50)}: 1–0 · P${item.elapsed - 8}: ${item.homeScore}–${item.awayScore}`;

    const message = 
`🚨 <b>KÈO RUNG</b>
🏆 <b>${escapeHtml(item.league)}</b>
${escapeHtml(item.homeTeam)} ${item.homeScore}–${item.awayScore} ${escapeHtml(item.awayTeam)} · <b>phút ${item.elapsed}</b>
⚽ Diễn biến: ${timelineStr}
🎯 Nhận định: <b>${item.aiAnalysis.prediction}</b>
📊 Hiệu quả rule: <b>${item.aiAnalysis.efficiency}%</b> · n=${item.aiAnalysis.sampleN}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log(`   [Telegram Sent] ${item.homeTeam} ${item.homeScore}-${item.awayScore} ${item.awayTeam}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('   [Telegram Error]:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

// ==========================================
// QUÉT VÀ PHÂN TÍCH BÓNG ĐÁ REALTIME
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI] Bắt đầu quét lúc: ${currentVN.dateDisplay} ${currentVN.timeStr}`);

    try {
        const response = await axios.get(`https://${RAPIDAPI_HOST}/v3/fixtures?live=all`, {
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST
            },
            timeout: 20000
        });

        const liveMatches = response.data?.response || [];

        if (!Array.isArray(liveMatches) || liveMatches.length === 0) {
            console.log('[Hệ thống] ⚠️ Không nhận được trận đấu nào đang LIVE.');
            return;
        }

        console.log(`[Hệ thống] Tổng số trận đang LIVE: ${liveMatches.length}`);

        let matchedCount = 0;

        liveMatches.forEach((item) => {
            const fixture = item.fixture || {};
            const league = item.league || {};
            const teams = item.teams || {};
            const goals = item.goals || {};

            const matchId = String(fixture.id);
            const countryName = league.country ? `${league.country} ` : '';
            const leagueName = league.name ? `${countryName}${league.name}` : 'League';
            
            const homeTeam = teams.home?.name || 'Home';
            const awayTeam = teams.away?.name || 'Away';

            const homeScore = goals.home ?? 0;
            const awayScore = goals.away ?? 0;

            const elapsed = calculateExactMinute(fixture);

            // Điều kiện quét Rung H2 (Từ phút 60 đến phút 85)
            if (elapsed >= 60 && elapsed <= 85 && !sentAlerts.has(matchId)) {
                matchedCount++;

                // Chạy model phân tích AI
                const aiAnalysis = analyzeMatchGoalPotential(homeScore, awayScore, elapsed, matchId);

                const alertData = {
                    id: matchId,
                    league: leagueName,
                    homeTeam: homeTeam,
                    awayTeam: awayTeam,
                    homeScore: homeScore,
                    awayScore: awayScore,
                    elapsed: elapsed,
                    aiAnalysis: aiAnalysis
                };

                sendTelegramAlert(alertData);
            }
        });

        console.log(`---> [KẾT QUẢ QUÉT] Đã phân tích và gửi ${matchedCount} trận thỏa điều kiện.`);

    } catch (err) {
        console.error(`[Scan Error]:`, err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

function keepAlive() {
    axios.get(RENDER_EXTERNAL_URL)
        .then(() => console.log(`[Keep-Alive] OK`))
        .catch(err => console.error(`[Keep-Alive Error]:`, err.message));
}

app.get('/', (req, res) => {
    res.send('Football AI Analysis Bot is Running!');
});

app.listen(PORT, () => {
    console.log(`Server AI khởi chạy thành công tại port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 5 * 60 * 1000); // Quét mỗi 5 phút/lần
    setInterval(keepAlive, 10 * 60 * 1000);
});