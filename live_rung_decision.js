'use strict';
// Single bookmaker BET365; never require cross-bookmaker consensus.
function decideLiveRung(match,market){
 const empty={level:null,reason:'Chưa đủ biến động kèo Tài LIVE BET365',overOdds:null};
 if(!market)return empty;
 const quote=(market.bookmakers||[]).find(b=>String(b.bookmakerId)==='2');
 const overOdds=quote?.overDecimal??null;
 const changes=(market.changes||[]).filter(c=>String(c.bookmakerId)==='2'&&c.marketMove&&!c.scoreChanged&&Number.isFinite(c.lineDelta)&&c.lineDelta>0);
 // Restore the original BET365 same-line Over-odds shortening evidence.
 // Detection is independent of Telegram's minimum-odds send gate.
 if(!changes.length){
  const priceChanges=(market.changes||[]).filter(c=>String(c.bookmakerId)==='2'&&c.marketMove===true&&!c.scoreChanged&&c.previous&&
   c.lineDelta===0&&Number.isFinite(c.overPriceDelta)&&c.overPriceDelta<0&&
   Number.isFinite(c.observedAt)&&Date.now()>=c.observedAt&&Date.now()-c.observedAt<=300000);
  if(priceChanges.length)return {level:'BET NHẸ TAY',reason:'BET365 giảm odds Tài tại cùng mốc',overOdds};
  return {...empty,overOdds};
 }
 const recent=changes.filter(c=>Date.now()-c.observedAt<=300000);
 if(recent.length>=2&&overOdds!==null&&overOdds>1.50)return {level:'BIG BET',reason:'BET365 nâng mốc Tài nhiều lần trong 5 phút',overOdds};
 if(recent.length>=1&&(overOdds===null||overOdds>=1.50))return {level:'BET NHẸ TAY',reason:'BET365 tăng mốc Tài LIVE',overOdds};
 return {...empty,overOdds};
}
module.exports={decideLiveRung};
