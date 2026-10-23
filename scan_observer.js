'use strict';
// Passive observation only. Never modifies predictions, alert decisions, or source data.
const fs=require('fs'),path=require('path');
const STORE=process.env.PROMAX_SCAN_HISTORY_STORE||path.join(__dirname,'scan_history.json');
const MAX=Number(process.env.PROMAX_SCAN_HISTORY_LIMIT)||20000;
let rows=[],last={at:null,totalLive:0,uniqueLive:0,eligible:0,analyzed:0,failed:0},liveNow=[];
try{const v=JSON.parse(fs.readFileSync(STORE,'utf8'));rows=Array.isArray(v.rows)?v.rows:[];last=v.last||last;}catch{}
function persist(){try{fs.mkdirSync(path.dirname(STORE),{recursive:true});fs.writeFileSync(STORE+'.tmp',JSON.stringify({rows,last}));fs.renameSync(STORE+'.tmp',STORE);}catch(e){console.warn('[SCAN OBSERVER] save:',e.message);}}
function numeric(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function fixtureKey(m){const api=m.sourceIds?.apisports||(m.source==='apisports'?m.id:null);if(api)return 'api:'+api;return [m.league,m.homeName,m.awayName,m.kickoff||''].map(x=>String(x||'').toLowerCase().trim()).join('|');}
function recordScan({totalLive,uniqueLive,eligible,results,candidates=[]}){
 const now=new Date().toISOString();const byKey=new Map((results||[]).map(r=>[fixtureKey(r),r]));
 last={at:now,totalLive,uniqueLive,eligible:eligible.length,analyzed:results.length,failed:Math.max(0,eligible.length-results.length)};
 const eligibleKeys=new Set(eligible.map(fixtureKey));
 liveNow=(candidates.length?candidates:eligible).map(m=>{
  const key=fixtureKey(m),r=byKey.get(key),inWindow=eligibleKeys.has(key);
  const minute=numeric(r?.minute??m.minute??m.raw?.fixture?.status?.elapsed);
  return {key,fixtureId:String(m.sourceIds?.apisports||(m.source==='apisports'?m.id:'')||''),league:m.league||'',home:m.homeName||'',away:m.awayName||'',minute,
    scoreH:numeric(r?.homeScore??m.homeScore),scoreA:numeric(r?.awayScore??m.awayScore),rule:numeric(r?.ai?.efficiency),goal:numeric(r?.aiGoal?.percent),
    inWindow,analyzed:!!r,reason:r?'ANALYZED':inWindow?'WAITING_ANALYSIS':'OUTSIDE_ALERT_SCAN_WINDOW',at:now};
 }).filter(x=>x.home&&x.away);
 // Latest state is intentionally transient; historical snapshots remain persisted in rows.

 for(const m of eligible){
  const r=byKey.get(fixtureKey(m));const rule=numeric(r?.ai?.efficiency),goal=numeric(r?.aiGoal?.percent);
  const scoreH=numeric(r?.homeScore??m.homeScore),scoreA=numeric(r?.awayScore??m.awayScore);
  const key=fixtureKey(m),minute=numeric(r?.minute);
  const previous=rows.findLast?rows.findLast(x=>x.key===key&&x.outcome==='PENDING_FT'):rows.slice().reverse().find(x=>x.key===key&&x.outcome==='PENDING_FT');
  if(previous && scoreH!==null&&scoreA!==null && scoreH+scoreA>previous.scoreH+previous.scoreA) previous.observedLaterGoal=true;
  rows.push({key,fixtureId:String(m.sourceIds?.apisports||(m.source==='apisports'?m.id:'')||''),league:m.league||'',home:m.homeName||'',away:m.awayName||'',minute,scoreH,scoreA,rule,goal,ruleGroup:rule===null?'NO_DATA':rule>65?'GT65':'LTE65',goalGroup:goal===null?'NO_DATA':goal>65?'GT65':'LTE65',reason:r?'ANALYZED':'NO_ANALYSIS',alertSent:r?.telegramSent===true,at:now,outcome:'PENDING_FT',observedLaterGoal:false});
 }
 if(rows.length>MAX)rows.splice(0,rows.length-MAX);persist();
}
function liveView(){
 const count=fn=>liveNow.filter(fn).length;
 return {ok:true,last,summary:{total:liveNow.length,eligible:count(x=>x.inWindow),analyzed:count(x=>x.analyzed),both:count(x=>x.goal>65&&x.rule>65),aiOnly:count(x=>x.goal>65&&!(x.rule>65)),ruleOnly:count(x=>x.rule>65&&!(x.goal>65)),neither:count(x=>!(x.goal>65)&&!(x.rule>65))},
 note:'Nhóm theo % >65 để theo dõi, không đồng nghĩa đủ toàn bộ điều kiện gửi Telegram.',rows:liveNow};
}
function trainingSummary(){const settled=rows.filter(x=>x.outcome==='WIN'||x.outcome==='LOSS');const score=field=>{const a=settled.filter(x=>x[field]!==null);if(!a.length)return {samples:0,brier:null,winRate:null};const wins=a.filter(x=>x.outcome==='WIN').length;return {samples:a.length,winRate:+(100*wins/a.length).toFixed(1),brier:+(a.reduce((t,x)=>t+(x[field]/100-(x.outcome==='WIN'?1:0))**2,0)/a.length).toFixed(4)};};return {mode:'SHADOW_RESEARCH_ONLY',settledSnapshots:settled.length,rule:score('rule'),aiGoal:score('goal'),note:'Thống kê lịch sử; không thay đổi trọng số hoặc thuật toán đang chạy.'};}
function view({page=1,limit=60,group='',status='',q=''}={}){
 page=Math.max(1,Number(page)||1);limit=Math.min(200,Math.max(1,Number(limit)||60));
 let filtered=rows;
 if(group==='rule_gt65')filtered=filtered.filter(x=>x.ruleGroup==='GT65');
 if(group==='rule_lte65')filtered=filtered.filter(x=>x.ruleGroup==='LTE65');
 if(group==='goal_gt65')filtered=filtered.filter(x=>x.goalGroup==='GT65');
 if(group==='goal_lte65')filtered=filtered.filter(x=>x.goalGroup==='LTE65');
 if(group==='not_qualified')filtered=filtered.filter(x=>x.rule===null||x.goal===null||x.rule<=65||x.goal<=65);
 if(status)filtered=filtered.filter(x=>x.outcome===status);
 if(q)filtered=filtered.filter(x=>[x.home,x.away,x.league].join(' ').toLowerCase().includes(String(q).toLowerCase()));
 const recent=rows.filter(x=>x.at===last.at),count=(fn)=>recent.filter(fn).length;
 return {ok:true,last,training:trainingSummary(),summary:{scannedTotal:rows.length,uniqueFixtures:new Set(rows.map(x=>x.key)).size,liveTracked:recent.length,ruleGT65:count(x=>x.ruleGroup==='GT65'),ruleLTE65:count(x=>x.ruleGroup==='LTE65'),goalGT65:count(x=>x.goalGroup==='GT65'),goalLTE65:count(x=>x.goalGroup==='LTE65'),noData:count(x=>x.reason==='NO_ANALYSIS'||x.rule===null||x.goal===null),settled:rows.filter(x=>x.outcome!=='PENDING_FT').length},total:filtered.length,page,limit,rows:filtered.slice().reverse().slice((page-1)*limit,page*limit)};
}
let reconciling=false;
async function reconcile(apiGet){if(reconciling)return;reconciling=true;try{
 const now=Date.now(),pending=new Map();
 for(const r of rows){if(r.outcome==='PENDING_FT'&&r.fixtureId&&now-Date.parse(r.at)>90*60000&&!pending.has(r.fixtureId))pending.set(r.fixtureId,r);}
 let changed=false;
 for(const id of [...pending.keys()].slice(0,8)){
  try{const data=await apiGet('/fixtures',{id});const f=data?.response?.[0];if(String(f?.fixture?.id)!==id)continue;
   if(!['FT','AET','PEN'].includes(String(f?.fixture?.status?.short||'')))continue;
   const h=numeric(f?.goals?.home),a=numeric(f?.goals?.away);if(h===null||a===null)continue;
   for(const r of rows.filter(x=>x.fixtureId===id&&x.outcome==='PENDING_FT')){
    if(r.scoreH===null||r.scoreA===null||h<r.scoreH||a<r.scoreA)continue;
    r.ftHome=h;r.ftAway=a;r.outcome=h+a>r.scoreH+r.scoreA?'WIN':'LOSS';r.settledAt=new Date().toISOString();changed=true;
   }
  }catch(e){console.warn('[SCAN OBSERVER FT]',id,e.message);}
 }
 if(changed)persist();
 }finally{reconciling=false;}}
module.exports={recordScan,view,reconcile,trainingSummary,liveView};
