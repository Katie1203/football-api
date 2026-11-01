'use strict';
// Restore the original sensitive market-direction decision from the supplied ZIP.
// Only the already-approved post-goal BIG BET branch is kept separate.
const {decideLiveRung: originalSensitiveDecision}=require('./live_rung_decision_sensitive_original');
function decideLiveRung(match,market,at=Date.now(),options={}){
 const quote=(market?.bookmakers||[]).find(b=>String(b.bookmakerId)==='2');
 const overOdds=quote?.overDecimal??null;
 const line=quote?.line??null;
 if(options.justScored){
  const recent=(market?.changes||[]).filter(c=>String(c.bookmakerId)==='2'&&c.marketMove===true&&!c.scoreChanged&&c.previous&&Number.isFinite(c.observedAt)&&at>=c.observedAt&&at-c.observedAt<=30000&&c.homeScore===match?.homeScore&&c.awayScore===match?.awayScore);
  const rising=recent.some(c=>c.lineDelta>0);
  const shortening=recent.some(c=>c.lineDelta===0&&c.overPriceDelta<0);
  if(rising&&shortening&&overOdds!==null&&overOdds>1.50)
   return {level:'BIG BET',reason:'Sau bàn thắng mới: mốc Tài tăng và giá Tài giảm tại tỷ số mới',overOdds,line,evidence:{postGoalMoves:recent.length}};
  return {level:null,reason:'Chưa đủ xác nhận biến động hậu bàn thắng cho BIG BET',overOdds,line};
 }
 // Do not recycle pre-goal trends after the score changes.
 const scoreMatched=(market?.changes||[]).filter(c=>!Number.isInteger(match?.homeScore)||!Number.isInteger(match?.awayScore)||(c.homeScore===match.homeScore&&c.awayScore===match.awayScore));
 const result=originalSensitiveDecision(match,market?{...market,changes:scoreMatched}:market,at);
 // The original model emitted BIG BET before a goal. Preserve its sensitivity
 // as BET NHẸ TAY without violating the approved post-goal-only BIG BET rule.
 if(result.level==='BIG BET')return {...result,level:'BET NHẸ TAY',line,reason:result.reason+' (tín hiệu sớm)'};
 return {...result,line};
}
module.exports={decideLiveRung};
