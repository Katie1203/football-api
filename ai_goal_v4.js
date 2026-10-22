'use strict';
// AI Goal V4: conditional prediction based on Rule V4 probability.
// No change to Rule/Telegram gating. No arbitrary score/time/odds adjustments.
const fs=require('fs'),path=require('path');
const scenario=require('./v4_goal_scenarios');
const FEATURES=['sot_quality','shot_balance','sot_balance','corner_pressure','shot_quality_alignment','big_chances_total'];
const finite=x=>Number.isFinite(x);
const pair=(stats,name)=>{
  if(!stats || stats._present?.['home'+name]!==true || stats._present?.['away'+name]!==true)return null;
  const a=Number(stats['home'+name]),b=Number(stats['away'+name]);
  return finite(a)&&finite(b)&&a>=0&&b>=0?[a,b]:null;
};
function extract(stats){
  const shots=pair(stats,'TotalShots'),sot=pair(stats,'ShotsOnTarget'),corners=pair(stats,'Corners'),chances=pair(stats,'BigChances');
  if(!shots||!sot||sot.some((v,i)=>v>shots[i]))return null;
  const n=shots[0]+shots[1],t=sot[0]+sot[1],c=corners?corners[0]+corners[1]:0;
  return [t/Math.max(n,1),Math.abs(shots[0]-shots[1])/Math.max(n,1),
    Math.abs(sot[0]-sot[1])/Math.max(t,1),c/Math.max(n,1),
    Math.abs(sot[0]/Math.max(shots[0],1)-sot[1]/Math.max(shots[1],1)),
    chances?chances[0]+chances[1]:0];
}
function valid(m){
  return !!(m&&m.type==='ai_goal_v4_rule_conditional'&&JSON.stringify(m.features)===JSON.stringify(FEATURES)&&
    finite(m.bias)&&['weights','means','stds'].every(k=>Array.isArray(m[k])&&m[k].length===FEATURES.length&&m[k].every(finite))&&m.stds.every(s=>s>0));
}
let model=null;
try{
  const candidate=JSON.parse(fs.readFileSync(path.join(__dirname,'ai_goal_v4_model.json'),'utf8'));
  if(valid(candidate))model=candidate;
  else console.warn('[AI GOAL V4] Invalid conditional model');
}catch(err){console.warn('[AI GOAL V4] Model unavailable:',err.message);}
function teamAnalysis(stats){
  const shots=pair(stats,'TotalShots'),sot=pair(stats,'ShotsOnTarget'),corners=pair(stats,'Corners');
  const chances=pair(stats,'BigChances'),xg=pair(stats,'ExpectedGoals'),inside=pair(stats,'ShotsInsideBox');
  const observations=[];
  for(const [name,v] of [['SOT',sot],['Shots',shots],['Corners',corners],['Big Chances',chances],['xG',xg],['Inside Box',inside]]){
    if(v)observations.push(`${name} ${v[0]}-${v[1]}`);
  }
  // No numeric team-scoring probability without a trained team-specific model.
  // Team direction is only a descriptive evidence tally.
  let home=0,away=0;
  for(const v of [sot,chances,xg,inside]){
    if(!v||v[0]===v[1])continue;
    if(v[0]>v[1])home++;else away++;
  }
  const teamLean=home>away?'HOME':away>home?'AWAY':'UNDETERMINED';
  return {teamLean,evidence:observations.join(' | ')||'Chưa đủ thống kê'};
}
// Optional independently validated scenario calibration. Without a verified model,
// preserve the original AI Goal exactly (no speculative boosts).
let enhanced=null;
try {
  const m=JSON.parse(fs.readFileSync(path.join(__dirname,'ai_goal_v4_scenario_model.json'),'utf8'));
  if(m.type==='ai_goal_v4_scenario_calibration_v1' && m.validation?.accepted===true &&
     JSON.stringify(m.features)===JSON.stringify(scenario.FEATURES) &&
     Array.isArray(m.weights)&&m.weights.length===scenario.FEATURES.length+1 &&
     m.weights.every(Number.isFinite)&&Number.isFinite(m.bias)&&
     Array.isArray(m.means)&&m.means.length===m.weights.length&&m.means.every(Number.isFinite)&&
     Array.isArray(m.stds)&&m.stds.length===m.weights.length&&m.stds.every(v=>Number.isFinite(v)&&v>0))enhanced=m;
} catch(_) { /* No validated model installed: use existing AI Goal. */ }
function installScenarioModel(m){
  if(m && m.type==='ai_goal_v4_scenario_calibration_v1' && m.validation?.accepted===true &&
     JSON.stringify(m.features)===JSON.stringify(scenario.FEATURES) &&
     Array.isArray(m.weights) && m.weights.length===scenario.FEATURES.length+1 &&
     m.weights.every(Number.isFinite) && Number.isFinite(m.bias) &&
     Array.isArray(m.means) && m.means.length===m.weights.length && m.means.every(Number.isFinite) &&
     Array.isArray(m.stds) && m.stds.length===m.weights.length && m.stds.every(v=>Number.isFinite(v)&&v>0)){
    enhanced=m;return true;
  }
  return false;
}
function predict(stats,rulePercent,windows,baseOnly=false){
  if(rulePercent===null||rulePercent===undefined||rulePercent==='')return null;
  const rule=Number(rulePercent);
  if(!finite(rule)||rule<0||rule>100)return null;
  const f=extract(stats);
  if(!model||!f)return null;
  const prior=Math.max(.001,Math.min(.999,rule/100));
  let z=Math.log(prior/(1-prior))+model.bias;
  for(let i=0;i<f.length;i++)z+=model.weights[i]*(f[i]-model.means[i])/model.stds[i];
  const p=1/(1+Math.exp(-Math.max(-35,Math.min(35,z))));
  const details=teamAnalysis(stats);
  const sf=enhanced&&!baseOnly?scenario.extract(stats,windows):null;
  if(enhanced&&sf){
    const v=[Math.log(Math.max(.001,Math.min(.999,p))/(1-Math.max(.001,Math.min(.999,p)))),...sf];
    const z2=enhanced.weights.reduce((acc,w,i)=>acc+w*(v[i]-enhanced.means[i])/enhanced.stds[i],enhanced.bias);
    const ep=100/(1+Math.exp(-Math.max(-35,Math.min(35,z2))));
    return {percent:Math.round(ep*10)/10,ruleScore:rule,delta:Math.round((ep-rule)*10)/10,
      source:'ai-goal-v4-scenario-calibrated',label:'AI Goal V4 + 4 nhóm (đã kiểm định ngoại tuyến)',
      calibrated:true,teamLean:details.teamLean,evidence:details.evidence,availableGroups:5};
  }
  return {percent:Math.round(p*1000)/10,ruleScore:rule,delta:Math.round((p*100-rule)*10)/10,
    source:'ai-goal-v4-rule-conditional',label:'AI Goal V4 (Rule + phân tích bổ sung; chưa hiệu chuẩn độc lập)',
    calibrated:false,teamLean:details.teamLean,evidence:details.evidence,availableGroups:5};
}
module.exports={predict,predictBase:(stats,rulePercent,windows)=>predict(stats,rulePercent,windows,true),teamAnalysis,modelLoaded:!!model,scenarioModelLoaded:!!enhanced,installScenarioModel,FEATURES};
