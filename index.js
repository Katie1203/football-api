const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());


// V17.0.1 + FULL LIVE DISCOVERY PATCH: PARTIAL STATS AI + COMPACT MISSING-ONLY LOG
// Mặc định chỉ hiện: chỉ số còn thiếu, DATA MISSING, cảnh báo đã gửi và lỗi quan trọng.
const COMPACT_MISSING_ONLY_LOG = String(process.env.DEBUG_LOG || '').toLowerCase() !== 'true';
const _consoleLog = console.log.bind(console);
console.log = (...args) => {
    if (!COMPACT_MISSING_ONLY_LOG) return _consoleLog(...args);
    const msg = args.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ');
    const keep = [
        '[THIẾU CHỈ SỐ]',
        '[DATA MISSING',
        '[ĐÃ GỬI TELEGRAM]',
        '[AI CHỌN NỔ BÀN]',
        '[AI CHƯA ĐẠT]',
        '[AI ĐẠT RULE]',
        '[MOMENTUM ALERT QUALIFIED]',
        '[API Fetch Error]',
        '[LIVEFOOTBALL LIVE ERROR]',
        '[LIVEFOOTBALL STATS ERROR]',
        '[CROSS-SOURCE ERROR]',
        'Server running',
        'BUILD V17',
        'Không thu thập được trận đấu nào'
    ];
    if (keep.some(k => msg.includes(k))) _consoleLog(...args);
};

// ==========================================
// CẤU HÌNH DỮ LIỆU & TELEGRAM
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8956360235:AAHTralILZmGJ9Ynm35M1DXa_S5tJ4eyAEs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7795416740';

const PAID_RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';

// Nguồn 1: SofaScore
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

// Nguồn 2: Livescore6 (Kết hợp kép đa endpoint để vét cạn toàn bộ giải đấu)
// V16.5: MERGED DISCOVERY + DEEP CROSS-SOURCE RESOLVER + FIELD COMPLETENESS LOG
// V16: LiveFootball fallback nằm giữa SofaScore và Livescore6
const LIVEFOOTBALL_HOST = 'free-api-live-football-data.p.rapidapi.com';
const LIVEFOOTBALL_LIVE_PATH = '/football-current-live';

// V16.5 - cache danh sách live để resolver không gọi lại API cho từng trận
const resolverLiveCache = { livefootball: { ts:0, data:null }, livescore6: { ts:0, live:null, date:null } };
const RESOLVER_CACHE_MS = 45 * 1000;
// V16.8: cache dữ liệu thật theo trận. Field đã lấy được không bị mất khi API vòng sau trả rỗng.
const dataMissingRetryCache = new Map();
const DATA_MISSING_RETRY_MS = 75 * 1000;
const persistentStatsCache = new Map();
const PERSISTENT_STATS_TTL_MS = 35 * 60 * 1000;
const liveFootballEventIdCache = new Map();
const EVENT_ID_CACHE_TTL_MS = 30 * 60 * 1000;

// V17.0.1 HOTFIX: helper dùng bởi persistent stats cache / LiveFootball event-id cache.
// Chỉ chuẩn hóa key; không thay đổi Rule, filter, resolver hay logic cảnh báo.
function normalizeTeamName(name = '') {
    return String(name || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/\breserves?\b/g, ' reserve ')
        .replace(/\bunder[ -]?(20|21|23)\b/g, ' u$1 ')
        .replace(/\bu[ -]?(20|21|23)\b/g, ' u$1 ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function statsCacheKey(matchId, homeName, awayName) {
    return `${normalizeTeamName(homeName||'')}|${normalizeTeamName(awayName||'')}`;
}
function getPersistentStats(key) {
    const x = persistentStatsCache.get(key);
    if (!x) return null;
    if (Date.now() - x.ts > PERSISTENT_STATS_TTL_MS) { persistentStatsCache.delete(key); return null; }
    return x;
}
function savePersistentStats(key, stats, present, advancedStats, sourceTrail=[]) {
    if (!key || !present || !Object.values(present).some(Boolean)) return;
    const old = getPersistentStats(key);
    const merged = mergeMissingStats(old?.stats || {}, old?.present || {}, stats || {}, present || {});
    const adv = { ...(old?.advancedStats || {}) };
    for (const k of ['xg','bigChances','shotsInsideBox','touchesOppBox']) {
        const v = Number(advancedStats?.[k]);
        if (Number.isFinite(v) && v > Number(adv[k] || 0)) adv[k] = v;
    }
    persistentStatsCache.set(key, { ts:Date.now(), stats:merged.stats, present:merged.present, advancedStats:adv, sourceTrail:[...new Set([...(old?.sourceTrail||[]), ...sourceTrail])] });
}
function getCachedLiveFootballEvent(homeName, awayName) {
    const key = `${normalizeTeamName(homeName)}|${normalizeTeamName(awayName)}`;
    const x = liveFootballEventIdCache.get(key);
    if (!x || Date.now()-x.ts > EVENT_ID_CACHE_TTL_MS) { if(x) liveFootballEventIdCache.delete(key); return null; }
    return x.match;
}
function cacheLiveFootballEvent(homeName, awayName, match) {
    if (!match?.id) return;
    liveFootballEventIdCache.set(`${normalizeTeamName(homeName)}|${normalizeTeamName(awayName)}`, {ts:Date.now(), match});
}


const LIVEFOOTBALL_STATS_PATH = '/football-get-match-event-all-stats';
const LIVEFOOTBALL_DETAIL_PATH = '/football-get-match-detail';

const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

const sentAlerts = new Set();

const alertStates = new Map();
const momentumStates = new Map();
const INTERNAL_MOMENTUM_WINDOW_MINUTES = 10;
const MOMENTUM_RULE_MIN = 52.0;
const SECOND_ALERT_WINDOW_MINUTES = 10;
const THIRD_ALERT_WINDOW_MINUTES = 10;
const BIGGGG_ODDS_MIN = 1.50;
const BIGGGG_ODDS_MAX = 2.00;

function makeMatchSnapshot(metrics, rule, minute, homeScore, awayScore) {
    const s = metrics?.sofaStats || {};
    return {
        minute: Number(minute || 0),
        rule: Number(rule || 0),
        homeScore: Number(homeScore || 0),
        awayScore: Number(awayScore || 0),
        shotsOnTarget: Number(s.shotsOnTarget || 0),
        totalShots: Number(s.totalShots || 0),
        corners: Number(s.corners || 0),
        redCards: Number(s.redCards || 0),
        shotsRate: (Number(s.totalShots || 0) / Math.max(1, Number(minute || 1))) * 100,
        sotRate: (Number(s.shotsOnTarget || 0) / Math.max(1, Number(minute || 1))) * 100,
        effectiveSot: (() => {
            const shots = Math.max(0, Number(s.totalShots || 0));
            const sot = Math.max(0, Number(s.shotsOnTarget || 0));
            if (sot <= 0) return 0;
            const raw = (sot / Math.max(1, Number(minute || 1))) * 100;
            if (shots <= 0) return raw;
            const ratio = sot / shots;
            const mult = ratio < 0.15 ? 0.5 : ratio < 0.25 ? 0.8 : ratio < 0.35 ? 1.0 : ratio < 0.45 ? 1.3 : 1.5;
            return raw * mult;
        })(),
        sotShotRatio: Number(s.totalShots || 0) > 0 ? Number(s.shotsOnTarget || 0) / Number(s.totalShots || 0) : null,
        cornerRate: (Number(s.corners || 0) / Math.max(1, Number(minute || 1))) * 100,
        xg: Number(metrics?.advancedStats?.xg || 0),
        bigChances: Number(metrics?.advancedStats?.bigChances || 0),
        shotsInsideBox: Number(metrics?.advancedStats?.shotsInsideBox || 0),
        touchesOppBox: Number(metrics?.advancedStats?.touchesOppBox || 0)
    };
}

function detectTenMinuteSpike(previous, current) {
    if (!previous || !current) return { isSpike: false, reasons: [] };
    const dm = current.minute - previous.minute;
    if (dm < 0 || dm > SECOND_ALERT_WINDOW_MINUTES) return { isSpike: false, reasons: [] };

    const reasons = [];
    const dRule = current.rule - previous.rule;
    const dSot = current.shotsOnTarget - previous.shotsOnTarget;
    const dEffectiveSot = Number(current.effectiveSot || 0) - Number(previous.effectiveSot || 0);
    const dSotQuality = (current.sotShotRatio == null || previous.sotShotRatio == null) ? null : (current.sotShotRatio - previous.sotShotRatio) * 100;
    const dShots = current.totalShots - previous.totalShots;
    const dCorners = current.corners - previous.corners;
    const dRed = current.redCards - previous.redCards;
    const dGoals = (current.homeScore + current.awayScore) - (previous.homeScore + previous.awayScore);

    if (dRule >= 8) reasons.push(`Rule +${dRule.toFixed(1)}%`);
    if (dEffectiveSot >= 1.5) reasons.push(`Effective SOT +${dEffectiveSot.toFixed(2)} điểm`);
    if (dSotQuality !== null && dSotQuality >= 5 && dSot >= 1) reasons.push(`Chất lượng SOT +${dSotQuality.toFixed(1)} điểm %`);
    if (dShots >= 4) reasons.push(`Tổng sút +${dShots}`);
    if (dCorners >= 2) reasons.push(`Phạt góc +${dCorners}`);
    if (dRed >= 1) reasons.push(`Thẻ đỏ mới +${dRed}`);
    if (dGoals >= 1) reasons.push(`Bàn thắng mới +${dGoals}`);

    const dShotsRate = current.shotsRate - previous.shotsRate;
    const dCornerRate = current.cornerRate - previous.cornerRate;
    if (dShotsRate >= 3) reasons.push(`Mật độ tổng sút +${dShotsRate.toFixed(1)} điểm`);
    if (dCornerRate >= 1.5) reasons.push(`Mật độ góc +${dCornerRate.toFixed(1)} điểm`);

    return { isSpike: current.rule >= 58 && reasons.length > 0, reasons, deltaMinute: dm };
}

function isBiggggOddsOK(oddsAnalysis) {
    const price = Number(oddsAnalysis?.odds);
    return Number.isFinite(price) && price >= BIGGGG_ODDS_MIN && price <= BIGGGG_ODDS_MAX;
}

function detectExtremeSpike(previous, current) {
    if (!previous || !current) return { isSpike: false, reasons: [] };
    const dm = current.minute - previous.minute;
    if (dm < 0 || dm > THIRD_ALERT_WINDOW_MINUTES) return { isSpike: false, reasons: [] };

    const reasons = [];
    const dRule = current.rule - previous.rule;
    const dSot = current.shotsOnTarget - previous.shotsOnTarget;
    const dEffectiveSot = Number(current.effectiveSot || 0) - Number(previous.effectiveSot || 0);
    const dSotQuality = (current.sotShotRatio == null || previous.sotShotRatio == null) ? null : (current.sotShotRatio - previous.sotShotRatio) * 100;
    const dShots = current.totalShots - previous.totalShots;
    const dCorners = current.corners - previous.corners;
    const dRed = current.redCards - previous.redCards;
    const dGoals = (current.homeScore + current.awayScore) - (previous.homeScore + previous.awayScore);
    const dShotsRate = current.shotsRate - previous.shotsRate;
    const dSotRate = current.sotRate - previous.sotRate;
    const dCornerRate = current.cornerRate - previous.cornerRate;

    if (dRule >= 10) reasons.push(`Rule +${dRule.toFixed(1)}%`);
    if (dEffectiveSot >= 2.0) reasons.push(`Effective SOT +${dEffectiveSot.toFixed(2)} điểm`);
    if (dSotQuality !== null && dSotQuality >= 7.5 && dSot >= 1) reasons.push(`Chất lượng SOT +${dSotQuality.toFixed(1)} điểm %`);
    if (dShots >= 5) reasons.push(`Tổng sút +${dShots}`);
    if (dCorners >= 3) reasons.push(`Phạt góc +${dCorners}`);
    if (dRed >= 1) reasons.push(`Thẻ đỏ mới +${dRed}`);
    if (dGoals >= 1 && (dShots >= 2 || dSot >= 1 || dCorners >= 1 || dShotsRate >= 2 || dSotRate >= 1)) {
        reasons.push(`Bàn thắng mới +${dGoals} kèm áp lực tiếp tục tăng`);
    }
    if (dShotsRate >= 4) reasons.push(`Mật độ tổng sút +${dShotsRate.toFixed(1)} điểm`);
    if (dCornerRate >= 2) reasons.push(`Mật độ góc +${dCornerRate.toFixed(1)} điểm`);

    return { isSpike: current.rule >= 60 && reasons.length > 0, reasons, deltaMinute: dm };
}

function detectInternalMomentum(previous, current) {
    if (!previous || !current) return { isStrong: false, reasons: [], deltaMinute: null };
    const dm = current.minute - previous.minute;
    if (dm <= 0 || dm > INTERNAL_MOMENTUM_WINDOW_MINUTES) return { isStrong: false, reasons: [], deltaMinute: dm };

    const dShots = current.totalShots - previous.totalShots;
    const dSot = current.shotsOnTarget - previous.shotsOnTarget;
    const dCorners = current.corners - previous.corners;
    const dXg = current.xg - previous.xg;
    const dBig = current.bigChances - previous.bigChances;
    const dInside = current.shotsInsideBox - previous.shotsInsideBox;
    const dTouches = current.touchesOppBox - previous.touchesOppBox;

    const reasons = [];
    let score = 0;
    if (dShots >= 4) { score += 2; reasons.push(`Shots +${dShots}`); }
    else if (dShots >= 3) { score += 1; reasons.push(`Shots +${dShots}`); }
    if (dSot >= 2) { score += 3; reasons.push(`SOT +${dSot}`); }
    else if (dSot >= 1) { score += 1; reasons.push(`SOT +${dSot}`); }
    if (dCorners >= 2) { score += 1; reasons.push(`Corners +${dCorners}`); }
    if (dXg >= 0.45) { score += 3; reasons.push(`xG +${dXg.toFixed(2)}`); }
    else if (dXg >= 0.25) { score += 2; reasons.push(`xG +${dXg.toFixed(2)}`); }
    if (dBig >= 1) { score += 3; reasons.push(`Big Chances +${dBig}`); }
    if (dInside >= 3) { score += 2; reasons.push(`Shots inside box +${dInside}`); }
    if (dTouches >= 6) { score += 1; reasons.push(`Touches opp. box +${dTouches}`); }

    return { isStrong: score >= 4, score, reasons, deltaMinute: dm, deltas: { shots: dShots, sot: dSot, corners: dCorners, xg: dXg, bigChances: dBig, shotsInsideBox: dInside, touchesOppBox: dTouches } };
}

function getVietnamTime() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return {
        dateStr: vnTime.toISOString().slice(0, 10),
        timeStr: vnTime.toISOString().slice(11, 19)
    };
}

// ==========================================
// 1. BẢNG DỊCH QUỐC GIA & GIẢI ĐẤU VIỆT HÓA
// ==========================================
const COUNTRY_MAP = {
    'England': 'Anh', 'Spain': 'Tây Ban Nha', 'Italy': 'Ý', 'Germany': 'Đức', 'France': 'Pháp',
    'Japan': 'Nhật Bản', 'South Korea': 'Hàn Quốc', 'Vietnam': 'Việt Nam', 'Brazil': 'Brazil',
    'Argentina': 'Argentina', 'Netherlands': 'Hà Lan', 'Portugal': 'Bồ Đào Nha', 'Turkey': 'Thổ Nhĩ Kỳ',
    'Saudi Arabia': 'Ả Rập Xê Út', 'China': 'Trung Quốc', 'Thailand': 'Thái Lan', 'Australia': 'Úc',
    'USA': 'Mỹ', 'Norway': 'Na Uy', 'Czech Republic': 'Cộng hòa Séc', 'Denmark': 'Đan Mạch',
    'Croatia': 'Croatia', 'Poland': 'Ba Lan', 'Austria': 'Áo', 'World': 'Quốc Tế', 'Europe': 'Châu Âu',
    'Asia': 'Châu Á', 'South America': 'Nam Mỹ', 'International': 'Quốc Tế', 'Finland': 'Phần Lan',
    'Sweden': 'Thụy Điển', 'Belgium': 'Bỉ', 'Switzerland': 'Thụy Sĩ', 'Greece': 'Hy Lạp',
    'Romania': 'Romania', 'Serbia': 'Serbia', 'Slovakia': 'Slovakia', 'Slovenia': 'Slovenia',
    'Hungary': 'Hungary', 'Bulgaria': 'Bulgaria', 'Ukraine': 'Ukraine', 'Scotland': 'Scotland',
    'Ireland': 'Ireland', 'Iceland': 'Iceland'
};

const LEAGUE_NAME_MAP = {
    'UEFA Champions League': 'Cúp C1 Châu Âu', 'UEFA Europa League': 'Cúp C2 Châu Âu',
    'UEFA Conference League': 'Cúp C3 Châu Âu', 'Premier League': 'Ngoại Hạng Anh',
    'Championship': 'Hạng Nhất Anh', 'LaLiga': 'VĐQG Tây Ban Nha', 'Serie A': 'VĐQG Ý',
    'Bundesliga': 'VĐQG Đức', 'Ligue 1': 'VĐQG Pháp', 'J1 League': 'VĐQG Nhật Bản',
    'K League 1': 'VĐQG Hàn Quốc', 'V-League 1': 'V-League Việt Nam'
};

function parseLeagueName(item, source) {
    if (!item) return 'Bóng Đá Quốc Tế';
    let category = '', tournament = '';

    if (source === 'sofascore') {
        category = item.tournament?.category?.name || item.category?.name || '';
        tournament = item.tournament?.name || item.tournament?.uniqueTournament?.name || '';
    } else if (source === 'livefootball') {
        category = item._lfCategory || item.country?.name || item.country || item.category?.name || '';
        tournament = item._lfLeague || item.league?.name || item.leagueName || item.tournament?.name || '';
    } else {
        category = item._inheritedCategory || item.Cname || item.country || '';
        tournament = item._inheritedTournament || item.Snm || item.Tname || '';
    }

    category = String(category || '').trim();
    tournament = String(tournament || '').trim();
    if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];

    const translatedCategory = COUNTRY_MAP[category] || category;
    let translatedTournament = tournament
        .replace(/\bPremier League\b/gi, 'Giải VĐQG')
        .replace(/\bSuper League\b/gi, 'VĐQG')
        .replace(/\bChampionship\b/gi, 'Hạng Nhất')
        .trim();

    if (translatedCategory && translatedTournament) {
        if (translatedTournament.toLowerCase().includes(translatedCategory.toLowerCase())) return translatedTournament;
        return `${translatedTournament} (${translatedCategory})`;
    }
    return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}

function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    const youthRegex = /\b(?:u[\s-]?(?:1[0-9]|[1-9])|under[\s-]?(?:1[0-9]|[1-9])|sub[\s-]?(?:1[0-9]|[1-9]))\b/i;
    if (youthRegex.test(textToTest)) return true;

    const blockedKeywords = ['amateur', 'nghiệp dư', 'student', 'university', 'sinh viên', 'đại học', 'esports', 'esoccer'];
    return blockedKeywords.some(kw => textToTest.includes(kw));
}

function passesPreApiGate(item, source) {
    if (!item) return false;
    let homeName = '', awayName = '';
    if (source === 'sofascore') {
        homeName = item.homeTeam?.name || '';
        awayName = item.awayTeam?.name || '';
    } else if (source === 'livefootball') {
        homeName = item._lfHome || item.homeTeam?.name || item.home?.name || item.team1?.name || '';
        awayName = item._lfAway || item.awayTeam?.name || item.away?.name || item.team2?.name || '';
    } else {
        homeName = (item.T1 && item.T1[0] && (item.T1[0].Nm || item.T1[0].Name)) || item.homeTeam?.name || '';
        awayName = (item.T2 && item.T2[0] && (item.T2[0].Nm || item.T2[0].Name)) || item.awayTeam?.name || '';
    }

    const leagueName = parseLeagueName(item, source);
    if (isFilteredLeague(leagueName, homeName, awayName)) return false;
    return isEligibleLiveMatch(item, source, 60, 92);
}

function calculateExactMinute(item, source) {
    if (!item) return 0;
    const nowSec = Math.floor(Date.now() / 1000);

    function parseMinuteValue(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value <= 130 ? Math.floor(value) : null;
        const text = String(value).trim();
        const plain = text.match(/(?:^|\D)(\d{1,3})(?:\s*['’′]|\s*MIN\b|$)/i);
        return plain ? Number(plain[1]) : null;
    }

    function statusResult(values) {
        const text = values.filter(v => v !== null && v !== undefined).map(v => String(v).trim().toUpperCase()).join(' | ');
        if (/\b(FT|AET|PEN|FINISHED|ENDED)\b/.test(text)) return 999;
        if (/\b(HT|HALF[ -]?TIME)\b/.test(text)) return 'HT';
        return null;
    }

    if (source === 'sofascore') {
        const ended = statusResult([item.status?.type, item.status?.description]);
        if (ended !== null) return ended;
        const direct = [item.minute, item.time?.current, item.status?.description];
        for (const v of direct) {
            const m = parseMinuteValue(v);
            if (m !== null) return m;
        }
        return 0;
    }

    if (source === 'livefootball') {
        const lfStatus = statusResult([item.status?.type, item.status?.description, item.status]);
        if (lfStatus !== null) return lfStatus;
        const lfMinuteCandidates = [item._lfMinute, item.minute, item.matchMinute, item.time?.current];
        for (const v of lfMinuteCandidates) {
            const m = parseMinuteValue(v);
            if (m !== null) return m;
        }
        return 0;
    }

    const status = statusResult([item.Eps, item.status, item.matchStatus]);
    if (status !== null) return status;
    const minuteCandidates = [item.Tm, item.Minute, item.minute, item.Eps];
    for (const v of minuteCandidates) {
        const m = parseMinuteValue(v);
        if (m !== null) return m;
    }
    return 0;
}

function isEligibleLiveMatch(item, source, minMinute = 60, maxMinute = 92) {
    const minute = calculateExactMinute(item, source);
    return Number.isFinite(minute) && minute >= minMinute && minute <= maxMinute && minute !== 999;
}

async function fetchLiveMatchesDualSource() {
    const collected = [];
    const seen = new Set();

    function normName(v='') {
        return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
            .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
    }
    function getNames(item, source) {
        if (source === 'sofascore') return [item.homeTeam?.name || '', item.awayTeam?.name || ''];
        if (source === 'livefootball') return [
            item._lfHome || item.homeTeam?.name || item.home?.name || item.team1?.name || '',
            item._lfAway || item.awayTeam?.name || item.away?.name || item.team2?.name || ''
        ];
        return [
            (item.T1 && item.T1[0] && (item.T1[0].Nm || item.T1[0].Name)) || item.homeTeam?.name || '',
            (item.T2 && item.T2[0] && (item.T2[0].Nm || item.T2[0].Name)) || item.awayTeam?.name || ''
        ];
    }
    function addEligible(item, source) {
        if (!item) return;
        const [home, away] = getNames(item, source);
        const league = parseLeagueName(item, source);
        const minute = calculateExactMinute(item, source);

        if (isFilteredLeague(league, home, away)) return;
        if (!Number.isFinite(Number(minute)) || Number(minute) < 60 || Number(minute) > 92 || Number(minute) === 999) return;

        const key = `${normName(home)}__${normName(away)}`;
        const reverseKey = `${normName(away)}__${normName(home)}`;
        if (seen.has(key) || seen.has(reverseKey)) return;
        seen.add(key);
        collected.push({ ...item, _scanSource: source });
    }

    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 10000
        });
        const events = response.data?.events || response.data?.liveEvents || [];
        for (const item of events) addEligible(item, 'sofascore');
    } catch (err) {}

    try {
        let liveList = [];
        const now = Date.now();
        if (resolverLiveCache.livefootball.data && now - resolverLiveCache.livefootball.ts < RESOLVER_CACHE_MS) {
            liveList = resolverLiveCache.livefootball.data;
        } else {
            const lfRes = await axios.get(`https://${LIVEFOOTBALL_HOST}${LIVEFOOTBALL_LIVE_PATH}`, {
                headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVEFOOTBALL_HOST },
                timeout: 10000
            });
            liveList = lfRes.data || null;
            resolverLiveCache.livefootball = { ts: now, data: liveList };
        }
        const lfCandidates = extractLiveFootballCandidates(liveList);
        for (const c of lfCandidates) {
            const raw = c.raw || {};
            const enriched = {
                ...raw, id: c.id, eventid: c.id, _lfHome: c.home, _lfAway: c.away,
                _lfMinute: raw.minute ?? raw.matchMinute ?? raw.liveMinute ?? raw.time?.minute,
                _lfLeague: raw.league?.name ?? raw.leagueName ?? raw.tournament?.name ?? '',
                _lfCategory: raw.country?.name ?? raw.country ?? ''
            };
            addEligible(enriched, 'livefootball');
        }
    } catch (err) {}

    try {
        const currentVN = getVietnamTime();
        const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
        const dateUrl = `https://${LIVESCORE_HOST}/matches/v2/list-by-date?Category=soccer&Date=${currentVN.dateStr}&Timezone=-7`;
        const [resLive, resDate] = await Promise.all([
            axios.get(liveUrl, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({data:null})),
            axios.get(dateUrl, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({data:null}))
        ]);
        const localSeenIds = new Set();
        function walk(obj, cat='', tour='') {
            if (!obj || typeof obj !== 'object') return;
            const matchId = String(obj.Eid || obj.id || obj.MatchId || '');
            const hasTeams = obj.T1 || obj.homeTeam || obj.T2 || obj.AwayTeam;
            if (matchId && hasTeams && !localSeenIds.has(matchId)) {
                localSeenIds.add(matchId);
                const enriched = { ...obj,
                    _inheritedCategory: obj.Cname || obj.country || cat,
                    _inheritedTournament: obj.Snm || obj.Tname || tour
                };
                addEligible(enriched, 'livescore6');
            }
            for (const key of Object.keys(obj)) if (obj[key] !== null && typeof obj[key] === 'object')
                walk(obj[key], obj.Cname || cat, obj.Snm || tour);
        }
        if (resLive?.data) walk(resLive.data);
        if (resDate?.data) walk(resDate.data);
    } catch (err) {}

    return { source: 'mixed', matches: collected };
}

async function fetchMatchIncidents(matchId, source, homeScore = 0, awayScore = 0) {
    try {
        const url = source === 'sofascore' 
            ? `https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`
            : `https://${LIVESCORE_HOST}/matches/v2/get-incidents?Eid=${matchId}&Category=soccer`;
        
        const response = await axios.get(url, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': source === 'sofascore' ? SOFASCORE_HOST : LIVESCORE_HOST },
            timeout: 6000
        });

        const incidents = response.data?.incidents || response.data || [];
        const goalEvents = (Array.isArray(incidents) ? incidents : []).filter(inc => {
            const type = String(inc.type || inc.incidentType || '').toLowerCase();
            return type.includes('goal') || type === '1';
        });

        if (goalEvents.length === 0) {
            const totalGoals = homeScore + awayScore;
            return totalGoals > 0 ? `${homeScore}-${awayScore}` : '0-0';
        }

        return goalEvents.map(g => `P${g.time || g.minute || 0}'`).join(' | ');
    } catch (err) {
        return homeScore + awayScore > 0 ? `${homeScore}-${awayScore}` : '0-0';
    }
}

async function fetchOddsData() {
    if (!ODDS_API_KEY) return [];
    try {
        const response = await axios.get(ODDS_API_URL, { timeout: 8000 });
        return response.data || [];
    } catch (err) {
        return [];
    }
}

async function fetchSofaJson(path, timeout = 6000) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}${path}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout
        });
        return response.data;
    } catch (err) {
        return null;
    }
}

function extractSofaStatistics(data) {
    let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
    let shotsOffTarget = 0, blockedShots = 0;
    let hasSOTComponent=false, hasOffComponent=false, hasBlockedComponent=false;
    let possessionHome = null, possessionAway = null;
    let xg = 0, bigChances = 0, shotsInsideBox = 0, touchesOppBox = 0;
    const present = { totalShots:false, shotsOnTarget:false, corners:false, possession:false, redCards:false };

    const roots = [];
    if (Array.isArray(data?.statistics)) roots.push(...data.statistics);
    if (Array.isArray(data?.stats)) roots.push(...data.stats);
    if (Array.isArray(data)) roots.push(...data);

    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }

        const name = String(node.name || node.slug || node.type || node.title || '').toLowerCase();
        const hvRaw = node.home ?? node.homeValue ?? node.valueHome;
        const avRaw = node.away ?? node.awayValue ?? node.valueAway;
        const homeVal = parseInt(String(hvRaw ?? '').replace('%',''), 10);
        const awayVal = parseInt(String(avRaw ?? '').replace('%',''), 10);

        if (name && (!isNaN(homeVal) || !isNaN(awayVal))) {
            const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);
            if (name.includes('shots on target') || name.includes('shot on target')) {
                shotsOnTarget = Math.max(shotsOnTarget, sumVal); present.shotsOnTarget=true; hasSOTComponent=true;
            } else if (name.includes('shots off target') || name.includes('shot off target')) {
                shotsOffTarget = Math.max(shotsOffTarget, sumVal); hasOffComponent=true;
            } else if (name.includes('blocked shots') || name.includes('blocked shot')) {
                blockedShots = Math.max(blockedShots, sumVal); hasBlockedComponent=true;
            } else if (name.includes('total shots') || name.includes('total shot')) {
                totalShots = Math.max(totalShots, sumVal); present.totalShots=true;
            } else if (name.includes('corner')) {
                corners = Math.max(corners, sumVal); present.corners=true;
            } else if (name.includes('red card')) {
                redCards = Math.max(redCards, sumVal); present.redCards=true;
            } else if (name.includes('expected goals') || name === 'xg') {
                const h = Number(String(hvRaw ?? '').replace(',','.')); const a = Number(String(avRaw ?? '').replace(',','.'));
                if (Number.isFinite(h) || Number.isFinite(a)) xg = Math.max(xg, (Number.isFinite(h)?h:0)+(Number.isFinite(a)?a:0));
            } else if (name.includes('big chance') && !name.includes('missed')) {
                bigChances = Math.max(bigChances, sumVal);
            } else if (name.includes('shots inside box')) {
                shotsInsideBox = Math.max(shotsInsideBox, sumVal);
            } else if (name.includes('touches in opposition box')) {
                touchesOppBox = Math.max(touchesOppBox, sumVal);
            } else if (name.includes('possession')) {
                if (!isNaN(homeVal) && !isNaN(awayVal)) {
                    possessionHome = homeVal; possessionAway = awayVal; present.possession=true;
                }
            }
        }
        Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    roots.forEach(walk);

    if (!present.totalShots && hasSOTComponent && hasOffComponent && hasBlockedComponent) {
        totalShots = shotsOnTarget + shotsOffTarget + blockedShots;
        present.totalShots = true;
    }

    return {
        foundItems: Object.values(present).filter(Boolean).length,
        sofaStats: {
            shotsOnTarget,
            totalShots: present.totalShots ? totalShots : null,
            shotsOffTarget,
            blockedShots,
            corners,
            redCards,
            possession: possessionHome !== null && possessionAway !== null ? `${possessionHome}% - ${possessionAway}%` : null
        },
        advancedStats: { xg, bigChances, shotsInsideBox, touchesOppBox },
        present
    };
}

function statPresenceFromParsed(parsed) {
    const p = parsed?.present || {};
    return {
        totalShots: !!p.totalShots,
        shotsOnTarget: !!p.shotsOnTarget,
        corners: !!p.corners,
        possession: !!p.possession,
        redCards: !!p.redCards
    };
}

function inferStatPresenceFromObject(stats) {
    if (!stats) return { totalShots: false, shotsOnTarget: false, corners: false, possession: false, redCards: false };
    return {
        totalShots: stats.totalShots > 0,
        shotsOnTarget: stats.shotsOnTarget > 0,
        corners: stats.corners > 0,
        possession: !!stats.possession,
        redCards: stats.redCards > 0
    };
}

function mergeMissingStats(baseStats, basePresent, incomingStats, incomingPresent) {
    const out = { ...(baseStats || {}) };
    const present = { ...(basePresent || {}) };
    const filled = [];
    const cumulative = new Set(['totalShots','shotsOnTarget','corners','redCards']);
    
    for (const key of ['totalShots', 'shotsOnTarget', 'corners', 'possession', 'redCards']) {
        if (!incomingPresent?.[key]) continue;
        if (!present[key]) {
            out[key] = incomingStats[key];
            present[key] = true;
            filled.push(key);
            continue;
        }
        if (cumulative.has(key)) {
            const oldV = Number(out[key]);
            const newV = Number(incomingStats[key]);
            if (Number.isFinite(newV) && (!Number.isFinite(oldV) || newV > oldV)) out[key] = incomingStats[key];
        } else if (key === 'possession' && incomingStats[key]) {
            out[key] = incomingStats[key];
        }
    }
    return { stats: out, present, filled };
}

function cleanTeamName(name) {
    return String(name || '').toLowerCase().replace(/\b(fc|cf|club|sc|sv|ac|afc)\b/g, '').replace(/[^a-z0-9]/g, '').trim();
}

function teamSimilarity(a, b) {
    const x = cleanTeamName(a), y = cleanTeamName(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return .88;
    return 0.5;
}

function pairMatchScore(homeName, awayName, cHome, cAway) {
    const directH = teamSimilarity(homeName, cHome), directA = teamSimilarity(awayName, cAway);
    const revH = teamSimilarity(homeName, cAway), revA = teamSimilarity(awayName, cHome);
    const direct = (directH + directA) / 2, reversed = (revH + revA) / 2;
    const score = Math.max(direct, reversed);
    const weakest = direct >= reversed ? Math.min(directH, directA) : Math.min(revH, revA);
    return { score: weakest < 0.30 ? score * 0.75 : score, reversed: reversed > direct };
}

function extractLiveFootballCandidates(data) {
    const out = [], seen = new Set();
    function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        const id = n.eventid ?? n.eventId ?? n.matchId ?? n.id;
        const home = n.homeTeam?.name ?? n.home?.name ?? n.homeName ?? n.team1?.name ?? n.team1 ?? '';
        const away = n.awayTeam?.name ?? n.away?.name ?? n.awayName ?? n.team2?.name ?? n.team2 ?? '';
        if (id && home && away && !seen.has(String(id))) {
            seen.add(String(id)); out.push({ id: String(id), home: String(home), away: String(away), raw: n });
        }
        Object.values(n).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    walk(data);
    return out;
}

async function resolveLiveFootballMatchByName(homeName, awayName) {
    const cachedEvent = getCachedLiveFootballEvent(homeName, awayName);
    if (cachedEvent) return cachedEvent;
    try {
        let liveList;
        const now = Date.now();
        if (resolverLiveCache.livefootball.data && now - resolverLiveCache.livefootball.ts < RESOLVER_CACHE_MS) {
            liveList = resolverLiveCache.livefootball.data;
        } else {
            const response = await axios.get(`https://${LIVEFOOTBALL_HOST}${LIVEFOOTBALL_LIVE_PATH}`, {
                headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVEFOOTBALL_HOST }, timeout: 7000
            });
            liveList = response.data || null;
            resolverLiveCache.livefootball = { ts: now, data: liveList };
        }
        const candidates = extractLiveFootballCandidates(liveList);
        if (candidates.length === 0) return null;

        let best = null, bestScore = 0;
        for (const c of candidates) {
            const m = pairMatchScore(homeName, awayName, c.home, c.away);
            if (m.score > bestScore) { bestScore = m.score; best = c; }
        }
        if (best && bestScore >= 0.62) {
            cacheLiveFootballEvent(homeName, awayName, best);
            return best;
        }
        return null;
    } catch (err) {
        return null;
    }
}

function normalizeStatKey(v) {
    return String(v ?? '').toLowerCase().replace(/[%_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function numericStatValue(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace('%','').trim());
    return Number.isFinite(n) ? n : null;
}

function readStatPair(n) {
    const arrays = [n.stats, n.values, n.value, n.score];
    for (const a of arrays) {
        if (Array.isArray(a) && a.length >= 2) {
            const h = numericStatValue(a[0]), w = numericStatValue(a[1]);
            if (h !== null && w !== null) return [h, w];
        }
    }
    const pairs = [
        [n.home, n.away], [n.homeValue, n.awayValue], [n.H, n.A], [n.Value1, n.Value2], [n.V1, n.V2]
    ];
    for (const [a, b] of pairs) {
        const h = numericStatValue(a), w = numericStatValue(b);
        if (h !== null && w !== null) return [h, w];
    }
    return null;
}

function classifyStatKey(raw) {
    const k = normalizeStatKey(raw);
    if (!k) return null;
    if (/shots? on target|shots? on goal|shotontarget/.test(k)) return 'shotsOnTarget';
    if (/total shots?|shots? total|goal attempts?|total attempts?/.test(k)) return 'totalShots';
    if (/corner kicks?|corners?/.test(k)) return 'corners';
    if (/red cards?|sending off/.test(k)) return 'redCards';
    if (/ball possession|possession/.test(k)) return 'possession';
    return null;
}

// Cải tiến tích hợp trích xuất Total Shots và toàn bộ chỉ số từ LiveFootball
function extractLiveFootballStatistics(data) {
    const stats = { totalShots: null, shotsOnTarget: null, corners: null, redCards: null, possession: null };
    const present = { totalShots: false, shotsOnTarget: false, corners: false, redCards: false, possession: false };
    const advancedStats = { xg: 0, bigChances: 0, shotsInsideBox: 0, touchesOppBox: 0 };

    function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }

        const rawKey = n.key ?? n.name ?? n.type ?? n.title ?? n.Nm ?? n.StatName ?? '';
        const key = normalizeStatKey(rawKey);
        const pair = readStatPair(n);

        if (pair) {
            const [a, b] = pair, sum = a + b, cls = classifyStatKey(rawKey);
            if (cls === 'totalShots') { stats.totalShots = Math.max(stats.totalShots ?? 0, sum); present.totalShots = true; }
            else if (cls === 'shotsOnTarget') { stats.shotsOnTarget = Math.max(stats.shotsOnTarget ?? 0, sum); present.shotsOnTarget = true; }
            else if (cls === 'corners') { stats.corners = Math.max(stats.corners ?? 0, sum); present.corners = true; }
            else if (cls === 'redCards') { stats.redCards = Math.max(stats.redCards ?? 0, sum); present.redCards = true; }
            else if (cls === 'possession') { stats.possession = `${a}% - ${b}%`; present.possession = true; }

            if (/expected goals|\bxg\b/.test(key)) advancedStats.xg = Math.max(advancedStats.xg, sum);
            else if (/big chance/.test(key)) advancedStats.bigChances = Math.max(advancedStats.bigChances, sum);
            else if (/shots? inside.*box/.test(key)) advancedStats.shotsInsideBox = Math.max(advancedStats.shotsInsideBox, sum);
            else if (/touches?.*box/.test(key)) advancedStats.touchesOppBox = Math.max(advancedStats.touchesOppBox, sum);
        }
        Object.values(n).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    walk(data);
    return { foundItems: Object.values(present).filter(Boolean).length, sofaStats: stats, present, advancedStats };
}

async function fetchLiveFootballPartialStats(homeName, awayName) {
    const match = await resolveLiveFootballMatchByName(homeName, awayName);
    if (!match) return null;
    const headers = { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVEFOOTBALL_HOST };
    try {
        const response = await axios.get(`https://${LIVEFOOTBALL_HOST}${LIVEFOOTBALL_STATS_PATH}?eventid=${encodeURIComponent(match.id)}`, { headers, timeout: 7000 });
        let parsed = extractLiveFootballStatistics(response.data);
        if (parsed.foundItems === 0) {
            try {
                const detail = await axios.get(`https://${LIVEFOOTBALL_HOST}${LIVEFOOTBALL_DETAIL_PATH}?eventid=${encodeURIComponent(match.id)}`, { headers, timeout: 7000 });
                const dp = extractLiveFootballStatistics(detail.data);
                if (dp.foundItems > parsed.foundItems) parsed = dp;
            } catch (e) {}
        }
        return parsed.foundItems > 0 ? { ...parsed, statsSource: 'livefootball', crossSourceMatchId: match.id } : null;
    } catch (err) {
        return null;
    }
}

function extractLivescoreMatchCandidates(data) {
    const out = [], seen = new Set();
    function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }

        const id = String(obj.Eid || obj.id || obj.MatchId || '');
        const home = (obj.T1 && obj.T1[0] && (obj.T1[0].Nm || obj.T1[0].Name)) || obj.homeTeam?.name || '';
        const away = (obj.T2 && obj.T2[0] && (obj.T2[0].Nm || obj.T2[0].Name)) || obj.awayTeam?.name || '';

        if (id && home && away && !seen.has(id)) {
            seen.add(id);
            out.push({ id, home, away, raw: obj });
        }
        Object.values(obj).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    walk(data);
    return out;
}

async function resolveLivescoreMatchByName(homeName, awayName) {
    const currentVN = getVietnamTime();
    const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
    const dateUrl = `https://${LIVESCORE_HOST}/matches/v2/list-by-date?Category=soccer&Date=${currentVN.dateStr}&Timezone=-7`;
    const headers = { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST };
    let liveData = null, dateData = null;
    const now = Date.now();
    if (resolverLiveCache.livescore6.live && now - resolverLiveCache.livescore6.ts < RESOLVER_CACHE_MS) {
        liveData = resolverLiveCache.livescore6.live; dateData = resolverLiveCache.livescore6.date;
    } else {
        const [liveRes, dateRes] = await Promise.all([
            axios.get(liveUrl, { headers, timeout: 7000 }).catch(() => ({ data: null })),
            axios.get(dateUrl, { headers, timeout: 7000 }).catch(() => ({ data: null }))
        ]);
        liveData = liveRes.data; dateData = dateRes.data;
        resolverLiveCache.livescore6 = { ts: now, live: liveData, date: dateData };
    }
    const rawCandidates = [...extractLivescoreMatchCandidates(liveData), ...extractLivescoreMatchCandidates(dateData)];
    const unique = [], seen = new Set();
    for (const c of rawCandidates) { if (!seen.has(c.id)) { seen.add(c.id); unique.push(c); } }

    let best = null, bestScore = 0;
    for (const c of unique) {
        const m = pairMatchScore(homeName, awayName, c.home, c.away);
        if (m.score > bestScore) { bestScore = m.score; best = c; }
    }
    return best && bestScore >= 0.62 ? best : null;
}

function extractLivescoreStatistics(data) {
    const stats = { shotsOnTarget: null, totalShots: null, corners: null, redCards: null, possession: null };
    const present = { shotsOnTarget: false, totalShots: false, corners: false, redCards: false, possession: false };
    const advancedStats = { xg: 0, bigChances: 0, shotsInsideBox: 0, touchesOppBox: 0 };

    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const rawName = node.name ?? node.type ?? node.title ?? node.Nm ?? node.StatName ?? '';
        const pair = readStatPair(node);
        if (pair) {
            const [hv, av] = pair, sum = hv + av, cls = classifyStatKey(rawName);
            if (cls === 'shotsOnTarget') { stats.shotsOnTarget = Math.max(stats.shotsOnTarget ?? 0, sum); present.shotsOnTarget = true; }
            else if (cls === 'totalShots') { stats.totalShots = Math.max(stats.totalShots ?? 0, sum); present.totalShots = true; }
            else if (cls === 'corners') { stats.corners = Math.max(stats.corners ?? 0, sum); present.corners = true; }
            else if (cls === 'redCards') { stats.redCards = Math.max(stats.redCards ?? 0, sum); present.redCards = true; }
            else if (cls === 'possession') { stats.possession = `${hv}% - ${av}%`; present.possession = true; }
        }
        Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    walk(data);
    return { foundItems: Object.values(present).filter(Boolean).length, sofaStats: stats, present, advancedStats };
}

async function fetchCrossSourcePartialStats(homeName, awayName) {
    try {
        const match = await resolveLivescoreMatchByName(homeName, awayName);
        if (!match) return null;

        const headers = { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST };
        const url = `https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${encodeURIComponent(match.id)}`;
        const response = await axios.get(url, { headers, timeout: 7000 }).catch(() => ({ data: null }));
        const parsed = extractLivescoreStatistics(response.data);

        return parsed.foundItems > 0 ? { ...parsed, statsAvailable: true, partialStats: true, statsSource: 'livescore6', crossSourceMatchId: match.id } : null;
    } catch (err) {
        return null;
    }
}

async function fetchMatchDetailStats(matchId, source, homeName = '', awayName = '') {
    if (source !== 'sofascore') {
        let sofaId = null;
        if (homeName && awayName) {
            try { sofaId = await resolveSofaEventIdByName(homeName, awayName, matchId); } catch (_) {}
        }
        return fetchMatchDetailStats(sofaId || matchId, 'sofascore', homeName, awayName);
    }

    const primary = await fetchSofaJson(`/matches/get-statistics?matchId=${encodeURIComponent(matchId)}`);
    let parsed = extractSofaStatistics(primary);
    if (parsed.foundItems === 0) {
        const legacy = await fetchSofaJson(`/events/get-statistics?eventId=${encodeURIComponent(matchId)}`);
        parsed = extractSofaStatistics(legacy);
    }

    let effectiveMatchId = String(matchId);
    let sofaPresent = statPresenceFromParsed(parsed);
    const pCacheKey = statsCacheKey(matchId, homeName, awayName);
    const cachedStats = getPersistentStats(pCacheKey);
    if (cachedStats) {
        const restored = mergeMissingStats(parsed.sofaStats, sofaPresent, cachedStats.stats, cachedStats.present);
        parsed.sofaStats = restored.stats; sofaPresent = restored.present;
    }

    const needMore = () => Object.values(sofaPresent).some(v => !v);
    if (homeName && awayName && needMore()) {
        const lf = await fetchLiveFootballPartialStats(homeName, awayName);
        if (lf?.foundItems > 0) {
            const merged = mergeMissingStats(parsed.sofaStats, sofaPresent, lf.sofaStats, lf.present);
            parsed.sofaStats = merged.stats; sofaPresent = merged.present;
        }
    }
    if (homeName && awayName && needMore()) {
        const ls = await fetchCrossSourcePartialStats(homeName, awayName);
        if (ls?.foundItems > 0) {
            const lsPresent = ls.present || inferStatPresenceFromObject(ls.sofaStats);
            const merged = mergeMissingStats(parsed.sofaStats, sofaPresent, ls.sofaStats, lsPresent);
            parsed.sofaStats = merged.stats; sofaPresent = merged.present;
        }
    }
    parsed.foundItems = Object.values(sofaPresent).filter(Boolean).length;
    if (parsed.foundItems > 0) savePersistentStats(pCacheKey, parsed.sofaStats, sofaPresent, parsed.advancedStats, ['sofascore']);

    return {
        ...parsed,
        statsAvailable: parsed.foundItems > 0,
        present: sofaPresent,
        resolvedMatchId: effectiveMatchId
    };
}

function analyzeOddsGoalProbability(allOdds, homeName, awayName) {
    if (!Array.isArray(allOdds) || allOdds.length === 0) return null;
    const hClean = cleanTeamName(homeName), aClean = cleanTeamName(awayName);
    const foundMatch = allOdds.find(m => cleanTeamName(m.home_team).includes(hClean) && cleanTeamName(m.away_team).includes(aClean));
    if (!foundMatch || !foundMatch.bookmakers?.[0]) return null;
    const overOutcome = foundMatch.bookmakers[0].markets?.find(mk => mk.key === 'totals')?.outcomes?.find(o => o.name === 'Over');
    if (!overOutcome) return null;
    return { bookmaker: foundMatch.bookmakers[0].title, odds: overOutcome.price, oddsNoteText: `Odds Over (${overOutcome.price})` };
}

function evaluateMatchDynamicAI(metrics, oddsAnalysis, elapsedMinute, momentumContext = null, homeScore = 0, awayScore = 0) {
    let matchAnalysis = [];
    let aiPercentage = 15.0;
    const stats = metrics.sofaStats || {};
    const minute = Math.max(1, Number(elapsedMinute) || 1);
    let hasTacticalData = false;

    const totalShots = Math.max(0, Number(stats.totalShots) || 0);
    const shotsOnTarget = Math.max(0, Number(stats.shotsOnTarget) || 0);
    const corners = Math.max(0, Number(stats.corners) || 0);

    const shotsRate = (totalShots / minute) * 100;
    const weightedShotsRate = shotsRate * 0.80;
    const sotRateRaw = (shotsOnTarget / minute) * 100;
    const sotShotRatio = totalShots > 0 ? shotsOnTarget / totalShots : null;

    let effectiveSotMultiplier = sotShotRatio === null ? 1.0 : (sotShotRatio < 0.15 ? 0.5 : sotShotRatio < 0.25 ? 0.8 : sotShotRatio < 0.35 ? 1.0 : sotShotRatio < 0.45 ? 1.3 : 1.5);
    const effectiveSot = sotRateRaw * effectiveSotMultiplier;
    const cornerRate = (corners / minute) * 100;

    if (totalShots > 0) { aiPercentage += weightedShotsRate; hasTacticalData = true; }
    if (shotsOnTarget > 0) { aiPercentage += effectiveSot; hasTacticalData = true; }
    if (corners > 0) { aiPercentage += cornerRate; hasTacticalData = true; }

    const finalNumber = Math.max(0, Math.min(aiPercentage, 98.0));
    return {
        efficiency: finalNumber.toFixed(1),
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend: finalNumber > 60.0 && hasTacticalData
    };
}

function predictFullTimeScore(metrics, ruleEfficiency, homeScore, awayScore, elapsed) {
    const rule = parseFloat(ruleEfficiency);
    if (!Number.isFinite(rule) || rule < 58) return null;
    return { ftScore: `${Number(homeScore)+1}-${Number(awayScore)}`, expectedGoals: 1, likelyScorer: 'Chủ nhà', homePressure: '60.0', awayPressure: '40.0', strength: 'CAO' };
}

async function sendTelegramAlert(item) {
    const message = `🔥 TÀI LỘC ĐẾNNNN 🔥\n🏆 Giải: ${item.league}\n⚔️ Trận: ${item.homeName} ${item.homeScore}-${item.awayScore} ${item.awayName}\n⏱ Phút: ${item.elapsed}'\n📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: message });
        sentAlerts.add(String(item.id));
    } catch (err) {}
}

async function scanLiveMatches() {
    try {
        const [allOdds, liveResult] = await Promise.all([fetchOddsData(), fetchLiveMatchesDualSource()]);
        const { source, matches } = liveResult;
        if (!matches || matches.length === 0) return;

        for (let index = 0; index < matches.length; index++) {
            const item = matches[index];
            const itemSource = item._scanSource || source;
            const matchId = String(itemSource === 'sofascore' ? item.id : (item.eventid || item.Eid || item.id));
            const homeName = itemSource === 'sofascore' ? (item.homeTeam?.name || 'Đội nhà') : (item._lfHome || item.homeTeam?.name || 'Đội nhà');
            const awayName = itemSource === 'sofascore' ? (item.awayTeam?.name || 'Đội khách') : (item._lfAway || item.awayTeam?.name || 'Đội khách');
            let homeScore = parseInt(item.homeScore?.current ?? item.Tr1 ?? 0, 10);
            let actualAwayScore = parseInt(item.awayScore?.current ?? item.Tr2 ?? 0, 10);
            if (isNaN(homeScore)) homeScore = 0;
            if (isNaN(actualAwayScore)) actualAwayScore = 0;

            const leagueName = parseLeagueName(item, itemSource);
            const numericElapsed = calculateExactMinute(item, itemSource);
            if (!Number.isFinite(numericElapsed) || numericElapsed < 60 || numericElapsed > 92) continue;

            const existingAlertState = alertStates.get(String(matchId));
            if (existingAlertState?.sendCount >= 3) continue;

            const metrics = await fetchMatchDetailStats(matchId, itemSource, homeName, awayName);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName);

            const statPresent = metrics.present || inferStatPresenceFromObject(metrics.sofaStats);
            const statCount = ['totalShots','shotsOnTarget','corners','possession','redCards'].filter(k => statPresent?.[k]).length;
            if (statCount < 3 || metrics.statsAvailable === false) continue;

            const momentumKey = `${itemSource}:${matchId}`;
            const previousMomentumSnapshot = momentumStates.get(momentumKey) || null;
            const rawCurrentSnapshot = makeMatchSnapshot(metrics, 0, numericElapsed, homeScore, actualAwayScore);
            const internalMomentum = detectInternalMomentum(previousMomentumSnapshot, rawCurrentSnapshot);

            if (numericElapsed < 70) {
                momentumStates.set(momentumKey, rawCurrentSnapshot);
                continue;
            }

            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis, numericElapsed, internalMomentum, homeScore, actualAwayScore);
            const currentSnapshot = { ...rawCurrentSnapshot, rule: Number(aiAnalysis.efficiency) };
            momentumStates.set(momentumKey, currentSnapshot);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, itemSource, homeScore, actualAwayScore);
                const ftPrediction = predictFullTimeScore(metrics, aiAnalysis.efficiency, homeScore, actualAwayScore, numericElapsed);

                await sendTelegramAlert({
                    id: matchId, source: itemSource, league: leagueName, homeName, awayName, homeScore, awayScore: actualAwayScore,
                    elapsed: numericElapsed, goalTimeline, detailText: aiAnalysis.detailText, ruleEfficiency: aiAnalysis.efficiency, ftPrediction, alertNumber: 1
                });
                alertStates.set(String(matchId), { sendCount: 1, firstSnapshot: currentSnapshot });
            }
        }
    } catch (err) {}
}

app.get('/', (req, res) => { res.send('Football Dual-Source AI Scanner Service is Running!'); });
app.listen(PORT, () => {
    console.log(`==> Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 7 * 60 * 1000);
});