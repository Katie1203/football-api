const express = require('express');
const axios = require('axios');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
let electron = null;
try { electron = require('electron'); } catch (_) { electron = null; }

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ==========================================
// HỆ THỐNG HỨNG LOG ĐỂ ĐẨY LÊN GIAO DIỆN WEB
// ==========================================
let liveLogs = [];
let systemStartTime = Date.now();

function addLog(message) {
    const timeStr = new Date().toLocaleTimeString();
    const logEntry = `[${timeStr}] ${message}`;
    console.log(logEntry);
    liveLogs.unshift(logEntry);
    if (liveLogs.length > 80) liveLogs.pop();
}

const originalConsoleLog = console.log;
console.log = function(...args) {
    originalConsoleLog.apply(console, args);
    addLog(args.join(' '));
};

const originalConsoleError = console.error;
console.error = function(...args) {
    originalConsoleError.apply(console, args);
    addLog(`[LỖI]: ${args.join(' ')}`);
};

// ==========================================
// CẤU HÌNH DỮ LIỆU & API TÁCH BIỆT KEY CHÍNH / PHỤ
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

const PREMIUM_RAPIDAPI_KEY = process.env.PREMIUM_RAPIDAPI_KEY || '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';
const SOFASCORE_RAPIDAPI_KEY = process.env.SOFASCORE_KEY || '196a145d93mshdea278b2009d5bdp1cf9c9jsn712c8ea84816';

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;
const RAPIDAPI_HOST = 'free-api-live-football-data.p.rapidapi.com';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

const sentAlerts = new Set();

// ==========================================
// KHỞI TẠO SQLITE AN TOÀN CHO FILE .EXE (ELECTRON)
// ==========================================
const electronApp = electron ? (electron.app || (electron.remote && electron.remote.app)) : null;
const userdataPath = electronApp ? electronApp.getPath('userData') : __dirname;
const dbPath = path.join(userdataPath, 'picks_history.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Lỗi SQLite:', err.message);
    } else {
        console.log('Đã kết nối CSDL SQLite thành công tại:', dbPath);
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS picks (
        id TEXT PRIMARY KEY,
        league TEXT,
        homeName TEXT,
        awayName TEXT,
        pickHomeScore INTEGER,
        pickAwayScore INTEGER,
        ftHomeScore INTEGER,
        ftAwayScore INTEGER,
        elapsed INTEGER,
        ruleEfficiency REAL,
        betType TEXT,
        ruleName TEXT,
        oddsInfo TEXT,
        status TEXT DEFAULT 'PENDING',
        createdAt TEXT
    )`);
});

function loadSentAlertsFromDB() {
    db.all(`SELECT id FROM picks`, [], (err, rows) => {
        if (!err && rows) {
            rows.forEach(row => sentAlerts.add(row.id));
            console.log(`Đã tải ${sentAlerts.size} bản ghi lịch sử trận đấu vào bộ nhớ đệm.`);
        }
    });
}

function getVietnamTime() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return {
        dateStr: vnTime.toISOString().slice(0, 10),
        timeStr: vnTime.toISOString().slice(11, 19),
        fullStr: `${vnTime.toISOString().slice(11, 16)} ${vnTime.toISOString().slice(8, 10)}-${vnTime.toISOString().slice(5, 7)}`
    };
}

// ==========================================
// HÀM TÍNH PHÚT TRẬN ĐẤU CHUẨN XÁC SOFASCORE
// ==========================================
function calculateExactMinute(item) {
    if (!item) return 0;

    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht') return 45;
    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft')) return 90;

    const matchDesc = statusDesc.match(/^(\d+)['\s]?$/);
    if (matchDesc) return parseInt(matchDesc[1], 10);

    const nowSeconds = Math.floor(Date.now() / 1000);
    let periodStart = item.time?.currentPeriodStartTimestamp || item.statusTime?.currentPeriodStartTimestamp;
    
    if (periodStart) {
        if (periodStart > 9999999999) periodStart = Math.floor(periodStart / 1000);

        let elapsedInPeriod = Math.floor((nowSeconds - periodStart) / 60);
        if (elapsedInPeriod < 0) elapsedInPeriod = 0;

        const isSecondHalf = statusType.includes('second') || 
                           statusDesc.includes('2nd') || 
                           item.time?.period === 2 || 
                           item.time?.currentPeriod === 2 ||
                           statusType === 'inprogress_2nd';

        if (isSecondHalf) return 45 + elapsedInPeriod;
        return elapsedInPeriod;
    }

    let initialTime = item.statusTime?.initial || item.time?.initial;
    if (initialTime) {
        if (initialTime > 9999999999) initialTime = Math.floor(initialTime / 1000);
        const elapsed = Math.floor((nowSeconds - initialTime) / 60);
        if (elapsed > 0 && elapsed <= 120) return elapsed;
    }

    const anyNum = statusDesc.match(/\d+/);
    if (anyNum) return parseInt(anyNum[0], 10);

    return 0;
}

function parseLeagueName(item) {
    if (!item) return 'Bóng Đá Quốc Tế';
    const category = item.tournament?.category?.name || item.category?.name || '';
    const tournament = item.tournament?.name || item.competitionName || '';
    if (category && tournament) {
        return tournament.toLowerCase().includes(category.toLowerCase()) ? tournament : `${category}: ${tournament}`;
    }
    return tournament || category || 'Bóng Đá Quốc Tế';
}

// ==========================================
// TỰ ĐỘNG CẬP NHẬT KẾT QUẢ FT (THẮNG/THUA)
// ==========================================
async function updatePendingPicksResult(sofaMatches) {
    db.all("SELECT * FROM picks WHERE status = 'PENDING'", async (err, pendingRows) => {
        if (err || !pendingRows || pendingRows.length === 0) return;

        for (const row of pendingRows) {
            const liveMatch = sofaMatches.find(m => String(m.id) === String(row.id));

            if (liveMatch) {
                const statusType = String(liveMatch.status?.type || '').toLowerCase();
                const isEnded = statusType.includes('ended') || statusType.includes('finished');

                if (isEnded) {
                    const ftHome = liveMatch.homeScore?.current ?? row.pickHomeScore;
                    const ftAway = liveMatch.awayScore?.current ?? row.pickAwayScore;
                    const pickTotal = row.pickHomeScore + row.pickAwayScore;
                    const ftTotal = ftHome + ftAway;
                    
                    const newStatus = (ftTotal > pickTotal) ? 'THẮNG' : 'THUA';

                    db.run("UPDATE picks SET ftHomeScore = ?, ftAwayScore = ?, status = ? WHERE id = ?", 
                        [ftHome, ftAway, newStatus, row.id]);
                }
            } else {
                db.run("UPDATE picks SET status = 'BỎ THEO DÕI' WHERE id = ?", [row.id]);
            }
        }
    });
}

// ==========================================
// THỐNG KÊ CHI TIẾT & INCIDENTS
// ==========================================
async function fetchMatchIncidents(matchId) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
            headers: { 'x-rapidapi-key': PREMIUM_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 6000
        });

        const incidents = response.data?.incidents || [];
        const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');

        if (goalEvents.length === 0) return 'Chưa có bàn thắng (0-0)';

        goalEvents.sort((a, b) => (a.time || 0) - (b.time || 0));

        const timeline = goalEvents.map(g => {
            const min = g.time || 0;
            const extra = g.addedTime ? `+${g.addedTime}` : '';
            const player = g.player?.shortName || g.player?.name || 'Cầu thủ';
            const isHome = g.isHome ? '⚽ [Chủ]' : '⚽ [Khách]';
            const scoreStr = (g.homeScore !== undefined && g.awayScore !== undefined) ? `[${g.homeScore}-${g.awayScore}]` : '';
            return `• Phút ${min}'${extra}: ${isHome} ${player} ${scoreStr}`;
        });

        return timeline.join('\n');
    } catch (err) {
        return 'Chưa cập nhật được diễn biến bàn thắng';
    }
}

async function fetchOddsData() {
    if (!ODDS_API_KEY) return [];
    try {
        const response = await axios.get(ODDS_API_URL, { timeout: 8000 });
        return response.data || [];
    } catch (err) { return []; }
}

async function fetchSofaScoreLive() {
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: { 'x-rapidapi-key': SOFASCORE_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 15000
        });
        const events = response.data?.events || response.data?.liveEvents || response.data?.matches || [];
        return events;
    } catch (err) {
        console.error(`[Lỗi SofaScore API]:`, err.message);
        return [];
    }
}

function sofaEmptyH2Stats(source = 'none') {
    return {
        shotsOnTarget: 0, totalShots: 0, shotsOffTarget: 0, blockedShots: 0,
        corners: 0, possession: 0, dangerousAttacks: 0, attacks: 0,
        bigChances: 0, bigChancesMissed: 0, finalThirdEntries: 0,
        goalkeeperSaves: 0, yellowCards: 0, redCards: 0, fouls: 0,
        available: {}, source
    };
}

function sofaNumber(v) {
    if (typeof v === 'string') v = v.replace('%', '').trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function normalizeSofaPeriod(v) {
    return String(v ?? '').toUpperCase().replace(/[\s_-]+/g, '');
}

function parseSofaPeriodBlock(periodBlock, source) {
    const out = sofaEmptyH2Stats(source);
    const groups = Array.isArray(periodBlock?.groups) ? periodBlock.groups : [];

    const mapKey = (key, name) => {
        const k = String(key || '');
        const n = String(name || '').toLowerCase();
        if (k === 'shotsOnGoal' || n.includes('shots on target')) return 'shotsOnTarget';
        if (k === 'totalShotsOnGoal' || n === 'total shots') return 'totalShots';
        if (k === 'shotsOffGoal' || n.includes('shots off')) return 'shotsOffTarget';
        if (k === 'blockedScoringAttempt' || n.includes('blocked')) return 'blockedShots';
        if (k === 'cornerKicks' || n.includes('corner')) return 'corners';
        if (k === 'ballPossession' || n.includes('possession')) return 'possession';
        if (k === 'dangerousAttacks' || n.includes('dangerous attack')) return 'dangerousAttacks';
        if (k === 'attacks' || n === 'attacks') return 'attacks';
        if (k === 'bigChanceCreated' || n === 'big chances') return 'bigChances';
        if (k === 'bigChanceMissed' || n.includes('big chances missed')) return 'bigChancesMissed';
        if (k === 'finalThirdEntries' || n.includes('final third')) return 'finalThirdEntries';
        if (k === 'goalkeeperSaves' || n.includes('goalkeeper saves')) return 'goalkeeperSaves';
        if (k === 'yellowCards' || n.includes('yellow card')) return 'yellowCards';
        if (k === 'redCards' || n.includes('red card')) return 'redCards';
        if (k === 'fouls' || n === 'fouls') return 'fouls';
        return null;
    };

    for (const group of groups) {
        const items = group?.statisticsItems || group?.statistics || group?.items || [];
        if (!Array.isArray(items)) continue;
        for (const st of items) {
            const field = mapKey(st?.key, st?.name);
            if (!field) continue;

            const home = st?.home ?? st?.homeValue ?? st?.valueHome ?? st?.home_value ?? st?.values?.[0];
            const away = st?.away ?? st?.awayValue ?? st?.valueAway ?? st?.away_value ?? st?.values?.[1];
            const hasHome = home !== undefined && home !== null && home !== '';
            const hasAway = away !== undefined && away !== null && away !== '';
            if (!hasHome && !hasAway) continue;

            const h = sofaNumber(home), a = sofaNumber(away);
            // Possession is a percentage, not an additive count.
            out[field] = field === 'possession' ? (h + a) / 2 : h + a;
            out.available[field] = true;
        }
    }
    return out;
}

function findSofaPeriodArray(data) {
    const direct = [
        data?.statistics,
        data?.data?.statistics,
        data?.response?.statistics,
        data?.result?.statistics
    ];
    for (const x of direct) {
        if (Array.isArray(x) && x.some(p => p && p.period !== undefined)) return x;
    }

    // Limited recursive fallback for alternate Sofa wrappers.
    const seen = new Set();
    function walk(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return null;
        seen.add(obj);
        if (Array.isArray(obj)) {
            if (obj.some(p => p && typeof p === 'object' && p.period !== undefined &&
                (Array.isArray(p.groups) || p.statisticsItems))) return obj;
            for (const x of obj) {
                const r = walk(x, depth + 1);
                if (r) return r;
            }
            return null;
        }
        for (const v of Object.values(obj)) {
            const r = walk(v, depth + 1);
            if (r) return r;
        }
        return null;
    }
    return walk(data, 0) || [];
}

function deriveSofaH2FromAllMinus1st(allStats, firstStats) {
    const out = sofaEmptyH2Stats('sofa-ALL-minus-1ST');
    // Only additive fields may be subtracted. Possession is deliberately excluded.
    const additive = [
        'shotsOnTarget','totalShots','shotsOffTarget','blockedShots','corners',
        'dangerousAttacks','attacks','bigChances','bigChancesMissed',
        'finalThirdEntries','goalkeeperSaves','yellowCards','redCards','fouls'
    ];
    for (const field of additive) {
        if (allStats.available[field] && firstStats.available[field]) {
            out[field] = Math.max(0, sofaNumber(allStats[field]) - sofaNumber(firstStats[field]));
            out.available[field] = true;
        }
    }
    return out;
}

async function fetchSofaScoreStats(matchId) {
    const urls = [
        `https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`,
        `https://${SOFASCORE_HOST}/matches/get-statistics?matchId=${matchId}`
    ];

    for (let i = 0; i < urls.length; i++) {
        try {
            const response = await axios.get(urls[i], {
                headers: {
                    'x-rapidapi-key': SOFASCORE_RAPIDAPI_KEY.trim(),
                    'x-rapidapi-host': SOFASCORE_HOST
                },
                timeout: 7000
            });

            const periods = findSofaPeriodArray(response.data);
            const periodNames = periods.map(p => String(p?.period ?? '')).filter(Boolean);
            const h2 = periods.find(p => ['2ND','2','SECONDHALF','2NDHALF'].includes(normalizeSofaPeriod(p?.period)));

            if (h2) {
                const parsed = parseSofaPeriodBlock(h2, 'sofa-2ND');
                console.log(`    ├─ [Sofa JSON Statistics] H2=2ND | fields=${Object.keys(parsed.available).join(',') || 'none'}`);
                if (Object.keys(parsed.available).length) return parsed;
            }

            // JSON fallback: ALL - 1ST gives 46' -> current for additive counters.
            const all = periods.find(p => ['ALL','FULL','MATCH'].includes(normalizeSofaPeriod(p?.period)));
            const first = periods.find(p => ['1ST','1','FIRSTHALF','1STHALF'].includes(normalizeSofaPeriod(p?.period)));
            if (all && first) {
                const allParsed = parseSofaPeriodBlock(all, 'sofa-ALL');
                const firstParsed = parseSofaPeriodBlock(first, 'sofa-1ST');
                const derived = deriveSofaH2FromAllMinus1st(allParsed, firstParsed);
                if (Object.keys(derived.available).length) {
                    console.log(`    ├─ [Sofa JSON Statistics] H2=ALL-1ST | fields=${Object.keys(derived.available).join(',')}`);
                    return derived;
                }
            }

            const topKeys = response.data && typeof response.data === 'object'
                ? Object.keys(response.data).slice(0, 12).join(',') : 'none';
            const preview = (() => {
                try { return JSON.stringify(response.data).slice(0, 300); } catch (_) { return ''; }
            })();
            console.log(`    ├─ [Sofa Stats DEBUG] endpoint=${i === 0 ? 'eventId' : 'matchId'} | HTTP ${response.status} | periods=${periodNames.join(',') || 'N/A'} | topKeys=${topKeys}`);
            if (!periods.length) console.log(`    │  └─ response=${preview || 'EMPTY'}`);
        } catch (err) {
            const status = err?.response?.status;
            console.log(`    ├─ [Sofa Stats] ${i === 0 ? 'eventId' : 'matchId'} | HTTP ${status || 'ERR'} | ${err.message}`);
            if ([401,403,429].includes(status)) break;
        }
    }

    return sofaEmptyH2Stats('none');
}

const sofaGraphCache = new Map();

async function fetchSofaScoreGraph(matchId, elapsed) {
    const empty = { available: false, score: 0, points: 0, source: 'none' };
    const key = String(matchId);
    const cached = sofaGraphCache.get(key);
    if (cached && Date.now() - cached.time < 4 * 60 * 1000) return cached.data;

    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}/matches/get-graph?matchId=${matchId}`, {
            headers: {
                'x-rapidapi-key': SOFASCORE_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 7000
        });

        // User's Sofa Graph JSON: graphPoints[] with minute/value.
        const points = response.data?.graphPoints || response.data?.data?.graphPoints || [];
        if (!Array.isArray(points) || !points.length) {
            console.log(`    ├─ [Sofa JSON Graph] N/A | HTTP ${response.status} | graphPoints=0`);
            return empty;
        }

        // Only second-half graph. Recent window is used for momentum,
        // while the Statistics JSON represents 46' -> current.
        const h2Points = points.filter(p => {
            const minute = Number(p?.minute);
            return Number.isFinite(minute) && minute >= 46 && minute <= elapsed;
        });
        const fromMinute = Math.max(46, elapsed - 9);
        const recent = h2Points.filter(p => Number(p?.minute) >= fromMinute);

        if (!recent.length) {
            console.log(`    ├─ [Sofa JSON Graph] H2 points=${h2Points.length} | recent=0`);
            return empty;
        }

        let homePressure = 0, awayPressure = 0, intensity = 0;
        for (const p of recent) {
            const v = sofaNumber(p?.value);
            intensity += Math.abs(v);
            if (v > 0) homePressure += v;
            else if (v < 0) awayPressure += Math.abs(v);
        }

        const avgIntensity = intensity / recent.length;
        const activePoints = recent.filter(p => Math.abs(sofaNumber(p?.value)) >= 2).length;
        const score = Math.max(20, Math.min(95,
            30 + avgIntensity * 3.2 + Math.min(15, activePoints * 1.5)
        ));

        const data = {
            available: true,
            score: Number(score.toFixed(1)),
            points: recent.length,
            h2Points: h2Points.length,
            homePressure: Number(homePressure.toFixed(1)),
            awayPressure: Number(awayPressure.toFixed(1)),
            source: 'sofa-graph-H2-recent'
        };
        sofaGraphCache.set(key, { time: Date.now(), data });
        console.log(`    ├─ [Sofa JSON Graph] H2=${h2Points.length} pts | recent=${recent.length} | momentum=${data.score}%`);
        return data;
    } catch (err) {
        console.log(`    ├─ [Sofa Graph] HTTP ${err?.response?.status || 'ERR'} | ${err.message}`);
        return empty;
    }
}


async function fetchRapidApiMatchStats(matchId) {
    try {
        const response = await axios.get(`https://${RAPIDAPI_HOST}/football-match-get-statistics?matchid=${matchId}`, {
            headers: { 'x-rapidapi-key': PREMIUM_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': RAPIDAPI_HOST },
            timeout: 6000
        });
        const statsObj = response.data?.stats || response.data?.statistics || {};
        return {
            rapidShotsTarget: (statsObj.homeShotsOnTarget || 0) + (statsObj.awayShotsOnTarget || 0),
            rapidCorners: (statsObj.homeCorners || 0) + (statsObj.awayCorners || 0)
        };
    } catch (err) {
        return { rapidShotsTarget: 0, rapidCorners: 0 };
    }
}

async function fetchMatchDetailStats(matchId, elapsed) {
    const [sofaStats, rapidStats, sofaGraph] = await Promise.all([
        fetchSofaScoreStats(matchId),
        fetchRapidApiMatchStats(matchId),
        fetchSofaScoreGraph(matchId, elapsed)
    ]);
    return { sofaStats, rapidStats, sofaGraph };
}

function analyzeOddsGoalProbability(allOdds, homeName, awayName, currentTotalGoals) {
    if (!Array.isArray(allOdds) || allOdds.length === 0) return null;
    const clean = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hClean = clean(homeName), aClean = clean(awayName);

    const foundMatch = allOdds.find(m => {
        const mHome = clean(m.home_team), mAway = clean(m.away_team);
        return (mHome.includes(hClean) || hClean.includes(mHome)) && (mAway.includes(aClean) || aClean.includes(mAway));
    });

    if (!foundMatch || !foundMatch.bookmakers?.[0]) return null;
    const totalsMarket = foundMatch.bookmakers[0].markets?.find(mk => mk.key === 'totals');
    const overOutcome = totalsMarket?.outcomes?.find(o => o.name === 'Over');
    if (!overOutcome) return null;

    let impliedProb = (1 / overOutcome.price) * 100;
    if (overOutcome.point - currentTotalGoals <= 0.75) impliedProb += 15;
    if (overOutcome.price <= 1.85) impliedProb += 10;

    return {
        bookmaker: foundMatch.bookmakers[0].title,
        line: overOutcome.point,
        odds: overOutcome.price,
        scoreBoost: Math.min(Math.max(impliedProb, 40.0), 90.0)
    };
}

function evaluateMatchDynamicAI(metrics, elapsed, oddsAnalysis, homeScore, awayScore) {
    const st = metrics.sofaStats || sofaEmptyH2Stats();
    const graph = metrics.sofaGraph || { available: false, score: 0 };
    const a = st.available || {};
    const h2Minutes = Math.max(1, elapsed - 45);
    const rate10 = v => sofaNumber(v) / h2Minutes * 10;
    const band = (v, rows, fallback) => {
        for (const [min, score] of rows) if (v >= min) return score;
        return fallback;
    };

    const rates = {
        sot: rate10(st.shotsOnTarget), dangerous: rate10(st.dangerousAttacks),
        shots: rate10(st.totalShots), blocked: rate10(st.blockedShots),
        corners: rate10(st.corners)
    };
    const score = {
        momentum: graph.score || 0,
        sot: band(rates.sot, [[2.6,95],[2,88],[1.5,78],[1.1,68],[.75,58],[.45,45]], 28),
        dangerous: band(rates.dangerous, [[12,95],[9,87],[7,78],[5,68],[3.5,58],[2.2,46]], 30),
        shots: band(rates.shots, [[7,94],[5.5,86],[4.3,77],[3.3,67],[2.4,57],[1.6,45]], 30),
        blocked: band(rates.blocked, [[2.4,90],[1.8,82],[1.3,72],[.9,62],[.5,52],[.2,42]], 32),
        corners: band(rates.corners, [[2.4,92],[1.8,84],[1.3,74],[.9,64],[.55,54],[.25,44]], 32),
        possession: a.possession ? Math.max(40, Math.min(78, 50 + Math.abs(sofaNumber(st.possession) - 50) * 1.1)) : 0,
        odds: oddsAnalysis?.scoreBoost || 0
    };

    const parts = [];
    const add = (name, val, weight, ok) => {
        if (ok && Number.isFinite(val)) parts.push({name, val, weight});
    };
    add('Momentum', score.momentum, 25, graph.available);
    add('SOT H2', score.sot, 20, !!a.shotsOnTarget);
    add('Dangerous H2', score.dangerous, 15, !!a.dangerousAttacks);
    add('Shots H2', score.shots, 12, !!a.totalShots);
    add('Blocked H2', score.blocked, 8, !!a.blockedShots);
    add('Corners H2', score.corners, 8, !!a.corners);
    add('Possession H2', score.possession, 5, !!a.possession);
    add('Odds', score.odds, 5, !!oddsAnalysis);

    const diff = Math.abs(sofaNumber(homeScore) - sofaNumber(awayScore));
    let context = diff <= 1 ? 72 : diff === 2 ? 48 : 30;
    if (a.redCards && st.redCards > 0) context = Math.min(88, context + 10);
    add('Context', context, 2, true);

    const totalWeight = parts.reduce((n,p) => n+p.weight, 0);
    let ai = totalWeight ? parts.reduce((n,p) => n+p.val*p.weight,0)/totalWeight : 0;

    let surge = 0;
    if (graph.available) {
        if (graph.score >= 80) surge += 5;
        else if (graph.score >= 70) surge += 3;
        else if (graph.score >= 60) surge += 1.5;
    }
    if (a.shotsOnTarget && rates.sot >= 1.5) surge += 3;
    if (a.corners && rates.corners >= 1.3) surge += 1;
    if (a.blockedShots && rates.blocked >= 1) surge += 1;
    surge = Math.min(10, surge);
    ai += surge;

    let penalty = 0;
    if (diff >= 5 && elapsed >= 65) penalty += 12;
    else if (diff >= 3 && elapsed >= 70) penalty += 9;
    else if (diff >= 2 && elapsed >= 82) penalty += 5;
    if (elapsed >= 86 && (!graph.available || graph.score < 60)) penalty += 4;
    ai -= penalty;

    const signals = [
        graph.available, a.shotsOnTarget, a.dangerousAttacks, a.totalShots,
        a.blockedShots, a.corners, a.possession, !!oddsAnalysis
    ].filter(Boolean).length;

    if (signals <= 1) ai = Math.min(ai, 55);
    else if (signals === 2) ai = Math.min(ai, 62);
    if (elapsed >= 80 && (!graph.available || graph.score < 60)) ai = Math.min(ai, 67);
    if (elapsed >= 86 && (!graph.available || graph.score < 70)) ai = Math.min(ai, 64);

    const finalScore = Number(Math.max(5, Math.min(95, ai)).toFixed(1));
    const confidence = totalWeight;
    const show = (label,val,ok,extra='') => `• ${label}: ${ok ? `${Number(val).toFixed(1)}%${extra}` : 'N/A'}`;
    const detail = [
        `• 📡 H2 Stats source: ${st.source || 'none'} (46'→${elapsed}')`,
        show('⚡ Sofa Graph', score.momentum, graph.available, graph.available ? ` | ${graph.points} điểm gần nhất` : ''),
        show('🎯 SOT H2', score.sot, !!a.shotsOnTarget, a.shotsOnTarget ? ` | ${st.shotsOnTarget} | ${rates.sot.toFixed(1)}/10m` : ''),
        show('🔥 Dangerous H2', score.dangerous, !!a.dangerousAttacks, a.dangerousAttacks ? ` | ${st.dangerousAttacks}` : ''),
        show('🥅 Total Shots H2', score.shots, !!a.totalShots, a.totalShots ? ` | ${st.totalShots}` : ''),
        show('🧱 Blocked H2', score.blocked, !!a.blockedShots, a.blockedShots ? ` | ${st.blockedShots}` : ''),
        show('🚩 Corners H2', score.corners, !!a.corners, a.corners ? ` | ${st.corners}` : ''),
        show('📊 Possession H2', score.possession, !!a.possession),
        show('💰 Odds', score.odds, !!oddsAnalysis),
        `• 🚀 Recent Surge: +${surge.toFixed(1)}`,
        `• ⚠️ Penalty: -${penalty.toFixed(1)}`,
        `• 📦 Data Confidence: ${confidence}% | Signals ${signals}/8`
    ];

    // Legacy Rapid stats are retained as fallback diagnostics only because
    // their period is not proven H2; they must not contaminate 46'→current AI.
    if (metrics.rapidStats && !a.shotsOnTarget &&
        (metrics.rapidStats.rapidShotsTarget || metrics.rapidStats.rapidCorners)) {
        detail.push('• ℹ️ Rapid stats: có dữ liệu nhưng không cộng AI vì chưa xác nhận riêng H2');
    }

    return {
        efficiency: finalScore,
        betType: oddsAnalysis ? `Over ${oddsAnalysis.line} (${finalScore}%)` : `Over H2 (${finalScore}%)`,
        detailText: detail.join('\n'),
        shouldSend: finalScore >= 58,
        isBigBet: finalScore >= 75 && confidence >= 55 && graph.available && signals >= 3
    };
}

async function sendTelegramAlert(item) {
    const message = 
`🔔 RUNG CHUỔNG VÀNGGGG
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱️ Thời gian: Phút ${item.elapsed}'

⚽ DIỄN BIẾN TỶ SỐ:
${item.goalTimeline}

📊 THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🎯 Nhận định: Xác suất cao có THÊM BÀN THẮNG H2
📈 Loại kèo: ${item.betType}
📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.message);
    }
}

async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n[Auto-Scan AI] Đang quét phân tích trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, sofaMatches] = await Promise.all([
            fetchOddsData(),
            fetchSofaScoreLive()
        ]);

        await updatePendingPicksResult(sofaMatches);

        for (let index = 0; index < sofaMatches.length; index++) {
            const item = sofaMatches[index];
            const matchId = String(item.id);
            const elapsed = calculateExactMinute(item);
            const homeName = item.homeTeam?.name || 'Đội nhà';
            const awayName = item.awayTeam?.name || 'Đội khách';
            const homeScore = item.homeScore?.current ?? 0;
            const awayScore = item.awayScore?.current ?? 0;
            const league = parseLeagueName(item);

            console.log(`[Trận #${index + 1}] [ID: ${matchId}] [Phút: ${elapsed}'] [${league}] ${homeName} ${homeScore}-${awayScore} ${awayName}`);

            if (!matchId) continue;

            if (sentAlerts.has(matchId)) {
                console.log(`    └─> [Bỏ qua]: Đã gửi thông báo Telegram trước đó`);
                continue;
            }

            if (elapsed < 46) {
                console.log(`    └─> [Bỏ qua]: Chưa vào H2 (${elapsed}' < 46')`);
                continue;
            }

            if (elapsed > 92) {
                console.log(`    └─> [Bỏ qua]: Ngoài vùng quét (${elapsed}' > 92')`);
                continue;
            }

            const metrics = await fetchMatchDetailStats(matchId, elapsed);
            const goalTimeline = await fetchMatchIncidents(matchId);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + awayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, elapsed, oddsAnalysis, homeScore, awayScore);

            if (aiAnalysis.shouldSend) {
                console.log(`    └─> [AI CHỌN: NỔ BÀN H2] (${aiAnalysis.efficiency}%)`);
                
                const currentRuleName = oddsAnalysis ? 'BIGGG BET' : 'RUNG';
                const currentTotalGoals = homeScore + awayScore;
                const oddsLineVal = oddsAnalysis ? oddsAnalysis.line : (currentTotalGoals + 1.75);
                const oddsLabelInfo = `T/X ${oddsLineVal} · ${aiAnalysis.efficiency >= 75 ? 'CAO' : 'TRUNG BÌNH'}`;
                const shortBetType = oddsAnalysis ? `HT10_TOTAL${Math.round(oddsAnalysis.line)}` : `HT00_TOTAL2`;

                db.run(`INSERT OR REPLACE INTO picks 
                    (id, league, homeName, awayName, pickHomeScore, pickAwayScore, elapsed, ruleEfficiency, betType, ruleName, oddsInfo, status, createdAt) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
                    [matchId, league, homeName, awayName, homeScore, awayScore, elapsed, aiAnalysis.efficiency, shortBetType, currentRuleName, oddsLabelInfo, currentVN.fullStr]
                );

                await sendTelegramAlert({
                    id: matchId, league, homeName, awayName, homeScore, awayScore, elapsed,
                    goalTimeline, detailText: aiAnalysis.detailText, ruleEfficiency: aiAnalysis.efficiency, betType: aiAnalysis.betType
                });
            }
        }
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

// ==========================================
// API & HỆ THỐNG ĐA TAB DASHBOARD TRỰC QUAN
// ==========================================
app.get('/api/picks', (req, res) => {
    db.all("SELECT * FROM picks ORDER BY rowid DESC LIMIT 100", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/stats', (req, res) => {
    db.all("SELECT status, COUNT(*) as count FROM picks GROUP BY status", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let total = 0, wins = 0, losses = 0, pending = 0;
        rows.forEach(r => {
            total += r.count;
            if (r.status === 'THẮNG') wins = r.count;
            if (r.status === 'THUA') losses = r.count;
            if (r.status === 'PENDING') pending = r.count;
        });

        const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';
        res.json({ total, wins, losses, pending, winRate });
    });
});

app.get('/api/logs', (req, res) => {
    res.json(liveLogs);
});

app.get('/api/health', (req, res) => {
    const uptimeSec = Math.floor((Date.now() - systemStartTime) / 1000);
    res.json({
        status: 'OK',
        uptime: uptimeSec,
        memoryUsage: process.memoryUsage(),
        database: 'Connected (SQLite)',
        activeAlertsCount: sentAlerts.size
    });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TÀI LỘC - ADVANCED DASHBOARD</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background-color: #0b100d; color: #e1e1e1; padding: 20px; max-width: 1050px; margin: 0 auto; }
        
        .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; border-bottom: 1px solid #1a231e; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .logo { background-color: #92e32b; color: #000; font-weight: bold; width: 42px; height: 42px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        .title-text h2 { font-size: 18px; color: #fff; }
        .title-text p { font-size: 10px; color: #617367; font-weight: 600; margin-top: 2px; }
        
        .nav-tabs { display: flex; gap: 8px; margin-top: 15px; border-bottom: 1px solid #16221a; padding-bottom: 10px; }
        .tab-btn { background: #111814; color: #8a9e90; border: 1px solid #1b2720; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
        .tab-btn.active { background: #92e32b; color: #0b100d; border-color: #92e32b; }
        .tab-btn:hover { background: #1b2720; color: #fff; }

        .tab-content { display: none; margin-top: 20px; }
        .tab-content.active { display: block; }

        .logs-section { background: #070a08; border: 1px solid #16221a; border-radius: 12px; padding: 15px; margin-top: 15px; }
        .logs-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 12px; font-weight: 600; color: #92e32b; }
        .log-box { background: #020403; border: 1px solid #111a14; border-radius: 8px; height: 180px; overflow-y: auto; font-family: monospace; color: #38bdf8; font-size: 11px; padding: 12px; line-height: 1.4; }

        .card-list { display: flex; flex-direction: column; gap: 10px; }
        .card { background: #111814; border: 1px solid #1b2720; border-radius: 12px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; }
        .card-left { flex: 1; }
        .meta-info { font-size: 11px; color: #617367; font-weight: 600; margin-bottom: 5px; display: flex; gap: 10px; align-items: center; }
        .league-tag { background: #16221a; padding: 2px 6px; border-radius: 4px; color: #92e32b; }
        .match-title { font-size: 15px; font-weight: 700; color: #ffffff; margin-bottom: 3px; }
        .match-sub { font-size: 11px; color: #8a9e90; display: flex; gap: 12px; }
        .bet-tag { color: #38bdf8; font-weight: 600; }
        
        .card-right { text-align: right; min-width: 120px; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .badge { font-size: 11px; font-weight: 800; padding: 4px 8px; border-radius: 6px; text-transform: uppercase; display: inline-block; }
        .badge.THẮNG { background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); }
        .badge.THUA { background: rgba(248, 113, 113, 0.15); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); }
        .badge.PENDING, .badge.ĐANG { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
        .badge.BỎ { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }
        .ft-score { font-size: 12px; color: #a1b0a6; font-weight: 700; }

        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: #111814; border: 1px solid #1b2720; padding: 18px; border-radius: 12px; text-align: center; }
        .stat-card h3 { font-size: 24px; color: #fff; margin-bottom: 4px; }
        .stat-card p { font-size: 12px; color: #617367; font-weight: 600; }

        .lab-card { background: #111814; border: 1px solid #1b2720; padding: 20px; border-radius: 12px; margin-bottom: 15px; }
        .lab-card h4 { color: #92e32b; margin-bottom: 8px; font-size: 15px; }
        .lab-card p { font-size: 13px; color: #a1b0a6; line-height: 1.5; }

        .health-box { background: #111814; border: 1px solid #1b2720; padding: 20px; border-radius: 12px; font-family: monospace; font-size: 13px; line-height: 1.6; color: #34d399; }
    </style>
</head>
<body>

    <div class="header">
        <div class="brand">
            <div class="logo">TL</div>
            <div class="title-text">
                <h2>TÀI LỘC TRADING LAB</h2>
                <p>AUTOMATED FOOTBALL SCANNING SYSTEM</p>
            </div>
        </div>
        <button class="tab-btn" onclick="location.reload()" style="background:#16221a; color:#a1b0a6; border-color:#233328;">🔄 Làm mới</button>
    </div>

    <div class="nav-tabs">
        <button class="tab-btn active" onclick="switchTab('picks', this)">Picks (Tín hiệu)</button>
        <button class="tab-btn" onclick="switchTab('efficiency', this)">Hiệu quả (Analytics)</button>
        <button class="tab-btn" onclick="switchTab('rulelab', this)">Rule Lab</button>
        <button class="tab-btn" onclick="switchTab('health', this)">Health (Hệ thống)</button>
        <button class="tab-btn" onclick="window.close()" style="color:#f87171;">Thoát</button>
    </div>

    <!-- TAB 1: PICKS -->
    <div id="tab-picks" class="tab-content active">
        <div class="card-list" id="picksContainer">
            <p style="text-align: center; color: #617367; margin-top: 30px;">Đang tải danh sách tín hiệu...</p>
        </div>
        <div class="logs-section">
            <div class="logs-header">
                <span>🟢 NHẬT KÝ HOẠT ĐỘNG (LIVE LOGS)</span>
            </div>
            <div class="log-box" id="logBox">Đang nạp luồng log...</div>
        </div>
    </div>

    <!-- TAB 2: HIỆU QUẢ -->
    <div id="tab-efficiency" class="tab-content">
        <div class="stats-grid">
            <div class="stat-card">
                <h3 id="statTotal">0</h3>
                <p>TỔNG TÍN HIỆU</p>
            </div>
            <div class="stat-card">
                <h3 id="statWins" style="color: #34d399;">0</h3>
                <p>THẮNG</p>
            </div>
            <div class="stat-card">
                <h3 id="statLosses" style="color: #f87171;">0</h3>
                <p>THUA</p>
            </div>
            <div class="stat-card">
                <h3 id="statRate" style="color: #38bdf8;">0%</h3>
                <p>TỶ LỆ THẮNG</p>
            </div>
        </div>
        <div class="lab-card">
            <h4>📈 Đánh giá hiệu suất hoạt động chiến thuật</h4>
            <p>Hệ thống tự động theo dõi tỷ lệ thắng thua của các khung giờ phút 70'-90'. Các tín hiệu được cập nhật tự động trạng thái FT trực tiếp thông qua kết nối cơ sở dữ liệu tích hợp.</p>
        </div>
    </div>

    <!-- TAB 3: RULE LAB -->
    <div id="tab-rulelab" class="tab-content">
        <div class="lab-card">
            <h4>🔬 Rule AI: Quét Sút Trúng Đích & Góc Phút Cuối</h4>
            <p>• Ngưỡng thời gian kích hoạt: Phút 70 đến 90 của trận đấu.<br>• Điều kiện lọc: Đội bóng chịu áp lực cao, số cú sút trúng đích tối thiểu, xuất hiện thẻ đỏ hoặc biến động dòng tiền Over từ nhà cái.<br>• Tự động gửi cảnh báo tức thì qua kênh Telegram cấu hình sẵn.</p>
        </div>
    </div>

    <!-- TAB 4: HEALTH -->
    <div id="tab-health" class="tab-content">
        <div class="health-box" id="healthBox">
            Đang kiểm tra thông số vận hành hệ thống...
        </div>
    </div>

    <script>
        function switchTab(tabName, element) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.nav-tabs .tab-btn').forEach(el => el.classList.remove('active'));
            
            document.getElementById('tab-' + tabName).classList.add('active');
            if(element) element.classList.add('active');

            if(tabName === 'efficiency') loadStats();
            if(tabName === 'health') loadHealth();
        }

        async function loadPicks() {
            try {
                const res = await fetch('/api/picks');
                const data = await res.json();
                const container = document.getElementById('picksContainer');
                
                if(!data || data.length === 0) {
                    container.innerHTML = '<p style="text-align: center; color: #617367; margin-top: 30px;">Chưa có dữ liệu tín hiệu nào.</p>';
                    return;
                }

                container.innerHTML = data.map(item => {
                    let badgeClass = item.status;
                    let badgeText = item.status;
                    let ftText = '';

                    if(item.status === 'THẮNG' || item.status === 'THUA') {
                        ftText = \`FT \${item.ftHomeScore}-\${item.ftAwayScore}\`;
                    } else if(item.status === 'PENDING') {
                        badgeText = 'ĐANG ĐÁ';
                        ftText = 'Chờ kết quả FT';
                    } else if(item.status === 'BỎ THEO DÕI') {
                        badgeText = 'BỎ THEO DÕI';
                        ftText = 'không lấy được FT';
                    }

                    const ruleName = item.ruleName || 'BIGGG BET';
                    const oddsInfo = item.oddsInfo || 'T/X 2.25 · TRUNG BÌNH';

                    return \`
                        <div class="card">
                            <div class="card-left">
                                <div class="meta-info">
                                    <span>\${item.createdAt} · phút \${item.elapsed} ·\${ruleName}</span>
                                </div>
                                <div class="match-title">\${item.homeName}\${item.pickHomeScore}–\${item.pickAwayScore}\${item.awayName}</div>
                                <div class="match-sub">
                                    <span class="bet-tag">\${item.betType || 'HT10_TOTAL2'}</span>
                                    <span>· \${oddsInfo}</span>
                                </div>
                            </div>
                            <div class="card-right">
                                <div class="badge \${badgeClass}">\${badgeText}</div>
                                <div class="ft-score">\${ftText}</div>
                            </div>
                        </div>
                    \`;
                }).join('');
            } catch(e) { console.error(e); }
        }

        async function loadStats() {
            try {
                const res = await fetch('/api/stats');
                const data = await res.json();
                document.getElementById('statTotal').innerText = data.total;
                document.getElementById('statWins').innerText = data.wins;
                document.getElementById('statLosses').innerText = data.losses;
                document.getElementById('statRate').innerText = data.winRate + '%';
            } catch(e) {}
        }

        async function loadHealth() {
            try {
                const res = await fetch('/api/health');
                const data = await res.json();
                document.getElementById('healthBox').innerHTML = \`
                    🟢 TRẠNG THÁI HỆ THỐNG: \${data.status}<br>
                    ⏱️ THỜI GIAN HOẠT ĐỘNG (Uptime): \${Math.floor(data.uptime / 60)} phút \${data.uptime % 60} giây<br>
                    💾 CƠ SỞ DỮ LIỆU: \${data.database}<br>
                    🔔 BỘ NHỚ ĐỆM CẢNH BÁO: \${data.activeAlertsCount} trận đã xử lý<br>
                    💻 BỘ NHỚ RAM (Heap Used): \${(data.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB
                \`;
            } catch(e) {
                document.getElementById('healthBox').innerText = 'Không thể tải thông tin hệ thống.';
            }
        }

        async function fetchLogs() {
            try {
                const response = await fetch('/api/logs');
                const logs = await response.json();
                const logBox = document.getElementById('logBox');
                logBox.innerHTML = logs.join('<br>');
                logBox.scrollTop = logBox.scrollHeight;
            } catch (e) {}
        }

        loadPicks();
        setInterval(loadPicks, 15000);
        setInterval(fetchLogs, 2000);
</script>
</body>
</html>
`);
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
    
    loadSentAlertsFromDB();
    setTimeout(() => {
        scanLiveMatches();
        setInterval(scanLiveMatches, 5 * 60 * 1000);
    }, 2000);
});