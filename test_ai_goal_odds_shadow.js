'use strict';const assert=require('assert');const m=require('./ai_goal_odds_shadow');
const values=[{value:'1',odd:'2.1',suspended:false},{value:'2',odd:'2.25',suspended:false},{value:'No goal',odd:'5',suspended:false}];
const p={response:[{odds:[{id:109,values}],status:{stopped:false,blocked:false}}]};
const a=m.evaluate(p,3,68);assert(a.marketImpliedPercent>80&&a.probability===null&&a.calibrated===false);
assert.strictEqual(m.evaluate(p,4,68).marketImpliedPercent,null);
assert.strictEqual(m.evaluate({response:[{odds:[{id:109,values:values.map(v=>({...v,suspended:true}))}]}]},3,68).marketImpliedPercent,null);
console.log('PASS: no fabricated probability, goal-index guard, suspended-market guard');
