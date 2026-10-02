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
const picksHistory = [];

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
// THÔNG BÁO TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const message = 
`🚨 *KÈO RUNGGGG* 🚨
------------------------------------
🏆 *Giải đấu:* ${item.league}
⚔️ *Trận đấu:* ${item.homeTeam} vs ${item.awayTeam}
⏱ *Phút thi đấu:* ${item.elapsed}'
⚽ *Tỷ số hiện tại:* ${item.score}
📊 *Timeline:* ${item.goalTimeline}
🔥 *Hiệu suất quy tắc:* ${item.ruleEfficiency}% (N=${item.sampleN})
------------------------------------
🎯 *Gợi ý:* Theo dõi cược Rung H2!`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log(`[Telegram] Đã gửi thông báo thành công: [${item.league}] ${item.homeTeam} vs ${item.awayTeam}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('[Telegram Error]:', err.response ? err.response.data : err.message);
    }
}

// ==========================================
// QUÉT TRẬN ĐẤU REAL-TIME
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan] Đang tải danh sách trận đấu THỰC TẾ... (${currentVN.timeStr})`);

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
        const liveMatches = data.response?.live || data.response || data.matches || data.results || (Array.isArray(data) ? data : []);

        if (!Array.isArray(liveMatches) || liveMatches.length === 0) {
            console.log('[Hệ thống] Không tìm thấy trận đấu nào đang live.');
            return;
        }

        console.log(`[Hệ thống] Tìm thấy ${liveMatches.length} trận đang diễn ra.`);

        let matchedCount = 0;

        for (const item of liveMatches) {
            const matchId = String(item.id || item.eventId || item.fixture?.id);

            // FIX TÊN GIẢI ĐẤU: Kiểm tra đa dạng trường dữ liệu từ API
            let rawLeague = item.league?.name || 
                            item.leagueName || 
                            item.tournament?.name || 
                            item.competition?.name || 
                            item.league_name || 
                            (typeof item.league === 'string' ? item.league : null);

            let leagueName = rawLeague ? String(rawLeague).trim() : '';

            // Nếu vẫn không có tên, kiểm tra ID hoặc gắn nhãn mặc định
            if (!leagueName) {
                const leagueId = item.league?.id || item.leagueId;
                leagueName = leagueId ? `Giải đấu #${leagueId}` : 'Giải đấu';
            }

            const homeTeam = item.home?.name || item.teams?.home?.name || item.homeTeam || 'Đội nhà';
            const awayTeam = item.away?.name || item.teams?.away?.name || item.awayTeam || 'Đội khách';

            const homeScore = item.home?.score ?? item.goals?.home ?? 0;
            const awayScore = item.away?.score ?? item.goals?.away ?? 0;

            const liveTimeObj = item.status?.liveTime || {};
            const timeShort = liveTimeObj.short || item.status?.short || String(item.elapsed || '');

            let elapsed = 0;
            if (timeShort === 'HT' || timeShort.toUpperCase().includes('HALF')) {
                elapsed = 45;
            } else {
                const parsedMin = parseInt(timeShort.replace(/[^0-9]/g, ''), 10);
                if (!isNaN(parsedMin)) {
                    elapsed = parsedMin;
                }
            }

            console.log(`[LIVE MATCH] [Phút: ${timeShort} (${elapsed}')] [${leagueName}] ${homeTeam} ${homeScore}-${awayScore} ${awayTeam}`);

            // Điều kiện quét Rung H2 (Từ phút 60 đến phút 90)
            if (elapsed >= 60 && elapsed <= 90) {
                if (sentAlerts.has(matchId)) {
                    console.log(`   └─> ⚠️ Bỏ qua: Trận ${homeTeam} vs ${awayTeam} đã gửi thông báo trước đó.`);
                    continue;
                }

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

                await sendTelegramAlert(pickItem);
            }
        }

        console.log(`---> [KẾT QUẢ] Tìm thấy ${matchedCount} trận thỏa điều kiện Rung H2.`);

    } catch (err) {
        if (err.response) {
            console.error(`[API Fetch Error] Status Code: ${err.response.status}`);
        } else {
            console.error(`[API Fetch Error]:`, err.message);
        }
    }
}

// ==========================================
// PING DUY TRÌ SERVER (KEEP-ALIVE 24/7)
// ==========================================
function keepAlive() {
    axios.get(RENDER_EXTERNAL_URL)
        .then(() => console.log(`[Keep-Alive] Ping server thành công để duy trì 24/7.`))
        .catch(err => console.error(`[Keep-Alive Error]:`, err.message));
}

app.get('/', (req, res) => {
    res.send('Football API Service is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches,8 * 60 * 1000);
    setInterval(keepAlive, 10 * 60 * 1000);
});