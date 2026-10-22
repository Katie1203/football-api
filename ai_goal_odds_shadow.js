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

// Train on completed fixtures only. One snapshot per fixture, chronologically split.
const sigmoid = x => 1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
const clip = p => Math.max(.01,Math.min(.99,p));
const logit = p => Math.log(p/(1-p));
function features(row) {
  const a=Number(row.aiGoalV4Percent),b=Number(row.marketImpliedPercent);
  if (!(a>0&&a<100&&b>0&&b<100)) return null;
  return [1,logit(clip(a/100)),logit(clip(b/100))];
}
function train(rows) {
  const sorted=[...rows].filter(r=>[0,1].includes(r.outcome)&&features(r))
    .sort((a,b)=>String(a.observedAt).localeCompare(String(b.observedAt)));
  const unique=[...new Map(sorted.map(r=>[String(r.fixtureId),r])).values()];
  if(unique.length<60) return {ready:false,count:unique.length,reason:'NEED_60_SETTLED_FIXTURES'};
  const cut=Math.floor(unique.length*.8);
  const training=unique.slice(0,cut),test=unique.slice(cut);
  let w=[0,1,0];
  const reg=.015, lr=.045;
  for(let step=0;step<1600;step++){
    const grad=[0,0,0];
    for(const r of training) {
      const x=features(r),err=sigmoid(w.reduce((t,v,i)=>t+v*x[i],0))-r.outcome;
      for(let j=0;j<3;j++)grad[j]+=err*x[j];
    }
    for(let j=0;j<3;j++)w[j]-=lr*(grad[j]/training.length+(j===0?0:reg*w[j]));
  }
  const brier=(items,fn)=>items.reduce((a,r)=>a+(fn(r)-r.outcome)**2,0)/items.length;
  const modelBrier=brier(test,r=>sigmoid(w.reduce((t,v,i)=>t+v*features(r)[i],0)));
  const baselineBrier=brier(test,r=>clip(r.aiGoalV4Percent/100));
  const ready=modelBrier<baselineBrier;
  return {ready,count:unique.length,training:training.length,holdout:test.length,
    modelBrier:+modelBrier.toFixed(5),baselineBrier:+baselineBrier.toFixed(5),
    weights:ready?w:null,reason:ready?'VALIDATED':'NO_HOLDOUT_IMPROVEMENT'};
}
function predict(model,row) {
  const x=features(row);
  if(!model?.ready||!x)return null;
  return +(100*sigmoid(model.weights.reduce((t,v,i)=>t+v*x[i],0))).toFixed(2);
}
module.exports={evaluate,fairBinary,train,predict};

