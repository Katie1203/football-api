'use strict';
// Observable market movement, no invented probability or legacy AI outputs.
function decideLiveRung(match,market){
 const empty={level:null,reason:'Chưa có biến động Tài LIVE được xác nhận',overOdds:null};
 if(!market||!Array.isArray(market.changes))return empty;
 const quotes=(market.bookmakers||[]).filter(b=>Number.isFinite(b.overDecimal)&&Number.isFinite(b.line));
 const movements=market.changes.filter(c=>c.marketMove===true&&c.scoreChanged===false&&Number.isFinite(c.lineDelta)&&c.lineDelta>0);
 const independent=new Set(movements.map(c=>c.bookmakerId));
 const latest=quotes.sort((a,b)=>b.observedAt-a.observedAt)[0];
 const overOdds=latest?.overDecimal??null;
 // Two independently observed upward OU line moves are a distinct stronger signal.
 if(independent.size>=2)return {level:'BIG BET',reason:`${independent.size} nhà cái độc lập nâng mốc Tài, không do đổi tỷ số`,overOdds};
 if(independent.size>=1&&overOdds!==null&&overOdds>=1.5)return {level:'BET NHẸ TAY',reason:'Biến động tăng mốc Tài được quan sát trực tiếp',overOdds};
 return {...empty,overOdds};
}
module.exports={decideLiveRung};
