const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/', (req, res) => {
    res.json({ message: 'API Football Proxy & Keo Rung Service active!' });
});

// Hàm kiểm tra Logic Kèo Rung nâng cao
function checkKeoRungLogic(match) {
    const elapsed = match.fixture?.status?.elapsed || parseInt(match.time) || 0;
    const status = match.fixture?.status?.short || match.status || '';
    const aiScore = match.aiScore || match.score_ai || match.ai_score || 0;

    // 1. Điều kiện thời gian: Phút 15-38 (H1) hoặc 55-80 (H2)
    const isH1 = (status === '1H' || status === 'HT') && (elapsed >= 15 && elapsed <= 38);
    const isH2 = (status === '2H') && (elapsed >= 55 && elapsed <= 80);
    if (!isH1 && !isH2) return false;

    // 2. Điều kiện AI Score > 60
    if (aiScore <= 60) return false;

    // --- LẤY THỐNG KÊ CHI TIẾT ---
    const redHome = match.stats?.redCards?.home || match.red_cards_home || 0;
    const redAway = match.stats?.redCards?.away || match.red_cards_away || 0;
    const hasRedCard = (redHome + redAway) > 0;

    const shotsHome = match.stats?.shotsOnTarget?.home || match.shots_on_target_home || 0;
    const shotsAway = match.stats?.shotsOnTarget?.away || match.shots_on_target_away || 0;
    const totalShotsOnTarget = shotsHome + shotsAway;

    const totalShotsHome = match.stats?.totalShots?.home || 8;
    const totalShotsAway = match.stats?.totalShots?.away || 7;
    const totalShots = totalShotsHome + totalShotsAway;

    const attacksHome = match.stats?.dangerousAttacks?.home || match.dangerous_attacks_home || 0;
    const attacksAway = match.stats?.dangerousAttacks?.away || match.dangerous_attacks_away || 0;
    const totalDangerousAttacks = attacksHome + attacksAway;

    const posHome = match.stats?.possession?.home || 50;
    const posAway = match.stats?.possession?.away || 50;

    const isFavoriteTrailed = match.isFavoriteTrailed || false;

    // --- ĐIỀU KIỆN MỚI ---

    // A. Điều kiện Ép sân (1 đội áp đảo hoàn toàn)
    const isEpSan = (posHome >= 60 || posAway >= 60) || 
                    (attacksHome >= 35 || attacksAway >= 35) || 
                    (totalDangerousAttacks >= 55);

    // B. Điều kiện Đôi công 2 đội (Cả 2 đội cùng dâng cao)
    const isDoiCong = (attacksHome >= 25 && attacksAway >= 25) && 
                      (totalShots >= 12 || totalShotsOnTarget > 8);

    // C. Điều kiện Sút trúng đích / Cửa trên bị dẫn
    const meetsShotsCondition = (totalShotsOnTarget > 8) || isFavoriteTrailed;

    // D. Điều kiện Thẻ đỏ (Nếu có thẻ đỏ, chỉ số kích hoạt sẽ nhạy hơn)
    if (hasRedCard) {
        // Có thẻ đỏ -> Chỉ cần có ép sân hoặc đôi công là đủ điều kiện nổ tài
        return (isEpSan || isDoiCong || meetsShotsCondition);
    }

    // Kết hợp tổng thể khi KHÔNG có thẻ đỏ: Bắt buộc thỏa mãn Sút trúng đích + (Ép sân HOẶC Đôi công)
    return meetsShotsCondition && (isEpSan || isDoiCong);
}

// Dữ liệu giả lập mẫu thỏa mãn tất cả tiêu chí
const mockMatches = [
    {
        id: 1001,
        match_id: 1001,
        fixture: { id: 1001, status: { short: '1H', elapsed: 28 } },
        league: { id: 39, name: 'Premier League', country: 'England' },
        teams: {
            home: { id: 33, name: 'Manchester United' },
            away: { id: 40, name: 'Liverpool' }
        },
        homeTeam: 'Manchester United',
        awayTeam: 'Liverpool',
        homeScore: 0,
        awayScore: 1,
        goals: { home: 0, away: 1 },
        status: '1H',
        time: '28',
        aiScore: 78,
        ai_score: 78,
        score_ai: 78,
        isFavoriteTrailed: true,
        stats: {
            redCards: { home: 1, away: 0 },         // Có 1 thẻ đỏ
            shotsOnTarget: { home: 4, away: 5 },    // Tổng sút trúng đích = 9 (>8)
            totalShots: { home: 8, away: 9 },       // Tổng sút = 17 (>12)
            dangerousAttacks: { home: 38, away: 32 },// Đôi công ép sân (38 & 32)
            possession: { home: 42, away: 58 }
        }
    },
    {
        id: 1002,
        match_id: 1002,
        fixture: { id: 1002, status: { short: '2H', elapsed: 65 } },
        league: { id: 140, name: 'La Liga', country: 'Spain' },
        teams: {
            home: { id: 541, name: 'Real Madrid' },
            away: { id: 529, name: 'Barcelona' }
        },
        homeTeam: 'Real Madrid',
        awayTeam: 'Barcelona',
        homeScore: 1,
        awayScore: 2,
        goals: { home: 1, away: 2 },
        status: '2H',
        time: '65',
        aiScore: 85,
        ai_score: 85,
        score_ai: 85,
        isFavoriteTrailed: false,
        stats: {
            redCards: { home: 0, away: 0 },
            shotsOnTarget: { home: 6, away: 4 },    // Tổng = 10 (>8)
            totalShots: { home: 10, away: 7 },
            dangerousAttacks: { home: 45, away: 30 },// Real Madrid ép sân mạnh (45)
            possession: { home: 63, away: 37 }       // Kiểm soát bóng 63%
        }
    }
];

// Endpoint live matches
app.get('/api/matches/live', (req, res) => {
    const keoRungMatches = mockMatches.filter(match => checkKeoRungLogic(match));

    const responseData = keoRungMatches;
    responseData.success = true;
    responseData.total = keoRungMatches.length;
    responseData.results = keoRungMatches.length;
    responseData.data = keoRungMatches;
    responseData.response = keoRungMatches;

    res.json(responseData);
});

// Telegram Webhook Endpoint
app.post('/bot:token', (req, res) => {
    res.status(200).json({ success: true, message: 'Telegram Webhook active' });
});

app.listen(PORT, () => {
    console.log(`Server Keo Rung dang chay tai port ${PORT}`);
});