'use strict';
// Stage 1: learn Rule V4 + four scenario families.
// Stage 2: learn AI Goal calibration using upgraded V4.
// Stage 3: evaluate both stages on untouched later matches.
const fs=require('fs');
const rule=require('./rule_v4_probability');
const goal=require('./ai_goal_v4');
const pipeline=require('./v4_ai_goal_pipeline');
const scenarios=require('./v4_goal_scenarios');
const sigmoid=z=>1/(1+Math.exp(-Math.max(-35,Math.min(35,z))));
const logit=p=>Math.log(Math.max(.001,Math.min(.999,p))/(1-Math.max(.001,Math.min(.999,p))));
const brier=rows=>rows.reduce((s,r)=>s+(r.y-r.p)**2,0)/rows.length;
function fit(rows){
 const d=rows[0].x.length,n=rows.length;
 const means=Array.from({length:d},(_,j)=>rows.reduce((s,r)=>s+r.x[j],0)/n);
 const stds=means.map((v,j)=>Math.max(1e-4,Math.sqrt(rows.reduce((s,r)=>s+(r.x[j]-v)**2,0)/n)));
 const xx=rows.map(r=>r.x.map((v,j)=>(v-means[j])/stds[j]));
 let bias=logit(Math.max(.02,Math.min(.98,rows.reduce((s,r)=>s+r.y,0)/n)));
 const weights=Array(d).fill(0);
 for(let step=0;step<1100;step++){
  const gw=Array(d).fill(0);let gb=0;
  for(let i=0;i<n;i++){
   const error=sigmoid(bias+weights.reduce((s,w,j)=>s+w*xx[i][j],0))-rows[i].y;
   gb+=error;for(let j=0;j<d;j++)gw[j]+=error*xx[i][j];
  }
  const rate=.09/Math.sqrt(1+step/150);
  bias-=rate*gb/n;
  for(let j=0;j<d;j++)weights[j]-=rate*(gw[j]/n+.12*weights[j]);
 }
 return {bias,weights,means,stds};
}
function statsFrom(row){
 const stats={_present:{}};
 for(const [k,v] of Object.entries(row.liveStats||{})){
  if(v!==null&&v!==''&&Number.isFinite(Number(v))){stats[k]=Number(v);stats._present[k]=true;}
 }
 return stats;
}
function rowFromAudit(r){
 if(!r.matchKey||!['WIN','LOSS'].includes(r.goalResult))return null;
 const stats=statsFrom(r),windows=r.trainingWindows||null;
 const originalRule=rule.predict(stats);
 const v=pipeline.vector(originalRule,stats,windows);
 const originalGoal=goal.predictBase(stats,originalRule,windows);
 if(!v||!originalGoal||originalGoal.percent==null)return null;
 return {matchKey:r.matchKey,createdAt:r.createdAt||'',stats,windows,x:v,y:r.goalResult==='WIN'?1:0,originalRule,originalGoal:originalGoal.percent};
}
let lastFingerprint='';
async function trainFromAudit(audit){
 const raw=await audit.getSettledTrainingRows();
 const byMatch=new Map();
 for(const r of raw.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))){
  if(byMatch.has(r.matchKey))continue;
  const row=rowFromAudit(r);if(row)byMatch.set(r.matchKey,row);
 }
 const rows=[...byMatch.values()];
 const fingerprint=rows.length+':'+rows.reduce((s,r)=>s+r.y,0)+':'+(rows.at(-1)?.createdAt||'');
 if(fingerprint===lastFingerprint)return;
 lastFingerprint=fingerprint;
 // Three nonoverlapping chronological partitions, never split one match across sets.
 if(rows.length<160){console.log(`[V4 GOAL TRAIN] ${rows.length}/160 settled first-alert matches; existing model unchanged`);return;}
 const cut1=Math.floor(rows.length*.55),cut2=Math.floor(rows.length*.8);
 const a=rows.slice(0,cut1),b=rows.slice(cut1,cut2),c=rows.slice(cut2);
 const bothClasses=r=>r.reduce((s,x)=>s+x.y,0)>=15&&r.reduce((s,x)=>s+1-x.y,0)>=15;
 if(!bothClasses(a)||!bothClasses(b)||!bothClasses(c)){
  console.log('[V4 GOAL TRAIN] Not enough confirmed WIN/LOSS diversity in chronological splits');return;
 }
 const v4=fit(a);
 const model={type:'v4_ai_goal_two_stage_v1',features:scenarios.FEATURES,v4,goal:null,validation:{accepted:true}};
 const stage2=[];
 for(const r of b){
  const improvedRule=100*pipeline.apply(v4,r.x);
  const rawGoal=goal.predictBase(r.stats,improvedRule,r.windows);
  const x=rawGoal?.percent==null?null:pipeline.vector(rawGoal.percent,r.stats,r.windows);
  if(x)stage2.push({x,y:r.y});
 }
 if(stage2.length<25||!bothClasses(stage2))return;
 model.goal=fit(stage2);
 const results=[];
 for(const r of c){
  const enhanced=pipeline.evaluate(model,r.stats,r.windows,r.originalRule);
  if(enhanced)results.push({y:r.y,p:enhanced.percent/100,baseline:r.originalGoal/100});
 }
 if(results.length<30)return;
 const alerts=results.filter(r=>r.p>.65),wins=alerts.reduce((s,r)=>s+r.y,0);
 const rate=alerts.length?wins/alerts.length:null;
 const newBrier=brier(results),oldBrier=brier(results.map(r=>({y:r.y,p:r.baseline})));
 const accepted=alerts.length>=20&&rate>=.65&&newBrier<oldBrier;
 console.log(`[V4 GOAL TRAIN] matches=${rows.length} holdout=${results.length} RUNG>65=${alerts.length} WIN=${wins} rate=${rate==null?'N/A':(rate*100).toFixed(1)+'%'} Brier old=${oldBrier.toFixed(4)} new=${newBrier.toFixed(4)} accepted=${accepted}`);
 if(!accepted)return;
 model.validation={accepted:true,holdout:results.length,alertsOver65:alerts.length,wins,winRate:rate,brierOld:oldBrier,brierNew:newBrier};
 model.training={matches:rows.length,stage1:a.length,stage2:stage2.length,stage3:results.length,createdAt:new Date().toISOString(),source:'confirmed_audit_first_alert'};
 // Persist first, then activate. If Render storage is ephemeral, re-train from audit on restart.
 try{fs.writeFileSync(pipeline.MODEL_FILE+'.tmp',JSON.stringify(model,null,2));fs.renameSync(pipeline.MODEL_FILE+'.tmp',pipeline.MODEL_FILE);}
 catch(e){console.warn('[V4 GOAL TRAIN] Could not persist model:',e.message);}
 pipeline.install(model);
}
module.exports={trainFromAudit};
