'use strict';
// Market-direction analysis, without fixed counts of line changes.
// Only comparable, score-stable, fresh BET365 snapshots are considered.
function decideLiveRung(match,market,at=Date.now()){
 const empty={level:null,reason:'Chưa có bằng chứng biến động Tài LIVE đủ rõ',overOdds:null};
 if(!market)return empty;
 const quote=(market.bookmakers||[]).find(b=>String(b.bookmakerId)==='2');
 const overOdds=quote?.overDecimal??null;
 const recent=(market.changes||[]).filter(c=>String(c.bookmakerId)==='2'&&c.marketMove===true&&!c.scoreChanged&&
  Number.isFinite(c.observedAt)&&at>=c.observedAt&&at-c.observedAt<=300000&&c.previous);
 if(!recent.length)return {...empty,overOdds};
 // Compare movement at the same score; price changes across different lines are not comparable.
 let lineUp=0,lineDown=0,overShortening=0,overDrifting=0,underShortening=0;
 for(const c of recent){
  if(Number.isFinite(c.lineDelta)){if(c.lineDelta>0)lineUp+=c.lineDelta;else if(c.lineDelta<0)lineDown-=c.lineDelta;}
  if(c.lineDelta===0&&Number.isFinite(c.overPriceDelta)){
   if(c.overPriceDelta<0)overShortening+=-c.overPriceDelta;
   else if(c.overPriceDelta>0)overDrifting+=c.overPriceDelta;
   const underDelta=Number(c.underRaw)-Number(c.previous.underRaw);
   if(Number.isFinite(underDelta)&&underDelta<0)underShortening+=-underDelta;
  }
 }
 const evidence={lineUp,lineDown,overShortening,overDrifting,underShortening,observations:recent.length};
 const bullish=lineUp>lineDown || (lineUp===lineDown&&overShortening>overDrifting&&overShortening>0);
 if(!bullish)return {...empty,overOdds,evidence};
 // BIG BET requires corroboration across line and price, rather than an arbitrary number of changes.
 const corroborated=lineUp>lineDown&&overShortening>overDrifting&&overShortening>0;
 if(corroborated&&overOdds!==null&&overOdds>1.50)
  return {level:'BIG BET',reason:'BET365 đồng thời nâng mốc Tài và giảm odds Tài',overOdds,evidence};
 if(overOdds===null||overOdds>=1.50)
  return {level:'BET NHẸ TAY',reason:lineUp>lineDown?'BET365 có xu hướng nâng mốc Tài':'BET365 giảm odds Tài tại cùng mốc',overOdds,evidence};
 return {...empty,overOdds,evidence};
}
module.exports={decideLiveRung};
