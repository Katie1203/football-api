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
        '[CACHE 46-69]',
        '[SOURCE AUDIT]',
        '[SOURCE AUDIT MERGED]',
        '[RULE BREAKDOWN]',
        '[ATTACK SURGE]',
        '[LIVESCORE6 SCOREBOARD]',
        '[LIVESCORE6 COMMENTARY]',
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
    // V17.0.3: canonical cache không phụ thuộc source matchId.
    // Cùng một trận đổi ID/nguồn vẫn phục hồi được partial stats đã lấy trước đó.
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

const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

const sentAlerts = new Set();

// V16.3: trạng thái cảnh báo theo trận. Tối đa 3 tin/trận trong một phiên chạy.
const alertStates = new Map();
// V16.4: snapshot mọi vòng quét để tự tính momentum 5-10 phút, không gọi thêm API.
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
    // V17.4.1: BIGGGG LẦN 2 dùng Effective SOT thay cho SOT thô.
    // SOT tăng chỉ được coi là spike khi chất lượng SOT/Total Shots đủ kéo Effective SOT tăng.
    if (dEffectiveSot >= 1.5) reasons.push(`Effective SOT +${dEffectiveSot.toFixed(2)} điểm`);
    if (dSotQuality !== null && dSotQuality >= 5 && dSot >= 1) reasons.push(`Chất lượng SOT +${dSotQuality.toFixed(1)} điểm %`);
    if (dShots >= 4) reasons.push(`Tổng sút +${dShots}`);
    if (dCorners >= 2) reasons.push(`Phạt góc +${dCorners}`);
    if (dRed >= 1) reasons.push(`Thẻ đỏ mới +${dRed}`);
    if (dGoals >= 1) reasons.push(`Bàn thắng mới +${dGoals}`);

    // Đột biến cường độ: rate toàn trận tăng đáng kể dù số phút cũng tăng.
    const dShotsRate = current.shotsRate - previous.shotsRate;
    const dSotRate = current.sotRate - previous.sotRate;
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
    // V17.4.1: LẦN 3 cũng dùng Effective SOT, ngưỡng mạnh hơn LẦN 2.
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

    // Strong = nhiều tín hiệu đồng thời. Không cộng trực tiếp vào Rule.
    return { isStrong: score >= 4, score, reasons, deltaMinute: dm, deltas: { shots: dShots, sot: dSot, corners: dCorners, xg: dXg, bigChances: dBig, shotsInsideBox: dInside, touchesOppBox: dTouches } };
}

function getVietnamTime() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return {
        dateStr: vnTime.toISOString().slice(0, 10), // YYYY-MM-DD
        timeStr: vnTime.toISOString().slice(11, 19)
    };
}

// ==========================================
// 1. BẢNG DỊCH QUỐC GIA & GIẢI ĐẤU VIỆT HÓA
// ==========================================
const COUNTRY_MAP = {
    'England': 'Anh',
    'Spain': 'Tây Ban Nha',
    'Italy': 'Ý',
    'Germany': 'Đức',
    'France': 'Pháp',
    'Japan': 'Nhật Bản',
    'South Korea': 'Hàn Quốc',
    'Vietnam': 'Việt Nam',
    'Brazil': 'Brazil',
    'Argentina': 'Argentina',
    'Netherlands': 'Hà Lan',
    'Portugal': 'Bồ Đào Nha',
    'Turkey': 'Thổ Nhĩ Kỳ',
    'Saudi Arabia': 'Ả Rập Xê Út',
    'China': 'Trung Quốc',
    'Thailand': 'Thái Lan',
    'Australia': 'Úc',
    'USA': 'Mỹ',
    'Norway': 'Na Uy',
    'Czech Republic': 'Cộng hòa Séc',
    'Denmark': 'Đan Mạch',
    'Croatia': 'Croatia',
    'Poland': 'Ba Lan',
    'Austria': 'Áo',
    'World': 'Quốc Tế',
    'Europe': 'Châu Âu',
    'Asia': 'Châu Á',
    'South America': 'Nam Mỹ',
    'International': 'Quốc Tế',
    'Finland': 'Phần Lan',
    'Sweden': 'Thụy Điển',
    'Belgium': 'Bỉ',
    'Switzerland': 'Thụy Sĩ',
    'Greece': 'Hy Lạp',
    'Romania': 'Romania',
    'Serbia': 'Serbia',
    'Slovakia': 'Slovakia',
    'Slovenia': 'Slovenia',
    'Hungary': 'Hungary',
    'Bulgaria': 'Bulgaria',
    'Ukraine': 'Ukraine',
    'Scotland': 'Scotland',
    'Ireland': 'Ireland',
    'Iceland': 'Iceland',
    'Finland Amateur': 'Phần Lan Nghiệp Dư',
    'Norway Amateur': 'Na Uy Nghiệp Dư',
    'Poland Amateur': 'Ba Lan Nghiệp Dư',
    'Sweden Amateur': 'Thụy Điển Nghiệp Dư'
};

const LEAGUE_NAME_MAP = {
    'UEFA Champions League': 'Cúp C1 Châu Âu',
    'UEFA Europa League': 'Cúp C2 Châu Âu',
    'UEFA Conference League': 'Cúp C3 Châu Âu',
    'UEFA Nations League': 'Nations League Châu Âu',
    'AFC Champions League Elite': 'Cúp C1 Châu Á',
    'AFC Champions League Two': 'Cúp C2 Châu Á',
    'AFC Asian Cup': 'Cúp Châu Á (Asian Cup)',
    'CONMEBOL Libertadores': 'Cúp C1 Nam Mỹ (Libertadores)',
    'CONMEBOL Sudamericana': 'Cúp C2 Nam Mỹ (Sudamericana)',
    'World Cup': 'Giải Vô Địch Thế Giới (World Cup)',
    'Club World Cup': 'Giải VĐQG Thế Giới Các CLB',
    'Friendlies': 'Giao Hữu Quốc Tế',
    'Club Friendly': 'Giao Hữu CLB',

    'Premier League': 'Ngoại Hạng Anh',
    'Championship': 'Hạng Nhất Anh',
    'League One': 'Hạng Hai Anh',
    'League Two': 'Hạng Ba Anh',
    'FA Cup': 'Cúp FA',
    'EFL Cup': 'Cúp Liên Đoàn Anh',

    'LaLiga': 'VĐQG Tây Ban Nha',
    'LaLiga 2': 'Hạng 2 Tây Ban Nha',
    'Copa del Rey': 'Cúp Nhà Vua Tây Ban Nha',

    'Serie A': 'VĐQG Ý',
    'Serie B': 'Hạng 2 Ý',
    'Coppa Italia': 'Cúp Quốc Gia Ý',

    'Bundesliga': 'VĐQG Đức',
    '2. Bundesliga': 'Hạng 2 Đức',
    'DFB Pokal': 'Cúp Quốc Gia Đức',

    'Ligue 1': 'VĐQG Pháp',
    'Ligue 2': 'Hạng 2 Pháp',
    'Coupe de France': 'Cúp Quốc Gia Pháp',

    'J1 League': 'VĐQG Nhật Bản',
    'J2 League': 'Hạng 2 Nhật Bản',
    'J3 League': 'Hạng 3 Nhật Bản',
    'K League 1': 'VĐQG Hàn Quốc',
    'K League 2': 'Hạng 2 Hàn Quốc',
    'V-League 1': 'V-League Việt Nam',
    'Thai League 1': 'VĐQG Thái Lan',
    'Super League': 'VĐQG Trung Quốc'
};

function parseLeagueName(item, source) {
    if (!item) return 'Bóng Đá Quốc Tế';

    let category = '';
    let tournament = '';

    if (source === 'sofascore') {
        category =
            item.tournament?.category?.name ||
            item.category?.name ||
            item.uniqueTournament?.category?.name ||
            '';
        tournament =
            item.tournament?.name ||
            item.tournament?.uniqueTournament?.name ||
            item.uniqueTournament?.name ||
            item.competitionName ||
            '';
    } else if (source === 'livefootball') {
        category = item._lfCategory || item.country?.name || item.country || item.category?.name || item.category || '';
        tournament = item._lfLeague || item.league?.name || item.leagueName || item.tournament?.name || item.tournamentName || item.competition?.name || item.competitionName || '';
    } else {
        category =
            item._inheritedCategory ||
            item.Cname ||
            item.Cnm ||
            item.categoryName ||
            item.country ||
            '';
        tournament =
            item._inheritedTournament ||
            item.Snm ||
            item.Tname ||
            item.tournamentName ||
            item.LeagueName ||
            '';
    }

    category = String(category || '').trim();
    tournament = String(tournament || '').trim();

    if (LEAGUE_NAME_MAP[tournament]) return LEAGUE_NAME_MAP[tournament];

    const translatedCategory = COUNTRY_MAP[category] || category;

    // Không dùng replace "Division 1 -> Hạng 1" mù quáng nữa:
    // một số API dùng Division 1 cho giải VĐQG, nên giữ nguyên tên gốc
    // nếu chưa có mapping chắc chắn.
    let translatedTournament = tournament
        .replace(/\bPremier League\b/gi, 'Giải VĐQG')
        .replace(/\bSuper League\b/gi, 'VĐQG')
        .replace(/\bChampionship\b/gi, 'Hạng Nhất')
        .replace(/\bCup\b/gi, 'Cúp')
        .replace(/\bWomen\b/gi, 'Nữ')
        .replace(/\bReserve\b/gi, 'Dự Bị')
        .replace(/\s+/g, ' ')
        .trim();

    // Các giải amateur / regional: giữ tên giải cụ thể + quốc gia,
    // tránh biến thành tên chung gây khó đọc log.
    const categoryLower = category.toLowerCase();
    const tournamentLower = tournament.toLowerCase();
    const isAmateur =
        categoryLower.includes('amateur') ||
        tournamentLower.includes('amateur');

    if (translatedCategory && translatedTournament) {
        const tLower = translatedTournament.toLowerCase();
        const cLower = translatedCategory.toLowerCase();

        if (tLower.includes(cLower)) return translatedTournament;

        return `${translatedTournament} (${translatedCategory}${isAmateur && !cLower.includes('nghiệp dư') ? ' - Nghiệp Dư' : ''})`;
    }

    return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}

// ==========================================
// 2. BỘ LỌC THÔNG MINH
// ==========================================
function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();

    // 1) LOẠI TOÀN BỘ GIẢI TRẺ U19 TRỞ XUỐNG:
    // U19, U18, U17 ... U10; Under 19, Under-18; Sub19...
    // Không loại U20/U21/U23 theo yêu cầu hiện tại.
    const youthRegex = /\b(?:u[\s-]?(?:1[0-9]|[1-9])|under[\s-]?(?:1[0-9]|[1-9])|sub[\s-]?(?:1[0-9]|[1-9]))\b/i;
    if (youthRegex.test(textToTest)) return true;

    // 2) LOẠI GIẢI NGHIỆP DƯ / GIẢI CỎ / PHONG TRÀO.
    const amateurKeywords = [
        'amateur', 'amateurs', 'amatori', 'amatör', 'amator',
        'nghiệp dư', 'nghiep du',
        'grassroots', 'grassroot',
        'sunday league',
        'recreational', 'recreation',
        'non league', 'non-league'
    ];

    // 3) LOẠI GIẢI SINH VIÊN / ĐẠI HỌC / CAO ĐẲNG.
    const studentKeywords = [
        'student', 'students',
        'university', 'universities',
        'college', 'collegiate',
        'campus',
        'varsity',
        'inter university', 'inter-university',
        'student league',
        'university league',
        'college league',
        'sinh viên', 'sinh vien',
        'đại học', 'dai hoc',
        'cao đẳng', 'cao dang'
    ];

    // 4) Giữ bộ lọc game mô phỏng/eSports cũ.
    const otherBlockedKeywords = [
        'simulated', 'srl', 'esports', 'e-soccer', 'esoccer'
    ];

    const blockedKeywords = [
        ...amateurKeywords,
        ...studentKeywords,
        ...otherBlockedKeywords
    ];

    return blockedKeywords.some(kw => textToTest.includes(kw));
}

// RÀO CẢN TRƯỚC MỌI API CHI TIẾT:
// Chỉ những trận qua rào này mới được phép gọi Statistics / Graph / Incidents / Odds analysis.
function passesPreApiGate(item, source) {
    if (!item) return false;

    let homeName = '';
    let awayName = '';

    if (source === 'sofascore') {
        homeName = item.homeTeam?.name || '';
        awayName = item.awayTeam?.name || '';
    } else if (source === 'livefootball') {
        homeName = item._lfHome || item.homeTeam?.name || item.home?.name || item.homeName || item.team1?.name || item.team1 || item.home_team || '';
        awayName = item._lfAway || item.awayTeam?.name || item.away?.name || item.awayName || item.team2?.name || item.team2 || item.away_team || '';
    } else {
        homeName =
            (item.T1 && item.T1[0] && (item.T1[0].Nm || item.T1[0].Name)) ||
            item.homeTeam?.name || '';
        awayName =
            (item.T2 && item.T2[0] && (item.T2[0].Nm || item.T2[0].Name)) ||
            item.awayTeam?.name || '';
    }

    const leagueName = parseLeagueName(item, source);

    // Loại giải trước, tuyệt đối không gọi API detail cho các trận bị loại.
    if (isFilteredLeague(leagueName, homeName, awayName)) {
        return false;
    }

    // Rào phút ngay từ đầu: chỉ 46–92 mới được đi tiếp.
    if (!isEligibleLiveMatch(item, source, 46, 92)) {
        return false;
    }

    return true;
}

// ==========================================
// 3. TÍNH PHÚT TRẬN ĐẤU (FIX CHUẨN XÁC 100% CHO LIVESCORE6)
// ==========================================
function calculateExactMinute(item, source) {
    if (!item) return 0;

    const nowSec = Math.floor(Date.now() / 1000);

    // Chuẩn hóa phút dạng: 67, "67", "67'", "45+2", "90+4"
    function parseMinuteValue(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number' && Number.isFinite(value)) {
            if (value > 0 && value <= 130) return Math.floor(value);
            return null;
        }
        const text = String(value).trim();
        const extra = text.match(/(?:^|\D)(\d{1,3})\s*\+\s*(\d{1,2})(?:\D|$)/);
        if (extra) {
            const base = Number(extra[1]);
            const added = Number(extra[2]);
            if (base >= 1 && base <= 120) return Math.min(130, base + added);
        }
        const plain = text.match(/(?:^|\D)(\d{1,3})(?:\s*['’′]|\s*MIN\b|\s*MINUTE\b|$)/i);
        if (plain) {
            const n = Number(plain[1]);
            if (n >= 1 && n <= 120) return n;
        }
        return null;
    }

    function statusResult(values) {
        const text = values.filter(v => v !== null && v !== undefined)
            .map(v => String(v).trim().toUpperCase()).join(' | ');
        if (/\b(FT|AET|PEN|FINISHED|ENDED|AFTER PENALTIES)\b/.test(text)) return 999;
        if (/\b(HT|HALF[ -]?TIME|HALFTIME)\b/.test(text)) return 'HT';
        return null;
    }

    if (source === 'sofascore') {
        const ended = statusResult([
            item.status?.type, item.status?.description, item.status?.code,
            item.statusDescription, item.statusText
        ]);
        if (ended !== null) return ended;

        // SofaScore thường trả time.played là số giây ở một số response,
        // và phút ở response khác. Không trả thẳng nếu > 130.
        const played = item.time?.played;
        if (typeof played === 'number' && played > 0) {
            if (played <= 130) return Math.floor(played);
            if (played <= 130 * 60) return Math.floor(played / 60);
        }

        const direct = [
            item.minute, item.time?.current, item.time?.minute,
            item.status?.description
        ];
        for (const v of direct) {
            const m = parseMinuteValue(v);
            if (m !== null) return m;
        }

        // ƯU TIÊN CLOCK CỦA HIỆP HIỆN TẠI.
        // SofaScore currentPeriodStartTimestamp là mốc bắt đầu hiệp đang đá.
        // time.initial thường là số giây đã hoàn tất trước hiệp hiện tại:
        // H1 = 0, H2 = 2700 (45 phút), ET có thể lớn hơn.
        const periodStartTs = Number(
            item.time?.currentPeriodStartTimestamp ||
            item.statusTime?.timestamp ||
            0
        );

        if (periodStartTs > 1000000000 && periodStartTs <= nowSec) {
            let initialSeconds = Number(
                item.time?.initial ??
                item.statusTime?.initial ??
                0
            );

            // Một số response không có initial: suy ra base theo trạng thái hiệp.
            if (!Number.isFinite(initialSeconds) || initialSeconds < 0) initialSeconds = 0;

            const statusText = [
                item.status?.description,
                item.status?.type,
                item.statusDescription,
                item.statusText
            ].filter(Boolean).join(' ').toLowerCase();

            if (initialSeconds === 0) {
                if (/2nd|second|2h|second half/.test(statusText)) initialSeconds = 45 * 60;
                else if (/extra time|overtime|et/.test(statusText)) initialSeconds = 90 * 60;
            }

            const periodElapsedSeconds = Math.max(0, nowSec - periodStartTs);
            const exactMinute = Math.floor((initialSeconds + periodElapsedSeconds) / 60) + 1;

            if (exactMinute >= 1 && exactMinute <= 130) return exactMinute;
        }

        // CUỐI CÙNG mới dùng startTimestamp của cả trận.
        // Chỉ dùng cho H1; KHÔNG dùng ở H2 vì sẽ cộng cả thời gian nghỉ giữa hiệp.
        const statusText = [
            item.status?.description,
            item.status?.type,
            item.statusDescription,
            item.statusText
        ].filter(Boolean).join(' ').toLowerCase();

        const looksSecondHalf = /2nd|second|2h|second half/.test(statusText);
        if (!looksSecondHalf) {
            const startTs = Number(item.startTimestamp || item.startTimeTimestamp || 0);
            if (startTs > 1000000000 && startTs <= nowSec) {
                const realElapsed = Math.floor((nowSec - startTs) / 60) + 1;
                if (realElapsed >= 1 && realElapsed <= 55) return realElapsed;
            }
        }

        // Không có clock đáng tin cậy => loại, không tự đoán phút.
        return 0;
    }

    if (source === 'livefootball') {
        const lfStatus = statusResult([
            item.status?.type, item.status?.description, item.status,
            item.matchStatus, item.statusText, item.state, item.period
        ]);
        if (lfStatus !== null) return lfStatus;
        const lfMinuteCandidates = [
            item._lfMinute, item.minute, item.matchMinute, item.liveMinute,
            item.time?.minute, item.time?.current, item.elapsed, item.elapsedTime,
            item.timer, item.clock, item.status?.description, item.statusText
        ];
        for (const v of lfMinuteCandidates) {
            const m = parseMinuteValue(v);
            if (m !== null) return m;
        }
        return 0;
    }

    const status = statusResult([
        item.Eps, item.status, item.matchStatus, item.statusText,
        item.statusDescription, item.Reason, item.Trh, item.MatchStatus
    ]);
    if (status !== null) return status;

    // Livescore6: ưu tiên trường phút thật. Hỗ trợ cả number và string.
    const minuteCandidates = [
        item.Tm, item.Minute, item.minute, item.time,
        item.MatchMinute, item.matchMinute, item.LiveMinute, item.liveMinute,
        item.Eps, item.statusText, item.statusDescription
    ];
    for (const v of minuteCandidates) {
        const m = parseMinuteValue(v);
        if (m !== null) return m;
    }

    return 0;
}

// Chỉ giữ trận đang diễn ra H2 ngay tại tầng thu thập dữ liệu.
// Trận 0', HT, FT/999 hoặc ngoài 46-92 sẽ không đi vào vòng AI.
function isEligibleLiveMatch(item, source, minMinute = 46, maxMinute = 92) {
    const elapsed = calculateExactMinute(item, source);
    const minute = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);
    return Number.isFinite(minute) && minute >= minMinute && minute <= maxMinute && minute !== 999;
}
// ==========================================
// 4. LẤY DỮ LIỆU KÉP (SOFASCORE & LIVESCORE6 KẾT HỢP ĐẶC BIỆT)
// ==========================================
async function fetchLiveMatchesDualSource() {
    // V16.2: KHÔNG return sớm khi SofaScore có trận.
    // V17.1 patch trên V17.0.1: FULL LIVE DISCOVERY 46-92.
    // Luôn gộp SofaScore + LiveFootball + Livescore6, không return sớm theo bất kỳ nguồn nào.
    const collected = [];
    const seen = new Set();

    function normName(v='') {
        return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
            .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
    }
    function getNames(item, source) {
        if (source === 'sofascore') return [item.homeTeam?.name || '', item.awayTeam?.name || ''];
        if (source === 'livefootball') return [
            item._lfHome || item.homeTeam?.name || item.home?.name || item.homeName || item.team1?.name || item.team1 || item.home_team || '',
            item._lfAway || item.awayTeam?.name || item.away?.name || item.awayName || item.team2?.name || item.team2 || item.away_team || ''
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
        const isU21 = /\bu[\s-]?21\b|\bunder[\s-]?21\b/i.test(`${league} ${home} ${away}`);

        if (isFilteredLeague(league, home, away)) {
            if (isU21) console.log(`    ⚠️ [FILTER CHECK U21] Bị loại bởi league filter: ${home} vs ${away} | ${league}`);
            return;
        }
        if (!Number.isFinite(Number(minute)) || Number(minute) < 46 || Number(minute) > 92 || Number(minute) === 999) {
            if (isU21) console.log(`    ⏱️ [REJECT MINUTE U21] ${home} vs ${away} | ${minute}' | ${league}`);
            return;
        }

        // Deduplicate xuyên nguồn theo cặp tên đội; ưu tiên bản Sofa vì được add trước.
        const key = `${normalizeTeamName(home)}__${normalizeTeamName(away)}`;
        const reverseKey = `${normalizeTeamName(away)}__${normalizeTeamName(home)}`;
        if (seen.has(key) || seen.has(reverseKey)) return;
        seen.add(key);
        collected.push({ ...item, _scanSource: source });
        if (isU21) console.log(`    ✅ [KEEP U21] ${home} vs ${away} | ${minute}' | ${league} | source=${source}`);
    }

    // 1) SofaScore discovery
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': SOFASCORE_HOST },
            timeout: 10000
        });
        const events = response.data?.events || response.data?.liveEvents || [];
        const before = collected.length;
        for (const item of events) addEligible(item, 'sofascore');
        console.log(`[Source: SofaScore] Tổng live=${events.length} | Qua PRE-API GATE (giải + phút 46-92)=${collected.length-before}`);
    } catch (err) {
        console.warn(`⚠️ [SofaScore Error]: ${err.message} -> vẫn tiếp tục discovery Livescore6...`);
    }

    // 2) LiveFootball discovery: luôn chạy để BỔ SUNG trận SofaScore bỏ sót.
    // Parser đệ quy chịu được nhiều shape; nếu response.live=[] thì bỏ qua an toàn.
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
            liveList = Array.isArray(lfRes.data?.response?.live) ? lfRes.data.response.live : [];
            resolverLiveCache.livefootball = { ts: now, data: liveList };
        }
        function extractLiveFootballCandidates(data) {
    const out = [], seen = new Set();
    function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        
        // Vét cạn mọi biến thể tên đội và ID của LiveFootball
        const id = String(n.eventid ?? n.eventId ?? n.matchId ?? n.id ?? n.MatchId ?? '');
        const home = String(n._lfHome ?? n.homeTeam?.name ?? n.home?.name ?? n.homeName ?? n.team1?.name ?? n.team1 ?? n.home_team ?? n.HomeName ?? n.T1?.[0]?.Nm ?? '').trim();
        const away = String(n._lfAway ?? n.awayTeam?.name ?? n.away?.name ?? n.awayName ?? n.team2?.name ?? n.team2 ?? n.away_team ?? n.AwayName ?? n.T2?.[0]?.Nm ?? '').trim();
        
        if (id && home && away && !seen.has(id)) {
            seen.add(id);
            out.push({ id, home, away, raw: n });
        }
        Object.values(n).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    walk(data);
    return out;
}

    // 3) Livescore6 discovery luôn chạy để BỔ SUNG trận SofaScore/LiveFootball bỏ sót.
    try {
        const currentVN = getVietnamTime();
        const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
        const dateUrl = `https://${LIVESCORE_HOST}/matches/v2/list-by-date?Category=soccer&Date=${currentVN.dateStr}&Timezone=-7`;
        const [resLive, resDate] = await Promise.all([
            axios.get(liveUrl, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({data:null})),
            axios.get(dateUrl, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({data:null}))
        ]);
        const localSeenIds = new Set();
        let candidates = 0, added = 0;
        function walk(obj, cat='', tour='') {
            if (!obj || typeof obj !== 'object') return;
            const matchId = String(obj.Eid || obj.id || obj.MatchId || '');
            const hasTeams = obj.T1 || obj.homeTeam || obj.T2 || obj.AwayTeam || (obj.Home && obj.Away);
            if (matchId && hasTeams && !localSeenIds.has(matchId)) {
                localSeenIds.add(matchId); candidates++;
                const enriched = { ...obj,
                    _inheritedCategory: obj.Cname || obj.categoryName || obj.country || obj.Cnm || cat,
                    _inheritedTournament: obj.Snm || obj.Tname || obj.tournamentName || obj.LeagueName || tour
                };
                const n0=collected.length; addEligible(enriched,'livescore6'); if(collected.length>n0) added++;
            }
            for (const key of Object.keys(obj)) if (obj[key] !== null && typeof obj[key] === 'object')
                walk(obj[key], obj.Cname || obj.categoryName || cat, obj.Snm || obj.Tname || tour);
        }
        if (resLive.data) walk(resLive.data);
        if (resDate.data) walk(resDate.data);
        console.log(`[Source: Livescore6] Candidate=${candidates} | Bổ sung sau PRE-API GATE + dedupe=${added}`);
    } catch (err) {
        console.error(`❌ [Livescore6 Discovery Error]: ${err.message}`);
    }

    console.log(`[DISCOVERY MERGED] Tổng trận hợp lệ 46-92 sau gộp nguồn=${collected.length}`);
    return { source: 'mixed', matches: collected };
}

// ==========================================
// 5. DIỄN BIẾN BÀN THẮNG
// ==========================================
async function fetchLivescoreCommentaryTimeline(eid, homeScore = 0, awayScore = 0) {
    if (!eid) return null;
    try {
        const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-commentary?Eid=${encodeURIComponent(eid)}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST },
            timeout: 6500
        });
        const goals = [];
        function walk(n) {
            if (!n || typeof n !== 'object') return;
            if (Array.isArray(n)) { n.forEach(walk); return; }
            const text = String(n.Txt ?? n.text ?? n.commentary ?? n.description ?? n.type ?? n.eventType ?? '').toLowerCase();
            const isGoal = /\bgoal\b|ghi bàn|scores?/.test(text) || String(n.type ?? n.eventType ?? '').toLowerCase() === 'goal';
            if (isGoal) {
                const minRaw = n.Min ?? n.minute ?? n.time ?? n.Tm ?? n.clock;
                const mm = String(minRaw ?? '').match(/(\d{1,3})(?:\s*\+\s*(\d{1,2}))?/);
                const hs = Number(n.homeScore ?? n.Tr1 ?? n.scoreHome ?? n.score?.home);
                const as = Number(n.awayScore ?? n.Tr2 ?? n.scoreAway ?? n.score?.away);
                goals.push({ minute:mm ? Number(mm[1]) : 0, extra:mm?.[2] ? Number(mm[2]) : 0,
                    homeScore:Number.isFinite(hs)?hs:null, awayScore:Number.isFinite(as)?as:null });
            }
            Object.values(n).forEach(v => { if (v && typeof v === 'object') walk(v); });
        }
        walk(response.data);
        goals.sort((a,b)=>(a.minute+a.extra/100)-(b.minute+b.extra/100));
        const out=[];
        for (const g of goals) {
            if (g.homeScore === null || g.awayScore === null) continue;
            const label = `P${g.minute}${g.extra?`+${g.extra}`:''}: ${g.homeScore}-${g.awayScore}`;
            if (!out.includes(label)) out.push(label);
        }
        if (out.length) {
            console.log(`    ✅ [LIVESCORE6 COMMENTARY] Eid=${eid} | goal timeline=${out.length}`);
            return out.join(' | ');
        }
        console.log(`    ⚠️ [LIVESCORE6 COMMENTARY] Eid=${eid} | không bóc được timeline bàn thắng`);
        return null;
    } catch (err) {
        console.log(`    ⚠️ [LIVESCORE6 COMMENTARY ERROR] Eid=${eid} | ${err.message}`);
        return null;
    }
}

async function fallbackLivescoreTimeline(homeName, awayName, homeScore, awayScore) {
    if (!homeName || !awayName) return null;
    const match = await resolveLivescoreMatchByName(homeName, awayName);
    if (!match?.id) return null;
    return fetchLivescoreCommentaryTimeline(match.id, homeScore, awayScore);
}

async function fetchMatchIncidents(matchId, source, homeScore = 0, awayScore = 0, homeName = '', awayName = '') {
    if (source === 'sofascore') {
        try {
            const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-incidents?eventId=${matchId}`, {
                headers: {
                    'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                    'x-rapidapi-host': SOFASCORE_HOST
                },
                timeout: 6000
            });

            const incidents = response.data?.incidents || [];
            const goalEvents = incidents.filter(inc => inc.incidentType === 'goal');

            if (goalEvents.length === 0) {
                const commentary = await fallbackLivescoreTimeline(homeName, awayName, homeScore, awayScore);
                if (commentary) return commentary;
                const totalGoals = homeScore + awayScore;
                if (totalGoals > 0) return `Tỷ số hiện tại: ${homeScore}-${awayScore}`;
                return 'Chưa có bàn thắng (0-0)';
            }

            goalEvents.sort((a, b) => (a.time || 0) - (b.time || 0));

            let runningHome = 0, runningAway = 0;
            const timeline = goalEvents.map(g => {
                const min = g.time || 0;
                const extra = g.addedTime ? `+${g.addedTime}` : '';
                if (g.homeScore !== undefined && g.awayScore !== undefined) {
                    runningHome = Number(g.homeScore) || 0;
                    runningAway = Number(g.awayScore) || 0;
                } else if (g.isHome) runningHome += 1;
                else runningAway += 1;
                return `P${min}${extra}: ${runningHome}-${runningAway}`;
            });

            return timeline.join(' | ');
        } catch (err) {
            const totalGoals = homeScore + awayScore;
            if (totalGoals > 0) {
                return `Tỷ số hiện tại: ${homeScore}-${awayScore}`;
            }
            return 'Chưa có bàn thắng (0-0)';
        }
    } else {
        try {
            const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-incidents?Eid=${matchId}&Category=soccer`, {
                headers: {
                    'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                    'x-rapidapi-host': LIVESCORE_HOST
                },
                timeout: 6000
            });

            const data = response.data;
            let incidents = [];
            if (Array.isArray(data)) incidents = data;
            else if (data?.incidents) incidents = data.incidents;
            else if (data?.events) incidents = data.events;

            const goalEvents = incidents.filter(inc => {
                const type = String(inc.type || inc.incidentType || '').toLowerCase();
                return type.includes('goal') || type === '1';
            });

            if (goalEvents.length === 0) {
                const commentary = await fetchLivescoreCommentaryTimeline(matchId, homeScore, awayScore);
                if (commentary) return commentary;
                const totalGoals = homeScore + awayScore;
                if (totalGoals > 0) return `Tỷ số hiện tại: ${homeScore}-${awayScore}`;
                return 'Chưa có bàn thắng (0-0)';
            }

            goalEvents.sort((a, b) => (a.time || a.minute || 0) - (b.time || b.minute || 0));

            let runningHome = 0, runningAway = 0;
            const timeline = goalEvents.map(g => {
                const min = g.time || g.minute || 0;
                const teamSide = String(g.team || g.homeAway || '').toLowerCase();
                const isHome = teamSide.includes('home') || teamSide === 'h';
                if (g.homeScore !== undefined && g.awayScore !== undefined) {
                    runningHome = Number(g.homeScore) || 0;
                    runningAway = Number(g.awayScore) || 0;
                } else if (isHome) runningHome += 1;
                else runningAway += 1;
                return `P${min}: ${runningHome}-${runningAway}`;
            });

            return timeline.join(' | ');
        } catch (err) {
            const totalGoals = homeScore + awayScore;
            if (totalGoals > 0) {
                return `Tỷ số hiện tại: ${homeScore}-${awayScore}`;
            }
            return 'Chưa có bàn thắng (0-0)';
        }
    }
}

// ==========================================
// 6. KÈO ODDS
// ==========================================
async function fetchOddsData() {
    if (!ODDS_API_KEY) return [];
    try {
        const response = await axios.get(ODDS_API_URL, { timeout: 8000 });
        return response.data || [];
    } catch (err) {
        return [];
    }
}

// ==========================================
// 7. THỐNG KÊ CHI TIẾT TRẬN ĐẤU
// ==========================================
async function fetchSofaJson(path, timeout = 6000) {
    try {
        const response = await axios.get(`https://${SOFASCORE_HOST}${path}`, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
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
    let possessionHome = null, possessionAway = null;
    let xg = 0, bigChances = 0, shotsInsideBox = 0, touchesOppBox = 0;
    let foundItems = 0;
    const present = { totalShots:false, shotsOnTarget:false, corners:false, possession:false, redCards:false };

    const roots = [];
    if (Array.isArray(data?.statistics)) roots.push(...data.statistics);
    if (Array.isArray(data?.stats)) roots.push(...data.stats);
    if (Array.isArray(data)) roots.push(...data);

    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }

        const name = String(node.name || node.slug || node.type || node.title || '').toLowerCase();
        const hvRaw = node.home ?? node.homeValue ?? node.homeTeam ?? node.valueHome;
        const avRaw = node.away ?? node.awayValue ?? node.awayTeam ?? node.valueAway;
        const homeVal = parseInt(String(hvRaw ?? '').replace('%',''), 10);
        const awayVal = parseInt(String(avRaw ?? '').replace('%',''), 10);

        if (name && (!isNaN(homeVal) || !isNaN(awayVal))) {
            const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);
            if (name.includes('shots on target') || name.includes('shot on target')) {
                shotsOnTarget = Math.max(shotsOnTarget, sumVal); present.shotsOnTarget=true; foundItems++;
            } else if (name.includes('shots off target') || name.includes('shot off target')) {
                shotsOffTarget = Math.max(shotsOffTarget, sumVal); foundItems++;
            } else if (name.includes('blocked shots') || name.includes('blocked shot')) {
                blockedShots = Math.max(blockedShots, sumVal); foundItems++;
            } else if (name.includes('total shots') || name.includes('total shot')) {
                totalShots = Math.max(totalShots, sumVal); present.totalShots=true; foundItems++;
            } else if (name.includes('corner')) {
                corners = Math.max(corners, sumVal); present.corners=true; foundItems++;
            } else if (name.includes('red card')) {
                redCards = Math.max(redCards, sumVal); present.redCards=true; foundItems++;
            } else if (name.includes('expected goals') || name === 'xg') {
                const h = Number(String(hvRaw ?? '').replace(',','.')); const a = Number(String(avRaw ?? '').replace(',','.'));
                if (Number.isFinite(h) || Number.isFinite(a)) xg = Math.max(xg, (Number.isFinite(h)?h:0)+(Number.isFinite(a)?a:0));
            } else if (name.includes('big chance') && !name.includes('missed')) {
                bigChances = Math.max(bigChances, sumVal);
            } else if (name.includes('shots inside box') || name.includes('shot inside box')) {
                shotsInsideBox = Math.max(shotsInsideBox, sumVal);
            } else if (name.includes('touches in opposition box') || name.includes('touches opposition box')) {
                touchesOppBox = Math.max(touchesOppBox, sumVal);
            } else if (name.includes('ball possession') || name === 'possession' || name.includes('possession')) {
                if (!isNaN(homeVal) && !isNaN(awayVal)) {
                    possessionHome = homeVal; possessionAway = awayVal; present.possession=true; foundItems++;
                }
            }
        }

        Object.values(node).forEach(v => {
            if (v && typeof v === 'object') walk(v);
        });
    }

    roots.forEach(walk);

    return {
        foundItems,
        sofaStats: {
            shotsOnTarget,
            totalShots: totalShots || (shotsOnTarget + shotsOffTarget + blockedShots),
            shotsOffTarget,
            blockedShots,
            corners,
            redCards,
            possession: possessionHome !== null && possessionAway !== null
                ? `${possessionHome}% - ${possessionAway}%`
                : null
        },
        advancedStats: { xg, bigChances, shotsInsideBox, touchesOppBox },
        present
    };
}


function detectSofaStatPresence(data) {
    const p={totalShots:false,shotsOnTarget:false,corners:false,possession:false,redCards:false};
    function walk(n){ if(!n||typeof n!=='object')return; if(Array.isArray(n)){n.forEach(walk);return;}
      const name=String(n.name||n.slug||n.type||n.title||'').toLowerCase();
      const hasPair=(n.home!==undefined||n.homeValue!==undefined||n.homeTeam!==undefined||n.valueHome!==undefined) && (n.away!==undefined||n.awayValue!==undefined||n.awayTeam!==undefined||n.valueAway!==undefined);
      if(hasPair){ if(name.includes('total shot'))p.totalShots=true; else if(name.includes('shot on target'))p.shotsOnTarget=true; else if(name.includes('corner'))p.corners=true; else if(name.includes('possession'))p.possession=true; else if(name.includes('red card'))p.redCards=true; }
      Object.values(n).forEach(v=>{if(v&&typeof v==='object')walk(v)});
    } walk(data); return p;
}

function extractEventArrayDeep(data) {
    const out=[], seen=new Set();
    function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        const id=n.id ?? n.eventId ?? n.matchId;
        const h=n.homeTeam?.name ?? n.home?.name ?? n.homeName;
        const a=n.awayTeam?.name ?? n.away?.name ?? n.awayName;
        if (id && h && a && !seen.has(String(id))) { seen.add(String(id)); out.push(n); }
        Object.values(n).forEach(v=>{ if(v && typeof v==='object') walk(v); });
    }
    walk(data); return out;
}
function normName(v = '') {
    return String(v || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/\breserves?\b/g, ' reserve ')
        .replace(/\bunder[ -]?(20|21|23)\b/g, ' u$1 ')
        .replace(/\bu[ -]?(20|21|23)\b/g, ' u$1 ')
        .replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk|fk|ks|as|deportivo|football|soccer|united|city|team)\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolverTokens(name) {
    return normName(name);
}

function teamSimilarity(a, b) {
    const x = resolverTokens(a), y = resolverTokens(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return .90;
    const A = new Set(x.split(/\s+/).filter(q => q.length >= 2));
    const B = new Set(y.split(/\s+/).filter(q => q.length >= 2));
    if (!A.size || !B.size) return 0;
    let hit = 0; for (const q of A) if (B.has(q)) hit++;
    const dice = 2 * hit / (A.size + B.size);
    const firstA = [...A][0], firstB = [...B][0];
    return Math.min(1, dice + (firstA === firstB ? 0.08 : 0));
}

function pairMatchScore(homeName, awayName, cHome, cAway) {
    const directH = teamSimilarity(homeName, cHome), directA = teamSimilarity(awayName, cAway);
    const revH = teamSimilarity(homeName, cAway), revA = teamSimilarity(awayName, cHome);
    const direct = (directH + directA) / 2, reversed = (revH + revA) / 2;
    const score = Math.max(direct, reversed);
    const weakest = direct >= reversed ? Math.min(directH, directA) : Math.min(revH, revA);
    return { score: weakest < 0.25 ? score * 0.75 : score, reversed: reversed > direct };
}
async function resolveSofaEventIdByName(homeName,awayName,originalId) {
    console.log(`    🔎 [DEEP RESOLVER] ${homeName} vs ${awayName}`);
    const live=await fetchSofaJson(`/tournaments/get-live-events?sport=football`,8000);
    let best=null,bestScore=0;
    for(const ev of extractEventArrayDeep(live)){
        const h=ev.homeTeam?.name??ev.home?.name??ev.homeName??'';
        const a=ev.awayTeam?.name??ev.away?.name??ev.awayName??'';
        const score=Math.max((teamSimilarity(homeName,h)+teamSimilarity(awayName,a))/2,
                             (teamSimilarity(homeName,a)+teamSimilarity(awayName,h))/2);
        if(score>bestScore){bestScore=score;best=ev;}
    }
    if(best && bestScore>=.68){
        const id=String(best.id??best.eventId??best.matchId);
        console.log(`    ✅ [MATCH-BY-NAME] score=${bestScore.toFixed(2)} | ${originalId} -> ${id}`);
        return id;
    }
    console.log(`    ❌ [MATCH-BY-NAME] Không tìm thấy ID đủ tin cậy | best=${bestScore.toFixed(2)}`);
    return null;
}


// ==========================================
// V16 - LIVEFOOTBALL FIELD-BY-FIELD FALLBACK
// SofaScore -> LiveFootball -> Livescore6
// Không dùng football-get-match-detail vì current-live đã resolver eventid,
// còn all-stats trả trực tiếp các chỉ số cần thiết.
// ==========================================
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
    if (!stats) return { totalShots:false, shotsOnTarget:false, corners:false, possession:false, redCards:false };
    return {
        totalShots: stats.totalShots !== undefined && stats.totalShots !== null,
        shotsOnTarget: stats.shotsOnTarget !== undefined && stats.shotsOnTarget !== null,
        corners: stats.corners !== undefined && stats.corners !== null,
        possession: stats.possession !== undefined && stats.possession !== null,
        redCards: stats.redCards !== undefined && stats.redCards !== null
    };
}
function mergeMissingStats(baseStats, basePresent, incomingStats, incomingPresent) {
    const out = { ...(baseStats || {}) };
    const present = { ...(basePresent || {}) };
    const filled = [];
    const cumulative = new Set(['totalShots','shotsOnTarget','corners','redCards']);
    for (const key of ['totalShots','shotsOnTarget','corners','possession','redCards']) {
        if (!incomingPresent?.[key]) continue;
        if (!present[key]) {
            out[key] = incomingStats[key];
            present[key] = true;
            filled.push(key);
            continue;
        }
        // V17.0.3: field đã có không bị tụt ở vòng/source sau.
        // Các chỉ số tích lũy chỉ tăng; possession lấy snapshot mới nhất hợp lệ.
        if (cumulative.has(key)) {
            const oldV = Number(out[key]);
            const newV = Number(incomingStats[key]);
            if (Number.isFinite(newV) && (!Number.isFinite(oldV) || newV > oldV)) out[key] = incomingStats[key];
        } else if (key === 'possession' && incomingStats[key] !== undefined && incomingStats[key] !== null && incomingStats[key] !== '') {
            out[key] = incomingStats[key];
        }
    }
    return { stats: out, present, filled };
}
function extractLiveFootballCandidates(data) {
    const out=[], seen=new Set();
    function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        const id = n.eventid ?? n.eventId ?? n.matchId ?? n.id;
        const home = n.homeTeam?.name ?? n.home?.name ?? n.homeName ?? n.team1?.name ?? n.team1 ?? n.home_team ?? '';
        const away = n.awayTeam?.name ?? n.away?.name ?? n.awayName ?? n.team2?.name ?? n.team2 ?? n.away_team ?? '';
        if (id && home && away && !seen.has(String(id))) {
            seen.add(String(id)); out.push({ id:String(id), home:String(home), away:String(away), raw:n });
        }
        Object.values(n).forEach(v=>{ if(v && typeof v==='object') walk(v); });
    }
    walk(data); return out;
}
async function resolveLiveFootballMatchByName(homeName, awayName) {
    console.log(`    🔄 [LIVEFOOTBALL] Tìm trận: ${homeName} vs ${awayName}`);
    const cachedEvent = getCachedLiveFootballEvent(homeName, awayName);
    if (cachedEvent) return cachedEvent;
    try {
        let liveList;
        const now=Date.now();
        if (resolverLiveCache.livefootball.data && now-resolverLiveCache.livefootball.ts < RESOLVER_CACHE_MS) {
            liveList=resolverLiveCache.livefootball.data;
            console.log(`    ♻️ [LIVEFOOTBALL CACHE] live=${liveList.length}`);
        } else {
            const response = await axios.get(`https://${LIVEFOOTBALL_HOST}${LIVEFOOTBALL_LIVE_PATH}`, {
                headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVEFOOTBALL_HOST }, timeout: 7000
            });
            liveList = Array.isArray(response.data?.response?.live) ? response.data.response.live : [];
            resolverLiveCache.livefootball={ts:now,data:liveList};
            console.log(`    📥 [LIVEFOOTBALL LIST] live=${liveList.length}`);
        }
        if (liveList.length === 0) { console.log(`    ↪️ [LIVEFOOTBALL] response.live=[] -> chuyển Livescore6`); return null; }
        const candidates=extractLiveFootballCandidates(liveList);
        console.log(`    🔎 [LIVEFOOTBALL CANDIDATES] parsed=${candidates.length}/${liveList.length}`);
        if (!candidates.length) return null;
        let best=null,bestScore=0,bestReversed=false;
        for(const c of candidates){
            const m=pairMatchScore(homeName,awayName,c.home,c.away);
            if(m.score>bestScore){bestScore=m.score;best=c;bestReversed=m.reversed;}
        }
        if(best) console.log(`    🧭 [LIVEFOOTBALL BEST] ${best.home} vs ${best.away} | score=${bestScore.toFixed(2)}${bestReversed?' | reversed':''}`);
        if(best && bestScore>=0.62){
            console.log(`    ✅ [LIVEFOOTBALL MATCH] score=${bestScore.toFixed(2)} | eventid=${best.id}`);
            cacheLiveFootballEvent(homeName, awayName, best);
            return best;
        }
        console.log(`    ❌ [LIVEFOOTBALL MATCH] Không tìm thấy trận đủ tin cậy | best=${bestScore.toFixed(2)}`);
        return null;
    } catch(err) { console.log(`    ⚠️ [LIVEFOOTBALL LIVE ERROR] ${err.message}`); return null; }
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
            const h=numericStatValue(a[0]), w=numericStatValue(a[1]);
            if(h!==null && w!==null) return [h,w];
        }
    }
    const pairs = [
        [n.home,n.away],[n.homeValue,n.awayValue],[n.home_value,n.away_value],
        [n.H,n.A],[n.Value1,n.Value2],[n.V1,n.V2],[n.homeStat,n.awayStat]
    ];
    for(const [a,b] of pairs){ const h=numericStatValue(a), w=numericStatValue(b); if(h!==null&&w!==null)return [h,w]; }
    return null;
}
function classifyStatKey(raw) {
    const k=normalizeStatKey(raw);
    if (!k) return null;
    if (/shots? on target|shots? on goal|on target shots?|target shots?|shotontarget/.test(k)) return 'shotsOnTarget';
    if (/total shots?|shots? total|goal attempts?|attempts total|total attempts?/.test(k)) return 'totalShots';
    if (/corner kicks?|corners?/.test(k)) return 'corners';
    if (/red cards?|sending off/.test(k)) return 'redCards';
    if (/ball possession|possession|ballposs/.test(k)) return 'possession';
    return null;
}
function extractLiveFootballStatistics(data) {
    const stats={ totalShots:null, shotsOnTarget:null, corners:null, redCards:null, possession:null };
    const present={ totalShots:false, shotsOnTarget:false, corners:false, redCards:false, possession:false };
    const advancedStats={ xg:0, bigChances:0, shotsInsideBox:0, touchesOppBox:0 };
    function walk(n){
        if(!n || typeof n!=='object') return;
        if(Array.isArray(n)){ n.forEach(walk); return; }
        const rawKey=n.key ?? n.name ?? n.type ?? n.title ?? n.Nm ?? n.StatName ?? n.statName ?? n.label ?? '';
        const key=normalizeStatKey(rawKey);
        const pair=readStatPair(n);
        if(pair){
            const [a,b]=pair, sum=a+b, cls=classifyStatKey(rawKey);
            if(cls==='totalShots'){ stats.totalShots=Math.max(stats.totalShots??0,sum); present.totalShots=true; }
            else if(cls==='shotsOnTarget'){ stats.shotsOnTarget=Math.max(stats.shotsOnTarget??0,sum); present.shotsOnTarget=true; }
            else if(cls==='corners'){ stats.corners=Math.max(stats.corners??0,sum); present.corners=true; }
            else if(cls==='redCards'){ stats.redCards=Math.max(stats.redCards??0,sum); present.redCards=true; }
            else if(cls==='possession'){ stats.possession=`${a}% - ${b}%`; present.possession=true; }
            if(/expected goals|expected_goals|\bxg\b/.test(key)) advancedStats.xg=Math.max(advancedStats.xg,sum);
            else if(/big chance/.test(key)) advancedStats.bigChances=Math.max(advancedStats.bigChances,sum);
            else if(/shots? inside.*box/.test(key)) advancedStats.shotsInsideBox=Math.max(advancedStats.shotsInsideBox,sum);
            else if(/touches?.*(opp|opposition).*box/.test(key)) advancedStats.touchesOppBox=Math.max(advancedStats.touchesOppBox,sum);
        }
        Object.values(n).forEach(v=>{if(v&&typeof v==='object')walk(v)});
    }
    walk(data);
    return { foundItems:Object.values(present).filter(Boolean).length, sofaStats:stats, present, advancedStats };
}
async function fetchLiveFootballPartialStats(homeName,awayName){
    const match=await resolveLiveFootballMatchByName(homeName,awayName);
    if(!match)return null;
    try{
        const response=await axios.get(`https://${LIVEFOOTBALL_HOST}${LIVEFOOTBALL_STATS_PATH}?eventid=${encodeURIComponent(match.id)}`,{
            headers:{'x-rapidapi-key':PAID_RAPIDAPI_KEY.trim(),'x-rapidapi-host':LIVEFOOTBALL_HOST},timeout:7000
        });
        const parsed=extractLiveFootballStatistics(response.data);
        console.log(parsed.foundItems>0 ? `    🛟 [LIVEFOOTBALL STATS OK] eventid=${match.id} | fields=${parsed.foundItems}` : `    ⚠️ [LIVEFOOTBALL STATS EMPTY] eventid=${match.id}`);
        return parsed.foundItems>0 ? {...parsed,statsSource:'livefootball',crossSourceMatchId:match.id} : null;
    }catch(err){console.log(`    ⚠️ [LIVEFOOTBALL STATS ERROR] ${err.message}`);return null;}
}

function extractLivescoreMatchCandidates(data) {
    const out = [], seen = new Set();
    function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }

        const id = String(obj.Eid || obj.id || obj.MatchId || obj.matchId || '');
        const home = String(
            (obj.T1 && obj.T1[0] && (obj.T1[0].Nm || obj.T1[0].Name)) ||
            obj.homeTeam?.name || obj.Home?.Nm || obj.Home?.Name || obj.homeName || obj.T1Name || ''
        ).trim();
        const away = String(
            (obj.T2 && obj.T2[0] && (obj.T2[0].Nm || obj.T2[0].Name)) ||
            obj.awayTeam?.name || obj.Away?.Nm || obj.Away?.Name || obj.awayName || obj.T2Name || ''
        ).trim();

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
    console.log(`    🔄 [CROSS-SOURCE] Tìm trận trên Livescore6: ${homeName} vs ${awayName}`);
    const currentVN = getVietnamTime();
    const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
    const dateUrl = `https://${LIVESCORE_HOST}/matches/v2/list-by-date?Category=soccer&Date=${currentVN.dateStr}&Timezone=-7`;
    const headers = { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST };
    let liveData=null,dateData=null;
    const now=Date.now();
    if (resolverLiveCache.livescore6.live && now-resolverLiveCache.livescore6.ts < RESOLVER_CACHE_MS) {
        liveData=resolverLiveCache.livescore6.live; dateData=resolverLiveCache.livescore6.date;
        console.log(`    ♻️ [LIVESCORE6 CACHE] dùng live/date list đã tải`);
    } else {
        const [liveRes, dateRes] = await Promise.all([
            axios.get(liveUrl, { headers, timeout: 7000 }).catch(() => ({ data: null })),
            axios.get(dateUrl, { headers, timeout: 7000 }).catch(() => ({ data: null }))
        ]);
        liveData=liveRes.data; dateData=dateRes.data;
        resolverLiveCache.livescore6={ts:now,live:liveData,date:dateData};
    }
    const rawCandidates=[...extractLivescoreMatchCandidates(liveData),...extractLivescoreMatchCandidates(dateData)];
    const unique=[], seen=new Set();
    for(const c of rawCandidates){ if(!seen.has(c.id)){seen.add(c.id);unique.push(c);} }
    console.log(`    🔎 [LIVESCORE6 CANDIDATES] unique=${unique.length}`);
    let best=null,bestScore=0,bestReversed=false;
    for (const c of unique) {
        const m=pairMatchScore(homeName,awayName,c.home,c.away);
        if(m.score>bestScore){bestScore=m.score;best=c;bestReversed=m.reversed;}
    }
    if(best) console.log(`    🧭 [LIVESCORE6 BEST] ${best.home} vs ${best.away} | score=${bestScore.toFixed(2)}${bestReversed?' | reversed':''}`);
    if (best && bestScore >= 0.62) {
        console.log(`    ✅ [CROSS-SOURCE MATCH] score=${bestScore.toFixed(2)} | Livescore Eid=${best.id}`);
        return best;
    }
    console.log(`    ❌ [CROSS-SOURCE MATCH] Không tìm thấy trận đủ tin cậy | best=${bestScore.toFixed(2)}`);
    return null;
}

function extractLivescoreStatistics(data) {
    const stats = { shotsOnTarget:null, totalShots:null, corners:null, redCards:null, possession:null };
    const present = { shotsOnTarget:false, totalShots:false, corners:false, redCards:false, possession:false };
    const advancedStats = { xg:0, bigChances:0, shotsInsideBox:0, touchesOppBox:0 };
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const rawName=node.name ?? node.type ?? node.title ?? node.Nm ?? node.StatName ?? node.statName ?? node.key ?? node.label ?? '';
        const pair=readStatPair(node);
        if(pair){
            const [hv,av]=pair, sum=hv+av, cls=classifyStatKey(rawName);
            if(cls==='shotsOnTarget'){stats.shotsOnTarget=Math.max(stats.shotsOnTarget??0,sum);present.shotsOnTarget=true;}
            else if(cls==='totalShots'){stats.totalShots=Math.max(stats.totalShots??0,sum);present.totalShots=true;}
            else if(cls==='corners'){stats.corners=Math.max(stats.corners??0,sum);present.corners=true;}
            else if(cls==='redCards'){stats.redCards=Math.max(stats.redCards??0,sum);present.redCards=true;}
            else if(cls==='possession'){stats.possession=`${hv}% - ${av}%`;present.possession=true;}
            const name=normalizeStatKey(rawName);
            if(/expected goals|\bxg\b/.test(name))advancedStats.xg=Math.max(advancedStats.xg,sum);
            else if(/big chance/.test(name))advancedStats.bigChances=Math.max(advancedStats.bigChances,sum);
            else if(/shots? inside.*box/.test(name))advancedStats.shotsInsideBox=Math.max(advancedStats.shotsInsideBox,sum);
            else if(/touches?.*(opp|opposition).*box/.test(name))advancedStats.touchesOppBox=Math.max(advancedStats.touchesOppBox,sum);
        }
        Object.values(node).forEach(v=>{if(v&&typeof v==='object')walk(v);});
    }
    walk(data);
    return {foundItems:Object.values(present).filter(Boolean).length,sofaStats:stats,present,advancedStats};
}
async function fetchLivescoreScoreboard(eid) {
    try {
        const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-scoreboard?Eid=${encodeURIComponent(eid)}&Category=soccer`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST },
            timeout: 6500
        });
        const ok = !!response.data && (typeof response.data !== 'object' || Object.keys(response.data).length > 0);
        console.log(`    ${ok ? '✅' : '⚠️'} [LIVESCORE6 SCOREBOARD] Eid=${eid} | ${ok ? 'response OK' : 'response rỗng'}`);
        return response.data || null;
    } catch (err) {
        console.log(`    ⚠️ [LIVESCORE6 SCOREBOARD ERROR] Eid=${eid} | ${err.message}`);
        return null;
    }
}

function auditFieldList(parsed) {
    const p = parsed?.present || {};
    const names = {totalShots:'Shots',shotsOnTarget:'SOT',corners:'Corners',possession:'Poss',redCards:'Red'};
    return Object.keys(names).map(k => `${names[k]}:${p[k] ? '✓' : '✗'}`).join(' ');
}

async function fetchCrossSourcePartialStats(homeName, awayName) {
    try {
        const match = await resolveLivescoreMatchByName(homeName, awayName);
        if (!match) return null;

        // V17.4.9: xác minh Eid bằng Scoreboard trước khi đọc Statistics.
        // Scoreboard chỉ hỗ trợ resolver/phút/tỷ số; KHÔNG dùng thay Statistics.
        await fetchLivescoreScoreboard(match.id);

        const url = `https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${encodeURIComponent(match.id)}`;
        const response = await axios.get(url, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': LIVESCORE_HOST
            },
            timeout: 7000
        }).catch(() => ({ data: null }));

        const parsed = extractLivescoreStatistics(response.data);
        if (parsed.foundItems > 0) {
            console.log(`    🛟 [PARTIAL STATS OK] Livescore6 Eid=${match.id} | fields=${parsed.foundItems} | ${auditFieldList(parsed)}`);
            return {
                ...parsed,
                statsAvailable: true,
                partialStats: true,
                statsSource: 'livescore6',
                crossSourceMatchId: match.id
            };
        }

        console.log(`    ⚠️ [PARTIAL STATS EMPTY] Livescore6 Eid=${match.id} | Statistics rỗng | ${auditFieldList(parsed)}`);
        return null;
    } catch (err) {
        console.log(`    ⚠️ [CROSS-SOURCE ERROR] ${err.message}`);
        return null;
    }
}

async function fetchMatchDetailStats(matchId, source, homeName = '', awayName = '') {
    // V17.4.9: 3 nguồn bổ sung lẫn nhau + SOURCE AUDIT + Livescore6 Scoreboard resolver.
    // Mọi nguồn quy về pipeline field-by-field: SofaScore -> LiveFootball -> Livescore6.
    // Nếu Sofa không resolve được ID, LiveFootball + Livescore6 vẫn tiếp tục bù field thiếu.
    if (source !== 'sofascore') {
        console.log(`    🔄 [3-WAY STATS] discovery=${source} -> hợp nhất SofaScore + LiveFootball + Livescore6`);
        let sofaId = null;
        if (homeName && awayName) {
            try { sofaId = await resolveSofaEventIdByName(homeName, awayName, matchId); } catch (_) {}
        }
        return fetchMatchDetailStats(sofaId || matchId, 'sofascore', homeName, awayName);
    }
    if (source === 'sofascore') {
        const missingCacheKey = `${String(homeName).toLowerCase()}|${String(awayName).toLowerCase()}`;
        const missingUntil = dataMissingRetryCache.get(missingCacheKey) || 0;
        const earlyPersistent = getPersistentStats(statsCacheKey(matchId, homeName, awayName));
        if (Date.now() < missingUntil && !earlyPersistent) {
            return {
                foundItems: 0,
                sofaStats: { totalShots:null, shotsOnTarget:null, corners:null, possession:null, redCards:null },
                present: { totalShots:false, shotsOnTarget:false, corners:false, possession:false, redCards:false },
                statsAvailable: false, partialStats: false, statsSource: 'retry-cache',
                resolvedMatchId: String(matchId), crossSourceMatchId: null, graphData: null, graphAvailable: false
            };
        }
        const primary = await fetchSofaJson(`/matches/get-statistics?matchId=${encodeURIComponent(matchId)}`);
        let parsed = extractSofaStatistics(primary);

        if (parsed.foundItems > 0) {
            console.log(`    ├─ [STAT OK] matches/get-statistics | fields=${parsed.foundItems}`);
        } else {
            console.log(`    ├─ [STAT EMPTY] matches/get-statistics -> thử events/get-statistics`);
            const legacy = await fetchSofaJson(`/events/get-statistics?eventId=${encodeURIComponent(matchId)}`);
            parsed = extractSofaStatistics(legacy);
            console.log(parsed.foundItems > 0
                ? `    ├─ [STAT OK] events/get-statistics | fields=${parsed.foundItems}`
                : `    ├─ [STAT EMPTY] cả 2 endpoint statistics`);
        }

        let effectiveMatchId = String(matchId);
        console.log(`    📡 [SOURCE AUDIT] SofaScore | MATCH=${matchId ? 'YES' : 'NO'} | fields=${parsed.foundItems}/5 | ${auditFieldList(parsed)}`);

        // V14: nếu ID hiện tại không trả stats, tìm lại event ID theo tên 2 đội.
        if (parsed.foundItems === 0 && homeName && awayName) {
            console.log(`    🛟 [FALLBACK] Kích hoạt MATCH-BY-NAME vì statistics rỗng`);
            const resolvedId = await resolveSofaEventIdByName(homeName, awayName, matchId);
            if (resolvedId && resolvedId !== String(matchId)) {
                effectiveMatchId = resolvedId;
                let retry = await fetchSofaJson(`/matches/get-statistics?matchId=${encodeURIComponent(effectiveMatchId)}`);
                parsed = extractSofaStatistics(retry);
                if (parsed.foundItems === 0) {
                    retry = await fetchSofaJson(`/events/get-statistics?eventId=${encodeURIComponent(effectiveMatchId)}`);
                    parsed = extractSofaStatistics(retry);
                }
                console.log(parsed.foundItems > 0
                    ? `    ✅ [DEEP STAT OK] ID=${effectiveMatchId} | fields=${parsed.foundItems}`
                    : `    ⚠️ [DEEP STAT EMPTY] ID=${effectiveMatchId}`);
            }
        }

        // V16: FIELD-BY-FIELD fallback. Giữ mọi field Sofa đã có; chỉ bù field thiếu.
        // Thứ tự: SofaScore -> LiveFootball -> Livescore6. Missing != 0.
        let crossSourcePartial = null;
        let sourceTrail = ['sofascore'];
        // V16.5: presence lấy trực tiếp từ raw response mà parser thực sự đã dùng.
        // Không suy diễn từ các giá trị 0 mặc định => 0 thật vẫn hợp lệ, missing vẫn là missing.
        let sofaPresent = parsed.foundItems > 0 ? statPresenceFromParsed(parsed) :
            { totalShots:false, shotsOnTarget:false, corners:false, possession:false, redCards:false };

        // V16.8: phục hồi các field thật đã lấy được ở vòng trước trước khi gọi fallback API.
        const pCacheKey = statsCacheKey(matchId, homeName, awayName);
        const cachedStats = getPersistentStats(pCacheKey);
        if (cachedStats) {
            const restored = mergeMissingStats(parsed.sofaStats, sofaPresent, cachedStats.stats, cachedStats.present);
            parsed.sofaStats = restored.stats; sofaPresent = restored.present;
            if (restored.filled.length) sourceTrail.push('persistent-cache');
            parsed.advancedStats = { ...(cachedStats.advancedStats || {}), ...(parsed.advancedStats || {}) };
        }

        const needMore = () => Object.values(sofaPresent).some(v => !v);
        if (homeName && awayName && needMore()) {
            const lf = await fetchLiveFootballPartialStats(homeName, awayName);
            console.log(`    📡 [SOURCE AUDIT] LiveFootball | MATCH=${lf?.crossSourceMatchId ? 'YES' : 'NO'} | fields=${lf?.foundItems || 0}/5 | ${auditFieldList(lf)}`);
            if (lf?.foundItems > 0) {
                const merged = mergeMissingStats(parsed.sofaStats, sofaPresent, lf.sofaStats, lf.present);
                parsed.sofaStats = merged.stats; sofaPresent = merged.present;
                if (merged.filled.length) {
                    sourceTrail.push('livefootball');
                    console.log(`    🔗 [MERGE] LiveFootball bù: ${merged.filled.join(', ')}`);
                    crossSourcePartial = lf;
                }
                parsed.advancedStats = parsed.advancedStats || {xg:0,bigChances:0,shotsInsideBox:0,touchesOppBox:0};
                for (const k of ['xg','bigChances','shotsInsideBox','touchesOppBox']) {
                    if (!(Number(parsed.advancedStats[k]) > 0) && Number(lf.advancedStats?.[k]) > 0) parsed.advancedStats[k] = Number(lf.advancedStats[k]);
                }
            }
        }
        if (homeName && awayName && needMore()) {
            const ls = await fetchCrossSourcePartialStats(homeName, awayName);
            console.log(`    📡 [SOURCE AUDIT] Livescore6 | MATCH=${ls?.crossSourceMatchId ? 'YES' : 'NO'} | fields=${ls?.foundItems || 0}/5 | ${auditFieldList(ls)}`);
            if (ls?.foundItems > 0) {
                const lsPresent = ls.present || inferStatPresenceFromObject(ls.sofaStats);
                const merged = mergeMissingStats(parsed.sofaStats, sofaPresent, ls.sofaStats, lsPresent);
                parsed.sofaStats = merged.stats; sofaPresent = merged.present;
                if (merged.filled.length) {
                    sourceTrail.push('livescore6');
                    console.log(`    🔗 [MERGE] Livescore6 bù: ${merged.filled.join(', ')}`);
                    crossSourcePartial = {...ls, crossSourceMatchId: ls.crossSourceMatchId};
                }
            }
        }
        parsed.foundItems = Object.values(sofaPresent).filter(Boolean).length;
        // V16.8: cache chỉ dữ liệu thật/present; vòng sau chỉ có thể giữ hoặc tăng độ đầy đủ, không tụt 4/5 -> 0/5.
        if (parsed.foundItems > 0) savePersistentStats(pCacheKey, parsed.sofaStats, sofaPresent, parsed.advancedStats, sourceTrail);
        const completeness = ['totalShots','shotsOnTarget','corners','possession','redCards']
            .map(k => `${k}=${sofaPresent[k] ? '✓' : '✗'}`).join(' | ');
        // V16.6: khi đủ 5/5 thì im lặng; chỉ log đúng field còn thiếu.
        const missingLabels = {
            totalShots: 'Total Shots',
            shotsOnTarget: 'Shots on Target',
            corners: 'Corners',
            possession: 'Possession',
            redCards: 'Red Cards'
        };
        const missingFields = Object.keys(missingLabels).filter(k => !sofaPresent[k]);
        console.log(`    🧩 [SOURCE AUDIT MERGED] ${homeName} vs ${awayName} | ${parsed.foundItems}/5 | ${auditFieldList({present:sofaPresent})} | nguồn=${sourceTrail.join('>')}`);
        if (missingFields.length > 0 && parsed.foundItems > 0) {
            console.log(`    ⚠️ [THIẾU CHỈ SỐ] ${homeName} vs ${awayName} | thiếu ${missingFields.length}/5: ${missingFields.map(k => missingLabels[k]).join(', ')} | có ${parsed.foundItems}/5 | nguồn=${sourceTrail.join('>')}`);
        }

        // V16.7: chỉ cache khi cả 3 nguồn vẫn 0/5; có bất kỳ field thật nào thì xóa cache ngay.
        if (parsed.foundItems === 0) dataMissingRetryCache.set(missingCacheKey, Date.now() + DATA_MISSING_RETRY_MS);
        else dataMissingRetryCache.delete(missingCacheKey);

        // Graph dùng ID Sofa đã resolve nếu có.
        // Nếu 0/5 thì bỏ Graph luôn để tiết kiệm API vì không có dữ liệu để chấm Rule.
        if (parsed.foundItems === 0) {
            return {
                ...parsed, statsAvailable:false, partialStats:false, statsSource:sourceTrail.join(' -> '),
                resolvedMatchId:effectiveMatchId, crossSourceMatchId:null, graphData:null, graphAvailable:false
            };
        }
        const graph = await fetchSofaJson(`/matches/get-graph?matchId=${encodeURIComponent(effectiveMatchId)}`);
        const graphArray =
            (Array.isArray(graph) && graph) ||
            graph?.graphPoints ||
            graph?.points ||
            graph?.graph ||
            graph?.data ||
            [];
        const graphCount = Array.isArray(graphArray) ? graphArray.length : 0;
        console.log(graphCount > 0
            ? `    └─ [GRAPH OK] ${graphCount} điểm graph/momentum`
            : `    └─ [GRAPH EMPTY] Không có graph/momentum`);

        return {
            ...parsed,
            statsAvailable: parsed.foundItems > 0,
            partialStats: sourceTrail.length > 1,
            statsSource: sourceTrail.join(' -> '),
            resolvedMatchId: effectiveMatchId,
            crossSourceMatchId: crossSourcePartial?.crossSourceMatchId || null,
            graphData: graphCount > 0 ? graphArray : null,
            graphAvailable: graphCount > 0
        };
    } else {
        try {
            const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${matchId}`, {
                headers: {
                    'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                    'x-rapidapi-host': LIVESCORE_HOST
                },
                timeout: 6000
            });

            let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0;
            let possessionHome = null, possessionAway = null;
            
            const statsData = response.data;
            let statList = [];

            if (Array.isArray(statsData)) {
                statList = statsData;
            } else if (statsData?.statistics) {
                statList = statsData.statistics;
            } else if (statsData?.stats) {
                statList = statsData.stats;
            }

            statList.forEach(st => {
                const name = String(st.name || st.type || st.title || '').toLowerCase();
                const homeVal = parseInt(st.home || st.homeValue, 10);
                const awayVal = parseInt(st.away || st.awayValue, 10);
                const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

                if (name.includes('shot on target') || name.includes('sút trúng đích')) {
                    shotsOnTarget = Math.max(shotsOnTarget, sumVal);
                } else if (name.includes('total shot') || name.includes('tổng cú sút')) {
                    totalShots = Math.max(totalShots, sumVal);
                } else if (name.includes('corner') || name.includes('phạt góc')) {
                    corners = Math.max(corners, sumVal);
                } else if (name.includes('red card') || name.includes('thẻ đỏ')) {
                    redCards = Math.max(redCards, sumVal);
                } else if (name.includes('possession') || name.includes('kiểm soát')) {
                    if (!isNaN(homeVal) && !isNaN(awayVal)) {
                        possessionHome = homeVal;
                        possessionAway = awayVal;
                    }
                }
            });

            let possessionStr = null;
            if (possessionHome !== null && possessionAway !== null) {
                possessionStr = `${possessionHome}% - ${possessionAway}%`;
            }

            return {
                sofaStats: { 
                    shotsOnTarget, 
                    totalShots: totalShots || shotsOnTarget, 
                    corners, 
                    redCards,
                    possession: possessionStr
                }
            };
        } catch (err) {
            return {
                sofaStats: { shotsOnTarget: 0, totalShots: 0, corners: 0, redCards: 0, possession: null }
            };
        }
    }
}

function cleanTeamName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk)\b/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

function analyzeOddsGoalProbability(allOdds, homeName, awayName, currentTotalGoals) {
    if (!Array.isArray(allOdds) || allOdds.length === 0) return null;

    const hClean = cleanTeamName(homeName);
    const aClean = cleanTeamName(awayName);

    const foundMatch = allOdds.find(m => {
        const mHome = cleanTeamName(m.home_team);
        const mAway = cleanTeamName(m.away_team);
        return (mHome.includes(hClean) || hClean.includes(mHome)) && (mAway.includes(aClean) || aClean.includes(mAway));
    });

    if (!foundMatch || !foundMatch.bookmakers?.[0]) return null;
    const totalsMarket = foundMatch.bookmakers[0].markets?.find(mk => mk.key === 'totals');
    const overOutcome = totalsMarket?.outcomes?.find(o => o.name === 'Over');
    if (!overOutcome) return null;

    let oddsBonus = 0;
    let oddsNotes = [];
    const overLine = overOutcome.point;
    const price = overOutcome.price;
    if (price <= 1.40) {
        oddsBonus += 0;
        oddsNotes.push(`Odds Over cực thấp (${price}) - Dòng tiền kết tài mạnh`);
    } else if (price <= 1.60) {
        oddsBonus += 0;
        oddsNotes.push(`Odds Over giảm sâu (${price})`);
    } else if (price <= 1.85) {
        oddsBonus += 0;
        oddsNotes.push(`Odds Over ổn định (${price})`);
    } else {
        oddsBonus += 0;
        oddsNotes.push(`Odds Over (${price})`);
    }

    return {
        bookmaker: foundMatch.bookmakers[0].title,
        line: overLine,
        odds: price,
        oddsBonus,
        oddsNoteText: oddsNotes.join(' | ')
    };
}

// ==========================================
// 8. THUẬT TOÁN AI
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis, elapsedMinute, momentumContext = null, homeScore = 0, awayScore = 0) {
    let matchAnalysis = [];
    let aiPercentage = 15.0; // V17.4: Base 15%.
    const stats = metrics.sofaStats || {};
    const minute = Math.max(1, Number(elapsedMinute) || 1);
    let hasTacticalData = false;

    if (metrics.partialStats) {
        matchAnalysis.push(`🛟 PARTIAL DATA: ${metrics.statsSource || 'cross-source'}; chỉ tính field thực sự có dữ liệu`);
    }

    const totalShots = Math.max(0, Number(stats.totalShots) || 0);
    const shotsOnTarget = Math.max(0, Number(stats.shotsOnTarget) || 0);
    const corners = Math.max(0, Number(stats.corners) || 0);
    const redCards = Math.max(0, Number(stats.redCards) || 0);

    // V17.4 - TOTAL SHOTS + EFFECTIVE SOT đi kèm nhau.
    // Total Shots vẫn đo cường độ tấn công theo phút thực tế.
    // SOT không còn cộng cố định 50%; chất lượng SOT phụ thuộc SOT/Total Shots.
    const shotsRate = (totalShots / minute) * 100;
    // V17.4.3: Total Shots lấy 80% trọng số để cân bằng độ nhạy và giảm bỏ lỡ trận.
    // Effective SOT bên dưới giữ nguyên và đi kèm Total Shots để phản ánh chất lượng ép sân.
    const weightedShotsRate = shotsRate * 0.80;
    const sotRateRaw = (shotsOnTarget / minute) * 100;
    const sotShotRatio = totalShots > 0 ? shotsOnTarget / totalShots : null;

    let effectiveSotMultiplier = 0;
    if (shotsOnTarget > 0) {
        if (sotShotRatio === null) effectiveSotMultiplier = 1.0; // partial stats: có SOT nhưng thiếu Total Shots
        else if (sotShotRatio < 0.15) effectiveSotMultiplier = 0.5;
        else if (sotShotRatio < 0.25) effectiveSotMultiplier = 0.8;
        else if (sotShotRatio < 0.35) effectiveSotMultiplier = 1.0;
        else if (sotShotRatio < 0.45) effectiveSotMultiplier = 1.3;
        else effectiveSotMultiplier = 1.5;
    }
    const effectiveSot = sotRateRaw * effectiveSotMultiplier;
    const cornerRate = (corners / minute) * 100;

    if (totalShots > 0) {
        aiPercentage += weightedShotsRate;
        matchAnalysis.push(`🔥 Tổng sút: ${shotsRate.toFixed(2)} × 80% = +${weightedShotsRate.toFixed(2)}%`);
        hasTacticalData = true;
    }
    if (shotsOnTarget > 0) {
        aiPercentage += effectiveSot;
        const ratioText = sotShotRatio === null ? 'N/A' : `${(sotShotRatio * 100).toFixed(1)}%`;
        matchAnalysis.push(`🎯 Effective SOT: +${effectiveSot.toFixed(2)}% | SOT/Shots ${ratioText} | x${effectiveSotMultiplier.toFixed(1)}`);
        hasTacticalData = true;
    }
    if (corners > 0) {
        aiPercentage += cornerRate;
        matchAnalysis.push(`🚩 Góc: +${cornerRate.toFixed(2)}%`);
        hasTacticalData = true;
    }

    // Possession chỉ được cộng mạnh khi có bằng chứng dứt điểm tốt.
    let possessionAdjustment = 0;
    let maxPoss = 50;
    if (stats.possession) {
        const possParts = String(stats.possession).split('-');
        if (possParts.length === 2) {
            const homePoss = parseInt(possParts[0], 10) || 50;
            const awayPoss = parseInt(possParts[1], 10) || 50;
            maxPoss = Math.max(homePoss, awayPoss);
            const qualityAttack = shotsOnTarget >= 3 || (sotShotRatio !== null && sotShotRatio >= 0.25);
            if (maxPoss >= 70) possessionAdjustment = qualityAttack ? 8 : 1;
            else if (maxPoss >= 60) possessionAdjustment = qualityAttack ? 5 : 1;
            if (possessionAdjustment) {
                aiPercentage += possessionAdjustment;
                matchAnalysis.push(`📊 Possession ${maxPoss}%: +${possessionAdjustment}%`);
                hasTacticalData = true;
            }
        }
    }

    // Sterile pressure: sút/góc/cầm bóng nhiều nhưng rất ít SOT.
    let sterilePenalty = 0;
    if (totalShots >= 12 && shotsOnTarget <= 2) sterilePenalty -= 8;
    else if (totalShots >= 9 && shotsOnTarget <= 1) sterilePenalty -= 6;
    if (maxPoss >= 65 && totalShots >= 8 && shotsOnTarget <= 1) sterilePenalty -= 4;
    if (corners >= 7 && shotsOnTarget <= 2) sterilePenalty -= 3;
    if (sterilePenalty < 0) {
        aiPercentage += sterilePenalty;
        matchAnalysis.push(`🧊 Sterile Pressure: ${sterilePenalty}%`);
    }

    // Recent momentum 5-10 phút: có thì cộng/trừ Rule; KHÔNG còn là gate bắt buộc.
    let momentumAdjustment = 0;
    if (momentumContext && Number(momentumContext.deltaMinute) > 0 && Number(momentumContext.deltaMinute) <= 10) {
        const d = momentumContext.deltas || {};
        if ((d.sot || 0) >= 2) momentumAdjustment += 8;
        else if ((d.sot || 0) >= 1) momentumAdjustment += 4;
        if ((d.shots || 0) >= 4) momentumAdjustment += (d.sot || 0) > 0 ? 3 : 1;
        if ((d.corners || 0) >= 2) momentumAdjustment += (d.sot || 0) > 0 ? 2 : 1;
        if ((d.sot || 0) <= 0 && ((d.shots || 0) >= 4 || (d.corners || 0) >= 3)) momentumAdjustment -= 6;
        if (momentumAdjustment !== 0) {
            aiPercentage += momentumAdjustment;
            matchAnalysis.push(`⚡ Recent Momentum: ${momentumAdjustment > 0 ? '+' : ''}${momentumAdjustment}%`);
        }
    }

    // V17.5.1: ATTACK SURGE tại 70+ dùng snapshot đã cache từ 46-69 và chỉ xét cửa sổ gần nhất 5-10 phút.
    // Nhờ vậy áp lực tăng mạnh trước phút 70 vẫn được mang vào quyết định tại 70+, nhưng spike quá cũ/ quá ngắn không được thưởng. Cap +12.
    let attackSurgeAdjustment = 0;
    if (minute >= 70 && momentumContext && Number(momentumContext.deltaMinute) >= 5 && Number(momentumContext.deltaMinute) <= 10) {
        const d = momentumContext.deltas || {};
        const dShots = Math.max(0, Number(d.shots || 0));
        const dSot = Math.max(0, Number(d.sot || 0));

        if (dShots >= 4) attackSurgeAdjustment += 3;
        else if (dShots >= 3) attackSurgeAdjustment += 2;
        else if (dShots >= 2) attackSurgeAdjustment += 1;

        if (dSot >= 3) attackSurgeAdjustment += 8;
        else if (dSot >= 2) attackSurgeAdjustment += 5;
        else if (dSot >= 1) attackSurgeAdjustment += 2;

        // Combo Shots + SOT cùng tăng: ưu tiên áp lực có chất lượng.
        if (dShots >= 5 && dSot >= 3) attackSurgeAdjustment += 6;
        else if (dShots >= 4 && dSot >= 2) attackSurgeAdjustment += 4;
        else if (dShots >= 3 && dSot >= 1) attackSurgeAdjustment += 2;

        attackSurgeAdjustment = Math.min(12, attackSurgeAdjustment);
        if (attackSurgeAdjustment > 0) {
            aiPercentage += attackSurgeAdjustment;
            matchAnalysis.push(`🚀 Attack Surge 70+ (${Number(momentumContext.deltaMinute)}m): +${attackSurgeAdjustment}% | ΔShots +${dShots} | ΔSOT +${dSot}`);
            hasTacticalData = true;
        }
    }

    let gameStateAdjustment = 0;
    const totalGoals = (Number(homeScore) || 0) + (Number(awayScore) || 0);
    if (minute >= 70 && minute <= 85 && Number(homeScore) !== Number(awayScore)) gameStateAdjustment += 3;
    if (minute >= 75 && minute <= 87 && Number(homeScore) === Number(awayScore)) gameStateAdjustment += 2;
    if (minute >= 89) gameStateAdjustment -= 5;
    if (totalGoals >= 5) gameStateAdjustment -= 2;
    if (gameStateAdjustment !== 0) {
        aiPercentage += gameStateAdjustment;
        matchAnalysis.push(`⏱️ Game State: ${gameStateAdjustment > 0 ? '+' : ''}${gameStateAdjustment}%`);
    }

    let redCardAdjustment = 0;
    if (redCards > 0) {
        redCardAdjustment = 10;
        aiPercentage += redCardAdjustment;
        matchAnalysis.push(`🟥 Red Card: +${redCardAdjustment}%`);
        hasTacticalData = true;
    }

    if (oddsAnalysis) matchAnalysis.push(`💰 Odds ${oddsAnalysis.odds}: tham khảo, +0 Rule`);

    const finalNumber = Math.max(0, Math.min(aiPercentage, 98.0));
    const finalPercentage = finalNumber.toFixed(1);
    const MIN_SEND_PERCENTAGE = 60.0;

    // V17.4: BỎ HOÀN TOÀN QUALITY GATE. Rule >60 + có tactical data => đủ điều kiện gửi.
    const shouldSend = finalNumber > MIN_SEND_PERCENTAGE && hasTacticalData;

    return {
        efficiency: finalPercentage,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend,
        components: {
            base: 15.0,
            shotsRate: Number(shotsRate.toFixed(2)),
            weightedShotsRate: Number(weightedShotsRate.toFixed(2)),
            sotRateRaw: Number(sotRateRaw.toFixed(2)),
            effectiveSot: Number(effectiveSot.toFixed(2)),
            effectiveSotMultiplier,
            sotShotRatio: sotShotRatio === null ? null : Number((sotShotRatio * 100).toFixed(1)),
            cornerRate: Number(cornerRate.toFixed(2)),
            possessionAdjustment,
            sterilePenalty,
            momentumAdjustment,
            attackSurgeAdjustment,
            gameStateAdjustment,
            redCardAdjustment
        }
    };
}

// ==========================================
// 8B. DỰ ĐOÁN TỶ SỐ FT - CHỈ KÍCH HOẠT KHI RULE >= 58%
// ==========================================
function predictFullTimeScore(metrics, ruleEfficiency, homeScore, awayScore, elapsed) {
    const rule = parseFloat(ruleEfficiency);
    if (!Number.isFinite(rule) || rule < 58) return null;

    const stats = metrics?.sofaStats || {};
    const currentGoals = Number(homeScore || 0) + Number(awayScore || 0);

    let homePressure = 50;
    let awayPressure = 50;

    // Possession là nền sức ép khi có dữ liệu.
    if (stats.possession) {
        const parts = String(stats.possession).match(/(\d+(?:\.\d+)?)\s*%?\s*-\s*(\d+(?:\.\d+)?)\s*%?/);
        if (parts) {
            const h = Number(parts[1]);
            const a = Number(parts[2]);
            if (Number.isFinite(h) && Number.isFinite(a) && h + a > 0) {
                homePressure = (h / (h + a)) * 100;
                awayPressure = 100 - homePressure;
            }
        }
    }

    // Graph/momentum: nếu endpoint có điểm home/away đọc được thì dùng để tinh chỉnh.
    const graph = Array.isArray(metrics?.graphData) ? metrics.graphData : [];
    let graphHome = 0, graphAway = 0, graphSamples = 0;
    graph.slice(-12).forEach(p => {
        if (!p || typeof p !== 'object') return;
        const h = Number(p.home ?? p.homeValue ?? p.homePressure ?? p.homeMomentum);
        const a = Number(p.away ?? p.awayValue ?? p.awayPressure ?? p.awayMomentum);
        if (Number.isFinite(h) && Number.isFinite(a) && (h + a) > 0) {
            graphHome += h;
            graphAway += a;
            graphSamples++;
        }
    });

    if (graphSamples > 0 && graphHome + graphAway > 0) {
        const graphHomePct = (graphHome / (graphHome + graphAway)) * 100;
        // 60% momentum gần nhất + 40% possession/nền.
        homePressure = homePressure * 0.40 + graphHomePct * 0.60;
        awayPressure = 100 - homePressure;
    }

    // Không để hiển thị sức ép cực đoan khi dữ liệu mỏng.
    homePressure = Math.max(20, Math.min(80, homePressure));
    awayPressure = 100 - homePressure;

    // Số bàn còn lại: dựa Rule + thời gian còn lại + sức tấn công hiện tại.
    let expectedGoals = 1;
    const attackScore =
        (Number(stats.shotsOnTarget || 0) >= 6 ? 2 : Number(stats.shotsOnTarget || 0) >= 4 ? 1 : 0) +
        (Number(stats.totalShots || 0) >= 15 ? 2 : Number(stats.totalShots || 0) >= 10 ? 1 : 0) +
        (Number(stats.corners || 0) >= 8 ? 1 : 0);

    if (rule >= 82 && elapsed <= 78 && attackScore >= 4) {
        expectedGoals = 2;
    } else if (rule >= 76 && elapsed <= 72 && attackScore >= 4) {
        expectedGoals = 2;
    }

    // Cuối trận thận trọng hơn.
    if (elapsed >= 86) expectedGoals = 1;

    let ftHome = Number(homeScore || 0);
    let ftAway = Number(awayScore || 0);

    if (expectedGoals === 1) {
        if (homePressure >= awayPressure) ftHome += 1;
        else ftAway += 1;
    } else {
        const diff = Math.abs(homePressure - awayPressure);
        if (diff >= 18) {
            if (homePressure > awayPressure) ftHome += 2;
            else ftAway += 2;
        } else {
            ftHome += 1;
            ftAway += 1;
        }
    }

    let likelyScorer;
    if (Math.abs(homePressure - awayPressure) < 5) {
        likelyScorer = 'Hai đội tương đương';
    } else {
        likelyScorer = homePressure > awayPressure ? 'Chủ nhà' : 'Đội khách';
    }

    let strength = 'TRUNG BÌNH';
    if (rule >= 78 && attackScore >= 4) strength = 'CAO';
    else if (rule < 65 || attackScore <= 1) strength = 'THẤP';

    return {
        ftScore: `${ftHome}-${ftAway}`,
        expectedGoals,
        likelyScorer,
        homePressure: homePressure.toFixed(1),
        awayPressure: awayPressure.toFixed(1),
        strength
    };
}

// ==========================================
// 9. THÔNG BÁO TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const alertHeader = item.alertNumber === 3
        ? `🚨🔥🔥🔥 BIGGGG LẦN 3 🔥🔥🔥🚨`
        : item.alertNumber === 2
            ? `🔥🔥🔥 BIGGGG LẦN 2 🔥🔥🔥`
            : `🔥 TÀI LỘC ĐẾNNNN 🔥`;

    const message =
`${alertHeader}
🏆 ${item.league}
⚔️ ${item.homeName} ${item.homeScore}-${item.awayScore} ${item.awayName}
⏱️ ${item.elapsed}'
⚽ Diễn biến: ${item.goalTimeline}
🎯 Còn khả năng xuất hiện THÊM BÀN THẮNG
📈 Rule: ${item.ruleEfficiency}%${item.ftPrediction ? `
🔮 FT: ${item.ftPrediction.ftScore}
⚽ Còn lại: +${item.ftPrediction.expectedGoals}
🎯 Khả năng ghi bàn: ${item.ftPrediction.likelyScorer}
📊 Sức ép: ${item.ftPrediction.homePressure}%-${item.ftPrediction.awayPressure}%
🔮 Độ mạnh: ${item.ftPrediction.strength}` : ''}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        sentAlerts.add(String(item.id));
        console.log(`    ✅ [ĐÃ GỬI TELEGRAM] [ID: ${item.id}] ${item.homeName} ${item.homeScore}-${item.awayScore} ${item.awayName} | AI ${item.ruleEfficiency}%`);
    } catch (err) {
        console.error('    └─> [Telegram Error]:', err.message);
    }
}

// ==========================================
// 10. TIẾN TRÌNH QUÉT TỰ ĐỘNG
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI Dual-Source] Đang quét trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, liveResult] = await Promise.all([
            fetchOddsData(),
            fetchLiveMatchesDualSource()
        ]);

        const { source, matches } = liveResult;
        if (matches.length === 0) {
            console.log(`[Thông báo]: Không thu thập được trận đấu nào từ SofaScore, LiveFootball và Livescore6.`);
            return;
        }

        for (let index = 0; index < matches.length; index++) {
            const item = matches[index];
            const itemSource = item._scanSource || source;
            
            let matchId, homeName, awayName, homeScore, actualAwayScore;

            if (itemSource === 'sofascore') {
                matchId = String(item.id);
                homeName = item.homeTeam?.name || 'Đội nhà';
                awayName = item.awayTeam?.name || 'Đội khách';
                homeScore = item.homeScore?.current ?? 0;
                actualAwayScore = item.awayScore?.current ?? 0;
            } else if (itemSource === 'livefootball') {
                matchId = String(item.eventid || item.eventId || item.matchId || item.id || `lf_${index}`);
                homeName = item._lfHome || item.homeTeam?.name || item.home?.name || item.homeName || item.team1?.name || item.team1 || item.home_team || 'Đội nhà';
                awayName = item._lfAway || item.awayTeam?.name || item.away?.name || item.awayName || item.team2?.name || item.team2 || item.away_team || 'Đội khách';
                homeScore = parseInt(item.homeScore?.current ?? item.homeScore ?? item.home_score ?? item.score?.home ?? item.scoreHome ?? 0, 10);
                actualAwayScore = parseInt(item.awayScore?.current ?? item.awayScore ?? item.away_score ?? item.score?.away ?? item.scoreAway ?? 0, 10);
            } else {
                matchId = String(item.Eid || item.id || item.matchId || `ls6_${index}`);
                
                homeName = (item.T1 && item.T1[0] && (item.T1[0].Nm || item.T1[0].Name)) || item.homeTeam?.name || 'Đội nhà';
                awayName = (item.T2 && item.T2[0] && (item.T2[0].Nm || item.T2[0].Name)) || item.awayTeam?.name || 'Đội khách';

                homeScore = parseInt(item.Tr1 ?? item.homeScore ?? item.fs_h ?? 0, 10);
                actualAwayScore = parseInt(item.Tr2 ?? item.awayScore ?? item.fs_a ?? 0, 10);
            }

            if (isNaN(homeScore)) homeScore = 0;
            if (isNaN(actualAwayScore)) actualAwayScore = 0;

            const leagueName = parseLeagueName(item, itemSource);

            // Safety guard: bình thường đã được lọc ngay từ tầng fetch.
            if (isFilteredLeague(leagueName, homeName, awayName)) continue;

            const elapsed = calculateExactMinute(item, itemSource);
            const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

            // Safety guard: 0/HT/FT/999 và ngoài 46-92 đã bị rào từ đầu.
            if (!Number.isFinite(numericElapsed) || numericElapsed < 46 || numericElapsed > 92 || numericElapsed === 999) continue;

            console.log(`[Đang Phân Tích (${itemSource.toUpperCase()})] [ID: ${matchId}] [Phút: ${numericElapsed}'] [${leagueName}] ${homeName} ${homeScore}-${actualAwayScore} ${awayName}`);

            const existingAlertState = alertStates.get(String(matchId));
            if (existingAlertState?.sendCount >= 3) {
                console.log(`    🔒 [ĐÃ GỬI ĐỦ 3 LẦN] ${homeName} - ${awayName} | dừng theo dõi cảnh báo trận này`);
                continue;
            }

            // Sau lần 1: tối đa 10 phút để tìm BIGGGG LẦN 2.
            if (existingAlertState?.sendCount === 1 && (numericElapsed - existingAlertState.firstSnapshot.minute) > SECOND_ALERT_WINDOW_MINUTES) {
                console.log(`    🔒 [HẾT 10 PHÚT THEO DÕI BIGGGG LẦN 2] ${homeName} - ${awayName}`);
                continue;
            }
            // Sau lần 2: mở một cửa sổ 10 phút MỚI, so với snapshot lần 2 để tìm BIGGGG LẦN 3.
            if (existingAlertState?.sendCount === 2 && existingAlertState.secondSnapshot &&
                (numericElapsed - existingAlertState.secondSnapshot.minute) > THIRD_ALERT_WINDOW_MINUTES) {
                console.log(`    🔒 [HẾT 10 PHÚT THEO DÕI BIGGGG LẦN 3] ${homeName} - ${awayName}`);
                continue;
            }

            const metrics = await fetchMatchDetailStats(matchId, itemSource, homeName, awayName);

            // V17.0.3: CHỐT GATE DATA. Có từ 3/5 field thật trở lên => LUÔN phân tích AI.
            // 0/5 = DATA MISSING; 1-2/5 = chưa đủ độ phủ để chấm.
            const statPresent = metrics.present || inferStatPresenceFromObject(metrics.sofaStats);
            const statCount = ['totalShots','shotsOnTarget','corners','possession','redCards']
                .filter(k => statPresent?.[k]).length;

            if (statCount === 0 || metrics.statsAvailable === false) {
                console.log(`    ❌ [DATA MISSING 0/5] ${homeName} vs ${awayName} | Sofa+LiveFootball+Livescore6 không có Stats | retry resolver sau 75s`);
                continue;
            }

            // 46-69': cache mọi Stats thật đang có (kể cả 1/5 hoặc 2/5), tuyệt đối chưa chấm Rule.
            // 70-92': cần tối thiểu 3/5 mới chấm AI; snapshot 5-10 phút trước dùng cho Momentum + Attack Surge.
            const momentumKey = `${normalizeTeamName(homeName)}|${normalizeTeamName(awayName)}`;
            const previousMomentumSnapshot = momentumStates.get(momentumKey) || null;
            const rawCurrentSnapshot = makeMatchSnapshot(metrics, 0, numericElapsed, homeScore, actualAwayScore);

            if (numericElapsed < 70) {
                momentumStates.set(momentumKey, rawCurrentSnapshot);
                console.log(`    📥 [CACHE 46-69] ${homeName} vs ${awayName} | ${numericElapsed}' | Stats ${statCount}/5 | CHƯA TÍNH RULE`);
                continue;
            }

            if (statCount < 3) {
                console.log(`    ⚠️ [THIẾU CHỈ SỐ] ${homeName} vs ${awayName} | có ${statCount}/5 | >=70' nhưng chưa đủ 3/5 để chấm AI`);
                momentumStates.set(momentumKey, rawCurrentSnapshot);
                continue;
            }

            const internalMomentum = detectInternalMomentum(previousMomentumSnapshot, rawCurrentSnapshot);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);
            const aiAnalysis = evaluateMatchDynamicAI(
                metrics, oddsAnalysis, numericElapsed, internalMomentum, homeScore, actualAwayScore
            );

            const c = aiAnalysis.components || {};
            console.log(`    🧮 [RULE BREAKDOWN] ${homeName} vs ${awayName} | ${numericElapsed}' | Base +${Number(c.base||0).toFixed(1)} | Shots +${Number(c.weightedShotsRate||0).toFixed(1)} | EffSOT +${Number(c.effectiveSot||0).toFixed(1)} | Corner +${Number(c.cornerRate||0).toFixed(1)} | Poss ${Number(c.possessionAdjustment||0)>=0?'+':''}${Number(c.possessionAdjustment||0).toFixed(1)} | Momentum ${Number(c.momentumAdjustment||0)>=0?'+':''}${Number(c.momentumAdjustment||0).toFixed(1)} | GameState ${Number(c.gameStateAdjustment||0)>=0?'+':''}${Number(c.gameStateAdjustment||0).toFixed(1)} | Red ${Number(c.redCardAdjustment||0)>=0?'+':''}${Number(c.redCardAdjustment||0).toFixed(1)} | Surge ${Number(c.attackSurgeAdjustment||0)>=0?'+':''}${Number(c.attackSurgeAdjustment||0).toFixed(1)} | Sterile ${Number(c.sterilePenalty||0).toFixed(1)} | FINAL ${aiAnalysis.efficiency}%`);
            if (Number(c.attackSurgeAdjustment||0) > 0) {
                const d = internalMomentum?.deltas || {};
                console.log(`    🚀 [ATTACK SURGE] ${homeName} vs ${awayName} | cửa sổ ${internalMomentum.deltaMinute}m | ΔShots +${Math.max(0,Number(d.shots||0))} | ΔSOT +${Math.max(0,Number(d.sot||0))} | +${Number(c.attackSurgeAdjustment).toFixed(1)} Rule`);
            }

            // V17.4: mọi trận >=3/5 đều log kết quả AI. Không còn Quality Gate.
            {
                const ruleNow = Number(aiAnalysis.efficiency);
                if (ruleNow <= 60 || !aiAnalysis.shouldSend) {
                    console.log(`    🧠 [AI CHƯA ĐẠT] ${homeName} vs ${awayName} | Stats ${statCount}/5 | AI ${aiAnalysis.efficiency}% | <=60% KHÔNG GỬI`);
                } else {
                    console.log(`    ✅ [AI ĐẠT RULE] ${homeName} vs ${awayName} | Stats ${statCount}/5 | AI ${aiAnalysis.efficiency}% | đủ điều kiện xét cảnh báo`);
                }
            }

            const currentSnapshot = { ...rawCurrentSnapshot, rule: Number(aiAnalysis.efficiency) };
            // Luôn lưu snapshot sau khi tính delta. Không phát sinh API call mới.
            momentumStates.set(momentumKey, currentSnapshot);
            if (internalMomentum.isStrong) {
                console.log(`    ⚡ [INTERNAL MOMENTUM] ${internalMomentum.deltaMinute} phút | score=${internalMomentum.score} | ${internalMomentum.reasons.join(' | ')}`);
            }

            let alertNumber = existingAlertState ? existingAlertState.sendCount + 1 : 1;
            let spikeInfo = null;
            let shouldAlertNow = false;
            const oddsOK = isBiggggOddsOK(oddsAnalysis);

            if (!existingAlertState) {
                // V17.4.1: Cảnh báo 1 gửi theo AI Rule >60; không còn Quality Gate.
                shouldAlertNow = aiAnalysis.shouldSend;
            } else if (existingAlertState.sendCount === 1) {
                spikeInfo = detectTenMinuteSpike(existingAlertState.firstSnapshot, currentSnapshot);
                // V17.4.1: BIGGGG LẦN 2 = Rule >60 + Effective-SOT/pressure spike + Odds 1.50-2.00.
                shouldAlertNow = aiAnalysis.shouldSend && spikeInfo.isSpike && oddsOK;
                if (!shouldAlertNow) {
                    const oddsText = oddsAnalysis?.odds ?? 'N/A';
                    console.log(`    👀 [THEO DÕI BIGGGG LẦN 2] phút ${numericElapsed}' | Rule ${aiAnalysis.efficiency}% | spike=${spikeInfo.isSpike ? 'YES' : 'NO'} | Odds=${oddsText} | cần 1.50-2.00`);
                }
            } else if (existingAlertState.sendCount === 2) {
                spikeInfo = detectExtremeSpike(existingAlertState.secondSnapshot, currentSnapshot);
                // V17.4.1: BIGGGG LẦN 3 dùng Effective-SOT spike mạnh hơn + Odds 1.50-2.00.
                shouldAlertNow = aiAnalysis.shouldSend && spikeInfo.isSpike && oddsOK;
                if (!shouldAlertNow) {
                    const oddsText = oddsAnalysis?.odds ?? 'N/A';
                    console.log(`    👀 [THEO DÕI BIGGGG LẦN 3] phút ${numericElapsed}' | Rule ${aiAnalysis.efficiency}% | extreme=${spikeInfo.isSpike ? 'YES' : 'NO'} | Odds=${oddsText} | cần 1.50-2.00`);
                }
            }

            if (shouldAlertNow) {
                const goalTimeline = await fetchMatchIncidents(matchId, itemSource, homeScore, actualAwayScore, homeName, awayName);
                console.log(`    └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%) | Cảnh báo ${alertNumber}`);

                const ftPrediction = predictFullTimeScore(
                    metrics,
                    aiAnalysis.efficiency,
                    homeScore,
                    actualAwayScore,
                    numericElapsed
                );

                const pickItem = {
                    id: matchId,
                    source: itemSource,
                    league: leagueName,
                    homeName,
                    awayName,
                    homeScore,
                    awayScore: actualAwayScore,
                    elapsed: numericElapsed,
                    goalTimeline,
                    detailText: aiAnalysis.detailText,
                    ruleEfficiency: aiAnalysis.efficiency,
                    ftPrediction,
                    alertNumber,
                    spikeReasons: spikeInfo?.reasons || [],
                    goalOdds: oddsAnalysis?.odds ?? 'N/A',
                    momentumAlert: false
                };
                await sendTelegramAlert(pickItem);
                if (sentAlerts.has(String(matchId))) {
                    if (!existingAlertState) {
                        alertStates.set(String(matchId), { sendCount: 1, firstSnapshot: currentSnapshot });
                    } else if (existingAlertState.sendCount === 1) {
                        alertStates.set(String(matchId), { ...existingAlertState, sendCount: 2, secondSnapshot: currentSnapshot });
                    } else {
                        alertStates.set(String(matchId), { ...existingAlertState, sendCount: 3, thirdSnapshot: currentSnapshot });
                    }
                }
            } else if (!existingAlertState) {
                console.log(`    └─> [Bỏ qua]: Rule ${aiAnalysis.efficiency}% | yêu cầu Rule >60`);
            }
        }
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

// ==========================================
// 11. KHỞI CHẠY SERVER EXPRESS
// ==========================================
app.get('/', (req, res) => {
    res.send('Football Dual-Source AI Scanner Service is Running!');
});

app.listen(PORT, () => {
    console.log(`==> Server running on port ${PORT}`);
    console.log(`🛟 BUILD V17.4.3: BASE15 | SHOTS x80% + EFFECTIVE SOT | BIGGGG EFFECTIVE-SOT SPIKE | NO QUALITY GATE`);
    scanLiveMatches();
    // Chu kỳ quét 7 phút/lần hoặc điều chỉnh theo ý muốn
    setInterval(scanLiveMatches, 7 * 60 * 1000);
});