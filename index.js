const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Cấu hình Telegram (Đã sửa chính xác ID)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

const alertedMatches = new Set();

// Dữ liệu danh sách trận đấu mẫu (mô phỏng đúng danh sách trong ảnh)
const matchesData = [
    {
        id: 101,
        homeTeam: 'Fundacion CD Tenerife B (W)',
        awayTeam: 'Real Madrid II (W)',
        score: '2–0',
        ftScore: 'FT 3–1',
        time: 'phút 76',
        tag: 'HT10_TOTAL2 · T/X 2.25 · TRUNG BÌNH',
        status: 'WIN', // THẮNG
        aiScore: 85
    },
    {
        id: 102,
        homeTeam: 'ACS Roma Florin Padurean (W)',
        awayTeam: 'ACS Targu Mures 1898 (W)',
        score: '2–2',
        ftScore: 'FT 3–3',
        time: 'phút 76',
        tag: 'HT10_TOTAL4 · T/X 3.75 · CAO',
        status: 'WIN',
        aiScore: 82
    },
    {
        id: 103,
        homeTeam: 'Karlslunds IF HFK',
        awayTeam: 'Bk Forward',
        score: '1–2',
        ftScore: 'FT 2–2',
        time: 'phút 75',
        tag: 'HT2_TOTAL3 · T/X 3 · THẤP',
        status: 'WIN',
        aiScore: 78
    },
    {
        id: 104,
        homeTeam: 'PFC Oleksandria',
        awayTeam: 'FK Yarud Mariupol',
        score: '1–1',
        ftScore: 'không lấy được FT',
        time: 'phút 83',
        tag: 'HT10_TOTAL2 · T/X 2.25 · TRUNG BÌNH',
        status: 'SKIP', // BỎ THEO DÕI
        aiScore: 50
    },
    {
        id: 105,
        homeTeam: 'Nữ Brommapojkarna',
        awayTeam: 'Nữ Malmo',
        score: '2–1',
        ftScore: 'FT 3–1',
        time: 'phút 83',
        tag: 'HT2_TOTAL3 · T/X 3.25 · TRUNG BÌNH',
        status: 'WIN',
        aiScore: 88
    }
];

// Hàm gửi tin nhắn báo kèo qua Telegram
async function sendTelegramAlert(match) {
    if (!TELEGRAM_CHAT_ID) return;

    const message = 
`🚨 KÈO RUNG
🏆 Giải đấu giao hữu / Quốc tế
${match.homeTeam} ${match.score} ${match.awayTeam} · ${match.time}
⚽ Diễn biến: Bàn thắng cập nhật H2
🎯 Nhận định: trận còn bàn thắng
📊 Hiệu quả rule: 78.5% · n=154`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`[Telegram Sent] ${match.homeTeam} vs ${match.awayTeam}`);
    } catch (error) {
        console.error('[Telegram Error]', error.message);
    }
}

// Tự động quét và bắn tin nhắn Telegram
async function runAutoScanner() {
    for (const match of matchesData) {
        if (match.status === 'WIN' && !alertedMatches.has(match.id)) {
            alertedMatches.add(match.id);
            await sendTelegramAlert(match);
        }
    }
}

setInterval(runAutoScanner, 60000);

// API trả dữ liệu cho Web
app.get('/api/matches', (req, res) => {
    res.json({ success: true, data: matchesData });
});

// Giao diện Web Dashboard (Dark Mode giống ảnh)
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Football Picks & Hiệu quả</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
            body { background-color: #0b1411; color: #ffffff; padding-bottom: 70px; }
            .container { max-width: 500px; margin: 0 auto; padding: 12px; }
            
            .card {
                background-color: #121d19;
                border-radius: 12px;
                padding: 14px;
                margin-bottom: 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border: 1px solid #1a2923;
            }
            .card-left { flex: 1; padding-right: 10px; }
            .time-tag { font-size: 11px; color: #7a8b84; margin-bottom: 4px; }
            .match-title { font-size: 15px; font-weight: bold; color: #ffffff; margin-bottom: 6px; line-height: 1.3; }
            .sub-tag { font-size: 11px; color: #5a6b64; }
            
            .badge-box { text-align: center; min-width: 100px; }
            .badge-win {
                background-color: #11281f;
                color: #2ed573;
                border-radius: 8px;
                padding: 12px 8px;
                font-weight: bold;
                font-size: 14px;
            }
            .badge-win .ft { font-size: 11px; color: #2ed573; margin-top: 4px; font-weight: normal; opacity: 0.8; }
            
            .badge-skip {
                background-color: #1f1b13;
                color: #eccc68;
                border-radius: 8px;
                padding: 12px 8px;
                font-weight: bold;
                font-size: 13px;
            }
            .badge-skip .ft { font-size: 11px; color: #7a715a; margin-top: 4px; font-weight: normal; }

            /* Bottom Nav */
            .navbar {
                position: fixed; bottom: 0; left: 0; right: 0;
                background-color: #090f0d;
                display: flex; justify-content: space-around;
                padding: 10px 0; border-top: 1px solid #15221c;
            }
            .nav-item { text-align: center; color: #5a6b64; font-size: 11px; text-decoration: none; }
            .nav-item.active { color: #2ed573; }
            .nav-icon { font-size: 16px; display: block; margin-bottom: 2px; }
        </style>
    </head>
    <body>
        <div class="container" id="match-list">
            <!-- Dữ liệu được load từ API -->
        </div>

        <div class="navbar">
            <a href="#" class="nav-item"><span class="nav-icon">◆</span>Picks</a>
            <a href="#" class="nav-item active"><span class="nav-icon">📊</span>Hiệu quả</a>
            <a href="#" class="nav-item"><span class="nav-icon">◇</span>Rule Lab</a>
            <a href="#" class="nav-item"><span class="nav-icon">●</span>Health</a>
            <a href="#" class="nav-item"><span class="nav-icon">⇆</span>Thoát</a>
        </div>

        <script>
            async function loadMatches() {
                const res = await fetch('/api/matches');
                const result = await res.json();
                const container = document.getElementById('match-list');
                
                container.innerHTML = result.data.map(m => {
                    if (m.status === 'WIN') {
                        return \`
                            <div class="card">
                                <div class="card-left">
                                    <div class="time-tag">19:28 27-09 · \${m.time} · BIGGG BET</div>
                                    <div class="match-title">\${m.homeTeam} \${m.score} \${m.awayTeam}</div>
                                    <div class="sub-tag">\${m.tag}</div>
                                </div>
                                <div class="badge-box">
                                    <div class="badge-win">
                                        THẮNG
                                        <div class="ft">\${m.ftScore}</div>
                                    </div>
                                </div>
                            </div>
                        \`;
                    } else {
                        return \`
                            <div class="card">
                                <div class="card-left">
                                    <div class="time-tag">19:27 27-09 · \${m.time} · BIGGG BET</div>
                                    <div class="match-title">\${m.homeTeam} \${m.score} \${m.awayTeam}</div>
                                    <div class="sub-tag">\${m.tag}</div>
                                </div>
                                <div class="badge-box">
                                    <div class="badge-skip">
                                        BỎ THEO DÕI
                                        <div class="ft">\${m.ftScore}</div>
                                    </div>
                                </div>
                            </div>
                        \`;
                    }
                }).join('');
            }

            loadMatches();
            setInterval(loadMatches, 10000);
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server Dashboard & Bot đang chạy tại port ${PORT}`);
    runAutoScanner();
});