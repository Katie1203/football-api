const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ message: 'API bong da dang hoat dong!' });
});

// Mock matches bao gomi ca dinh dang API-Football lan dinh dang Dashboard AI Score
const mockMatches = [
    {
        id: 1001,
        match_id: 1001,
        fixture: { id: 1001, status: { short: '1H', elapsed: 35 } },
        league: { id: 39, name: 'Premier League', country: 'England' },
        teams: {
            home: { id: 33, name: 'Manchester United' },
            away: { id: 40, name: 'Liverpool' }
        },
        homeTeam: 'Manchester United',
        awayTeam: 'Liverpool',
        homeScore: 1,
        awayScore: 0,
        goals: { home: 1, away: 0 },
        score: { halftime: { home: 1, away: 0 } },
        status: '1H',
        time: '35',
        aiScore: 85,
        ai_score: 85,
        score_ai: 85
    },
    {
        id: 1002,
        match_id: 1002,
        fixture: { id: 1002, status: { short: '2H', elapsed: 70 } },
        league: { id: 140, name: 'La Liga', country: 'Spain' },
        teams: {
            home: { id: 541, name: 'Real Madrid' },
            away: { id: 529, name: 'Barcelona' }
        },
        homeTeam: 'Real Madrid',
        awayTeam: 'Barcelona',
        homeScore: 2,
        awayScore: 2,
        goals: { home: 2, away: 2 },
        score: { halftime: { home: 1, away: 1 } },
        status: '2H',
        time: '70',
        aiScore: 78,
        ai_score: 78,
        score_ai: 78
    }
];

// Endpoint live matches
app.get('/api/matches/live', (req, res) => {
    // Trả về trực tiếp mảng danh sách trận đấu và đính kèm các thuộc tính bọc ngoài
    const result = mockMatches;
    result.success = true;
    result.total = mockMatches.length;
    result.results = mockMatches.length;
    result.data = mockMatches;
    result.response = mockMatches;
    
    res.json(result);
});

// Telegram Webhook
app.post('/bot:token', (req, res) => {
    res.status(200).json({ success: true, message: 'Telegram Webhook active' });
});

app.listen(PORT, () => {
    console.log(`Server dang chay tai port ${PORT}`);
});