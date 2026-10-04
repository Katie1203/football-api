const axios = require('axios');

// Lấy trực tiếp từ cấu hình hiện tại của bạn
const PAID_RAPIDAPI_KEY = '555e7a3fa7mshf8f27713bedc219p1fb72fjsnbf65b7120b2c';
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_LIVE_URL = `https://${SOFASCORE_HOST}/tournaments/get-live-events?sport=football`;

const ODDS_API_KEY = '0338c7727f7e9be5c773763cf65d25fb';
const ODDS_API_URL = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;

async function testAPIs() {
    console.log('--- BẮT ĐẦU KIỂM TRA KẾT NỐI API ---');

    // 1. Kiểm tra SofaScore (RapidAPI)
    try {
        console.log('\nĐang gọi SofaScore API...');
        const responseSofa = await axios.get(SOFASCORE_LIVE_URL, {
            headers: {
                'x-rapidapi-key': PAID_RAPIDAPI_KEY.trim(),
                'x-rapidapi-host': SOFASCORE_HOST
            },
            timeout: 10000
        });
        const events = responseSofa.data?.events || responseSofa.data?.liveEvents || [];
        console.log(`✅ SofaScore API THÀNH CÔNG! Lấy được ${events.length} sự kiện/trận đấu live.`);
        if (events.length > 0) {
            console.log(`   Ví dụ trận đầu tiên:`, events[0].homeTeam?.name, 'vs', events[0].awayTeam?.name);
        }
    } catch (err) {
        console.error('❌ SofaScore API THẤT BẠI:');
        if (err.response) {
            console.error(`   Status: ${err.response.status}`, err.response.data);
        } else {
            console.error(`   Error Message: ${err.message}`);
        }
    }

    // 2. Kiểm tra The-Odds-API
    try {
        console.log('\nĐang gọi The-Odds-API...');
        const responseOdds = await axios.get(ODDS_API_URL, { timeout: 10000 });
        console.log(`✅ The-Odds-API THÀNH CÔNG! Lấy được ${responseOdds.data?.length || 0} trận đấu.`);
    } catch (err) {
        console.error('❌ The-Odds-API THẤT BẠI:');
        if (err.response) {
            console.error(`   Status: ${err.response.status}`, err.response.data);
        } else {
            console.error(`   Error Message: ${err.message}`);
        }
    }
    console.log('\n--- HOÀN TẤT KIỂM TRA ---');
}

testAPIs();