'use strict';
// Policy adapter ONLY: original sensitive model and market collector are byte-identical to supplied ZIP.
// Original pre-goal BIG BET is presented as BET NHẸ TAY; BIG BET only follows a newly detected goal.
const {decideLiveRung}=require('./live_rung_decision');
function decideWithGoalPolicy(match,market,at=Date.now(),options={}){
 const quote=(market?.bookmakers||[]).find(b=>String(b.bookmakerId)==='2');
 const overOdds=quote?.overDecimal??null,line=quote?.line??null;
 if(options.justScored){
  const recent=(market?.changes||[]).filter(c=>String(c.bookmakerId)==='2'&&c.marketMove===true&&!c.scoreChanged&&c.previous&&Number.isFinite(c.observedAt)&&at>=c.observedAt&&at-c.observedAt<=30000&&c.homeScore===match?.homeScore&&c.awayScore===match?.awayScore);
  const rising=recent.some(c=>c.lineDelta>0);
  const shortening=recent.some(c=>c.lineDelta===0&&c.overPriceDelta<0);
  if(rising&&shortening&&overOdds!==null&&overOdds>1.50)return {level:'BIG BET',reason:'Sau bàn thắng mới: mốc Tài tăng và giá Tài giảm tại tỷ số mới',overOdds,line,evidence:{postGoalMoves:recent.length}};
  return {level:null,reason:'Chưa đủ xác nhận biến động hậu bàn thắng cho BIG BET',overOdds,line};
 }
 // Never carry a previous score's market changes into the current-score decision.
 const changes=(market?.changes||[]).filter(c=>!Number.isInteger(match?.homeScore)||!Number.isInteger(match?.awayScore)||(c.homeScore===match.homeScore&&c.awayScore===match.awayScore));
 const result=decideLiveRung(match,market?{...market,changes}:market,at);
 if(result.level==='BIG BET')return {...result,level:'BET NHẸ TAY',line,reason:result.reason+' (tín hiệu nhạy trước bàn thắng)'};
 return {...result,line};
}
module.exports={decideWithGoalPolicy};
