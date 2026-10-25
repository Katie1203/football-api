'use strict';
// Independent retrospective experiment. No production alert gates or probabilities changed.
const fs=require('fs');
const path=require('path');
const store=process.env.BIGGG_SHADOW_STORE||'./biggg_shadow_records.json';
let rows=[];
try {const raw=JSON.parse(fs.readFileSync(store,'utf8'));if(Array.isArray(raw))rows=raw.filter(x=>x&&x.key).slice(-15000);}catch(_){}
const seen=new Set(rows.map(x=>x.key));
function persist(){try{const target=path.resolve(store);fs.mkdirSync(path.dirname(target),{recursive:true});const tmp=target+'.tmp';fs.writeFileSync(tmp,JSON.stringify(rows));fs.renameSync(tmp,target);}catch(e){console.warn('[BIGGG SHADOW STORAGE]',e.message);}}
const number=x=>x===null||x===undefined||x===''?null:(Number.isFinite(Number(x))?Number(x):null);
function classify(record){
 // An observed odds criterion is NOT proof of the website's hidden tier rules.
 const odds=number(record.bigggOverOdds);
 const oddsValid=record.bigggOddsValid===true && odds!==null && odds>1;
 const oddsCriterion=oddsValid?(odds>1.5?'PASS':'FAIL'):'UNKNOWN';
 const reasons=[];
 if(oddsCriterion==='PASS')reasons.push('Odds cửa Over cho bàn tiếp theo > 1.50 (điều kiện quan sát, chưa chứng minh đủ để phát BIGGG)');
 if(oddsCriterion==='FAIL')reasons.push('Odds cửa Over cho bàn tiếp theo không vượt 1.50');
 if(oddsCriterion==='UNKNOWN')reasons.push('Chưa có giá Odds cửa Over hợp lệ, cùng sự kiện');
 reasons.push('Chưa có quy tắc phân cấp RUNG/BIGGG/BIGGGGG được kiểm định độc lập');
 return {tier:oddsCriterion==='UNKNOWN'?'THIẾU DỮ LIỆU':'CHỜ KIỂM ĐỊNH',
  status:oddsCriterion==='UNKNOWN'?'MISSING_ODDS':'UNVALIDATED_TIER_RULES',
  oddsCriterion,reason:reasons.join('; ')};
}
function observe(record){
 const fixtureId=record.fixtureId==null?null:String(record.fixtureId);
 const minute=number(record.minute),probability=number(record.baselineProbability??record.probability);
 const score=String(record.score||'');
 if(!fixtureId||!Number.isFinite(minute)||minute<60||minute>80||!/^(\d+)\s*[-–:]\s*(\d+)$/.test(score))return null;
 const key=`${fixtureId}:${minute}:${score}`;
 if(seen.has(key))return rows.find(x=>x.key===key)||null;
 const match=score.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
 const label=classify(record);
 const row={key,fixtureId,home:record.home,away:record.away,league:record.league,minute,score,
  observedGoals:Number(match[1])+Number(match[2]),observedAt:record.updatedAt||new Date().toISOString(),
  probability,lambda:number(record.baselineExpectedRemainingGoals??record.expectedRemainingGoals),
  htScore:record.htScore||null,goalTimeline:record.goalTimeline||null,oddsStatus:record.oddsStatus||null,
  overOdds:number(record.bigggOverOdds),overLine:number(record.bigggOverLine),oddsMarket:record.bigggOddsMarket||null,oddsUpdatedAt:record.bigggOddsUpdatedAt||null,
  liveStatsEvidence:record.liveStatsEvidence||null,...label,outcome:null,evaluation:'PENDING_FT',ftScore:null};
 rows.push(row);seen.add(key);if(rows.length>15000){const old=rows.shift();seen.delete(old.key);}persist();return row;
}
function settle(fixtureId,ftScore,status){
 const id=String(fixtureId);const state=String(status||'').toUpperCase();
 const m=String(ftScore||'').match(/^(\d+)\s*[-–:]\s*(\d+)$/);
 if(!['FT','AET','PEN','CANC','ABD','PST','SUSP'].includes(state))return false;
 let changed=false;
 for(const row of rows){if(row.fixtureId!==id||row.outcome!==null)continue;
  if(['CANC','ABD','PST','SUSP'].includes(state)){row.outcome='VOID';row.evaluation='VOID';}
  else if(m){const total=Number(m[1])+Number(m[2]);if(total<row.observedGoals)continue;row.outcome=total>row.observedGoals?1:0;row.evaluation=row.outcome?'WIN':'LOSS';row.ftScore=`${m[1]}-${m[2]}`;}
  else continue;
  row.settledAt=new Date().toISOString();changed=true;
 }
 if(changed)persist();return changed;
}
function summary(){const wins=rows.filter(x=>x.outcome===1).length,losses=rows.filter(x=>x.outcome===0).length;
 return {total:rows.length,wins,losses,voids:rows.filter(x=>x.outcome==='VOID').length,
 pending:rows.filter(x=>x.outcome===null).length,winRate:wins+losses?Number((100*wins/(wins+losses)).toFixed(1)):null,
 tierStatus:'NOT_CALIBRATED',note:'Chỉ thu thập tín hiệu phút 60–80; chưa xác định quy tắc BIGGG BET của website.'};}
function getRecords(limit=20,offset=0,filter='all'){
 const take=Math.max(1,Math.min(100,Number(limit)||20));
 const skip=Math.max(0,Math.floor(Number(offset)||0));
 const allowed=new Set(['all','pending','settled','WIN','LOSS','KHÔNG ĐẠT','RUNG','BIGGG BET','BIGGGGG BET','THIẾU DỮ LIỆU','CHỜ KIỂM ĐỊNH']);
 const f=allowed.has(filter)?filter:'all';
 const list=rows.filter(x=>f==='all'||(f==='pending'&&x.outcome===null)||(f==='settled'&&[0,1].includes(x.outcome))||x.evaluation===f||x.tier===f);
 return {records:list.slice().reverse().slice(skip,skip+take),filteredTotal:list.length,limit:take,offset:skip};
}
module.exports={observe,settle,summary,getRecords,classify};
