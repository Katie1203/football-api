'use strict';
// Market-direction analysis, without fixed counts of line changes.
// Only comparable, score-stable, fresh BET365 snapshots are considered.
function decideLiveRung(match,market,at=Date.now(),options={}){
 const empty={level:null,reason:'Chưa có bằng chứng biến động Tài LIVE đủ rõ',overOdds:null};
 if(!market)return empty;
 const quote=(market.bookmakers||[]).find(b=>String(b.bookmakerId)==='2');
 const overOdds=quote?.overDecimal??null;
 const line=quote?.line??null;
 const recent=(market.changes||[]).filter(c=>String(c.bookmakerId)==='2'&&c.marketMove===true&&!c.scoreChanged&&
  Number.isFinite(c.observedAt)&&at>=c.observedAt&&at-c.observedAt<=300000&&c.previous&&
  (options.justScored||!Number.isInteger(match?.homeScore)||!Number.isInteger(match?.awayScore)||(c.homeScore===match.homeScore&&c.awayScore===match.awayScore)));
 if(options.justScored){
  // Analyze only fresh, score-matched post-goal movements. Never recycle pre-goal evidence.
  const postGoal=recent.filter(c=>c.observedAt>=at-30000&&c.homeScore===match.homeScore&&c.awayScore===match.awayScore);
  const rising=postGoal.some(c=>c.lineDelta>0);
  const shortening=postGoal.some(c=>c.lineDelta===0&&c.overPriceDelta<0);
  if(rising&&shortening)return {level:'BIG BET',reason:'Sau bàn thắng mới: mốc Tài tăng và giá Tài giảm tại tỷ số mới',overOdds,line,evidence:{postGoalMoves:postGoal.length}};
  return {...empty,reason:'BIG BET đã kích hoạt sau GOAL nhưng chưa có xác nhận biến động hậu bàn thắng',overOdds,line};
 }
 if(!recent.length)return {...empty,overOdds,line};
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
 if(!bullish)return {...empty,overOdds,line,evidence};
 // BIG BET requires corroboration across line and price, rather than an arbitrary number of changes.
 const corroborated=lineUp>lineDown&&overShortening>overDrifting&&overShortening>0;
 if(overOdds!==null&&overOdds>=1.50)
  return {level:'BET NHẸ TAY',reason:lineUp>lineDown?'BET365 có xu hướng nâng mốc Tài':'BET365 giảm odds Tài tại cùng mốc',overOdds,line,evidence};
 return {...empty,overOdds,line,evidence};
}
module.exports={decideLiveRung};
