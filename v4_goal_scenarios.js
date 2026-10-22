'use strict';
// Numeric H2 scenario evidence; no hand-added probability or time/score/odds inputs.
const pair=(s,n)=>{
  if(!s||s._present?.['home'+n]!==true||s._present?.['away'+n]!==true)return null;
  const a=Number(s['home'+n]),b=Number(s['away'+n]);
  return [a,b].every(x=>Number.isFinite(x)&&x>=0)?[a,b]:null;
};
const sum=p=>p?p[0]+p[1]:0;
function windowDelta(w,name){
  if(!w||w.available!==true)return null;
  const v=w.delta?.[name];
  return v!==null&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
}
function extract(stats,windows){
  const sh=pair(stats,'TotalShots'),so=pair(stats,'ShotsOnTarget'),co=pair(stats,'Corners');
  if(!sh||!so||so.some((v,i)=>v>sh[i]))return null;
  const bc=pair(stats,'BigChances'),xg=pair(stats,'ExpectedGoals'),ib=pair(stats,'ShotsInsideBox');
  const n=sum(sh),t=sum(so),c=sum(co);
  const dominance=(Math.max(...sh)/Math.max(1,n)+Math.max(...so)/Math.max(1,t))/2;
  const twoWay=Math.min(so[0],so[1])/Math.max(1,t);
  const spikeSot=windowDelta(windows?.five,'ShotsOnTarget')??windowDelta(windows?.ten,'ShotsOnTarget');
  const spikeShots=windowDelta(windows?.five,'TotalShots')??windowDelta(windows?.ten,'TotalShots');
  const quality=(bc?Math.log1p(sum(bc)):0)+(xg?Math.log1p(sum(xg)):0)+(ib?Math.log1p(sum(ib)):0);
  // Explicit missingness flags allow the model to learn absent != zero.
  return [dominance,twoWay,spikeSot??0,spikeShots??0,quality,bc?1:0,xg?1:0,ib?1:0,spikeSot!==null?1:0,spikeShots!==null?1:0,Math.log1p(n),Math.log1p(t),Math.log1p(c),co?1:0];
}
const FEATURES=['one_side_pressure','two_way_attack','h2_spike_sot','h2_spike_shots','high_quality_chances','has_big_chances','has_xg','has_inside_box','has_spike_sot','has_spike_shots','log_shots','log_sot','log_corners','has_corners'];
module.exports={extract,FEATURES};
