const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Trang chủ kiểm tra API
app.get('/', (req, res) => {
    res.json({ message: 'API bong da dang hoat dong!' });
});

// Đường dẫn lấy thông tin các trận đang diễn ra (Live)
app.get('/api/matches/live', async (req, res) => {
    try {
        const apiKey = process.env.FOOTBALL_API_KEY;
        
        if (!apiKey) {
            return res.status(500).json({ success: false, error: 'Chua cau hinh FOOTBALL_API_KEY' });
        }

        const response = await axios.get('https://api-football-v1.p.rapidapi.com/v3/fixtures', {
            params: { live: 'all' },
            headers: {
                'X-RapidAPI-Key': apiKey,
                'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com'
            }
        });

        res.json({
            success: true,
            total: response.data.results,
            data: response.data.response
        });
    } catch (error) {
        console.error('Loi khi goi API:', error.message);
        res.status(500).json({
            success: false,
            message: 'Loi server khi lay du lieu tran dau',
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server dang chay tai port ${PORT}`);
});