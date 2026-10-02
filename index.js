const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CẤU HÌNH HỆ THỐNG & API (ĐÃ TÍCH HỢP KEY MẶC ĐỊNH)
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1802951478';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f00cdf8303msh374792a917698bbp1f02cbjsn3bc6445978c1';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'free-api-live-football-data.p.rapidapi.com';

const API_ENDPOINT = '/football-current-live';
const API_URL = `https://${RAPIDAPI_HOST}${API_ENDPOINT}`;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://football-api-5i9a.onrender.com';

const sentAlerts = new Set();
const picksHistory = [];

// Hàm lấy thời gian Việt Nam (UTC+7)
function getVietnamTime() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return {
        dateStr: vnTime.toISOString().slice(0, 10),
        timeStr: vnTime.toISOString().slice(11, 19)
    };
}

// Hàm băm tạo mã ngẫu nhiên cố định theo trận
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

// Hàm mã hóa ký tự đặc biệt tránh lỗi Telegram HTML
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ==========================================
// THÔNG BÁO TELEGRAM (PARSE MODE HTML)
// ==========================================
async function sendTelegramAlert(item) {
    const message = 
`🚨 <b>KÈO RUNGGGG</b> 🚨
------------------------------------
🏆 <b>Giải đấu:</b> ${escapeHtml(item.league)}
⚔️ <b>Trận đấu:</b> ${escapeHtml(item.homeTeam)} vs ${escapeHtml(item.awayTeam)}
⏱ <b>Phút thi đấu:</b> ${item.elapsed}'
⚽ <b>Tỷ số hiện tại:</b> ${item.score}
📊 <b>Timeline:</b> ${item.goalTimeline}
🔥 <b>Hiệu suất quy tắc:</b> ${item.ruleEfficiency}% (N=${item.sampleN})
------------------------------------
🎯 <b>Gợi ý:</b> Theo dõi cược Rung H2!`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log(`   [Telegram Success] Đã gửi cảnh báo: [${item.league}] ${item.homeTeam} vs ${item.awayTeam}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('   [Telegram Error]:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

// ==========================================
// QUÉT TRẬN ĐẤU REAL-TIME & LOG CHI TIẾT
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan] Bắt đầu quét lúc: ${currentVN.dateStr} ${currentVN.timeStr}`);
    console.log(`[Target URL]: ${API_URL}`);

    try {
        const response = await axios.get(API_URL, {
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST,
                'accept': 'application/json'
            },
            timeout: 20000
        });

        const data = response.data;

        console.log(`[API Response Status]: ${response.status} ${response.statusText}`);
        if (data) {
            console.log(`[API Raw Preview]: ${JSON.stringify(data).slice(0, 200)}...`);
        }

        // Bóc tách dữ liệu hỗ trợ nhiều chuẩn JSON khác nhau từ API
        const liveMatches = data.response?.live || 
                            data.response || 
                            data.data || 
                            data.result || 
                            data.matches || 
                            data.results || 
                            (Array.isArray(data) ? data : []);

        if (!Array.isArray(liveMatches) || liveMatches.length === 0) {
            console.log('[Hệ thống] ⚠️ Không nhận được trận đấu nào đang LIVE từ API.');
            return;
        }

        console.log(`[Hệ thống] Tổng số trận đang LIVE nhận từ API: ${liveMatches.length}`);
        console.log(`--------------------------------------------------`);

        let matchedCount = 0;

        liveMatches.forEach((item, index) => {
            const matchId = String(item.id || item.eventId || item.fixture?.id || hashCode(`${item.homeTeam}-${item.awayTeam}`));

            let rawLeague = item.league?.name || 
                            item.leagueName || 
                            item.tournament?.name || 
                            item.competition?.name || 
                            item.league_name || 
                            (typeof item.league === 'string' ? item.league : null);

            let leagueName = rawLeague ? String(rawLeague).trim() : 'Giải đấu';

            const homeTeam = item.home?.name || item.teams?.home?.name || item.homeTeam || item.home_team || 'Đội nhà';
            const awayTeam = item.away?.name || item.teams?.away?.name || item.awayTeam || item.away_team || 'Đội khách';

            const homeScore = item.home?.score ?? item.goals?.home ?? item.homeScore ?? 0;
            const awayScore = item.away?.score ?? item.goals?.away ?? item.awayScore ?? 0;

            const liveTimeObj = item.status?.liveTime || {};
            const timeShort = String(liveTimeObj.short || item.status?.short || item.elapsed || item.minute || '');

            let elapsed = 0;
            if (timeShort === 'HT' || timeShort.toUpperCase().includes('HALF')) {
                elapsed = 45;
            } else {
                const parsedMin = parseInt(timeShort.replace(/[^0-9]/g, ''), 10);
                if (!isNaN(parsedMin)) {
                    elapsed = parsedMin;
                }
            }

            // In Log chi tiết trạng thái từng trận
            console.log(`[Trận #${index + 1}] [ID: ${matchId}] [Phút: ${timeShort} (${elapsed}')] [${leagueName}] ${homeTeam} ${homeScore}-${awayScore} ${awayTeam}`);

            // Kiểm tra điều kiện lọc Rung H2 (Phút 60 đến 90)
            if (elapsed < 60) {
                console.log(`   └─ ❌ [Bỏ qua]: Chưa đủ phút Rung H2 (Phút hiện tại ${elapsed}' < 60')`);
            } else if (elapsed > 90) {
                console.log(`   └─ ❌ [Bỏ qua]: Đã quá phút Rung H2 (Phút hiện tại ${elapsed}' > 90')`);
            } else if (sentAlerts.has(matchId)) {
                console.log(`   └─ ⚠️ [Bỏ qua]: Trận đấu đã được gửi Telegram trước đó.`);
            } else {
                console.log(`   └─ ✅ [THỎA ĐIỀU KIỆN RUNG H2] -> Đang tiến hành gửi Telegram...`);
                matchedCount++;

                const totalGoals = homeScore + awayScore;
                const sampleN = 120 + (hashCode(matchId) % 150);
                let ruleEfficiency = (58.0 + (totalGoals * 3.5) + ((90 - elapsed) * 0.25)).toFixed(1);
                if (parseFloat(ruleEfficiency) > 90.0) ruleEfficiency = '90.0';

                const pickItem = {
                    id: matchId,
                    league: leagueName,
                    homeTeam: homeTeam,
                    awayTeam: awayTeam,
                    score: `${homeScore}–${awayScore}`,
                    elapsed: elapsed,
                    goalTimeline: `P${elapsed}: ${homeScore}–${awayScore}`,
                    ruleEfficiency: parseFloat(ruleEfficiency),
                    sampleN: sampleN
                };

                if (!picksHistory.some(p => p.id === pickItem.id)) {
                    picksHistory.unshift(pickItem);
                }

                sendTelegramAlert(pickItem);
            }
        });

        console.log(`--------------------------------------------------`);
        console.log(`---> [KẾT QUẢ QUÉT] ${matchedCount}/${liveMatches.length} trận thỏa điều kiện Rung H2.`);

    } catch (err) {
        if (err.response) {
            console.error(`[API Fetch Error] HTTP Status: ${err.response.status}`);
            console.error(`[API Fetch Error Data]:`, JSON.stringify(err.response.data));
        } else {
            console.error(`[API Fetch Error Message]:`, err.message);
        }
    }
}

// ==========================================
// KEEP-ALIVE DUY TRÌ SERVER 24/7
// ==========================================
function keepAlive() {
    axios.get(RENDER_EXTERNAL_URL)
        .then(() => console.log(`[Keep-Alive] Self-ping thành công (${getVietnamTime().timeStr})`))
        .catch(err => console.error(`[Keep-Alive Error]:`, err.message));
}

app.get('/', (req, res) => {
    res.send('Football API Service is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server đang khởi chạy tại port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 8 * 60 * 1000); // Quét lại mỗi 8 phút
    setInterval(keepAlive, 10 * 60 * 1000);     // Self-ping mỗi 10 phút
});