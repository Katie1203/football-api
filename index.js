'use strict';
// Single-source Bongdalu / single-decision-engine AI LIVE RUNG.
const express=require('express');
const axios=require('axios');
const fs=require('fs');
const path=require('path');
const {Pool}=require('pg');
const {LiveRungMarket}=require('./ai_live_rung_market');
const {decideLiveRung}=require('./live_rung_decision');
const app=express();app.use(express.json({limit:'32kb'}));
const PORT=Number(process.env.PORT||10000);
const PROXY=(process.env.BONGDALU_BASE_URL||'https://g4mlw.net').replace(/\/+$/,'');
const ODDS_HOST=(process.env.BONGDALU_ODDS_HOST||'https://www.bongdalu814.com').replace(/\/+$/,'');
const TOKEN=process.env.TELEGRAM_BOT_TOKEN,CHAT=process.env.TELEGRAM_CHAT_ID;
const ADMIN_TOKEN=process.env.ADMIN_TOKEN;
const market=new LiveRungMarket(),matches=new Map(),sent=new Map(),observations=new Map();
const STATE=process.env.STATE_FILE||path.join(__dirname,'live_rung_sent.json');
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false}}):null;
let scanning=false,paused=false,lastScan=null,lastError=null,ready=false;
const now=()=>new Date().toISOString();
function vnDate(){const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const g=x=>f.find(p=>p.type===x)?.value;return `${g('year')}-${g('month')}-${g('day')}`;}
function authorized(req,res,next){if(!ADMIN_TOKEN)return res.status(503).json({error:'ADMIN_TOKEN is required for control endpoints'});if(req.get('x-admin-token')!==ADMIN_TOKEN)return res.status(401).json({error:'Unauthorized'});next();}
async function init(){if(pool){await pool.query('CREATE TABLE IF NOT EXISTS live_rung_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL)');const r=await pool.query('SELECT id,payload FROM live_rung_state');for(const x of r.rows)if(x.id!=='__control__')sent.set(x.id,x.payload);const control=await pool.query("SELECT payload FROM live_rung_state WHERE id='__control__'");paused=!!control.rows[0]?.payload?.paused;}else{try{for(const r of JSON.parse(fs.readFileSync(STATE,'utf8')))sent.set(String(r.id),r);}catch{}}ready=true;}
async function save(id,value){if(pool){await pool.query('INSERT INTO live_rung_state(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',[id,JSON.stringify(value)]);}else{const tmp=STATE+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...sent.values()],null,2));fs.renameSync(tmp,STATE);}}
async function proxyGet(p){const {data}=await axios.get(`${PROXY}/wp-json/wpsport/v1/proxy`,{params:{path:p,_bdts:Date.now()},timeout:12000});if(Number(data?.code)!==0)throw Error('Bongdalu proxy error: '+JSON.stringify(data).slice(0,120));return data?.data?.results||data?.data?.matches||data?.data||[];}
function rows(payload){return Array.isArray(payload)?payload:[];}
function asText(v){return typeof v==='string'?v.trim():typeof v==='object'&&v?String(v.name||v.Name||'').trim():'';}
function minuteNumber(value){
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)&&n>=1&&n<=130?n:null;
}
function verifiedDeltaMinute(delta, at=Date.now()){
  if(!delta||typeof delta!=='object')return null;
  const state=Number(delta.MatchState), start=Number(delta.matchTime);
  if(![1,3].includes(state)||!Number.isFinite(start)||start<1000000000)return null;
  const age=(at-start*1000)/60000;
  if(age<0||!Number.isFinite(age))return null;
  if(state===1&&age<=50)return Math.max(1,Math.floor(age)+1);
  if(state===3&&age<=70)return 45+Math.floor(age);
  return null;
}
function verifiedOddsMinute(m, odds){
  if(m.state!==3)return null;
  const candidates=(odds||[]).filter(r=>String(r.match_id)===m.id &&
    Number(r.match_status)===4 && String(r.score||'')===`${m.homeScore}-${m.awayScore}` &&
    Number.isFinite(Number(r.time_of_the_match)) && Number(r.time_of_the_match)>=45 && Number(r.time_of_the_match)<=120);
  if(!candidates.length)return null;
  const nums=candidates.map(r=>Number(r.time_of_the_match));
  return Math.max(...nums)-Math.min(...nums)<=2?Math.max(...nums):null;
}
function norm(r){
  const id=r.ScheduleID??r.scheduleId??r.id,state=Number(r.MatchState??r.matchState);
  const home=asText(r.homeTeam??r.HomeTeam),away=asText(r.guestTeam??r.GuestTeam);
  if(!id||!home||!away)return null;
  const h=Number(r.HomeScore??r.homeScore??0),a=Number(r.GuestScore??r.awayScore??0);
  const minute=minuteNumber(r.minute??r.MatchMinute??r.matchMinute??r.liveMinute??r.elapsed);
  return {id:String(id),source:'bongdalu',homeName:home,awayName:away,league:asText(r.LeagueName??r.SclassName),homeScore:h,awayScore:a,minute,state};
}
async function fetchOddsMinuteRows(){
  try{
    const data=await proxyGet('/v1/football/odds/live?companyid=22&locale=vi');
    return rows(data).filter(r=>String(r.market).toUpperCase()==='OU');
  }catch(e){console.warn('[BONGDALU MINUTE ODDS]',e.message);return [];}
}
async function fetchFixtures(){
  const q=`date=${vnDate()}&timeRange=all&lang=vn&ishot=0&halfOdd=0&locale=vi`;
  const diary=rows(await proxyGet('/v1/football/match/diary?'+q));
  const byId=new Map(diary.filter(r=>r.ScheduleID).map(r=>[String(r.ScheduleID),r]));
  const deltas=new Map();
  try{
    for(const d of rows(await proxyGet('/v1/football/match/live?locale=vi'))){
      const id=String(d.ScheduleID??d.scheduleId??d.id);
      if(!byId.has(id))continue;
      deltas.set(id,d);byId.set(id,{...byId.get(id),...d});
    }
  }catch(e){console.warn('[BONGDALU LIVE DELTA]',e.message);}
  const all=[...byId.values()].map(norm).filter(Boolean);
  const live=all.filter(m=>m.state===1||m.state===3);
  const odds=await fetchOddsMinuteRows();
  const byOdds=new Map();
  for(const row of odds){const id=String(row.match_id??'');if(!byOdds.has(id))byOdds.set(id,[]);byOdds.get(id).push(row);}
  const sourceCounts={direct:0,delta:0,odds:0,unknown:0};
  for(const m of live){
    if(m.minute!==null){sourceCounts.direct++;m.minuteSource='direct';continue;}
    const fromDelta=verifiedDeltaMinute(deltas.get(m.id));
    const fromOdds=verifiedOddsMinute(m,byOdds.get(m.id));
    const minute=fromDelta??fromOdds;
    if(minute!==null){m.minute=minute;m.minuteSource=fromDelta!==null?'delta':'odds';sourceCounts[m.minuteSource]++;}
    else{m.minuteSource='unverified';sourceCounts.unknown++;}
  }
  console.log('[BONGDALU MINUTE AUDIT]',JSON.stringify({live:live.length,...sourceCounts,eligible:live.filter(m=>m.minute>=60&&m.minute<=88).length}));
  return all;
}
async function fetchMarket(id){const {data}=await axios.get(`${ODDS_HOST}/Ajax/SoccerAjax`,{params:{type:4,id,p:Date.now(),flesh:Math.random()},timeout:10000,headers:{Accept:'application/json'}});return data;}
async function telegram(m,decision){if(!TOKEN||!CHAT)throw Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');const body=`💰 THẦN TÀI ĐẾN — ${decision.level}\n${m.league}\n${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName}\nPhút: ${m.minute}\nAI LIVE RUNG: ${decision.reason}\nOdds Tài: ${decision.overOdds??'Không xác minh'}`;const {data}=await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{chat_id:CHAT,text:body},{timeout:10000});if(!data?.ok)throw Error('Telegram rejected');return data.result?.message_id;}
async function scan(){if(scanning||paused||!ready)return [];scanning=true;const output=[];try{const fixtures=await fetchFixtures();for(const m of fixtures){const old=matches.get(m.id);matches.set(m.id,m);if(m.state===-1){const previous=sent.get(m.id);if(previous&&!previous.ft){previous.ft={home:m.homeScore,away:m.awayScore,at:now()};await save(m.id,previous);}continue;}if(m.state!==1&&m.state!==3)continue;if(m.minute===null||m.minute<60||m.minute>88)continue;try{const observed=market.observe(m.id,await fetchMarket(m.id));const decision=decideLiveRung(m,market.get(m.id));observations.set(m.id,{marketStatus:observed.status,decision,at:now(),goalChanged:!!old&&(old.homeScore!==m.homeScore||old.awayScore!==m.awayScore)});output.push({...m,marketStatus:observed.status,decision});if(m.minute<65||sent.has(m.id)||!decision.level)continue;
// Durable claim prevents duplicate sends across restarts or concurrent instances. Failed/unknown sends remain pending for manual review.
const record={id:m.id,home:m.homeName,away:m.awayName,league:m.league,minute:m.minute,score:`${m.homeScore}-${m.awayScore}`,decision,status:'pending',sentAt:null,ft:null};sent.set(m.id,record);await save(m.id,record);
try{record.telegramMessageId=await telegram(m,decision);record.status='sent';record.sentAt=now();}catch(e){record.status='send_unknown';record.error=e.message;console.error('[Telegram]',m.id,e.message);}await save(m.id,record);
}catch(e){console.warn('[AI LIVE RUNG]',m.id,e.message);}}lastScan={at:now(),fixtures:fixtures.length,analyzed:output.length};lastError=null;return output;}catch(e){lastError={at:now(),message:e.message};throw e;}finally{scanning=false;}}
app.get('/health',(req,res)=>res.status(ready?200:503).json({ok:ready,source:'bongdalu',engine:'AI LIVE RUNG',lastScan,lastError,db:!!pool}));
app.get('/api/live-rung',(req,res)=>res.json({ok:true,engine:'AI LIVE RUNG',source:'bongdalu',paused,lastScan,lastError,matches:[...matches.values()].filter(x=>x.state===1||x.state===3).map(m=>({...m,observation:observations.get(m.id)||null,market:market.get(m.id),alert:sent.get(m.id)||null}))}));
app.get('/api/rung-bet',(req,res)=>res.json({ok:true,records:[...sent.values()].filter(r=>r.status==='sent'&&!r.ft).map(r=>({...r,alertLabel:r.decision?.level==='BIG BET'?'BIGGG BET':'BET NHẸ TAY',scoreAtAlert:r.score}))}));
app.get('/api/audit',(req,res)=>res.json({ok:true,records:[...sent.values()].filter(r=>r.id!=='__control__')}));
app.get('/api/scan-control',(req,res)=>res.json({ok:true,paused}));
app.post('/api/scan-control',authorized,async(req,res)=>{if(typeof req.body?.paused!=='boolean')return res.status(400).json({error:'paused boolean required'});try{paused=req.body.paused;if(pool)await save('__control__',{paused});res.json({ok:true,paused});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/scan',authorized,async(req,res)=>{try{const result=await scan();res.json({ok:true,analyzed:result.length,results:result});}catch(e){res.status(502).json({ok:false,error:e.message});}});
app.get('/scan',(req,res)=>res.status(405).json({error:'Use authenticated POST /api/scan'}));
// Compatibility view-models for the ORIGINAL HTML screens; no old AI computation.
function uiLiveRows(){return [...matches.values()].filter(m=>m.state===1||m.state===3).map(m=>{
 const o=observations.get(m.id)||{},d=o.decision||{},q=market.get(m.id)||{};
 return {fixtureId:m.id,id:m.id,home:m.homeName,away:m.awayName,league:m.league,minute:m.minute,scoreH:m.homeScore,scoreA:m.awayScore,score:`${m.homeScore}-${m.awayScore}`,status:'LIVE',alertLabel:sent.get(m.id)?.status==='sent'?(sent.get(m.id).decision?.level||'RUNG BET'):null,probability:d.probability??null,aiProbability:d.probability??null,expectedRemainingGoals:null,aiLiveEnhanced:{marketProbability:d.probability??null,combinedLambda:null,marketLambda:null,overOdds:d.overOdds??null,marketLine:d.line??null,liveCoverage:o.marketStatus||'UNAVAILABLE'},market:q,decision:d};
});}
app.get('/api/live-monitor',(req,res)=>res.json({ok:true,rows:uiLiveRows(),noStats:[],totalLive:uiLiveRows().length,analyzed:lastScan?.analyzed||0}));
app.get('/api/ai-live-market',(req,res)=>res.json({ok:true,rows:uiLiveRows()}));
app.get('/api/ai-no-stats',(req,res)=>res.json({ok:true,records:uiLiveRows()}));
app.get('/api/no-stats-alerts',(req,res)=>{const records=[...sent.values()].filter(r=>r.id!=='__control__'&&r.status==='sent');res.json({ok:true,records:records.map(r=>({...r,fixtureId:r.id,alertLabel:r.decision?.level,scoreAtAlert:r.score})),summary:{sent:records.length,settled:records.filter(r=>r.ft).length,pending:records.filter(r=>!r.ft).length,wins:0,losses:0,winRate:null,over:{rate:null,wins:0,losses:0,noLine:0}}});});
app.get('/api/no-stats-odds-waiting',(req,res)=>res.json({ok:true,records:[]}));
app.get('/api/no-stats-bet-control',(req,res)=>res.json({ok:true,enabled:true,engine:'AI LIVE RUNG'}));
app.get('/api/scan-history',(req,res)=>{const rows=[...sent.values()].filter(r=>r.id!=='__control__').map(r=>({at:r.sentAt||null,league:r.league,home:r.home,away:r.away,minute:r.minute,scoreH:Number(String(r.score).split('-')[0]),scoreA:Number(String(r.score).split('-')[1]),noStatsProbability:r.decision?.probability??null,noStatsExpectedGoals:null,noStatsModel:'AI LIVE RUNG',noStatsAudit:r.status,reason:r.decision?.reason||'',outcome:r.ft?'FT':'PENDING',ftHome:r.ft?.home,ftAway:r.ft?.away}));const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||60));res.json({ok:true,rows:rows.slice((page-1)*limit,page*limit),total:rows.length,limit,summary:{scannedTotal:lastScan?.fixtures||0,uniqueFixtures:matches.size,settled:rows.filter(r=>r.outcome==='FT').length,noStatsAvailable:rows.length,noStatsQualified:0,noData:0},last:{totalLive:uiLiveRows().length,uniqueLive:uiLiveRows().length,eligible:uiLiveRows().filter(x=>x.minute>=60&&x.minute<=88).length}});});
// Original multi-page interface restored. Backend is exclusively AI LIVE RUNG.
const originalPages = {'/':'dashboard.html','/dashboard':'dashboard.html','/dashboard.html':'dashboard.html','/live-monitor':'live-monitor.html','/live-monitor.html':'live-monitor.html','/rung-bet':'rung-bet.html','/rung-bet.html':'rung-bet.html','/scan-history':'scan-history.html','/scan-history.html':'scan-history.html','/login':'login.html','/login.html':'login.html'};
for (const [route,file] of Object.entries(originalPages)) app.get(route,(req,res)=>res.sendFile(path.join(__dirname,file)));
// Original HTML files remain in project root. No public/ folder required.

async function start(){await init();app.listen(PORT,()=>console.log(`Bongdalu AI LIVE RUNG listening on ${PORT}`));setTimeout(()=>scan().catch(e=>console.error('[scan]',e.message)),1500);setInterval(()=>scan().catch(e=>console.error('[scan]',e.message)),5000);}
if(require.main===module)start().catch(e=>{console.error('Startup failure:',e);process.exit(1);});
module.exports={app,scan,norm,init,fetchFixtures,verifiedDeltaMinute,verifiedOddsMinute};
