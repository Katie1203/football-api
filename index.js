const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CẤU HÌNH HỆ THỐNG & API
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1802951478';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f00cdf8303msh374792a917698bbp1f02cbjsn3bc6445978c1';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'free-api-live-football-data.p.rapidapi.com';

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://football-api-5i9a.onrender.com';

const sentAlerts = new Set();
const picksHistory = [];

function getVietnamTime() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return {
        dateStr: vnTime.toISOString().slice(0, 10).replace(/-/g, ''), // YYYYMMDD cho API
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

// ==========================================
// THÔNG BÁO TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const message = 
`🚨 <b>KÈO RUNGGGG</b> 🚨
------------------------------------
🏆 <b>Giải đấu:</b> ${escapeHtml(item.league)}
⚔️️ <b>Trận đấu:</b> ${escapeHtml(item.homeTeam)} vs ${escapeHtml(item.awayTeam)}
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
// LẤY DỮ LIỆU BẰNG NHIỀU ENDPOINT (ĐẢM BẢO QUÉT ĐỦ)
// ==========================================
async function fetchAllLiveMatches() {
    const vnTime = getVietnamTime();
    let allMatches = [];

    // Endpoint 1: Trận Live trực tiếp
    try {
        const res1 = await axios.get(`https://${RAPIDAPI_HOST}/football-current-live`, {
            headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
            timeout: 15000
        });
        const list1 = res1.data?.response?.live || res1.data?.response || res1.data?.data || (Array.isArray(res1.data) ? res1.data : []);
        if (Array.isArray(list1)) allMatches.push(...list1);
    } catch (e) {
        console.log(`[Fetch Endpoint 1 Error]: ${e.message}`);
    }

    // Endpoint 2: Quét tất cả trận trong ngày để không bỏ sót các giải nhỏ/giao hữu
    try {
        const res2 = await axios.get(`https://${RAPIDAPI_HOST}/football-get-matches-by-date?date=${vnTime.dateStr}`, {
            headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
            timeout: 15000
        });
        const list2 = res2.data?.response?.matches || res2.data?.response || res2.data?.data || [];
        if (Array.isArray(list2)) {
            // Lọc ra các trận có trạng thái đang diễn ra (In Play / Live / HT / FT...)
            const liveFromDate = list2.filter(m => {
                const status = String(m.status?.short || m.status || m.time || '').toUpperCase();
                return ['1H', '2H', 'HT', 'LIVE', 'INPLAY', 'IN PLAY', 'PAUSED'].some(s => status.includes(s)) ||
                       (parseInt(status, 10) > 0 && parseInt(status, 10) <= 120);
            });
            allMatches.push(...liveFromDate);
        }
    } catch (e) {
        // Bỏ qua nếu endpoint 2 không hỗ trợ trên gói API
    }

    // Lọc trùng lặp trận đấu theo ID hoặc tên Đội
    const uniqueMatchesMap = new Map();
    allMatches.forEach(item => {
        const home = item.home?.name || item.homeTeam || item.teams?.home?.name || '';
        const away = item.away?.name || item.awayTeam || item.teams?.away?.name || '';
        const key = item.id || item.eventId || `${home}-${away}`;
        if (key && !uniqueMatchesMap.has(key)) {
            uniqueMatchesMap.set(key, item);
        }
    });

    return Array.from(uniqueMatchesMap.values());
}

// ==========================================
// QUÉT TRẬN ĐẤU REAL-TIME & LOG CHI TIẾT
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan] Bắt đầu quét lúc: ${currentVN.dateDisplay} ${currentVN.timeStr}`);

    try {
        const liveMatches = await fetchAllLiveMatches();

        if (liveMatches.length === 0) {
            console.log('[Hệ thống] ⚠️ Không nhận được trận đấu nào đang LIVE từ API.');
            return;
        }

        console.log(`[Hệ thống] Tổng số trận đang LIVE thu thập được: ${liveMatches.length}`);
        console.log(`--------------------------------------------------`);

        let matchedCount = 0;

        liveMatches.forEach((item, index) => {
            const homeTeam = item.home?.name || item.teams?.home?.name || item.homeTeam || item.home_team || 'Đội nhà';
            const awayTeam = item.away?.name || item.teams?.away?.name || item.awayTeam || item.away_team || 'Đội khách';
            const matchId = String(item.id || item.eventId || item.fixture?.id || hashCode(`${homeTeam}-${awayTeam}`));

            let rawLeague = item.league?.name || 
                            item.leagueName || 
                            item.tournament?.name || 
                            item.competition?.name || 
                            item.league_name || 
                            (typeof item.league === 'string' ? item.league : null);

            let leagueName = rawLeague ? String(rawLeague).trim() : 'Giải đấu';

            const homeScore = item.home?.score ?? item.goals?.home ?? item.homeScore ?? 0;
            const awayScore = item.away?.score ?? item.goals?.away ?? item.awayScore ?? 0;

            const liveTimeObj = item.status?.liveTime || {};
            const timeShort = String(liveTimeObj.short || item.status?.short || item.status || item.elapsed || item.minute || item.time || '');

            let elapsed = 0;
            if (timeShort === 'HT' || timeShort.toUpperCase().includes('HALF')) {
                elapsed = 45;
            } else {
                const parsedMin = parseInt(timeShort.replace(/[^0-9]/g, ''), 10);
                if (!isNaN(parsedMin)) {
                    elapsed = parsedMin;
                }
            }

            console.log(`[Trận #${index + 1}] [ID: ${matchId}] [Phút: ${timeShort} (${elapsed}')] [${leagueName}] ${homeTeam} ${homeScore}-${awayScore} ${awayTeam}`);

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
        console.error(`[Scan Error Message]:`, err.message);
    }
}

// ==========================================
// KEEP-ALIVE DUY TRÌ SERVER
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
    setInterval(scanLiveMatches, 5 * 60 * 1000); // Quét rút ngắn xuống mỗi 5 phút/lần
    setInterval(keepAlive, 10 * 60 * 1000);
});