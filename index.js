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

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

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

function parseLeagueName(item) {
    if (!item) return 'Bóng Đá Quốc Tế';

    let category = item.tournament?.category?.name || item.category?.name || '';
    let tournament = item.tournament?.name || item.competitionName || '';

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
// 3. TÍNH PHÚT TRẬN ĐẤU (TỪ PHÚT 50 ĐẾN 92', BỎ QUA HT)
// ==========================================
function calculateExactMinute(item) {
    if (!item) return 0;

    const statusType = String(item.status?.type || item.status?.code || '').toLowerCase();
    const statusDesc = String(item.status?.description || '').toLowerCase();

    if (statusType.includes('ended') || statusType.includes('finished') || statusDesc.includes('ft') || statusType === 'ft') return 999;
    
    if (statusType.includes('halftime') || statusDesc.includes('ht') || statusType === 'ht' || statusDesc.includes('half time')) {
        return 'HT';
    }

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

    const anyNum = statusDesc.match(/\d+/);
    if (anyNum) return parseInt(anyNum[0], 10);

    return 0;
}

// ==========================================
// 4. DIỄN BIẾN BÀN THẮNG THEO PHÚT
// ==========================================
async function fetchMatchIncidents(matchId, homeScore = 0, awayScore = 0) {
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
}

// ==========================================
// 5. LẤY DỮ LIỆU & CHUẨN HÓA KÈO ODDS
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

async function fetchSofaScoreLive() {
    try {
        const response = await axios.get(SOFASCORE_LIVE_URL, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 15000
        });
        return response.data?.events || response.data?.liveEvents || [];
    } catch (err) {
        return [];
    }
}

// ==========================================
// 6. HÀM LẤY CHI TIẾT CHỈ SỐ TRẬN ĐẤU
// ==========================================
async function fetchMatchDetailStats(matchId) {
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
}

function cleanTeamName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\b(fc|cf|club|sc|sv|usd|ac|afc|vfb|fsv|cd|nk)\b/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

// Đã tinh chỉnh lại mức cộng điểm kèo nhà cái phù hợp hơn, cân bằng với chỉ số thực tế
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
        oddsBonus = 10.0;
        oddsNotes.push(`Line Over giữ mức cao (${overLine}) so với tổng ${currentTotalGoals} bàn`);
    } else if (pointDiff > 0) {
        oddsBonus = 6.0;
        oddsNotes.push(`Line Over (${overLine}) sát mốc nổ bàn`);
    }

    if (price <= 1.35) {
        oddsBonus += 12.0;
        oddsNotes.push(`Odds Over rất thấp (${price}) - Dòng tiền tài cực mạnh`);
    } else if (price <= 1.55) {
        oddsBonus += 8.0;
        oddsNotes.push(`Odds Over giảm sâu (${price})`);
    } else if (price <= 1.80) {
        oddsBonus += 5.0;
        oddsNotes.push(`Odds Over ổn định (${price})`);
    } else {
        oddsBonus += 2.0;
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
// 7. THUẬT TOÁN AI & ĐỌC VỊ DỰ ĐOÁN TỶ SỐ (ĐỒNG BỘ NỔ BÀN)
// ==========================================
function evaluateMatchDynamicAI(metrics, oddsAnalysis, currentHomeScore, currentAwayScore) {
    let matchAnalysis = [];
    let aiPercentage = 35.0; // Mốc khởi đầu nền

    const stats = metrics.sofaStats || {};
    let hasTacticalData = false;

    let homePossNum = 50, awayPossNum = 50;
    if (stats.possession) {
        matchAnalysis.push(`📊 Tỷ lệ kiểm soát bóng: ${stats.possession}`);
        const possParts = stats.possession.split('-');
        if (possParts.length === 2) {
            homePossNum = parseInt(possParts[0].trim(), 10) || 50;
            awayPossNum = parseInt(possParts[1].trim(), 10) || 50;
            const maxPoss = Math.max(homePossNum, awayPossNum);

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

    if (stats.redCards > 0) {
        aiPercentage += 15.0;
        matchAnalysis.push(`🟥 Thẻ đỏ (${stats.redCards} thẻ - cộng thêm 15.0%)`);
        hasTacticalData = true;
    }

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

    if (stats.corners >= 8) {
        aiPercentage += 12.0;
        matchAnalysis.push(`🚩 Sức ép phạt góc lớn: ${stats.corners} quả (Cộng thêm 12.0%)`);
        hasTacticalData = true;
    } else if (stats.corners >= 4) {
        aiPercentage += 6.0;
        matchAnalysis.push(`🚩 Phạt góc ổn định: ${stats.corners} quả (Cộng thêm 6.0%)`);
        hasTacticalData = true;
    }

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

    // --- LOGIC ĐỌC VỊ TỶ SỐ ĐỒNG BỘ VỚI KÈO NỔ BÀN ---
    let predictedHome = currentHomeScore;
    let predictedAway = currentAwayScore;
    let predictionNote = "Thế trận sáng nước, dự kiến nổ thêm bàn thắng.";

    // Nếu bot đã kết luận trận đấu có khả năng nổ bàn (shouldSend = true) 
    // và dòng tiền nhà cái / kèo Over cao hơn tổng tỷ số hiện tại -> Đảm bảo dự đoán tỷ số chung cuộc phải tăng lên
    if (shouldSend) {
        if (oddsAnalysis && oddsAnalysis.line > (currentHomeScore + currentAwayScore)) {
            // Dựa vào đội đang kiểm soát bóng tốt hơn hoặc ngẫu nhiên cộng thêm 1 bàn phản ánh việc nổ bàn
            if (homePossNum >= awayPossNum) {
                predictedHome += 1;
            } else {
                predictedAway += 1;
            }
            predictionNote = `Kèo và thế trận ủng hộ nổ tài, dự báo tỷ số được nới rộng lên ${predictedHome}-${predictedAway}.`;
        } else {
            // Mặc định cộng 1 bàn chia đều cho thế trận ép cuối trận
            predictedHome += 1;
            predictionNote = "Áp lực dồn dập cuối trận, khả năng xuất hiện thêm bàn thắng.";
        }
    }

    const predictedScoreStr = `${predictedHome} - ${predictedAway}`;

    return {
        efficiency: finalPercentage,
        detailText: matchAnalysis.map(t => `• ${t}`).join('\n'),
        shouldSend,
        prediction: {
            score: predictedScoreStr,
            note: predictionNote
        }
    };
}

// ==========================================
// 8. THÔNG BÁO TELEGRAM
// ==========================================
async function sendTelegramAlert(item) {
    const timeDisplay = `Phút ${item.elapsed}'`;
    const message = 
`🔔 RUNG CHUỔNG VÀNGGGG
🏆 Giải đấu: ${item.league}
⚔️ Trận đấu: ${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}
⏱ Thời gian: ${timeDisplay}

⚽ DIỄN BIẾN TỶ SỐ THEO PHÚT:
${item.goalTimeline}

📊 TỔNG HỢP THẾ TRẬN & DÒNG TIỀN:
${item.detailText}

🔮 ĐỌC VỊ & DỰ ĐOÁN TỶ SỐ:
• Dự kiến chung cuộc: [ ${item.prediction.score} ]
• Nhận định: ${item.prediction.note}

📈 Hiệu suất Rule: ${item.ruleEfficiency}%`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log(`        └─> [Telegram Success] Đã gửi thông báo: ${item.homeName} vs ${item.awayName} - Dự đoán: ${item.prediction.score} (${item.ruleEfficiency}%)`);
        sentAlerts.add(item.id);
    } catch (err) {
        console.error('        └─> [Telegram Error]:', err.message);
    }
}

// ==========================================
// 9. TIẾN TRÌNH QUÉT TỰ ĐỘNG (TỪ PHÚT 50 ĐẾN 92', KHÔNG HT)
// ==========================================
async function scanLiveMatches() {
    const currentVN = getVietnamTime();
    console.log(`\n==================================================`);
    console.log(`[Auto-Scan AI] Đang quét trận đấu... (${currentVN.timeStr})`);

    try {
        const [allOdds, sofaMatches] = await Promise.all([
            fetchOddsData(),
            fetchSofaScoreLive()
        ]);

        for (let index = 0; index < sofaMatches.length; index++) {
            const item = sofaMatches[index];
            const matchId = String(item.id);
            const elapsed = calculateExactMinute(item);
            const homeName = item.homeTeam?.name || 'Đội nhà';
            const awayName = item.awayTeam?.name || 'Đội khách';
            const homeScore = item.homeScore?.current ?? 0;
            const actualAwayScore = item.awayScore?.current ?? 0;
            const league = parseLeagueName(item);

            if (!matchId) continue;
            if (sentAlerts.has(matchId)) continue;

            if (isFilteredLeague(league, homeName, awayName)) {
                console.log(`[Trận #${index + 1}] [${league}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Giải trẻ/Phụ`);
                continue;
            }

            const numericElapsed = typeof elapsed === 'number' ? elapsed : parseInt(elapsed, 10);

            // THAY ĐỔI MỚI: Chỉ quét từ phút 50 đến 92 (bỏ qua dưới phút 50, bỏ qua HT)
            if (isNaN(numericElapsed) || numericElapsed < 50 || numericElapsed > 92) {
                const timeLabel = (elapsed === 'HT' || elapsed === 999) ? elapsed : `${elapsed}'`;
                console.log(`[Trận #${index + 1}] [Phút: ${timeLabel}] [${league}] ${homeName} vs ${awayName} └─> [Bỏ qua]: Ngoài khung quét (50-92') hoặc HT`);
                continue;
            }

            console.log(`[Đang Phân Tích AI] [ID: ${matchId}] [Phút: ${numericElapsed}'] [${league}] ${homeName} ${homeScore}-${actualAwayScore} ${awayName}`);

            const metrics = await fetchMatchDetailStats(matchId);
            const oddsAnalysis = analyzeOddsGoalProbability(allOdds, homeName, awayName, homeScore + actualAwayScore);
            const aiAnalysis = evaluateMatchDynamicAI(metrics, oddsAnalysis, homeScore, actualAwayScore);

            if (aiAnalysis.shouldSend) {
                const goalTimeline = await fetchMatchIncidents(matchId, homeScore, actualAwayScore);
                console.log(`    └─> [AI CHỌN NỔ BÀN] (${aiAnalysis.efficiency}%) - Dự đoán tỷ số: ${aiAnalysis.prediction.score}`);
                
                const pickItem = {
                    id: matchId,
                    league,
                    homeName,
                    awayName,
                    homeScore,
                    awayScore: actualAwayScore,
                    elapsed: numericElapsed,
                    goalTimeline,
                    detailText: aiAnalysis.detailText,
                    ruleEfficiency: aiAnalysis.efficiency,
                    prediction: aiAnalysis.prediction
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
    res.send('Football Live AI Scanner Service is Running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanLiveMatches();
    setInterval(scanLiveMatches, 3 * 60 * 1000);
});