 'use strict';
// Rule V4: regularized logistic probability fitted on settled historical alert snapshots.
// No odds, match minute, time remaining, score margin, ATT/DA or arbitrary Rule boosts.
const fs=require('fs'),path=require('path');
const FEATURES=['log_shots','log_sot','log_corners','shot_accuracy','sot_concentration','corner_per_shot','possession_imbalance','log_big_chances','big_chances_present'];
function features(stats){
  const present=stats?._present||{};
  const pair=name=>{
    const h='home'+name,a='away'+name;
    if(present[h]!==true||present[a]!==true)return null;
    const x=Number(stats[h]),y=Number(stats[a]);
    return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0?[x,y]:null;
  };
  const sh=pair('TotalShots'),so=pair('ShotsOnTarget'),co=pair('Corners'),po=pair('Possession'),bc=pair('BigChances');
  if(!sh||!so||so.some((v,i)=>v>sh[i]))return null;
  const n=sh[0]+sh[1],t=so[0]+so[1],c=co?co[0]+co[1]:0;
  return [Math.log1p(n),Math.log1p(t),Math.log1p(c),t/Math.max(n,1),Math.max(...so)/Math.max(t,1),c/Math.max(n,1),po?Math.abs(po[0]-po[1])/100:0,bc?Math.log1p(bc[0]+bc[1]):0,bc?1:0];
}
function valid(m){return !!(m&&m.type==='rule_v4_audit_logistic'&&JSON.stringify(m.features)===JSON.stringify(FEATURES)&&Number.isFinite(m.bias)&&['weights','means','stds'].every(k=>Array.isArray(m[k])&&m[k].length===FEATURES.length&&m[k].every(Number.isFinite))&&m.stds.every(v=>v>0));}
let model=null;
try{const m=JSON.parse(fs.readFileSync(path.join(__dirname,'rule_v4_model.json'),'utf8'));if(valid(m))model=m;}catch(e){console.warn('[RULE V4] model unavailable:',e.message);}
function predict(stats){
  if(!model)return null;
  const f=features(stats);if(!f)return null;
  const z=model.weights.reduce((s,w,i)=>s+w*(f[i]-model.means[i])/model.stds[i],model.bias);
  const p=1/(1+Math.exp(-Math.max(-35,Math.min(35,z))));
  return Number.isFinite(p)?Math.round(p*1000)/10:null;
}
module.exports={FEATURES,features,predict,modelLoaded:!!model};
