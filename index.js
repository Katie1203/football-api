const express = require('express');
const cors = require('cors');
const axios = require('axios'); // Dùng để gửi tin nhắn Telegram
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Bật CORS cho phép tất cả origin và custom header từ Canva
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-Requested-With']
}));

app.use(express.json());

// Cấu hình Telegram Bot Token & Chat ID của bạn
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.7795416740|| ''; // Nhập Chat ID Telegram của bạn vào file .env hoặc thay trực tiếp ở đây

// Hàm tự động gửi thông báo về Telegram
async function sendTelegramAlert(match, winRate) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('Chưa cấu hình TELEGRAM_CHAT_ID hoặc TELEGRAM_BOT_TOKEN');
        return;
    }

    const message = `
🔥 **CẢNH BÁO KÈO RUNG H2 (SẮP CÓ BÀN THẮNG)** 🔥

⚽ **Trận đấu:** ${match.homeTeam} VS ${match.awayTeam}
🏆 **Giải đấu:** ${match.league?.name || 'N/A'}
⏱ **Thời gian:** Phút ${match.time}' (Hiệp 2)
📊 **Tỉ số hiện tại:** ${match.homeScore} - ${match.awayScore}
🎯 **Dự đoán nổ bàn:** **${winRate}%** (AI Score: ${match.aiScore})

📌 **Thống kê nổi bật:**
- 🔴 Thẻ đỏ: ${match.stats.redCards.home} - ${match.stats.redCards.away}
- 🎯 Sút trúng đích: ${match.stats.shotsOnTarget.home} - ${match.stats.shotsOnTarget.away}
- ⚡ Tấn công nguy hiểm: ${match.stats.dangerousAttacks.home} - ${match.stats.dangerousAttacks.away}
- ⚽ Kiểm soát bóng: ${match.stats.possession.home}% - ${match.stats.possession.away}%

🚀 *Khuyến nghị: Theo dõi vào kèo Rung Tài!*
    `;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log(`[Telegram] Đã gửi thông báo trận ${match.homeTeam} vs ${match.awayTeam}`);
    } catch (error) {
        console.error('[Telegram] Lỗi gửi tin nhắn:', error.message);
    }
}

// Hàm phân tích Rule Kèo Rung từ phút 60 & Tính Tỷ lệ bàn thắng (%)
function analyzeKeoRungH2(match) {
    const elapsed = match.fixture?.status?.elapsed || parseInt(match.time) || 0;
    const status = match.fixture?.status?.short || match.status || '';
    const aiScore = match.aiScore || match.score_ai || match.ai_score || 0;

    // 1. Chỉ quét từ phút 60 đến phút 85 của Hiệp 2 (2H)
    if (status !== '2H' || elapsed < 60 || elapsed > 85) {
        return { isQualified: false, winRate: 0 };
    }

    // 2. Yêu cầu AI Score > 60
    if (aiScore <= 60) {
        return { isQualified: false, winRate: 0 };
    }

    // Trích xuất chỉ số
    const redHome = match.stats?.redCards?.home || match.red_cards_home || 0;
    const redAway = match.stats?.redCards?.away || match.red_cards_away || 0;
    const hasRedCard = (redHome + redAway) > 0;

    const shotsOnTargetHome = match.stats?.shotsOnTarget?.home || 0;
    const shotsOnTargetAway = match.stats?.shotsOnTarget?.away || 0;
    const totalShotsOnTarget = shotsOnTargetHome + shotsOnTargetAway;

    const totalShotsHome = match.stats?.totalShots?.home || 0;
    const totalShotsAway = match.stats?.totalShots?.away || 0;
    const totalShots = totalShotsHome + totalShotsAway;

    const attacksHome = match.stats?.dangerousAttacks?.home || 0;
    const attacksAway = match.stats?.dangerousAttacks?.away || 0;
    const totalDangerousAttacks = attacksHome + attacksAway;

    const posHome = match.stats?.possession?.home || 50;
    const posAway = match.stats?.possession?.away || 50;

    // --- KIỂM TRA ĐIỀU KIỆN ---
    const isEpSan = (posHome >= 60 || posAway >= 60) || (attacksHome >= 35 || attacksAway >= 35) || (totalDangerousAttacks >= 55);
    const isDoiCong = (attacksHome >= 25 && attacksAway >= 25) && (totalShots >= 12 || totalShotsOnTarget > 8);
    
    // Hiệu suất dứt điểm trúng đích (Shots on Target / Total Shots)
    const accuracyRate = totalShots > 0 ? (totalShotsOnTarget / totalShots) : 0;
    const isHighEfficiency = accuracyRate >= 0.40; // Tỷ lệ trúng đích >= 40%

    // --- TÍNH TOÁN XÁC SUẤT NỔ BÀN THẮNG (%) ---
    let winRate = 50; // Điểm nền khởi điểm

    if (aiScore > 75) winRate += 10;
    if (hasRedCard) winRate += 15; // Có thẻ đỏ tăng xác suất rất cao
    if (isEpSan) winRate += 10;
    if (isDoiCong) winRate += 10;
    if (isHighEfficiency) winRate += 10;
    if (totalShotsOnTarget >= 8) winRate += 10;

    // Giới hạn xác suất tối đa 98%
    winRate = Math.min(winRate, 98);

    // Bắt buộc tỷ lệ nổ bàn > 60% VÀ thỏa mãn (Ép sân HOẶC Đôi công HOẶC Thẻ đỏ)
    const isQualified = winRate > 60 && (isEpSan || isDoiCong || hasRedCard);

    return { isQualified, winRate };
}

// Dữ liệu mẫu kiểm thử từ phút 60 trở đi
const mockMatches = [
    {
        id: 2001,
        match_id: 2001,
        fixture: { id: 2001, status: { short: '2H', elapsed: 68 } },
        league: { id: 39, name: 'Premier League', country: 'England' },
        teams: {
            home: { id: 33, name: 'Arsenal', logo: '' },
            away: { id: 40, name: 'Chelsea', logo: '' }
        },
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea',
        home_team: 'Arsenal',
        away_team: 'Chelsea',
        homeScore: 1,
        awayScore: 1,
        home_score: 1,
        away_score: 1,
        goals: { home: 1, away: 1 },
        score: '1 - 1',
        status: '2H',
        time: '68',
        elapsed: 68,
        minute: '68\'',
        aiScore: 82,
        ai_score: 82,
        score_ai: 82,
        stats: {
            redCards: { home: 1, away: 0 },         // Có thẻ đỏ
            shotsOnTarget: { home: 6, away: 4 },    // 10 cú sút trúng đích
            totalShots: { home: 12, away: 8 },      // Tổng 20 cú sút
            dangerousAttacks: { home: 42, away: 35 },// Đôi công ép sân mạnh
            possession: { home: 58, away: 42 }
        }
    }
];

// Endpoint live matches cho Dashboard & Tự động báo Telegram
app.get('/api/matches/live', async (req, res) => {
    const qualifiedMatches = [];

    for (const match of mockMatches) {
        const { isQualified, winRate } = analyzeKeoRungH2(match);
        if (isQualified) {
            match.winRate = winRate;
            match.win_rate = winRate;
            match.prediction = `Xác suất nổ bàn: ${winRate}%`;
            qualifiedMatches.push(match);

            // Tự động bắn tin nhắn về Telegram
            await sendTelegramAlert(match, winRate);
        }
    }

    const currentUrl = 'https://football-api-5i9a.onrender.com/api/matches/live';

    res.json({
        success: true,
        status: 'success',
        url: currentUrl,
        endpoint: currentUrl,
        count: qualifiedMatches.length,
        results: qualifiedMatches.length,
        total: qualifiedMatches.length,
        data: qualifiedMatches,
        response: qualifiedMatches,
        matches: qualifiedMatches
    });
});

// Telegram Webhook Endpoint
app.post('/bot:token', (req, res) => {
    res.status(200).json({ success: true, message: 'Telegram Webhook active' });
});

app.listen(PORT, () => {
    console.log(`Server Keo Rung H2 dang chay tai port ${PORT}`);
});