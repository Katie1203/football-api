const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// 1. Endpoint kiem tra trang thai server (Health Check)
app.get('/', (req, res) => {
    res.json({ message: 'API bong da dang hoat dong!' });
});

// 2. Endpoint lay danh sach cac tran dau dang da (Live Scores)
app.get('/api/matches/live', async (req, res) => {
    try {
        const apiKey = process.env.FOOTBALL_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ success: false, error: 'Chua cau hinh FOOTBALL_API_KEY tren Render' });
        }

        const response = await axios.get('https://api-football-v1.p.rapidapi.com/v3/fixtures', {
            params: { live: 'all' },
            headers: {
                'X-RapidAPI-Key': apiKey,
                'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com'
            }
        });

        // Tra ve cau truc mang data cho dashboard doc đuoc
        const matches = response.data.response || [];
        res.json({
            success: true,
            total: response.data.results || 0,
            data: matches
        });
    } catch (error) {
        console.error('Loi API Football:', error.message);
        res.status(500).json({
            success: false,
            message: 'Loi server khi lay du lieu tran dau',
            error: error.message
        });
    }
});

// 3. Endpoint Telegram Webhook (Xu ly tin nhan & test ket noi)
app.post('/bot:token', (req, res) => {
    // Tra ve status 200 de Telegram / Dashboard xac nhan ket noi thanh cong
    res.status(200).json({ success: true, message: 'Telegram Webhook active' });
});

app.listen(PORT, () => {
    console.log(`Server dang chay tai port ${PORT}`);
});