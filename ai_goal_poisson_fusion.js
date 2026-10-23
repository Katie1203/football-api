'use strict';
// Optional, audit-trained fusion of Rule, AI Goal and Poisson probability.
// NO model is bundled: do not manufacture a combined probability.
const fs=require('fs'),path=require('path');
const MODEL_FILE=process.env.AI_GOAL_POISSON_MODEL || path.join(__dirname,'ai_goal_poisson_model.json');
let model=null;
try {
 const candidate=JSON.parse(fs.readFileSync(MODEL_FILE,'utf8'));
 if(candidate.type==='ai_goal_poisson_fusion_v1' &&
    candidate.validation?.accepted===true &&
    candidate.validation?.chronologicalHoldout===true &&
    Number(candidate.validation?.trainCount)>=100 &&
    Number(candidate.validation?.testCount)>=30 &&
    Number.isFinite(candidate.validation?.brier) &&
    Number.isFinite(candidate.validation?.baselineBrier) &&
    candidate.validation.brier<candidate.validation.baselineBrier &&
    Array.isArray(candidate.weights) && candidate.weights.length===3 &&
    candidate.weights.every(Number.isFinite) && Number.isFinite(candidate.bias)) model=candidate;
} catch (_) {}
const sigmoid=x=>1/(1+Math.exp(-Math.max(-35,Math.min(35,x))));
const logit=x=>Math.log(Math.max(.001,Math.min(.999,x))/(1-Math.max(.001,Math.min(.999,x))));
function predict({aiGoalPercent,rulePercent,poisson}={}){
 const p=Number(aiGoalPercent),r=Number(rulePercent),q=Number(poisson?.probabilityAtLeastOne);
 if(!Number.isFinite(p)||!Number.isFinite(r)||!poisson||!Number.isFinite(q)||p<=0||p>=100||r<=0||r>=100||q<=0||q>=100)
   return {status:'INSUFFICIENT_DATA',percent:null};
 if(!model){
   // Immediately active, explicitly uncalibrated log-odds consensus.
   // Equal weights are a transparent default, not learned coefficients.
   const features=[logit(p/100),logit(r/100),logit(q/100)];
   const percent=Math.round(1000*sigmoid(features.reduce((a,b)=>a+b,0)/3))/10;
   return {status:'EXPERIMENTAL_ACTIVE',percent,calibrated:false};
 }
 const features=[logit(p/100),logit(r/100),logit(q/100)];
 return {status:'VALIDATED',percent:Math.round(1000*sigmoid(model.bias+model.weights.reduce((sum,w,i)=>sum+w*features[i],0)))/10};
}
module.exports={predict,isReady:()=>!!model};
