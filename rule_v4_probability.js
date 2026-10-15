'use strict';
// Data-trained Rule V4. No match minute, score gap, odds, or arbitrary score modifiers.
const fs = require('fs');
const path = require('path');
const FEATURES = [
  'sot_total','sot_max','shots_total','shots_max','corners_total','corners_max',
  'inside_total','inside_max','xg_total','xg_max','chances_total','chances_max',
  'possession_dominance','sot_per_shot','inside_per_shot','corners_per_shot',
  'sot_present','shots_present','corners_present','inside_present','xg_present',
  'chances_present','possession_present'
];
function features(stats) {
  const p = stats?._present || {};
  const pair = name => {
    if (p['home'+name] !== true || p['away'+name] !== true) return null;
    const a=Number(stats['home'+name]), b=Number(stats['away'+name]);
    return Number.isFinite(a)&&Number.isFinite(b)&&a>=0&&b>=0 ? [a,b] : null;
  };
  const shots=pair('TotalShots'), sot=pair('ShotsOnTarget'), corners=pair('Corners');
  const inside=pair('ShotsInsideBox'), xg=pair('ExpectedGoals'), chances=pair('BigChances'), poss=pair('Possession');
  const sum=x=>x?x[0]+x[1]:0, max=x=>x?Math.max(...x):0;
  const goodSot=!!(sot&&(!shots||sot.every((v,i)=>v<=shots[i])));
  const goodInside=!!(inside&&(!shots||inside.every((v,i)=>v<=shots[i])));
  const s=goodSot?sot:null, ib=goodInside?inside:null;
  const totalShots=sum(shots);
  return [sum(s),max(s),sum(shots),max(shots),sum(corners),max(corners),
    sum(ib),max(ib),sum(xg),max(xg),sum(chances),max(chances),
    poss?Math.abs(poss[0]-poss[1]):0,
    shots&&s&&totalShots>0?sum(s)/totalShots:0,
    shots&&ib&&totalShots>0?sum(ib)/totalShots:0,
    shots&&corners&&totalShots>0?sum(corners)/totalShots:0,
    Number(!!s),Number(!!shots),Number(!!corners),Number(!!ib),
    Number(!!xg),Number(!!chances),Number(!!poss)];
}
function validateModel(m) {
  return !!(m && m.type==='rule_v4_logistic' && m.validation?.accepted===true &&
    JSON.stringify(m.features)===JSON.stringify(FEATURES) &&
    Array.isArray(m.weights)&&m.weights.length===FEATURES.length &&
    Array.isArray(m.means)&&m.means.length===FEATURES.length &&
    Array.isArray(m.stds)&&m.stds.length===FEATURES.length &&
    Number.isFinite(m.bias) && [...m.weights,...m.means,...m.stds].every(Number.isFinite) &&
    m.stds.every(v=>v>0));
}
function loadModel() {
  try {
    const m=JSON.parse(fs.readFileSync(path.join(__dirname,'rule_v4_model.json'),'utf8'));
    return validateModel(m)?m:null;
  } catch {return null;}
}
const model=loadModel();
function predict(stats) {
  if(!model)return null;
  const f=features(stats);
  if(!(f[16]&&f[17]))return null; // require valid SOT and Total Shots
  const z=model.weights.reduce((v,w,i)=>v+w*(f[i]-model.means[i])/model.stds[i],model.bias);
  const probability=1/(1+Math.exp(-Math.max(-35,Math.min(35,z))));
  return Number.isFinite(probability)?Math.round(probability*1000)/10:null;
}
module.exports={FEATURES,features,validateModel,predict,modelLoaded:!!model};
