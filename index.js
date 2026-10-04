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

// Nguồn 2: Livescore6 (Dự phòng tự động khi SofaScore lỗi)
const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';[cite: 7]
const LIVESCORE_LIVE_URL = `https://${LIVESCORE_HOST}/matches/v2/list-live?Timezone=-7&Category=soccer`;[cite: 7]

const ODDS_API_KEY = process.env.ODDS_API_KEY || '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

const sentAlerts = new Set();

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
    'Estonia': 'Estonia',
    'India': 'Ấn Độ',
    'South Africa': 'Nam Phi',
    'World': 'Quốc Tế',
    'Europe': 'Châu Âu',
    'Asia': 'Châu Á',
    'South America': 'Nam Mỹ',
    'Africa': 'Châu Phi'
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
        category = item.tournament?.category?.name || item.category?.name || '';
        tournament = item.tournament?.name || item.competitionName || '';
    } else {
        category = item.categoryName || item.tournament?.category?.name || item.category?.name || '';
        tournament = item.tournamentName || item.tournament?.name || item.competitionName || '';
    }

    if (LEAGUE_NAME_MAP[tournament]) {
        return LEAGUE_NAME_MAP[tournament];
    }

    const translatedCategory = COUNTRY_MAP[category] || category;

    let translatedTournament = tournament
        .replace(/\bPremier League\b/gi, 'Giải VĐQG')
        .replace(/\bDivision 1\b/gi, 'Hạng 1')
        .replace(/\bDivision 2\b/gi, 'Hạng 2')
        .replace(/\bSuper League\b/gi, 'VĐQG')
        .replace(/\bCup\b/gi, 'Cúp');

    if (translatedCategory && translatedTournament) {
        if (translatedTournament.toLowerCase().includes(translatedCategory.toLowerCase())) {
            return translatedTournament;
        }
        return `${translatedTournament} (${translatedCategory})`.trim();
    }

    return translatedTournament || translatedCategory || 'Bóng Đá Quốc Tế';
}

// ==========================================
// 2. BỘ LỌC THÔNG MINH (CHO PHÉP U21, CHẶN U20 TRỞ XUỐNG)
// ==========================================
function isFilteredLeague(leagueName, homeName, awayName) {
    const textToTest = `${leagueName} ${homeName} ${awayName}`.toLowerCase();
    
    const youthRegex = /\b(u-?1[0-9]|u-?20|sub-?1[0-9]|sub-?20|under-?1[0-9]|under-?20)\b/i;
    if (youthRegex.test(textToTest)) return true;

    const filterKeywords = ['simulated', 'srl', 'esports', 'e-soccer'];
    return filterKeywords.some(kw => textToTest.includes(kw));
}

// ==========================================
// 3. TÍNH PHÚT TRẬN ĐẤU (BỎ QUA HT)
// ==========================================
function calculateExactMinute(item, source) {
    if (!item) return 0;

    let statusType = '';
    let statusDesc = '';

    if (source === 'sofascore') {
        statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
        statusDesc = String(item.status?.description || '').toLowerCase();
    } else {
        statusType = String(item.status || item.statusText || item.matchStatus || '').toLowerCase();
        statusDesc = String(item.statusDescription || '').toLowerCase();
    }

    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft') || statusType === 'ft') return 999;
    
    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht' || statusDesc.includes('half time')) {
        return 'HT';
    }

    if (source === 'sofascore') {
        if (item.time && typeof item.time.played === 'number' && item.time.played > 0) {
            return item.time.played;
        }
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

            if (isSecondHalf) return Math.min(45 + elapsedInPeriod, 95);
            return Math.min(elapsedInPeriod, 45);
        }
    } else {
        if (typeof item.time === 'number') return item.time;
        if (typeof item.minute === 'number') return item.minute;
        const matchMin = statusType.match(/(\d+)/);
        if (matchMin) {
            const val = parseInt(matchMin[1], 10);
            if (val > 0 && val <= 120) return val;
        }
    }

    return 0;
}

// ==========================================
// 4. HỆ THỐNG LẤY DỮ LIỆU KÉP (SOFASCORE -> FALLBACK LIVESCORE6)
// ==========================================
async function fetchLiveMatchesDualSource() {
    // Thử lấy từ SofaScore trước
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 10000
        });
        const events = response.data?.events || response.data?.liveEvents || [];
        if (events.length > 0) {
            console.log(`[Source: SofaScore] ✅ Lấy thành công ${events.length} trận live.`);
            return { source: 'sofascore', matches: events };
        }
    } catch (err) {
        console.warn(`⚠️ [SofaScore Error]: ${err.message} -> Đang chuyển sang nguồn dự phòng Livescore6...`);
    }

    // Nếu SofaScore lỗi, tự động gọi Livescore6
    try {
        const response = await axios.get(LIVESCORE_LIVE_URL, {[cite: 7]
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': LIVESCORE_HOST
            },
            timeout: 10000
        });

        let rawData = [];
        const data = response.data;

        if (Array.isArray(data)) {
            rawData = data;
        } else if (data && typeof data === 'object') {
            const possibleKeys = ['matches', 'events', 'response', 'data', 'fixtures', 'live', 'result', 'Stages'];
            for (const key of possibleKeys) {
                if (Array.isArray(data[key])) {
                    rawData = data[key];
                    break;
                }
            }
            if (rawData.length === 0 && data.Stages) {
                data.Stages.forEach(stage => {
                    if (stage.events && Array.isArray(stage.events)) {
                        rawData.push(...stage.events);
                    } else if (stage.matches && Array.isArray(stage.matches)) {
                        rawData.push(...stage.matches);
                    }
                });
            }
        }

        console.log(`[Source: Livescore6 Backup] ✅ Lấy thành công ${rawData.length} trận live.`);
        return { source: 'livescore6', matches: rawData };
    } catch (err) {
        console.error(`❌ [Livescore6 Backup Error]:`, err.message);
        return { source: 'none', matches: [] };
    }
}

// ==========================================
// 5. DIỄN BIẾN BÀN THẮNG THEO PHÚT
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
            const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-incidents?Eid=${matchId}&Category=soccer`, {[cite: 7]
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
// 6. LẤY DỮ LIỆU & CHUẨN HÓA KÈO ODDS
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
// 7. HÀM LẤY CHI TIẾT CHỈ SỐ TRẬN ĐẤU
// ==========================================
async function fetchMatchDetailStats(matchId, source) {
    if (source === 'sofascore') {
        try {
            const response = await axios.get(`https://${SOFASCORE_HOST}/events/get-statistics?eventId=${matchId}`, {
                headers: {
                    'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                    'x-rapidapi-host': SOFASCORE_HOST
                },
                timeout: 6000
            });

            let shotsOnTarget = 0, corners = 0, redCards = 0, totalShots = 0, shotsOffTarget = 0, blockedShots = 0;
            let possessionHome = null, possessionAway = null;
            
            const statistics = response.data?.statistics;

            if (Array.isArray(statistics)) {
                statistics.forEach(period => {
                    const groups = period.groups || [];
                    groups.forEach(group => {
                        const items = group.statisticsItems || [];
                        items.forEach(st => {
                            const name = String(st.name || st.slug || '').toLowerCase();
                            const homeVal = parseInt(st.home, 10);
                            const awayVal = parseInt(st.away, 10);
                            const sumVal = (isNaN(homeVal) ? 0 : homeVal) + (isNaN(awayVal) ? 0 : awayVal);

                            if (name.includes('shots on target') || name.includes('sút trúng đích')) {
                                shotsOnTarget = Math.max(shotsOnTarget, sumVal);
                            } else if (name.includes('shots off target') || name.includes('sút ra ngoài')) {
                                shotsOffTarget = Math.max(shotsOffTarget, sumVal);
                            } else if (name.includes('blocked shots') || name.includes('sút bị cản')) {
                                blockedShots = Math.max(blockedShots, sumVal);
                            } else if (name.includes('total shots') || name.includes('tổng số cú sút')) {
                                totalShots = Math.max(totalShots, sumVal);
                            } else if (name.includes('corner') || name.includes('phạt góc')) {
                                corners = Math.max(corners, sumVal);
                            } else if (name.includes('red card') || name.includes('thẻ đỏ')) {
                                redCards = Math.max(redCards, sumVal);
                            } else if (name.includes('ball possession') || name.includes('possession') || name.includes('kiểm soát bóng')) {
                                if (!isNaN(homeVal) && !isNaN(awayVal)) {
                                    possessionHome = homeVal;
                                    possessionAway = awayVal;
                                }
                            }
                        });
                    });
                });
            }

            let possessionStr = null;
            if (possessionHome !== null && possessionAway !== null) {
                possessionStr = `${possessionHome}% - ${possessionAway}%`;
            }

            return {
                sofaStats: { 
                    shotsOnTarget, 
                    totalShots: totalShots || (shotsOnTarget + shotsOffTarget + blockedShots), 
                    shotsOffTarget,
                    blockedShots,
                    corners, 
                    redCards,
                    possession: possessionStr
                }
            };
        } catch (err) {
            return {
                sofaStats: { shotsOnTarget: 0, totalShots: 0, shotsOffTarget: 0, blockedShots: 0, corners: 0, redCards: 0, possession: null }
            };
        }
    } else {
        try {
            const response = await axios.get(`https://${LIVESCORE_HOST}/matches/v2/get-statistics?Category=soccer&Eid=${matchId}`, {[cite: 7]
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
    const pointDiff = overLine - currentTotalGoals;

    if (pointDiff >= 0.75) {
        oddsBonus = 16.0;
        oddsNotes.push(`Line Over giữ mức cao (${overLine}) so với tổng ${currentTotalGoals} bàn`);
    } else if (pointDiff > 0) {
        oddsBonus = 10.0;
        oddsNotes.push(`Line Over (${overLine}) sát mốc nổ bàn`);
    }

    if (price <= 1.40) {
        oddsBonus += 18.0;
        oddsNotes.push(`Odds Over cực thấp (${price}) - Dòng tiền kết tài mạnh`);
    } else if (price <= 1.60) {
        oddsBonus += 13.0;
        oddsNotes.push(`Odds Over giảm sâu (${price})`);
    } else if (price <= 1.85) {
        oddsBonus += 8.0;
        oddsNotes.push(`Odds Over ổn định (${price})`);
    } else {
        oddsBonus += 4.0;
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
// 8. THUẬT TOÁN AI TÍNH PHẦN TRĂM CỘNG DỒN ĐỘNG
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis) {
    let matchAnalysis = [];
    let aiPercentage = 35.0; // Mốc khởi đầu nền

    const stats = metrics.sofaStats || {};
    let hasTacticalData = false;

    // 1. Tỷ lệ kiểm soát bóng (Tối đa +15%)
    if (stats.possession) {
        matchAnalysis.push(`📊 Tỷ lệ kiểm soát bóng: ${stats.possession}`);
        const possParts = stats.possession.split('-');
        if (possParts.length === 2) {
            const homePoss = parseInt(possParts[0].trim(), 10) || 50;
            const awayPoss = parseInt(possParts[1].trim(), 10) || 50;
            const maxPoss = Math.max(homePoss, awayPoss);

            if (maxPoss >= 70) {
                aiPercentage += 15.0;
                matchAnalysis.push(`    └─> Thế trận áp đảo cực mạnh (${maxPoss}% - cộng thêm 15.0%)`);
                hasTacticalData = true;
            } else if (maxPoss >= 60) {
                aiPercentage += 10.0;
                matchAnalysis.push(`    └─> Thế trận lấn lướt (${maxPoss}% - cộng thêm 10.0%)`);
                hasTacticalData = true;
            }
        }
    }

    // 2. Thẻ đỏ (+15%)
    if (stats.redCards > 0) {
        aiPercentage += 15.0;
        matchAnalysis.push(`🟥 Thẻ đỏ (${stats.redCards} thẻ - cộng thêm 15.0%)`);
        hasTacticalData = true;
    }

    // 3. Sút trúng khung thành (Từ +6% đến +18%)
    if (stats.shotsOnTarget >= 6) {
        aiPercentage += 18.0;
        matchAnalysis.push(`⚡ Sút trúng đích dồn dập: ${stats.shotsOnTarget} lần (Cộng thêm 18.0%)`);
        hasTacticalData = true;
    } else if (stats.shotsOnTarget >= 4) {
        aiPercentage += 12.0;
        matchAnalysis.push(`⚡ Sút trúng đích dồn dập: ${stats.shotsOnTarget} lần (Cộng thêm 12.0%)`);
        hasTacticalData = true;
    } else if (stats.shotsOnTarget >= 2) {
        aiPercentage += 6.0;
        matchAnalysis.push(`🎯 Sút trúng đích: ${stats.shotsOnTarget} lần (Cộng thêm 6.0%)`);
        hasTacticalData = true;
    }

    // 4. Tổng số cú sút (Từ +5% đến +15%)
    if (stats.totalShots >= 15) {
        aiPercentage += 15.0;
        matchAnalysis.push(`🔥 Thế trận cực kỳ cởi mở, tổng sút: ${stats.totalShots} (Cộng thêm 15.0%)`);
        hasTacticalData = true;
    } else if (stats.totalShots >= 10) {
        aiPercentage += 10.0;
        matchAnalysis.push(`⚽ Hai đội tích cực bắn phá, tổng sút: ${stats.totalShots} (Cộng thêm 10.0%)`);
        hasTacticalData = true;
    } else if (stats.totalShots >= 6) {
        aiPercentage += 5.0;
        matchAnalysis.push(`⚽ Tổng sút: ${stats.totalShots} (Cộng thêm 5.0%)`);
        hasTacticalData = true;
    }

    // 5. Phạt góc (Từ +5% đến +12%)
    if (stats.corners >= 8) {
        aiPercentage += 12.0;
        matchAnalysis.push(`🚩 Sức ép phạt góc lớn: ${stats.corners} quả (Cộng thêm 12.0%)`);
        hasTacticalData = true;
    } else if (stats.corners >= 4) {
        aiPercentage += 6.0;
        matchAnalysis.push(`🚩 Phạt góc ổn định: ${stats.corners} quả (Cộng thêm 6.0%)`);
        hasTacticalData = true;
    }

    // 6. Phân tích Kèo nhà cái (Tỷ lệ phần trăm động theo Odds)
    if (oddsAnalysis) {
        aiPercentage += oddsAnalysis.oddsBonus;
        matchAnalysis.push(`💰 Kèo nhà cái (${oddsAnalysis.bookmaker}): Over ${oddsAnalysis.line} (Odds: ${oddsAnalysis.odds} - Cộng thêm ${oddsAnalysis.oddsBonus.toFixed(1)}%)`);
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
        shouldSend
    };
}

// ==========================================
// 9. THÔNG BÁO TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const timeDisplay = `Phút ${item.elapsed}'`;
    const message = 
`🔔 RUNG CHUỔNG VÀNGGGG (${item.source.toUpperCase()})
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: ${timeDisplay}

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🎯 Nhận định: Trận đấu có xác suất cao xuất hiện THÊM BÀN THẮNG
📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi thông báo: ${item.homeName} vs ${item.awayName} (${item.ruleEfficiency}%)`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.message);
    }
}

// ==========================================
// 10. TIẾN TRÌNH QUÉT TỰ ĐỘNG KÉP
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
                matchId = String(item.Eid || item.id || item.matchId);
                homeName = item.homeTeam?.name || item.home || item.t1?.[0] || 'Đội nhà';
                awayName = item.awayTeam?.name || item.away || item.t2?.[0] || 'Đội khách';
                homeScore = parseInt(item.homeScore ?? item.fs_h ?? item.homeGoals ?? 0, 10);
                actualAwayScore = parseInt(item.awayScore ?? item.fs_a ?? item.awayGoals ?? 0, 10);
            }

            const elapsed = calculateExactMinute(item, source);
            const league = parseLeagueName(item, source);

            if (!matchId) continue;
            if (sentAlerts.has(matchId)) continue;

            if (isFilteredLeague(league, homeName, awayName)) {
                console.log(`[Trận #${index + 1}] [${league}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Giải trẻ/Phụ`);
                continue;
            }

            const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

            if (isNaN(numericElapsed) || numericElapsed < 45 || numericElapsed > 92) {
                const timeLabel = (elapsed === 'HT' || elapsed === 999) ? elapsed : `${elapsed}'`;
                console.log(`[Trận #${index + 1}] [Phút: ${timeLabel}] [${league}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Ngoài khung hiệp 2 (45-92') hoặc HT`);
                continue;
            }

            console.log(`[Đang Phân Tích (${source.toUpperCase()})] [ID: ${matchId}] [Phút: ${numericElapsed}'] [${league}] ${homeName} ${homeScore}-${actualAwayScore} ${awayName}`);

            const metrics = await fetchMatchDetailStats(matchId, source);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, source, homeScore, actualAwayScore);
                console.log(`    └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%)`);
                
                const pickItem = {
                    id: matchId,
                    source,
                    league,
                    homeName,
                    awayName,
                    homeScore,
                    awayScore: actualAwayScore,
                    elapsed: numericElapsed,
                    goalTimeline,
                    detailText: aiAnalysis.detailText,
                    ruleEfficiency: aiAnalysis.efficiency
                };
                await sendTelegramAlert(pickItem);
            } else {
                console.log(`    └─> [Bỏ qua]: Điểm AI chưa đủ (${aiAnalysis.efficiency}%) - Yêu cầu Rule > 60%`);
            }
        }
    } catch (err) {
        console.error(`[API Fetch Error]:`, err.message);
    }
}

app.get('/', (req, res) => {
    res.send('Football Dual-Source AI Scanner Service is Running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 10 * 60 * 1000);
});