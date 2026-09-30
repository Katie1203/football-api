const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// 1. Health check
app.get('/', (req, res) => {
    res.json({ message: 'API bong da dang hoat dong!' });
});

// Mock data chuan định dạng API-Football / Dashboard
const mockMatches = [
    {
        fixture: { id: 1001, status: { short: '1H', elapsed: 35 } },
        league: { id: 39, name: 'Premier League', country: 'England' },
        teams: {
            home: { id: 33, name: 'Manchester United' },
            away: { id: 40, name: 'Liverpool' }
        },
        goals: { home: 1, away: 0 },
        score: { halftime: { home: 1, away: 0 } }
    },
    {
        fixture: { id: 1002, status: { short: '2H', elapsed: 70 } },
        league: { id: 140, name: 'La Liga', country: 'Spain' },
        teams: {
            home: { id: 541, name: 'Real Madrid' },
            away: { id: 529, name: 'Barcelona' }
        },
        goals: { home: 2, away: 2 },
        score: { halftime: { home: 1, away: 1 } }
    }
];

// 2. Endpoint tra ve live matches
app.get('/api/matches/live', (req, res) => {
    // Trả về cả dạng mảng trực tiếp lẫn bọc trong response/data để tương thích mọi Dashboard
    res.json({
        success: true,
        results: mockMatches.length,
        response: mockMatches,
        data: mockMatches
    });
});

// 3. Telegram Webhook
app.post('/bot:token', (req, res) => {
    res.status(200).json({ success: true, message: 'Telegram Webhook active' });
});

app.listen(PORT, () => {
    console.log(`Server dang chay tai port ${PORT}`);
});