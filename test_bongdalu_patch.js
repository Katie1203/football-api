const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/index.js','utf8');
function extract(start,end){return src.slice(src.indexOf(start),src.indexOf(end,src.indexOf(start)));}
const code=extract('function bongdaluTimestampMs(', '\nasync function fetchBongdaluLiveMatches()');
const ctx={Date,Number,String,Math};vm.createContext(ctx);vm.runInContext(code,ctx);
const now=Date.parse('2026-10-31T11:15:00+07:00');
assert.strictEqual(ctx.bongdaluVerifiedDeltaMinute({MatchState:3,matchTime:'2026-10-31 09:45:00',matchTime2:'2026-10-31 10:45:00'},now),75);
assert.strictEqual(ctx.bongdaluVerifiedDeltaMinute({MatchState:1,matchTime:'2026-10-31 11:00:00'},now),16);
assert.strictEqual(ctx.bongdaluVerifiedDeltaMinute({MatchState:2,matchTime:'2026-10-31 11:00:00'},now),null);
assert.strictEqual(ctx.bongdaluVerifiedDeltaMinute({MatchState:3,matchTime2:'invalid'},now),null);
assert(src.includes("BONGDALU_COMPANIES = ['2']"));
assert(src.includes('raw?.HomeHalfScore'));
console.log('PASS: LIVE minute first/second half, HT, invalid clock, company=2, HT score adapter');
