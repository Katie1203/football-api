'use strict';
// Single-source Bongdalu / single-decision-engine AI LIVE RUNG.
const express=require('express');
const axios=require('axios');
const fs=require('fs');
const path=require('path');
const {Pool}=require('pg');
const {LiveRungMarket}=require('./ai_live_rung_market');
const {decideLiveRung}=require('./live_rung_decision');
const {signalConfidence}=require('./signal_confidence');
const app=express();app.use(express.json({limit:'32kb'}));
const PORT=Number(process.env.PORT||10000);
const PROXY=(process.env.BONGDALU_BASE_URL||'https://g4mlw.net').replace(/\/+$/,'');
const ODDS_HOST=(process.env.BONGDALU_ODDS_HOST||'https://www.bongdalu814.com').replace(/\/+$/,'');
const TOKEN=process.env.TELEGRAM_BOT_TOKEN,CHAT=process.env.TELEGRAM_CHAT_ID;
const ADMIN_TOKEN=process.env.ADMIN_TOKEN;
const market=new LiveRungMarket(),matches=new Map(),sent=new Map(),observations=new Map(),watchlist=new Map();
const STATE=process.env.STATE_FILE||path.join(__dirname,'live_rung_sent.json');
const TRACK_STATE=process.env.TRACK_STATE_FILE||path.join(__dirname,'live_rung_tracking.json');
const trackedKey='__tracking__';
let persistQueue=Promise.resolve();
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false}}):null;
let scanning=false,paused=false,lastScan=null,lastError=null,ready=false;
const now=()=>new Date().toISOString();
function vnDate(){const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const g=x=>f.find(p=>p.type===x)?.value;return `${g('year')}-${g('month')}-${g('day')}`;}
function authorized(req,res,next){if(!ADMIN_TOKEN)return res.status(503).json({error:'ADMIN_TOKEN is required for control endpoints'});if(req.get('x-admin-token')!==ADMIN_TOKEN)return res.status(401).json({error:'Unauthorized'});next();}
function trackingSnapshot(){return {watchlist:[...watchlist],market:[...market.matches].map(([id,v])=>[id,{...v,books:[...v.books]}]),observations:[...observations],savedAt:now()};}
function restoreTracking(data){if(!data||typeof data!=='object')return;for(const [id,v] of data.watchlist||[])if(!sent.has(id))watchlist.set(id,v);for(const [id,v] of data.market||[])market.matches.set(id,{...v,books:new Map(v.books||[])});for(const [id,v] of data.observations||[])observations.set(id,v);}
async function init(){
 if(pool){
  await pool.query('CREATE TABLE IF NOT EXISTS live_rung_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL)');
  const r=await pool.query('SELECT id,payload FROM live_rung_state');
  for(const x of r.rows){if(x.id==='__control__')paused=!!x.payload?.paused;else if(x.id===trackedKey)restoreTracking(x.payload);else sent.set(x.id,x.payload);}
  // Restore tracking after alerts, so already-alerted fixtures are never re-added.
  for(const id of watchlist.keys())if(sent.has(id))watchlist.delete(id);
 }else{
  try{for(const r of JSON.parse(fs.readFileSync(STATE,'utf8')))sent.set(String(r.id),r);}catch{}
  try{restoreTracking(JSON.parse(fs.readFileSync(TRACK_STATE,'utf8')));}catch{}
  for(const id of watchlist.keys())if(sent.has(id))watchlist.delete(id);
 }
 ready=true;
}
async function save(id,value){
 if(pool){await pool.query('INSERT INTO live_rung_state(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',[id,JSON.stringify(value)]);}
 else if(id!=='__control__'&&id!==trackedKey){const tmp=STATE+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...sent.values()],null,2));fs.renameSync(tmp,STATE);}
}
async function persistTracking(){
 const payload=trackingSnapshot();
 persistQueue=persistQueue.catch(()=>{}).then(async()=>{
  if(pool)await save(trackedKey,payload);
  else{const tmp=TRACK_STATE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(payload));fs.renameSync(tmp,TRACK_STATE);}
 });return persistQueue;
}
function resultOf(r){
 if(!r.ft)return 'PENDING_FT';
 const [h,a]=String(r.score).split('-').map(Number);
 if(!Number.isFinite(h)||!Number.isFinite(a))return 'VOID';
 return Number(r.ft.home)+Number(r.ft.away)>h+a?'WIN':'LOSS';
}
function alertView(r){
 const m=matches.get(r.id),ft=r.ft,scoreNow=ft?`${ft.home}-${ft.away}`:m?`${m.homeScore}-${m.awayScore}`:r.score;
 const [h,a]=String(r.score).split('-').map(Number);
 const current=scoreNow.split('-').map(Number);
 const goals=Number.isFinite(h+a+current[0]+current[1])?Math.max(0,current[0]+current[1]-h-a):null;
 const label=r.decision?.level==='BIG BET'?'BIGGG BET':r.decision?.level||'BET NHẸ TAY';
 return {...r,key:r.id,fixtureId:r.id,liveMinute:m?.minute??null,alertLabel:label,alertType:label,probability:r.signalConfidence?.probability??null,signalConfidence:r.signalConfidence??null,
  expectedRemainingGoals:null,scoreAtAlert:r.score,liveScore:ft?null:scoreNow,ftScore:ft?scoreNow:null,
  liveGoalsAfterAlert:goals,score: r.score,overOddsAtAlert:r.decision?.overOdds??null,
  oddsAtAlertStatus:r.decision?.overOdds==null?'CHUA_LAY_DUOC_ODDS':'DAT_ODDS',
  evaluation:resultOf(r),outcome:resultOf(r),status:r.status};
}
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
function isFilteredLeague(
  leagueName,
  homeName,
  awayName
) {

  const text =

    `${leagueName} ${homeName} ${awayName}`
      .toLowerCase();


  // Explicitly allow U20/U21 competitions, including European U20/U21.
  // Also allow the European U19 competitions requested by the user.
  // Keep all other league exclusions unchanged.
  const leagueText = String(leagueName || '').toLowerCase();
  const teamText = `${homeName || ''} ${awayName || ''}`.toLowerCase();
  const normalizedLeague = leagueText.replace(/[–—_]/g, '-');
  const normalizedTeams = teamText.replace(/[–—_]/g, '-');
  const age20or21 = /\b(?:u-?2[01]|under-?2[01]|sub-?2[01])\b/i;
  const age19 = /\b(?:u-?19|under-?19|sub-?19)\b/i;
  const europeanU19Names = [
    'uefa youth league',
    'youth league',
    'european championship u19',
    'u19 euro qualification',
    "u19 women's championship",
    'uefa european under-19',
    'uefa under-19',
    'uefa u19',
    'euro u19'
  ];
  const allowedYouthLeague =
    age20or21.test(normalizedLeague) ||
    age20or21.test(normalizedTeams) ||
    europeanU19Names.some(k => normalizedLeague.includes(k)) ||
    ((age19.test(normalizedLeague) || age19.test(normalizedTeams)) &&
      /\b(?:uefa|europe|european|euro)\b/i.test(normalizedLeague));

  if (allowedYouthLeague) return false;

  // Other youth competitions remain excluded as before (including U17/U18).
  if (/\b(?:u-?1[0-9]|sub-?1[0-9]|under-?1[0-9])\b/i.test(text)) {
    return true;
  }

  // Explicitly allow senior UEFA/AFC continental competitions at club and
  // national-team level. The youth exclusion above still applies; U20/U21
  // and the previously approved European U19 competitions are handled above.
  // Restrict the match to recognized confederation competition names rather
  // than the generic words 'europe' or 'asia' (which can occur in other labels).
  const continentalCompetition = [
    /\buefa\b/i,
    /\bafc\b/i,
    /\beuro(?:pean)?\s+(?:championship|qualif(?:ication|iers|ying)|nations\s+league)\b/i,
    /\basian\s+(?:cup|qualif(?:ication|iers|ying)|champions\s+league|challenge\s+league)\b/i,
    /\b(?:champions|europa|conference)\s+league\b.*\b(?:europe|asia)\b/i
  ].some(pattern => pattern.test(normalizedLeague));
  if (continentalCompetition) {
    const excludedContinental = [
      'simulated', 'srl', 'esports', 'e-soccer', 'ncaa', 'amateur',
      'semi-pro', 'regional', 'reserve', 'state league', 'local',
      'college', 'university'
    ];
    return excludedContinental.some(k => text.includes(k));
  }

  const professionalWomenKeywords = [

    'womens champions league',

    'uefa women',

    'afc women',

    'conmebol libertadores femenina',

    'nwsl',

    'womens super league',

    'd1 arkema',

    'frauen-bundesliga',

    'liga f',

    'serie a fem',

    'a-league women',

    'world cup women',

    'olympic women',

    'shebelieves cup'

  ];


  if (
    professionalWomenKeywords
      .some(
        k => text.includes(k)
      )
  ) {

    return false;
  }


  const excluded = [

    'simulated',

    'srl',

    'esports',

    'e-soccer',

    'ncaa',

    'amateur',

    'semi-pro',

    'regional',

    'reserve',

    'state league',

    'local',

    'college',

    'university'

  ];


  return excluded.some(
    k => text.includes(k)
  );
}



function norm(r){
  const id=r.ScheduleID??r.scheduleId??r.id,state=Number(r.MatchState??r.matchState);
  const home=asText(r.homeTeam??r.HomeTeam),away=asText(r.guestTeam??r.GuestTeam);
  if(!id||!home||!away)return null;
  const h=Number(r.HomeScore??r.homeScore??0),a=Number(r.GuestScore??r.awayScore??0);
  const minute=minuteNumber(r.minute??r.MatchMinute??r.matchMinute??r.liveMinute??r.elapsed);
  const htH=Number(r.HomeHalfScore??r.homeHalfScore??r.HomeHalf??NaN),htA=Number(r.GuestHalfScore??r.guestHalfScore??r.AwayHalfScore??NaN);
  return {id:String(id),source:'bongdalu',homeName:home,awayName:away,league:asText(r.LeagueName??r.SclassName),homeScore:h,awayScore:a,htGoals:Number.isFinite(htH)&&Number.isFinite(htA)?htH+htA:null,minute,state};
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
  console.log('[BONGDALU MINUTE AUDIT]',JSON.stringify({live:live.length,...sourceCounts,eligible:live.filter(m=>m.minute>=60&&m.minute<85&&m.htGoals>=1&&!isFilteredLeague(m.league,m.homeName,m.awayName)).length}));
  return all;
}
async function fetchMarket(id){const {data}=await axios.get(`${ODDS_HOST}/Ajax/SoccerAjax`,{params:{type:4,id,p:Date.now(),flesh:Math.random()},timeout:10000,headers:{Accept:'application/json'}});return data;}
async function telegram(m,decision){if(!TOKEN||!CHAT)throw Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');const body=`💰 THẦN TÀI ĐẾN — ${decision.level}\n${m.league}\n${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName}\nPhút: ${m.minute}\nAI LIVE RUNG: ${decision.reason}\nOdds Tài: ${decision.overOdds??'Không xác minh'}`;const {data}=await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{chat_id:CHAT,text:body},{timeout:10000});if(!data?.ok)throw Error('Telegram rejected');return data.result?.message_id;}
function qualifying(m){return m.state===3&&m.minute!==null&&m.minute>=60&&m.minute<85&&m.htGoals!==null&&m.htGoals>=1&&!isFilteredLeague(m.league,m.homeName,m.awayName);}
async function scan(){
 if(scanning||paused||!ready)return [];
 scanning=true;const output=[];
 try{
  const fixtures=await fetchFixtures();const seen=new Set();
  for(const m of fixtures){
   seen.add(m.id);const old=matches.get(m.id);
   // Retain last VERIFIED minute when Bongdalu temporarily omits it. Never use it for a new signal.
   const verified=m.minute!==null;
   if(!verified&&old?.minute!==null&&old?.minute!==undefined){m.lastVerifiedMinute=old.minute;m.minuteSource='stale';}
   matches.set(m.id,m);
   if(m.state===-1){const previous=sent.get(m.id);if(previous&&!previous.ft){previous.ft={home:m.homeScore,away:m.awayScore,at:now()};await save(m.id,previous);}watchlist.delete(m.id);continue;}
   if(m.state!==1&&m.state!==3){watchlist.delete(m.id);continue;}
   if(sent.has(m.id)){watchlist.delete(m.id);continue;}
   if(verified&&m.minute>=85){watchlist.delete(m.id);continue;}
   if(!watchlist.has(m.id)&&qualifying(m))watchlist.set(m.id,{id:m.id,addedAt:now(),order:watchlist.size});
   if(!watchlist.has(m.id))continue;
   // Only fresh, verified minutes in range may trigger AI decisions.
   if(!verified||m.minute<60||m.minute>=85){observations.set(m.id,{...(observations.get(m.id)||{}),stale:true});continue;}
   try{
    const observed=market.observe(m.id,await fetchMarket(m.id));
    if(observed.status!=='OBSERVED'){observations.set(m.id,{...(observations.get(m.id)||{}),marketStatus:observed.status,stale:true});continue;}
    const decision=decideLiveRung(m,market.get(m.id));
    const confidence=decision.level?signalConfidence(decision.level,market.get(m.id),sent.values()):null;
    observations.set(m.id,{marketStatus:observed.status,decision,signalConfidence:confidence,at:now(),stale:false,goalChanged:!!old&&(old.homeScore!==m.homeScore||old.awayScore!==m.awayScore)});
    output.push({...m,marketStatus:observed.status,decision});
    if(m.minute<65||sent.has(m.id)||!decision.level)continue;
    const record={id:m.id,home:m.homeName,away:m.awayName,league:m.league,minute:m.minute,score:`${m.homeScore}-${m.awayScore}`,decision,signalConfidence:confidence,marketEvidenceAtAlert:confidence?.evidence??null,marketSnapshotAtAlert:market.get(m.id),status:'pending',sentAt:null,ft:null};
    sent.set(m.id,record);watchlist.delete(m.id);await save(m.id,record);
    try{record.telegramMessageId=await telegram(m,decision);record.status='sent';record.sentAt=now();}catch(e){record.status='send_unknown';record.error=e.message;console.error('[Telegram]',m.id,e.message);}await save(m.id,record);
   }catch(e){console.warn('[AI LIVE RUNG]',m.id,e.message);observations.set(m.id,{...(observations.get(m.id)||{}),stale:true});}
  }
  lastScan={at:now(),fixtures:fixtures.length,analyzed:output.length,watching:watchlist.size};lastError=null;await persistTracking();return output;
 }catch(e){lastError={at:now(),message:e.message};throw e;}finally{scanning=false;}
}
app.get('/health',(req,res)=>res.status(ready?200:503).json({ok:ready,source:'bongdalu',engine:'AI LIVE RUNG',lastScan,lastError,db:!!pool}));
app.get('/api/live-rung',(req,res)=>res.json({ok:true,engine:'AI LIVE RUNG',source:'bongdalu',paused,lastScan,lastError,matches:[...matches.values()].filter(x=>x.state===1||x.state===3).map(m=>({...m,observation:observations.get(m.id)||null,market:market.get(m.id),alert:sent.get(m.id)||null}))}));
app.get('/api/rung-bet',(req,res)=>res.json({ok:true,records:[...sent.values()].filter(r=>r.status==='sent'&&!r.ft).map(alertView)}));
app.get('/api/audit',(req,res)=>res.json({ok:true,records:[...sent.values()].map(alertView)}));
app.get('/api/scan-control',(req,res)=>res.json({ok:true,paused}));
app.post('/api/scan-control',authorized,async(req,res)=>{if(typeof req.body?.paused!=='boolean')return res.status(400).json({error:'paused boolean required'});try{paused=req.body.paused;if(pool)await save('__control__',{paused});res.json({ok:true,paused});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/scan',authorized,async(req,res)=>{try{const result=await scan();res.json({ok:true,analyzed:result.length,results:result});}catch(e){res.status(502).json({ok:false,error:e.message});}});
app.get('/scan',(req,res)=>res.status(405).json({error:'Use authenticated POST /api/scan'}));
// Compatibility view-models for the ORIGINAL HTML screens; no old AI computation.
function uiLiveRows(){return [...matches.values()].filter(m=>m.state===1||m.state===3).map(m=>{
 const o=observations.get(m.id)||{},d=o.decision||{},q=market.get(m.id)||{};
 return {fixtureId:m.id,id:m.id,tracked:watchlist.has(m.id),htGoals:m.htGoals,lastVerifiedMinute:m.lastVerifiedMinute??null,minuteSource:m.minuteSource,stale:!!o.stale,home:m.homeName,away:m.awayName,league:m.league,minute:m.minute??m.lastVerifiedMinute??null,scoreH:m.homeScore,scoreA:m.awayScore,score:`${m.homeScore}-${m.awayScore}`,status:'LIVE',alertLabel:sent.get(m.id)?.status==='sent'?(sent.get(m.id).decision?.level||'RUNG BET'):null,probability:o.signalConfidence?.probability??null,signalConfidence:o.signalConfidence??null,aiProbability:o.signalConfidence?.probability??null,expectedRemainingGoals:null,aiLiveEnhanced:{marketProbability:o.signalConfidence?.probability??null,combinedLambda:null,marketLambda:null,overOdds:d.overOdds??null,marketLine:d.line??null,liveCoverage:o.marketStatus||'UNAVAILABLE'},market:q,decision:d};
});}
app.get('/api/live-monitor',(req,res)=>res.json({ok:true,rows:uiLiveRows().filter(m=>watchlist.has(String(m.id))),noStats:[],totalLive:[...matches.values()].filter(m=>m.state===1||m.state===3).length,watching:watchlist.size,analyzed:[...observations].filter(([id,o])=>watchlist.has(id)&&o.decision).length,alerts:[...sent.values()].filter(r=>r.status==='sent').length,lastScan}));
app.get('/api/ai-live-market',(req,res)=>res.json({ok:true,rows:uiLiveRows()}));
app.get('/api/ai-no-stats',(req,res)=>res.json({ok:true,records:uiLiveRows()}));
app.get('/api/no-stats-alerts',(req,res)=>{
 const records=[...sent.values()].filter(r=>r.status==='sent').map(alertView);
 const settled=records.filter(r=>r.evaluation!=='PENDING_FT'),wins=settled.filter(r=>r.evaluation==='WIN').length,losses=settled.filter(r=>r.evaluation==='LOSS').length;
 res.json({ok:true,records,summary:{sent:records.length,settled:settled.length,pending:records.length-settled.length,
  wins,losses,winRate:wins+losses?Number((wins*100/(wins+losses)).toFixed(1)):null,
  over:{rate:null,wins:0,losses:0,noLine:records.length}}});
});
app.get('/api/no-stats-odds-waiting',(req,res)=>res.json({ok:true,records:[]}));
app.get('/api/no-stats-bet-control',(req,res)=>res.json({ok:true,enabled:true,engine:'AI LIVE RUNG'}));
app.get('/api/scan-history',(req,res)=>{const rows=[...sent.values()].filter(r=>r.id!=='__control__').map(r=>({at:r.sentAt||null,league:r.league,home:r.home,away:r.away,minute:r.minute,scoreH:Number(String(r.score).split('-')[0]),scoreA:Number(String(r.score).split('-')[1]),noStatsProbability:r.signalConfidence?.probability??null,signalConfidence:r.signalConfidence??null,noStatsExpectedGoals:null,noStatsModel:'AI LIVE RUNG',noStatsAudit:r.status,reason:r.decision?.reason||'',outcome:resultOf(r),ftHome:r.ft?.home,ftAway:r.ft?.away}));const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||60));res.json({ok:true,rows:rows.slice((page-1)*limit,page*limit),total:rows.length,limit,summary:{scannedTotal:lastScan?.fixtures||0,uniqueFixtures:matches.size,settled:rows.filter(r=>r.outcome!=='PENDING_FT').length,noStatsAvailable:rows.length,noStatsQualified:0,noData:0},last:{totalLive:uiLiveRows().length,uniqueLive:uiLiveRows().length,eligible:watchlist.size}});});
// Original multi-page interface restored. Backend is exclusively AI LIVE RUNG.
const originalPages = {'/':'dashboard.html','/dashboard':'dashboard.html','/dashboard.html':'dashboard.html','/live-monitor':'live-monitor.html','/live-monitor.html':'live-monitor.html','/rung-bet':'rung-bet.html','/rung-bet.html':'rung-bet.html','/scan-history':'scan-history.html','/scan-history.html':'scan-history.html','/login':'login.html','/login.html':'login.html'};
for (const [route,file] of Object.entries(originalPages)) app.get(route,(req,res)=>res.sendFile(path.join(__dirname,file)));
// Original HTML files remain in project root. No public/ folder required.

async function start(){await init();app.listen(PORT,()=>console.log(`Bongdalu AI LIVE RUNG listening on ${PORT}`));setTimeout(()=>scan().catch(e=>console.error('[scan]',e.message)),1500);setInterval(()=>scan().catch(e=>console.error('[scan]',e.message)),5000);}
if(require.main===module)start().catch(e=>{console.error('Startup failure:',e);process.exit(1);});
module.exports={app,scan,norm,init,fetchFixtures,verifiedDeltaMinute,verifiedOddsMinute};
