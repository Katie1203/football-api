'use strict';
// Shadow-only scenario labels. No probabilities, Rule boosts, or Telegram gates.
// Inputs are H2 observations already collected by PROMAX; missing != zero.
function detect(stats, windows) {
  const p=stats?._present||{};
  const pair=(field)=>{
    const keys=['home'+field,'away'+field];
    if(!keys.every(k=>p[k]===true))return null;
    const v=keys.map(k=>Number(stats[k]));
    return v.every(x=>Number.isFinite(x)&&x>=0)?v:null;
  };
  const sh=pair('TotalShots'),so=pair('ShotsOnTarget'),co=pair('Corners');
  const bc=pair('BigChances'),xg=pair('ExpectedGoals');
  const sum=v=>v?v[0]+v[1]:null;
  const groups=[];
  // Descriptive heuristics only; thresholds are NOT calibrated probabilities.
  if(sh&&so&&sum(sh)>=10&&sum(so)>=3 &&
      (Math.max(...sh)/Math.max(1,sum(sh))>=.7) &&
      (Math.max(...so)/Math.max(1,sum(so))>=.7))groups.push('ONE_SIDE_PRESSURE');
  if(sh&&so&&sh.every(x=>x>=5)&&so.every(x=>x>=2))groups.push('TWO_WAY_ATTACK');
  const spike=[windows?.five,windows?.ten].some(w=>w?.available===true &&
    ((w.delta?.ShotsOnTarget!==null && w.delta?.ShotsOnTarget>=2) ||
     (w.delta?.TotalShots!==null && w.delta?.TotalShots>=4 && w.delta?.Corners!==null && w.delta?.Corners>=2)));
  if(spike)groups.push('H2_ATTACK_SPIKE');
  if((bc&&sum(bc)>=2)||(xg&&sum(xg)>=1.5&&so&&sum(so)>=2))groups.push('HIGH_QUALITY_CHANCES');
  return {groups,coverage:{shots:!!sh,sot:!!so,corners:!!co,bigChances:!!bc,xg:!!xg,window5:!!windows?.five?.available,window10:!!windows?.ten?.available},version:'SCENARIO_SHADOW_V1'};
}
module.exports={detect};
