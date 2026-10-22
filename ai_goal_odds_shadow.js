'use strict';
// Independent experiment. No writes to production AI Goal, Rule or Telegram.
function fairBinary(over, under) {
  if (!(over > 1 && under > 1)) return null;
  const a=1/over,b=1/under;
  return {over: +(100*a/(a+b)).toFixed(2), under:+(100*b/(a+b)).toFixed(2)};
}
function evaluate(payload, goals, aiGoalPercent) {
  const markets = Array.isArray(payload?.response?.[0]?.odds) ? payload.response[0].odds : [];
  const valid = v => v?.suspended === false && Number(v.odd)>1;
  const market = id => markets.find(m => Number(m.id)===id);
  let derived=null, marketId=null, marketLabel=null;
  // For three goals already scored, 'No goal' in the fourth-goal market is
  // the direct complement of at least one more goal. Normalize all three prices.
  if (goals===3) {
    const values=(market(109)?.values||[]).filter(valid);
    const no=values.find(v=>String(v.value).toLowerCase()==='no goal');
    const home=values.find(v=>String(v.value)==='1');
    const away=values.find(v=>String(v.value)==='2');
    if (no && home && away) {
      const implied=[1/Number(home.odd),1/Number(away.odd),1/Number(no.odd)];
      derived=+(100*(implied[0]+implied[1])/implied.reduce((a,b)=>a+b,0)).toFixed(2);
      marketId=109;marketLabel='Fourth goal, normalized three-way';
    }
  }
  // Match Goals O/U (total goals ending with .5): no push, no quarter-line approximation.
  if (derived===null) {
    const line=(goals+0.5).toFixed(1);
    const values=(market(25)?.values||[]).filter(v=>valid(v)&&String(v.handicap)===line);
    const over=values.find(v=>v.value==='Over'),under=values.find(v=>v.value==='Under');
    const fair=fairBinary(Number(over?.odd),Number(under?.odd));
    if (fair) {derived=fair.over;marketId=25;marketLabel=`Match Goals O/U ${line}`;}
  }
  const status=payload?.response?.[0]?.status;
  const updatedAt=payload?.response?.[0]?.update||null;
  return {mode:'SHADOW_ONLY',calibrated:false,model:'MARKET_REFERENCE_UNTRAINED',
    probability:null,marketImpliedPercent:derived,aiGoalV4Percent:Number.isFinite(Number(aiGoalPercent))?Number(aiGoalPercent):null,
    marketId,marketLabel,oddsUpdate:updatedAt,stopped:status?.stopped??null,blocked:status?.blocked??null,
    note:derived===null?'No suitable complete, unsuspended next-goal market; no forecast.':'Market-implied reference only, NOT a trained AI Goal + Odds forecast.'};
}
module.exports={evaluate,fairBinary};
