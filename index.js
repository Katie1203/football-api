const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

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
// V16: LiveFootball fallback nằm giữa SofaScore và Livescore6
const LIVEFOOTBALL_HOST = 'free-api-live-football-data.p.rapidapi.com';
const LIVEFOOTBALL_LIVE_PATH = '/football-current-live';
const LIVEFOOTBALL_STATS_PATH = '/football-get-match-event-all-stats';

const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

const sentAlerts = new Set();

// V12: trạng thái cảnh báo theo trận. Tối đa 2 tin/trận trong một phiên chạy.
const alertStates = new Map();
const SECOND_ALERT_WINDOW_MINUTES = 10;

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
        cornerRate: (Number(s.corners || 0) / Math.max(1, Number(minute || 1))) * 100
    };
}

function detectTenMinuteSpike(previous, current) {
    if (!previous || !current) return { isSpike: false, reasons: [] };
    const dm = current.minute - previous.minute;
    if (dm < 0 || dm > SECOND_ALERT_WINDOW_MINUTES) return { isSpike: false, reasons: [] };

    const reasons = [];
    const dRule = current.rule - previous.rule;
    const dSot = current.shotsOnTarget - previous.shotsOnTarget;
    const dShots = current.totalShots - previous.totalShots;
    const dCorners = current.corners - previous.corners;
    const dRed = current.redCards - previous.redCards;
    const dGoals = (current.homeScore + current.awayScore) - (previous.homeScore + previous.awayScore);

    if (dRule >= 8) reasons.push(`Rule +${dRule.toFixed(1)}%`);
    if (dSot >= 2) reasons.push(`Sút trúng đích +${dSot}`);
    if (dShots >= 4) reasons.push(`Tổng sút +${dShots}`);
    if (dCorners >= 2) reasons.push(`Phạt góc +${dCorners}`);
    if (dRed >= 1) reasons.push(`Thẻ đỏ mới +${dRed}`);
    if (dGoals >= 1) reasons.push(`Bàn thắng mới +${dGoals}`);

    // Đột biến cường độ: rate toàn trận tăng đáng kể dù số phút cũng tăng.
    const dShotsRate = current.shotsRate - previous.shotsRate;
    const dSotRate = current.sotRate - previous.sotRate;
    const dCornerRate = current.cornerRate - previous.cornerRate;
    if (dShotsRate >= 3) reasons.push(`Mật độ tổng sút +${dShotsRate.toFixed(1)} điểm`);
    if (dSotRate >= 1.5) reasons.push(`Mật độ SOT +${dSotRate.toFixed(1)} điểm`);
    if (dCornerRate >= 1.5) reasons.push(`Mật độ góc +${dCornerRate.toFixed(1)} điểm`);

    return { isSpike: current.rule >= 58 && reasons.length > 0, reasons, deltaMinute: dm };
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

    // Rào phút ngay từ đầu: chỉ 60–92 mới được đi tiếp.
    if (!isEligibleLiveMatch(item, source, 60, 92)) {
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
// Trận 0', HT, FT/999 hoặc ngoài 60-92 sẽ không đi vào vòng AI.
function isEligibleLiveMatch(item, source, minMinute = 60, maxMinute = 92) {
    const elapsed = calculateExactMinute(item, source);
    const minute = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);
    return Number.isFinite(minute) && minute >= minMinute && minute <= maxMinute && minute !== 999;
}
// ==========================================
// 4. LẤY DỮ LIỆU KÉP (SOFASCORE & LIVESCORE6 KẾT HỢP ĐẶC BIỆT)
// ==========================================
async function fetchLiveMatchesDualSource() {
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 10000
        });
        const events = response.data?.events || response.data?.liveEvents || [];
        // PRE-API GATE: loại giải + rào phút trước mọi API Stats/Graph/Incidents.
        const eligibleEvents = events.filter(item => passesPreApiGate(item, 'sofascore'));
        if (eligibleEvents.length > 0) {
            console.log(`[Source: SofaScore] Tổng live=${events.length} | Qua PRE-API GATE (giải + phút 60-92)=${eligibleEvents.length}`);
            return { source: 'sofascore', matches: eligibleEvents };
        }
        if (events.length > 0) {
            console.log(`[Source: SofaScore] Tổng live=${events.length} | Không có trận hợp lệ 60-92 -> thử Livescore6.`);
        }
    } catch (err) {
        console.warn(`⚠️ [SofaScore Error]: ${err.message} -> Đang chuyển sang nguồn dự phòng Livescore6...`);
    }

    try {
        const currentVN = getVietnamTime();
        // Gọi song song cả 2 endpoint: list-live (lấy ngay lập tức các trận đang đá) và list-by-date (lấy toàn bộ các giải trong ngày)
        const liveUrl = `https://${LIVESCORE_HOST}/matches/v2/list-live?Category=soccer`;
        const dateUrl = `https://${LIVESCORE_HOST}/matches/v2/list-by-date?Category=soccer&Date=${currentVN.dateStr}&Timezone=-7`;

        const [resLive, resDate] = await Promise.all([
            axios.get(liveUrl, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({ data: null })),
            axios.get(dateUrl, { headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVESCORE_HOST }, timeout: 10000 }).catch(() => ({ data: null }))
        ]);

        let rawData = [];
        const seenIds = new Set();

        function processMatchObject(obj, cat = '', tour = '') {
            if (!obj || typeof obj !== 'object') return;

            const matchId = String(obj.Eid || obj.id || obj.MatchId || '');
            const hasTeams = obj.T1 || obj.homeTeam || obj.T2 || obj.AwayTeam || (obj.Home && obj.Away);

            if (matchId && hasTeams && !seenIds.has(matchId)) {
                const enriched = {
                    ...obj,
                    _inheritedCategory: obj.Cname || obj.categoryName || obj.country || obj.Cnm || cat,
                    _inheritedTournament: obj.Snm || obj.Tname || obj.tournamentName || obj.LeagueName || tour
                };

                // PRE-API GATE: loại giải rác + rào phút 60–92 ngay tại tầng thu thập.
                // Trận không đạt sẽ không bao giờ đi tới Statistics/Graph/Incidents.
                if (passesPreApiGate(enriched, 'livescore6')) {
                    seenIds.add(matchId);
                    rawData.push(enriched);
                }
            }

            for (const key of Object.keys(obj)) {
                if (obj[key] !== null && typeof obj[key] === 'object') {
                    processMatchObject(
                        obj[key], 
                        obj.Cname || obj.categoryName || cat, 
                        obj.Snm || obj.Tname || tour
                    );
                }
            }
        }

        if (resLive && resLive.data) processMatchObject(resLive.data);
        if (resDate && resDate.data) processMatchObject(resDate.data);

        console.log(`[Source: Livescore6] Qua PRE-API GATE từ đầu (giải + phút 60-92): ${rawData.length} trận.`);
        return { source: 'livescore6', matches: rawData };
    } catch (err) {
        console.error(`❌ [Livescore6 Backup Error]:`, err.message);
        return { source: 'none', matches: [] };
    }
}

// ==========================================
// 5. DIỄN BIẾN BÀN THẮNG
// ==========================================
async function fetchMatchIncidents(matchId, source, homeScore = 0, awayScore = 0) {
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
                const totalGoals = homeScore + awayScore;
                if (totalGoals > 0) {
                    return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số hiện tại: ${homeScore}-${awayScore})`;
                }
                return '• Chưa có bàn thắng (Tỷ số: 0-0)';
            }

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
            const totalGoals = homeScore + awayScore;
            if (totalGoals > 0) {
                return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;
            }
            return '• Chưa có bàn thắng (Tỷ số: 0-0)';
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
                const totalGoals = homeScore + awayScore;
                if (totalGoals > 0) {
                    return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số hiện tại: ${homeScore}-${awayScore})`;
                }
                return '• Chưa có bàn thắng (Tỷ số: 0-0)';
            }

            goalEvents.sort((a, b) => (a.time || a.minute || 0) - (b.time || b.minute || 0));

            const timeline = goalEvents.map(g => {
                const min = g.time || g.minute || 0;
                const player = g.player || g.playerName || g.player?.name || 'Cầu thủ';
                const teamSide = String(g.team || g.homeAway || '').toLowerCase();
                const isHome = teamSide.includes('home') || teamSide === 'h' ? '⚽ [Chủ]' : '⚽ [Khách]';
                const scoreStr = (g.homeScore !== undefined && g.awayScore !== undefined) ? `[${g.homeScore}-${g.awayScore}]` : '';
                return `• Phút ${min}': ${isHome} ${player} ${scoreStr}`;
            });

            return timeline.join('\n');
        } catch (err) {
            const totalGoals = homeScore + awayScore;
            if (totalGoals > 0) {
                return `• Đã có ${totalGoals} bàn thắng được ghi (Tỷ số: ${homeScore}-${awayScore})`;
            }
            return '• Chưa có bàn thắng (Tỷ số: 0-0)';
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
    let foundItems = 0;

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
                shotsOnTarget = Math.max(shotsOnTarget, sumVal); foundItems++;
            } else if (name.includes('shots off target') || name.includes('shot off target')) {
                shotsOffTarget = Math.max(shotsOffTarget, sumVal); foundItems++;
            } else if (name.includes('blocked shots') || name.includes('blocked shot')) {
                blockedShots = Math.max(blockedShots, sumVal); foundItems++;
            } else if (name.includes('total shots') || name.includes('total shot')) {
                totalShots = Math.max(totalShots, sumVal); foundItems++;
            } else if (name.includes('corner')) {
                corners = Math.max(corners, sumVal); foundItems++;
            } else if (name.includes('red card')) {
                redCards = Math.max(redCards, sumVal); foundItems++;
            } else if (name.includes('ball possession') || name === 'possession' || name.includes('possession')) {
                if (!isNaN(homeVal) && !isNaN(awayVal)) {
                    possessionHome = homeVal; possessionAway = awayVal; foundItems++;
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
        }
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
function teamSimilarity(a,b) {
    const x=cleanTeamName(a), y=cleanTeamName(b);
    if(!x||!y) return 0;
    if(x===y) return 1;
    if(x.includes(y)||y.includes(x)) return .88;
    const tok=s=>String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(q=>q.length>=2);
    const A=new Set(tok(a)), B=new Set(tok(b)); if(!A.size||!B.size)return 0;
    let hit=0; for(const q of A) if(B.has(q)) hit++;
    return 2*hit/(A.size+B.size);
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
    for (const key of ['totalShots','shotsOnTarget','corners','possession','redCards']) {
        if (!present[key] && incomingPresent?.[key]) {
            out[key] = incomingStats[key];
            present[key] = true;
            filled.push(key);
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
    try {
        const response = await axios.get(`https://${LIVEFOOTBALL_HOST}${LIVEFOOTBALL_LIVE_PATH}`, {
            headers: { 'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': LIVEFOOTBALL_HOST }, timeout: 7000
        });
        // API contract confirmed: current-live list is response.live.
        // Do not recursively treat unrelated response metadata as match candidates.
        const liveList = Array.isArray(response.data?.response?.live) ? response.data.response.live : [];
        if (liveList.length === 0) {
            console.log(`    ↪️ [LIVEFOOTBALL] response.live=[] -> chuyển Livescore6`);
            return null;
        }
        const candidates=extractLiveFootballCandidates(liveList);
        if (candidates.length === 0) {
            console.log(`    ⚠️ [LIVEFOOTBALL] live=${liveList.length} nhưng chưa bóc được eventid/home/away -> chuyển Livescore6`);
            return null;
        }
        let best=null,bestScore=0;
        for(const c of candidates){
            const direct=(teamSimilarity(homeName,c.home)+teamSimilarity(awayName,c.away))/2;
            const reversed=(teamSimilarity(homeName,c.away)+teamSimilarity(awayName,c.home))/2;
            const score=Math.max(direct,reversed);
            if(score>bestScore){bestScore=score;best=c;}
        }
        if(best && bestScore>=0.68){
            console.log(`    ✅ [LIVEFOOTBALL MATCH] score=${bestScore.toFixed(2)} | eventid=${best.id}`);
            return best;
        }
        console.log(`    ❌ [LIVEFOOTBALL MATCH] Không tìm thấy trận đủ tin cậy | best=${bestScore.toFixed(2)}`);
        return null;
    } catch(err) { console.log(`    ⚠️ [LIVEFOOTBALL LIVE ERROR] ${err.message}`); return null; }
}
function extractLiveFootballStatistics(data) {
    const stats={ totalShots:null, shotsOnTarget:null, corners:null, redCards:null, possession:null };
    const present={ totalShots:false, shotsOnTarget:false, corners:false, redCards:false, possession:false };
    function walk(n){
        if(!n || typeof n!=='object') return;
        if(Array.isArray(n)){ n.forEach(walk); return; }
        const key=String(n.key||'');
        const arr=Array.isArray(n.stats)?n.stats:null;
        if(arr && arr.length>=2 && arr[0]!==null && arr[1]!==null){
            const a=Number(arr[0]), b=Number(arr[1]);
            if(Number.isFinite(a)&&Number.isFinite(b)){
                if(key==='total_shots'){ stats.totalShots=a+b; present.totalShots=true; }
                else if(key==='ShotsOnTarget'){ stats.shotsOnTarget=a+b; present.shotsOnTarget=true; }
                else if(key==='corners'){ stats.corners=a+b; present.corners=true; }
                else if(key==='red_cards'){ stats.redCards=a+b; present.redCards=true; }
                else if(key==='BallPossesion'){ stats.possession=`${a}% - ${b}%`; present.possession=true; }
            }
        }
        Object.values(n).forEach(v=>{if(v&&typeof v==='object')walk(v)});
    }
    walk(data);
    return { foundItems:Object.values(present).filter(Boolean).length, sofaStats:stats, present };
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

        const id = String(obj.Eid || obj.id || obj.MatchId || '');
        const home = (obj.T1 && obj.T1[0] && (obj.T1[0].Nm || obj.T1[0].Name))
            || obj.homeTeam?.name || obj.Home?.Nm || obj.Home?.Name || obj.homeName || '';
        const away = (obj.T2 && obj.T2[0] && (obj.T2[0].Nm || obj.T2[0].Name))
            || obj.awayTeam?.name || obj.Away?.Nm || obj.Away?.Name || obj.awayName || '';

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

    const headers = {
        'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
        'x-rapidapi-host': LIVESCORE_HOST
    };

    const [liveRes, dateRes] = await Promise.all([
        axios.get(liveUrl, { headers, timeout: 7000 }).catch(() => ({ data: null })),
        axios.get(dateUrl, { headers, timeout: 7000 }).catch(() => ({ data: null }))
    ]);

    const candidates = [
        ...extractLivescoreMatchCandidates(liveRes.data),
        ...extractLivescoreMatchCandidates(dateRes.data)
    ];

    let best = null, bestScore = 0;
    for (const c of candidates) {
        const direct = (teamSimilarity(homeName, c.home) + teamSimilarity(awayName, c.away)) / 2;
        const reversed = (teamSimilarity(homeName, c.away) + teamSimilarity(awayName, c.home)) / 2;
        const score = Math.max(direct, reversed);
        if (score > bestScore) { bestScore = score; best = c; }
    }

    if (best && bestScore >= 0.68) {
        console.log(`    ✅ [CROSS-SOURCE MATCH] score=${bestScore.toFixed(2)} | Livescore Eid=${best.id}`);
        return best;
    }

    console.log(`    ❌ [CROSS-SOURCE MATCH] Không tìm thấy trận đủ tin cậy | best=${bestScore.toFixed(2)}`);
    return null;
}

function extractLivescoreStatistics(data) {
    let shotsOnTarget = 0, totalShots = 0, corners = 0, redCards = 0;
    let possessionHome = null, possessionAway = null;
    let foundItems = 0;

    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }

        const name = String(node.name || node.type || node.title || node.Nm || node.StatName || '').toLowerCase();
        const hvRaw = node.home ?? node.homeValue ?? node.H ?? node.Value1 ?? node.V1;
        const avRaw = node.away ?? node.awayValue ?? node.A ?? node.Value2 ?? node.V2;
        const hv = parseInt(String(hvRaw ?? '').replace('%',''), 10);
        const av = parseInt(String(avRaw ?? '').replace('%',''), 10);

        if (name && (!isNaN(hv) || !isNaN(av))) {
            const sum = (isNaN(hv) ? 0 : hv) + (isNaN(av) ? 0 : av);
            if (name.includes('shot on target') || name.includes('shots on target')) {
                shotsOnTarget = Math.max(shotsOnTarget, sum); foundItems++;
            } else if (name.includes('total shot') || name.includes('shots total')) {
                totalShots = Math.max(totalShots, sum); foundItems++;
            } else if (name.includes('corner')) {
                corners = Math.max(corners, sum); foundItems++;
            } else if (name.includes('red card')) {
                redCards = Math.max(redCards, sum); foundItems++;
            } else if (name.includes('possession')) {
                if (!isNaN(hv) && !isNaN(av)) {
                    possessionHome = hv; possessionAway = av; foundItems++;
                }
            }
        }
        Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    walk(data);

    return {
        foundItems,
        sofaStats: {
            shotsOnTarget,
            totalShots: totalShots || shotsOnTarget,
            corners,
            redCards,
            possession: possessionHome !== null && possessionAway !== null
                ? `${possessionHome}% - ${possessionAway}%` : null
        }
    };
}

async function fetchCrossSourcePartialStats(homeName, awayName) {
    try {
        const match = await resolveLivescoreMatchByName(homeName, awayName);
        if (!match) return null;

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
            console.log(`    🛟 [PARTIAL STATS OK] Livescore6 Eid=${match.id} | fields=${parsed.foundItems}`);
            return {
                ...parsed,
                statsAvailable: true,
                partialStats: true,
                statsSource: 'livescore6',
                crossSourceMatchId: match.id
            };
        }

        console.log(`    ⚠️ [PARTIAL STATS EMPTY] Livescore6 có trận nhưng endpoint statistics cũng rỗng`);
        return null;
    } catch (err) {
        console.log(`    ⚠️ [CROSS-SOURCE ERROR] ${err.message}`);
        return null;
    }
}

async function fetchMatchDetailStats(matchId, source, homeName = '', awayName = '') {
    if (source === 'sofascore') {
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
        let sofaPresent = detectSofaStatPresence(primary);
        // QUAN TRỌNG: extractSofaStatistics dùng 0 làm giá trị mặc định.
        // Khi foundItems=0, tuyệt đối không suy diễn các số 0 mặc định là dữ liệu thật.
        // Nhờ vậy DATA MISSING không bị biến thành Base 28%.
        if (parsed.foundItems > 0) {
            const inferred = inferStatPresenceFromObject(parsed.sofaStats);
            for (const k of Object.keys(sofaPresent)) sofaPresent[k] = sofaPresent[k] || inferred[k];
        } else {
            sofaPresent = { totalShots:false, shotsOnTarget:false, corners:false, possession:false, redCards:false };
        }

        const needMore = () => Object.values(sofaPresent).some(v => !v);
        if (homeName && awayName && needMore()) {
            const lf = await fetchLiveFootballPartialStats(homeName, awayName);
            if (lf?.foundItems > 0) {
                const merged = mergeMissingStats(parsed.sofaStats, sofaPresent, lf.sofaStats, lf.present);
                parsed.sofaStats = merged.stats; sofaPresent = merged.present;
                if (merged.filled.length) {
                    sourceTrail.push('livefootball');
                    console.log(`    🔗 [MERGE] LiveFootball bù: ${merged.filled.join(', ')}`);
                    crossSourcePartial = lf;
                }
            }
        }
        if (homeName && awayName && needMore()) {
            const ls = await fetchCrossSourcePartialStats(homeName, awayName);
            if (ls?.foundItems > 0) {
                const lsPresent = inferStatPresenceFromObject(ls.sofaStats);
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

        // Graph dùng ID Sofa đã resolve nếu có.
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
function evaluateMatchDynamicAI(metrics, oddsAnalysis, elapsedMinute) {
    let matchAnalysis = [];
    let aiPercentage = 28.0; // Base giữ nguyên
    const stats = metrics.sofaStats || {};
    const minute = Math.max(1, Number(elapsedMinute) || 1);
    let hasTacticalData = false;

    if (metrics.partialStats) {
        matchAnalysis.push(`🛟 PARTIAL DATA: thống kê lấy từ nguồn dự phòng ${metrics.statsSource || 'cross-source'}; chỉ tính các chỉ số thực sự lấy được`);
    }

    // V13 NEW AI:
    // Chỉ số dạng số lần = số lần / phút hiện tại * 100.
    // Total Shots dùng 100% giá trị.
    // SOT chỉ cộng 50% giá trị để hạn chế đếm trùng vì SOT đã nằm trong Total Shots.
    // Corners dùng 100% giá trị.
    const totalShots = Math.max(0, Number(stats.totalShots) || 0);
    const shotsOnTarget = Math.max(0, Number(stats.shotsOnTarget) || 0);
    const corners = Math.max(0, Number(stats.corners) || 0);

    const shotsRate = (totalShots / minute) * 100;
    const sotRateRaw = (shotsOnTarget / minute) * 100;
    const sotContribution = sotRateRaw * 0.50;
    const cornerRate = (corners / minute) * 100;

    if (totalShots > 0) {
        aiPercentage += shotsRate;
        matchAnalysis.push(`🔥 Tổng sút: ${totalShots} | ${totalShots}/${minute}×100 = ${shotsRate.toFixed(2)}% (Cộng ${shotsRate.toFixed(2)}%)`);
        hasTacticalData = true;
    }

    if (shotsOnTarget > 0) {
        aiPercentage += sotContribution;
        matchAnalysis.push(`🎯 Sút trúng đích: ${shotsOnTarget} | ${shotsOnTarget}/${minute}×100 = ${sotRateRaw.toFixed(2)}% × 50% = ${sotContribution.toFixed(2)}%`);
        hasTacticalData = true;
    }

    if (corners > 0) {
        aiPercentage += cornerRate;
        matchAnalysis.push(`🚩 Phạt góc: ${corners} | ${corners}/${minute}×100 = ${cornerRate.toFixed(2)}% (Cộng ${cornerRate.toFixed(2)}%)`);
        hasTacticalData = true;
    }

    // Possession là % sẵn có nên KHÔNG chia cho phút.
    // Giảm trọng số so với V12 để các chỉ số nhịp trận là phần chính của AI.
    if (stats.possession) {
        matchAnalysis.push(`📊 Tỷ lệ kiểm soát bóng: ${stats.possession}`);
        const possParts = stats.possession.split('-');
        if (possParts.length === 2) {
            const homePoss = parseInt(possParts[0].trim(), 10) || 50;
            const awayPoss = parseInt(possParts[1].trim(), 10) || 50;
            const maxPoss = Math.max(homePoss, awayPoss);

            if (maxPoss >= 70) {
                aiPercentage += 8.0;
                matchAnalysis.push(`    └─> Kiểm soát áp đảo ${maxPoss}% (Cộng 8.0%)`);
                hasTacticalData = true;
            } else if (maxPoss >= 60) {
                aiPercentage += 5.0;
                matchAnalysis.push(`    └─> Kiểm soát lấn lướt ${maxPoss}% (Cộng 5.0%)`);
                hasTacticalData = true;
            }
        }
    }

    // Thẻ đỏ là biến bối cảnh, không áp dụng số lần/phút.
    if ((Number(stats.redCards) || 0) > 0) {
        aiPercentage += 10.0;
        matchAnalysis.push(`🟥 Thẻ đỏ: ${stats.redCards} (Yếu tố thay đổi thế trận - cộng 10.0%)`);
        hasTacticalData = true;
    }

    // Kèo nhà cái chỉ là dữ liệu tham khảo, tuyệt đối không cộng Rule.
    if (oddsAnalysis) {
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Odds Over ${oddsAnalysis.odds} — chỉ tham khảo nhận định, KHÔNG cộng Rule`);
        if (oddsAnalysis.oddsNoteText) {
            matchAnalysis.push(`    └─> ${oddsAnalysis.oddsNoteText}`);
        }
        hasTacticalData = true;
    }

    const finalPercentage = Math.min(aiPercentage, 98.0).toFixed(1);
    const MIN_SEND_PERCENTAGE = 60.0;
    const shouldSend = parseFloat(finalPercentage) > MIN_SEND_PERCENTAGE && hasTacticalData;

    return {
        efficiency: finalPercentage,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend,
        components: {
            base: 28.0,
            shotsRate: Number(shotsRate.toFixed(2)),
            sotRateRaw: Number(sotRateRaw.toFixed(2)),
            sotContribution: Number(sotContribution.toFixed(2)),
            cornerRate: Number(cornerRate.toFixed(2))
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
    const timeDisplay = `Phút ${item.elapsed}'`;
    const alertHeader = item.alertNumber === 2
        ? `🚨 ĐỘT BIẾN 10 PHÚT - CẢNH BÁO LẦN 2 🚨`
        : `🔔 RUNG CHUỔNG VÀNGGGG (${item.source.toUpperCase()})`;
    const spikeBlock = item.alertNumber === 2 && item.spikeReasons?.length
        ? `\n⚡ CHỈ SỐ ĐỘT BIẾN: ${item.spikeReasons.join(' | ')}`
        : '';

    const message =
`${alertHeader}${spikeBlock}
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: ${timeDisplay}

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🎯 Nhận định: Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG
📈 Hiệu suất Rule: ${item.ruleEfficiency}%${item.ftPrediction ? `

🔮 DỰ ĐOÁN TỶ SỐ FT: ${item.ftPrediction.ftScore}
⚽ Dự kiến bàn còn lại: +${item.ftPrediction.expectedGoals}
🎯 Đội có khả năng ghi bàn: ${item.ftPrediction.likelyScorer}
📊 Sức ép: Chủ nhà ${item.ftPrediction.homePressure}% - ${item.ftPrediction.awayPressure}% Đội khách
🔮 Độ mạnh dự đoán: ${item.ftPrediction.strength}` : ''}`;

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
            console.log(`[Thông báo]: Không thu thập được trận đấu nào từ cả SofaScore và Livescore6.`);
            return;
        }

        for (let index = 0; index < matches.length; index++) {
            const item = matches[index];
            
            let matchId, homeName, awayName, homeScore, actualAwayScore;

            if (source === 'sofascore') {
                matchId = String(item.id);
                homeName = item.homeTeam?.name || 'Đội nhà';
                awayName = item.awayTeam?.name || 'Đội khách';
                homeScore = item.homeScore?.current ?? 0;
                actualAwayScore = item.awayScore?.current ?? 0;
            } else {
                matchId = String(item.Eid || item.id || item.matchId || `ls6_${index}`);
                
                homeName = (item.T1 && item.T1[0] && (item.T1[0].Nm || item.T1[0].Name)) || item.homeTeam?.name || 'Đội nhà';
                awayName = (item.T2 && item.T2[0] && (item.T2[0].Nm || item.T2[0].Name)) || item.awayTeam?.name || 'Đội khách';

                homeScore = parseInt(item.Tr1 ?? item.homeScore ?? item.fs_h ?? 0, 10);
                actualAwayScore = parseInt(item.Tr2 ?? item.awayScore ?? item.fs_a ?? 0, 10);
            }

            if (isNaN(homeScore)) homeScore = 0;
            if (isNaN(actualAwayScore)) actualAwayScore = 0;

            const leagueName = parseLeagueName(item, source);

            // Safety guard: bình thường đã được lọc ngay từ tầng fetch.
            if (isFilteredLeague(leagueName, homeName, awayName)) continue;

            const elapsed = calculateExactMinute(item, source);
            const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

            // Safety guard: 0/HT/FT/999 và ngoài 60-92 đã bị rào từ đầu.
            if (!Number.isFinite(numericElapsed) || numericElapsed < 60 || numericElapsed > 92 || numericElapsed === 999) continue;

            console.log(`[Đang Phân Tích (${source.toUpperCase()})] [ID: ${matchId}] [Phút: ${numericElapsed}'] [${leagueName}] ${homeName} ${homeScore}-${actualAwayScore} ${awayName}`);

            const existingAlertState = alertStates.get(String(matchId));
            if (existingAlertState?.sendCount >= 2) {
                console.log(`    🔒 [ĐÃ GỬI ĐỦ 2 LẦN] ${homeName} - ${awayName}`);
                continue;
            }
            if (existingAlertState && (numericElapsed - existingAlertState.firstSnapshot.minute) > SECOND_ALERT_WINDOW_MINUTES) {
                console.log(`    🔒 [HẾT 10 PHÚT THEO DÕI LẦN 2] ${homeName} - ${awayName}`);
                continue;
            }

            const metrics = await fetchMatchDetailStats(matchId, source, homeName, awayName);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);

            if (source === 'sofascore' && metrics.statsAvailable === false) {
                console.log(`    ⚠️ [DATA MISSING ≠ ZERO] Không chấm giả Base 28%. Sẽ thử resolver lại ở vòng quét sau.`);
                continue;
            }

            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis, numericElapsed);
            const currentSnapshot = makeMatchSnapshot(metrics, aiAnalysis.efficiency, numericElapsed, homeScore, actualAwayScore);

            let alertNumber = existingAlertState ? 2 : 1;
            let spikeInfo = null;
            let shouldAlertNow = false;

            if (!existingAlertState) {
                shouldAlertNow = aiAnalysis.shouldSend;
            } else {
                spikeInfo = detectTenMinuteSpike(existingAlertState.firstSnapshot, currentSnapshot);
                shouldAlertNow = spikeInfo.isSpike;
                if (!shouldAlertNow) {
                    console.log(`    👀 [THEO DÕI ĐỘT BIẾN] phút ${numericElapsed}' | Rule ${aiAnalysis.efficiency}% | chưa đủ điều kiện lần 2`);
                }
            }

            if (shouldAlertNow) {
                const goalTimeline = await fetchMatchIncidents(matchId, source, homeScore, actualAwayScore);
                console.log(`    └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%)`);

                const ftPrediction = predictFullTimeScore(
                    metrics,
                    aiAnalysis.efficiency,
                    homeScore,
                    actualAwayScore,
                    numericElapsed
                );

                const pickItem = {
                    id: matchId,
                    source,
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
                    spikeReasons: spikeInfo?.reasons || []
                };
                await sendTelegramAlert(pickItem);
                if (sentAlerts.has(String(matchId))) {
                    if (!existingAlertState) {
                        alertStates.set(String(matchId), { sendCount: 1, firstSnapshot: currentSnapshot });
                    } else {
                        alertStates.set(String(matchId), { ...existingAlertState, sendCount: 2, secondSnapshot: currentSnapshot });
                    }
                }
            } else {
                console.log(`    └─> [Bỏ qua]: Điểm AI chưa đủ (${aiAnalysis.efficiency}%) - Yêu cầu Rule > 60%`);
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
    console.log(`🛟 BUILD V16.1: LIVEFOOTBALL response.live FIX | DATA MISSING FIX | V15 LOGIC PRESERVED`);
    scanLiveMatches();
    // Chu kỳ quét 7 phút/lần hoặc điều chỉnh theo ý muốn
    setInterval(scanLiveMatches, 7 * 60 * 1000);
});