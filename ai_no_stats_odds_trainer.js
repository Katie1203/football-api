'use strict';
// Shadow-only, binary outcome: >=1 goal AFTER the stored snapshot.
// Each fixture contributes its first eligible snapshot; no look-ahead features.
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
const clip=x=>Math.max(.01,Math.min(.99,x));
const logit=x=>Math.log(clip(x)/(1-clip(x)));
function features(row){
  const a=Number(row.probability),b=Number(row.marketImpliedPercent);
  if(row.probability==null||row.marketImpliedPercent==null||!(a>0&&a<100&&b>0&&b<100))return null;
  return [1,logit(a/100),logit(b/100)];
}
function train(rows){
  const eligible=rows.filter(r=>r.fixtureId&&[0,1].includes(r.outcome)&&features(r))
    .sort((a,b)=>String(a.observedAt).localeCompare(String(b.observedAt)));
  const unique=[...new Map([...eligible].reverse().map(r=>[String(r.fixtureId),r])).values()].reverse();
  if(unique.length<60)return {ready:false,count:unique.length,reason:'NEED_60_SETTLED_FIXTURES'};
  const split=Math.floor(unique.length*.8),training=unique.slice(0,split),holdout=unique.slice(split);
  const w=[0,1,0],lambda=.015,rate=.04;
  for(let epoch=0;epoch<1800;epoch++){
    const grad=[0,0,0];
    for(const r of training){const x=features(r);const err=sigmoid(w.reduce((sum,v,i)=>sum+v*x[i],0))-r.outcome;
      for(let i=0;i<3;i++)grad[i]+=err*x[i];}
    for(let i=0;i<3;i++)w[i]-=rate*(grad[i]/training.length+(i===0?0:lambda*w[i]));
  }
  const brier=(items,fn)=>items.reduce((sum,r)=>sum+(fn(r)-r.outcome)**2,0)/items.length;
  const modelBrier=brier(holdout,r=>sigmoid(w.reduce((sum,v,i)=>sum+v*features(r)[i],0)));
  const baselineBrier=brier(holdout,r=>Number(r.probability)/100);
  const marketBrier=brier(holdout,r=>Number(r.marketImpliedPercent)/100);
  const ready=modelBrier<baselineBrier&&modelBrier<marketBrier;
  return {ready,count:unique.length,training:training.length,holdout:holdout.length,
    modelBrier:+modelBrier.toFixed(5),baselineBrier:+baselineBrier.toFixed(5),marketBrier:+marketBrier.toFixed(5),
    weights:ready?w:null,reason:ready?'VALIDATED':'NO_HOLDOUT_IMPROVEMENT'};
}
function predict(model,row){const x=features(row);if(!x)return null;
  if(!model?.ready)return +(100*sigmoid(0.5*x[1]+0.5*x[2])).toFixed(2); // provisional log-odds pool, uncalibrated
  return +(100*sigmoid(model.weights.reduce((sum,v,i)=>sum+v*x[i],0))).toFixed(2);}
module.exports={train,predict,features};
