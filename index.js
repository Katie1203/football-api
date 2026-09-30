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

// 2. Endpoint tra ve danh sach tran dau (Mock Data chuan format)
app.get('/api/matches/live', (req, res) => {
    res.json({
        success: true,
        total: 2,
        data: [
            {
                fixture: { id: 1001, status: { short: '1H', elapsed: 35 } },
                league: { name: 'Premier League', country: 'England' },
                teams: {
                    home: { name: 'Manchester United' },
                    away: { name: 'Liverpool' }
                },
                goals: { home: 1, away: 0 }
            },
            {
                fixture: { id: 1002, status: { short: '2H', elapsed: 70 } },
                league: { name: 'La Liga', country: 'Spain' },
                teams: {
                    home: { name: 'Real Madrid' },
                    away: { name: 'Barcelona' }
                },
                goals: { home: 2, away: 2 }
            }
        ]
    });
});

// 3. Telegram Webhook
app.post('/bot:token', (req, res) => {
    res.status(200).json({ success: true, message: 'Telegram Webhook active' });
});

app.listen(PORT, () => {
    console.log(`Server dang chay tai port ${PORT}`);
});