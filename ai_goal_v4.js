'use strict';
// AI Goal V4: conditional prediction based on Rule V4 probability.
// No change to Rule/Telegram gating. No arbitrary score/time/odds adjustments.
const fs=require('fs'),path=require('path');
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
function predict(stats,rulePercent){
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
  return {percent:Math.round(p*1000)/10,ruleScore:rule,delta:Math.round((p*100-rule)*10)/10,
    source:'ai-goal-v4-rule-conditional',label:'AI Goal V4 (Rule + phân tích bổ sung; chưa hiệu chuẩn độc lập)',
    calibrated:false,teamLean:details.teamLean,evidence:details.evidence,availableGroups:5};
}
module.exports={predict,teamAnalysis,modelLoaded:!!model,FEATURES};
