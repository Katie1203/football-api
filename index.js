const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Điền API Key của bạn ở đây nếu chưa đặt trong Environment Variable của Render
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_TELEGRAM_CHAT_ID';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'YOUR_RAPIDAPI_KEY';

let liveMatchesCache = [];

// Hàm lấy danh sách trận đấu live từ RapidAPI
async function fetchRealLiveMatches() {
    if (!RAPIDAPI_KEY || RAPIDAPI_KEY.includes('YOUR_')) {
        console.log('⚠️ Chưa điền RAPIDAPI_KEY, vui lòng kiểm tra lại!');
        return [];
    }

    try {
        const response = await axios.get('https://api-football-v1.p.rapidapi.com/v3/fixtures', {
            params: { live: 'all' },
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': 'api-football-v1.p.rapidapi.com'
            }
        });
        return response.data.response || [];
    } catch (error) {
        console.error(`[API Fetch Error] ${error.message}`);
        return [];
    }
}

// Hàm tự động quét dữ liệu theo múi giờ Việt Nam
async function runAutoScanner() {
    const gioVietNam = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    console.log(`[Auto-Scan] Đang tải danh sách trận đấu THỰC TẾ... (${gioVietNam})`);
    
    const realMatches = await fetchRealLiveMatches();
    liveMatchesCache = realMatches;
}

app.get('/', (req, res) => {
    res.send('Football API Server đang hoạt động!');
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
    // Chạy lần đầu ngay khi server khởi động
    runAutoScanner();
    // Tự động quét lại mỗi 60 giây
    setInterval(runAutoScanner, 60000);
});