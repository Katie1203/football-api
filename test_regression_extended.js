const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/index.js','utf8');
const segment=(a,b)=>{const start=src.indexOf(a),end=src.indexOf(b,start);assert(start>=0&&end>start,`missing ${a}`);return src.slice(start,end)};
const ctx={Date,Number,String,Math,Map,Set,JSON,Object,console};vm.createContext(ctx);
vm.runInContext(segment('function bongdaluTimestampMs(', '\nasync function fetchBongdaluLiveMatches()'),ctx);
vm.runInContext('const bongdaluOddsHistory=new Map();const BONGDALU_ODDS_HISTORY_WINDOWS=[1,3,5,10];',ctx);
vm.runInContext(segment('function rememberBongdaluOdds(', '\nasync function fetchBongdaluLiveOdds('),ctx);
const now=Date.parse('2026-10-31T11:15:00+07:00');
for(const [state,half1,half2,expected] of [[1,'2026-10-31 11:00:00',null,16],[3,'2026-10-31 09:45:00','2026-10-31 10:45:00',75],[2,'2026-10-31 09:45:00',null,null],[3,'2026-10-31 09:45:00','invalid',null]]){
 assert.strictEqual(ctx.bongdaluVerifiedDeltaMinute({MatchState:state,matchTime:half1,matchTime2:half2},now),expected);
}
const odds=[{match_id:'abc',company_id:2,market:'OU',time_of_the_match:'75',match_status:4,score:'1-0',provider_time:Math.floor(Date.now()/1000),line:'2.5',v1:'1.85',v2:'1.95'}];
const match={id:'abc',homeScore:1,awayScore:0,raw:{MatchState:3}};
assert.strictEqual(ctx.bongdaluVerifiedOddsMinute(match,odds),75);
assert.strictEqual(ctx.bongdaluVerifiedOddsMinute({...match,awayScore:1},odds),null);
assert.strictEqual(ctx.bongdaluVerifiedOddsMinute(match,[{...odds[0],provider_time:Math.floor(Date.now()/1000)-3600}]),null);
assert.strictEqual(ctx.bongdaluVerifiedOddsMinute(match,[{...odds[0],match_status:3}]),null);
const first=ctx.rememberBongdaluOdds('abc',odds,now,true);
assert.strictEqual(first.rows.length,1);assert.strictEqual(first.stale,false);
const fail=ctx.rememberBongdaluOdds('abc',[],now+5000,false);
assert.strictEqual(fail.rows.length,1);assert.strictEqual(fail.stale,true);
const second=ctx.rememberBongdaluOdds('abc',[{...odds[0],v1:'1.70'}],now+10000,true);
assert.strictEqual(second.rows[0].v1,'1.70');assert.strictEqual(second.history['1m'].length,2);
assert(src.includes("BONGDALU_COMPANIES = ['2']"));
assert(!src.includes('company=22 | active='));
const html=fs.readFileSync(__dirname+'/live-monitor.html','utf8');
assert(html.includes('grid-template-columns:repeat(4,minmax(0,1fr))'));
console.log('PASS: 4 clock cases, verified odds clock, stale/mismatched odds, snapshot history, single bookmaker and 4-column UI');
