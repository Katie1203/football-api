'use strict';
// Calibrate the existing Poisson baseline from first-at-observation FT snapshots.
// Never use live-updated records, FT score or any future feature for prediction.
const clip = x => Math.max(0.001, Math.min(0.999, x));
const logit = p => Math.log(clip(p)/(1-clip(p)));
const sigmoid = x => 1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
const brier = (rows,fn) => rows.reduce((s,r)=>s+(fn(r)-r.outcome)**2,0)/rows.length;
function eligibleRows(rows) {
  const seen=new Set();
  return (Array.isArray(rows)?rows:[]).filter(r=>{
    if(!r||!r.fixtureId||![0,1].includes(r.outcome)||r.probability==null||
      !Number.isFinite(Number(r.probability))||Number(r.probability)<=0||Number(r.probability)>=100||
      !Number.isFinite(Date.parse(r.observedAt)))return false;
    return true;
  }).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)).filter(r=>{
    const key=String(r.fixtureId);if(seen.has(key))return false;seen.add(key);return true;
  });
}
function train(rows) {
  const data=eligibleRows(rows);
  const pending={ready:false,count:data.length,minSamples:100,reason:'NEED_100_VALID_FT_SNAPSHOTS'};
  if(data.length<100)return pending;
  const split=Math.floor(data.length*.8),training=data.slice(0,split),holdout=data.slice(split);
  // Fit an intercept and slope to baseline log odds; L2 regularization anchors to baseline.
  let intercept=0,slope=1;
  for(let epoch=0;epoch<1200;epoch++){
    let g0=0,g1=0;
    for(const r of training){const x=logit(Number(r.probability)/100),e=sigmoid(intercept+slope*x)-r.outcome;g0+=e;g1+=e*x;}
    const rate=.025;
    intercept-=rate*(g0/training.length+.05*intercept);
    slope-=rate*(g1/training.length+.05*(slope-1));
  }
  const base=brier(holdout,r=>Number(r.probability)/100);
  const learned=brier(holdout,r=>sigmoid(intercept+slope*logit(Number(r.probability)/100)));
  // Require meaningful improvement on untouched chronological holdout.
  const ready=learned+0.002<base;
  return {ready,count:data.length,training:training.length,holdout:holdout.length,
    baselineBrier:+base.toFixed(5),modelBrier:+learned.toFixed(5),
    weights:ready?{intercept:+intercept.toFixed(8),slope:+slope.toFixed(8)}:null,
    reason:ready?'VALIDATED_HOLDOUT_IMPROVEMENT':'NO_HOLDOUT_IMPROVEMENT'};
}
function predict(model,baseline){
  if(!model?.ready||baseline==null||!(Number(baseline)>0&&Number(baseline)<100))return null;
  return +(100*sigmoid(model.weights.intercept+model.weights.slope*logit(Number(baseline)/100))).toFixed(1);
}
module.exports={train,predict,eligibleRows};
