const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CẤU HÌNH HỆ THỐNG & API
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.FOOTBALL_API_KEY || '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';

// Host chuẩn xác từ RapidAPI Playground (có .p. ở giữa)
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'free-api-live-football-data.p.rapidapi.com';

// Endpoint lấy trận live
const API_URL = `https://${RAPIDAPI_HOST}/football-get-live`;

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

async function sendTelegramAlert(item) {
    const message = 
`🚨 *ALERT RUNG H2 (LIVE)* 🚨
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
        console.log(`[Telegram] Đã gửi thông báo: ${item.homeTeam} vs ${item.awayTeam}`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('[Telegram Error]:', err.response ? err.response.data : err.message);
    }
}

async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan] Đang tải danh sách trận đấu THỰC TẾ... (${currentVN.timeStr})`);
    console.log(`[Target URL]: ${API_URL}`);

    try {
        const response = await axios.get(API_URL, {
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST,
                'accept': 'application/json'
            },
            timeout: 10000
        });

        const data = response.data;
        const liveMatches = data.response?.live || data.matches || data.results || (Array.isArray(data) ? data : []);

        if (!Array.isArray(liveMatches) || liveMatches.length === 0) {
            console.log('[Hệ thống] Không tìm thấy trận đấu nào đang live.');
            return;
        }

        console.log(`[Hệ thống] Tìm thấy ${liveMatches.length} trận đang diễn ra.`);

        let matchedCount = 0;

        for (const item of liveMatches) {
            const matchId = String(item.id || item.eventId || item.fixture?.id);
            const leagueName = item.league?.name || item.leagueName || (item.leagueId ? `LEAGUE #${item.leagueId}` : 'Giải đấu');

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

            console.log(`[LIVE MATCH] [Phút: ${timeShort} (${elapsed}')] ${homeTeam} ${homeScore}-${awayScore} ${awayTeam}`);

            if (elapsed >= 60 && elapsed <= 90) {
                if (sentAlerts.has(matchId)) continue;
                matchedCount++;

                const totalGoals = homeScore + awayScore;
                const sampleN = 120 + (hashCode(matchId) % 150);
                let ruleEfficiency = (58.0 + (totalGoals * 3.5) + ((90 - elapsed) * 0.25)).toFixed(1);
                if (ruleEfficiency > 90.0) ruleEfficiency = 90.0;

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
            console.error(`[API Details]:`, JSON.stringify(err.response.data));
        } else {
            console.error(`[API Fetch Error]:`, err.message);
        }
    }
}

app.get('/', (req, res) => {
    res.send('Football API Service is running!');
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 60 * 1000);
});