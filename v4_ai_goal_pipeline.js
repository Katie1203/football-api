'use strict';
// Optional two-stage validated pipeline. The original Rule V4 and AI Goal remain
// untouched until an independent chronological holdout approves BOTH stages.
const fs=require('fs'),path=require('path');
const rule=require('./rule_v4_probability');
const goal=require('./ai_goal_v4');
const scenarios=require('./v4_goal_scenarios');
const MODEL_FILE=path.join(__dirname,'v4_ai_goal_pipeline_model.json');
const sigmoid=z=>1/(1+Math.exp(-Math.max(-35,Math.min(35,z))));
const logit=p=>Math.log(Math.max(.001,Math.min(.999,p))/(1-Math.max(.001,Math.min(.999,p))));
const vector=(p,stats,windows)=>{
 const sf=scenarios.extract(stats,windows);
 return sf&&Number.isFinite(p)&&p>0&&p<100?[logit(p/100),...sf]:null;
};
const validPart=m=>m&&Number.isFinite(m.bias)&&['weights','means','stds'].every(k=>Array.isArray(m[k])&&m[k].length===scenarios.FEATURES.length+1&&m[k].every(Number.isFinite))&&m.stds.every(x=>x>0);
function valid(m){return !!(m&&m.type==='v4_ai_goal_two_stage_v1'&&m.validation?.accepted===true&&JSON.stringify(m.features)===JSON.stringify(scenarios.FEATURES)&&validPart(m.v4)&&validPart(m.goal));}
let active=null;
try{const m=JSON.parse(fs.readFileSync(MODEL_FILE,'utf8'));if(valid(m))active=m;}catch(_){}
function install(m){if(!valid(m))return false;active=m;return true;}
function apply(m,x){return sigmoid(m.bias+m.weights.reduce((sum,w,i)=>sum+w*(x[i]-m.means[i])/m.stds[i],0));}
function evaluate(model,stats,windows,originalRule){
 const v=vector(originalRule,stats,windows);if(!v)return null;
 const improvedRule=100*apply(model.v4,v);
 const rawGoal=goal.predictBase(stats,improvedRule,windows);
 if(rawGoal?.percent==null)return null;
 const gv=vector(rawGoal.percent,stats,windows);if(!gv)return null;
 return {percent:Math.round(1000*apply(model.goal,gv))/10,enhancedRule:Math.round(improvedRule*10)/10,baseAI:rawGoal.percent};
}
function predict(stats,windows,originalRule){
 if(!active)return null;
 const p=evaluate(active,stats,windows,originalRule);if(!p)return null;
 return {percent:p.percent,ruleScore:originalRule,enhancedRule:p.enhancedRule,delta:Math.round((p.percent-originalRule)*10)/10,
  source:'ai-goal-v4-two-stage-trained',label:'AI Goal: V4 + 4 nhóm (kiểm định độc lập)',calibrated:true,
  teamLean:goal.teamAnalysis(stats).teamLean,evidence:goal.teamAnalysis(stats).evidence,availableGroups:4};
}
module.exports={vector,apply,evaluate,predict,install,valid,MODEL_FILE,active:()=>!!active};
