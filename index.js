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
const BET365_COMPANY_ID=2; // Bongdalu bookmaker mapping supplied for BET365; verify against provider metadata
const TOKEN=process.env.TELEGRAM_BOT_TOKEN,CHAT=process.env.TELEGRAM_CHAT_ID;
const ADMIN_TOKEN=process.env.ADMIN_TOKEN;
const market=new LiveRungMarket(),matches=new Map(),sent=new Map(),observations=new Map(),watchlist=new Map();
const leagueNamesByFixture=new Map();
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
 return {...r,goalTimeline:r.goalTimeline||'Chưa có dữ liệu diễn biến xác minh',league:r.league||m?.league||leagueNamesByFixture.get(String(r.id))||'',key:r.id,fixtureId:r.id,liveMinute:m?.minute??null,alertLabel:label,alertType:label,probability:r.signalConfidence?.probability??null,signalConfidence:r.signalConfidence??null,
  expectedRemainingGoals:null,overLineAtAlert:r.decision?.line??null,scoreAtAlert:r.score,liveScore:ft?null:scoreNow,ftScore:ft?scoreNow:null,
  liveGoalsAfterAlert:goals,score: r.score,overOddsAtAlert:r.decision?.overOdds??null,
  oddsAtAlertStatus:r.decision?.overOdds==null?'CHUA_LAY_DUOC_ODDS':'DAT_ODDS',
  evaluation:resultOf(r),outcome:resultOf(r),status:r.status};
}
async function proxyGetPayload(p){const {data}=await axios.get(`${PROXY}/wp-json/wpsport/v1/proxy`,{params:{path:p,_bdts:Date.now()},timeout:12000});if(Number(data?.code)!==0)throw Error('Bongdalu proxy error: '+JSON.stringify(data).slice(0,120));return data?.data||[];}
async function proxyGet(p){const payload=await proxyGetPayload(p);return payload?.results||payload?.matches||payload;}
function rows(payload){return Array.isArray(payload)?payload:[];}
function asText(v){return typeof v==='string'?v.trim():typeof v==='object'&&v?String(v.name||v.Name||'').trim():'';}
function minuteNumber(value){
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)&&n>=1&&n<=130?n:null;
}
function parseBongdaluTime(value){
 if(typeof value==='number'&&value>1000000000)return value*1000;
 if(typeof value==='string'&&/^\d{10}$/.test(value))return Number(value)*1000;
 if(typeof value==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(value)){
  // Provider local clock: no implicit server-local timezone conversion.
  const utc=Date.parse(value.replace(' ','T')+'Z');
  const offset=Number(process.env.BONGDALU_TIME_UTC_OFFSET_HOURS);
  return Number.isFinite(offset)?utc-offset*3600000:null;
 }
 return null;
}
function verifiedDeltaMinute(delta,at=Date.now()){
 if(!delta||typeof delta!=='object')return null;
 const state=Number(delta.MatchState);
 if(state!==1&&state!==3)return null;
 const started=parseBongdaluTime(state===3?(delta.matchTime2??delta.MatchTime2):delta.matchTime);
 if(!Number.isFinite(started))return null;
 const elapsed=(at-started)/60000;
 if(!Number.isFinite(elapsed)||elapsed<0)return null;
 if(state===1&&elapsed<=50)return Math.max(1,Math.floor(elapsed)+1);
 if(state===3&&elapsed<=70)return 45+Math.floor(elapsed);
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
  return {id:String(id),source:'bongdalu',homeName:home,awayName:away,league:asText(r.LeagueName??r.SclassName),homeScore:h,awayScore:a,htGoals:Number.isFinite(htH)&&Number.isFinite(htA)?htH+htA:null,minute,state,raw:r};
}
// Prefer the most specific verified league name supplied by Bongdalu.
function leagueText(value){
 if(value==null || typeof value==='object')return '';
 return String(value).trim();
}
function leagueSpecificity(name){
 const v=leagueText(name);
 if(!v)return 0;
 // Generic country-level labels should not override a named competition.
 if(/^(?:football\s+league|league|giải\s+bóng\s+đá|bóng\s+đá)(?:\s+|\s*[-–:]\s*).+$/i.test(v))return 1;
 return 2;
}
function preferLeague(...values){
 return values.map(leagueText).filter(Boolean).sort((a,b)=>leagueSpecificity(b)-leagueSpecificity(a))[0]||'';
}
function leagueId(r){return String(r?.sclassID??r?.SclassID??r?.sclassId??r?.leagueId??r?.LeagueID??'');}
function leagueFromRow(r){return preferLeague(r?.leagueName,r?.LeagueName,r?.name,r?.Name,r?.SclassName,r?.sort_name);}
function buildLeagueMap(payload){
 const map=new Map();
 for(const r of rows(payload?.leagues??payload?.Leagues)){
  const id=leagueId(r);
  if(id)map.set(id,preferLeague(leagueFromRow(r),map.get(id)));
 }
 return map;
}
function resolveLeague(match,leagueMap,previous=''){
 return preferLeague(leagueMap.get(leagueId(match)),leagueFromRow(match),previous);
}
async function fetchOddsMinuteRows(){
  try{
    const data=await proxyGet(`/v1/football/odds/live?companyid=${BET365_COMPANY_ID}&locale=vi`);
    return rows(data).filter(r=>String(r.market).toUpperCase()==='OU');
  }catch(e){console.warn('[BONGDALU MINUTE ODDS]',e.message);return [];}
}
// Resolve older persisted alerts from Bongdalu diary dates without changing AI decisions.
let leagueBackfillRunning=false;
async function backfillMissingAlertLeagues(){
 if(leagueBackfillRunning)return;
 const missing=[...sent.values()].filter(r=>r?.status==='sent'&&!r.league&&r.sentAt);
 if(!missing.length)return;
 leagueBackfillRunning=true;
 try{
  const dates=[...new Set(missing.map(r=>{
   const d=new Date(r.sentAt);return Number.isFinite(d.getTime())?(()=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const v=k=>parts.find(x=>x.type===k)?.value;return `${v('year')}-${v('month')}-${v('day')}`;})():null;
  }).filter(Boolean))].slice(0,3);
  for(const date of dates){
   try{
    const payload=await proxyGetPayload('/v1/football/match/diary?'+`date=${date}&timeRange=all&lang=vn&ishot=0&halfOdd=0&locale=vi`);
    const names=buildLeagueMap(payload);
    for(const match of rows(payload?.matches??payload?.results??payload)){
     const id=String(match.ScheduleID??match.scheduleId??'');
     const league=resolveLeague(match,names,leagueNamesByFixture.get(id));
     if(!id||!league)continue;
     leagueNamesByFixture.set(id,league);
     const saved=sent.get(id);
     if(saved&&preferLeague(league,saved.league)!==saved.league){saved.league=preferLeague(league,saved.league);await save(id,saved);}
    }
   }catch(err){console.warn('[BONGDALU LEAGUE BACKFILL]',date,err.message);}
  }
 }finally{leagueBackfillRunning=false;}
}
async function fetchFixtures(){
  const q=`date=${vnDate()}&timeRange=all&lang=vn&ishot=0&halfOdd=0&locale=vi`;
  const diaryPayload=await proxyGetPayload('/v1/football/match/diary?'+q);
  const diary=rows(diaryPayload?.matches??diaryPayload?.results??diaryPayload);
  // Bongdalu match rows contain sclassID; names are in the sibling leagues list.
  const leagueById=buildLeagueMap(diaryPayload);
  const byId=new Map(diary.filter(r=>r.ScheduleID).map(r=>{
    const league=resolveLeague(r,leagueById,leagueNamesByFixture.get(String(r.ScheduleID)));
    if(league)leagueNamesByFixture.set(String(r.ScheduleID),league);
    return [String(r.ScheduleID),{...r,LeagueName:league}];
  }));
  const deltas=new Map();
  try{
    for(const d of rows(await proxyGet('/v1/football/match/live?locale=vi'))){
      const id=String(d.ScheduleID??d.scheduleId??d.id);
      if(!byId.has(id))continue;
      deltas.set(id,d);const prior=byId.get(id);byId.set(id,{...prior,...d,LeagueName:resolveLeague(d,leagueById,preferLeague(prior.LeagueName,leagueNamesByFixture.get(id)))});
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
async function fetchMarket(id,allOdds){return rows(allOdds).filter(r=>String(r.match_id)===String(id)&&String(r.market).toUpperCase()==='OU');}
function goalTimeline(m){
 // Accept only explicit goal events with verified cumulative home/away scores.
 const raw=m?.raw||{};
 const containers=[raw.goalEvents,raw.goals,raw.GoalEvents,raw.goalTimeline,raw.events,raw.Events,raw.incidents,raw.Incidents,raw.matchEvents,raw.MatchEvents,raw.goalList,raw.GoalList];
 const events=containers.find(Array.isArray);
 if(!events)return 'Chưa có dữ liệu diễn biến xác minh';
 const parsed=[];
 for(const e of events){
  if(!e||typeof e!=='object')continue;
  const type=String(e.type??e.Type??e.eventType??e.EventType??'').toLowerCase();
  if(type&&(/corner|card|yellow|red|substitution|penalty missed|var cancelled|goal cancelled/.test(type)))continue;
  const minute=minuteNumber(e.minute??e.Minute??e.time??e.Time??e.matchTime);
  const home=Number(e.homeScore??e.HomeScore??e.scoreHome??e.homeGoals);
  const away=Number(e.awayScore??e.AwayScore??e.GuestScore??e.scoreAway??e.awayGoals);
  if(minute===null||!Number.isInteger(home)||!Number.isInteger(away)||home<0||away<0)continue;
  parsed.push({minute,home,away});
 }
 parsed.sort((a,b)=>a.minute-b.minute||a.home+a.away-b.home-b.away);
 const valid=[];let h=0,a=0;
 for(const e of parsed){
  if(e.home+e.away!==h+a+1||(e.home!==h+1||e.away!==a)&&(e.home!==h||e.away!==a+1))continue;
  valid.push(`P${e.minute}: ${e.home}-${e.away}`);h=e.home;a=e.away;
 }
 // Incomplete event histories are not presented as verified timelines.
 if(!valid.length||h!==Number(m.homeScore)||a!==Number(m.awayScore))return 'Chưa có dữ liệu diễn biến xác minh';
 return valid.join(' | ');
}
function telegramBody(m,decision,confidence){
 const label=String(decision.level||'').toUpperCase().includes('BIG')?'BIGGG BET':'BET NHẸ TAY';
 const odd=Number(decision.overOdds);
 const oddsText=decision.overOdds!==null&&decision.overOdds!==undefined&&Number.isFinite(odd)&&odd>1?`BET365 — Tài ${decision.line??'—'} @ ${odd.toFixed(2)}`:'BET365 — Chưa xác minh odds LIVE';
 const probability=Number(confidence?.probability);
 const probabilityText=confidence?.probability!=null&&Number.isFinite(probability)?`${probability.toFixed(1)}%`:'Chưa có xác suất xác minh';
 return `💰 THẦN TÀI ĐẾN 🧧🧧🧧 - ${label}\n🏆 ${m.league||'Chưa rõ giải đấu'}\n⚽️ ${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName} ⏱️ Phút ${m.minute}\n⚽️ Diễn biến tỷ số: ${goalTimeline(m)}\nODD NHÀ CÁI: ${oddsText}\n🎯 Xác suất: ${probabilityText}`;
}
async function telegram(m,decision,confidence){
 if(!TOKEN||!CHAT)throw Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
 const body=telegramBody(m,decision,confidence);
 const {data}=await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{chat_id:CHAT,text:body},{timeout:10000});
 if(!data?.ok)throw Error('Telegram rejected');return data.result?.message_id;
}
function qualifying(m){return m.state===3&&m.minute!==null&&m.minute>=60&&m.minute<85&&m.htGoals!==null&&m.htGoals>=1&&!isFilteredLeague(m.league,m.homeName,m.awayName);}
async function scan(){
 if(scanning||paused||!ready)return [];
 scanning=true;const output=[];
 try{
  const fixtures=await fetchFixtures();const oddsSnapshot=await proxyGet(`/v1/football/odds/live?companyid=${BET365_COMPANY_ID}&locale=vi`).catch(e=>{console.warn('[BET365 ODDS]',e.message);return [];});const seen=new Set();
  for(const m of fixtures){
   seen.add(m.id);const old=matches.get(m.id);
   // Retain last VERIFIED minute when Bongdalu temporarily omits it. Never use it for a new signal.
   const verified=m.minute!==null;
   if(!verified&&old?.minute!==null&&old?.minute!==undefined){m.lastVerifiedMinute=old.minute;m.minuteSource='stale';}
   matches.set(m.id,m);
   if(m.state===-1){const previous=sent.get(m.id);if(previous&&previous.status==='sent'&&!previous.ft&&Number.isFinite(m.homeScore)&&Number.isFinite(m.awayScore)){previous.ft={home:m.homeScore,away:m.awayScore,at:now()};await save(m.id,previous);}watchlist.delete(m.id);continue;}
   if(m.state!==1&&m.state!==3){if(watchlist.has(m.id)){observations.set(m.id,{...(observations.get(m.id)||{}),stale:true});}continue;}
   if(sent.has(m.id)){watchlist.delete(m.id);continue;}
   if(verified&&m.minute>=85){watchlist.delete(m.id);continue;}
   if(!watchlist.has(m.id)&&qualifying(m))watchlist.set(m.id,{id:m.id,addedAt:now(),order:watchlist.size});
   if(!watchlist.has(m.id))continue;
   // Only fresh, verified minutes in range may trigger AI decisions.
   if(!verified||m.minute<60||m.minute>=85){observations.set(m.id,{...(observations.get(m.id)||{}),stale:true});continue;}
   try{
    const observed=market.observe(m.id,(await fetchMarket(m.id,oddsSnapshot)).filter(r=>Number(r.match_status)===4&&String(r.score)===`${m.homeScore}-${m.awayScore}`));
    if(observed.status!=='OBSERVED'){observations.set(m.id,{...(observations.get(m.id)||{}),marketStatus:observed.status,stale:true});continue;}
    const decision=decideLiveRung(m,market.get(m.id));
    const confidence=decision.level?signalConfidence(decision.level,market.get(m.id),sent.values()):null;
    observations.set(m.id,{marketStatus:observed.status,decision,signalConfidence:confidence,at:now(),stale:false,goalChanged:!!old&&(old.homeScore!==m.homeScore||old.awayScore!==m.awayScore)});
    output.push({...m,marketStatus:observed.status,decision});
    if(m.minute<65||sent.has(m.id)||!decision.level)continue;
    const record={goalTimeline:goalTimeline(m),id:m.id,home:m.homeName,away:m.awayName,league:m.league,minute:m.minute,score:`${m.homeScore}-${m.awayScore}`,decision,signalConfidence:confidence,marketEvidenceAtAlert:confidence?.evidence??null,marketSnapshotAtAlert:market.get(m.id),status:'pending',sentAt:null,ft:null};
    sent.set(m.id,record);watchlist.delete(m.id);await save(m.id,record);
    try{record.telegramMessageId=await telegram(m,decision,confidence);record.status='sent';record.sentAt=now();}catch(e){record.status='send_unknown';record.error=e.message;console.error('[Telegram]',m.id,e.message);}await save(m.id,record);
   }catch(e){console.warn('[AI LIVE RUNG]',m.id,e.message);observations.set(m.id,{...(observations.get(m.id)||{}),stale:true});}
  }
  // Keep missing fixtures in the watchlist until an explicit FT, alert or verified minute >=85.
  for(const [id,entry] of watchlist){if(!seen.has(id)){observations.set(id,{...(observations.get(id)||{}),stale:true});}}
  lastScan={at:now(),fixtures:fixtures.length,analyzed:output.length,watching:watchlist.size};lastError=null;await persistTracking();void backfillMissingAlertLeagues().catch(e=>console.warn('[LEAGUE BACKFILL]',e.message));return output;
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
function uiLiveRows(){return [...matches.values()].filter(m=>m.state===1||m.state===3||watchlist.has(m.id)).map(m=>{
 const o=observations.get(m.id)||{},d=o.decision||{},q=market.get(m.id)||{};
 return {fixtureId:m.id,id:m.id,tracked:watchlist.has(m.id),htGoals:m.htGoals,lastVerifiedMinute:m.lastVerifiedMinute??null,minuteSource:m.minuteSource,stale:!!o.stale||!(m.state===1||m.state===3),home:m.homeName,away:m.awayName,league:m.league,minute:m.minute??m.lastVerifiedMinute??null,scoreH:m.homeScore,scoreA:m.awayScore,score:`${m.homeScore}-${m.awayScore}`,status:'LIVE',alertLabel:sent.get(m.id)?.status==='sent'?(sent.get(m.id).decision?.level||'RUNG BET'):null,probability:o.signalConfidence?.probability??null,signalConfidence:o.signalConfidence??null,aiProbability:o.signalConfidence?.probability??null,expectedRemainingGoals:null,aiLiveEnhanced:{marketProbability:o.signalConfidence?.probability??null,combinedLambda:null,marketLambda:null,overOdds:d.overOdds??q.bookmakers?.[0]?.overDecimal??null,marketLine:d.line??q.bookmakers?.[0]?.line??null,liveCoverage:o.marketStatus||'UNAVAILABLE'},market:q,decision:d};
});}
app.get('/api/live-monitor',(req,res)=>res.json({ok:true,rows:uiLiveRows().filter(m=>watchlist.has(String(m.id))&&!([...sent.values()].some(r=>r.id===m.id&&r.status==='sent'))),noStats:[],totalLive:[...matches.values()].filter(m=>m.state===1||m.state===3).length,watching:watchlist.size,analyzed:[...observations].filter(([id,o])=>watchlist.has(id)&&o.decision).length,alerts:[...sent.values()].filter(r=>r.status==='sent').length,lastScan}));
app.get('/api/ai-live-market',(req,res)=>res.json({ok:true,rows:uiLiveRows()}));

app.get('/api/live-rung-alerts',(req,res)=>{
 const records=[...sent.values()].filter(r=>r.status==='sent').map(alertView).sort((a,b)=>String(b.sentAt||'').localeCompare(String(a.sentAt||'')));
 const settled=records.filter(r=>r.ft&&r.evaluation!=='PENDING_FT'),wins=settled.filter(r=>r.evaluation==='WIN').length,losses=settled.filter(r=>r.evaluation==='LOSS').length;
 res.json({ok:true,records,summary:{sent:records.length,settled:settled.length,pending:records.length-settled.length,
  wins,losses,winRate:wins+losses?Number((wins*100/(wins+losses)).toFixed(1)):null,
  over:{rate:null,wins:0,losses:0,noLine:records.length}}});
});


// Read-only compatibility endpoint for the legacy dashboard: data comes exclusively from AI LIVE RUNG.
app.get('/api/no-stats-alerts',(req,res)=>{
 const records=[...sent.values()].filter(r=>r.status==='sent').map(alertView).sort((a,b)=>String(b.sentAt||'').localeCompare(String(a.sentAt||'')));
 const wins=records.filter(r=>r.evaluation==='WIN').length,losses=records.filter(r=>r.evaluation==='LOSS').length;
 const settled=records.filter(r=>r.evaluation!=='PENDING_FT').length;
 res.json({ok:true,records,summary:{sent:records.length,settled,pending:records.length-settled,wins,losses,voids:0,winRate:wins+losses?Number((100*wins/(wins+losses)).toFixed(1)):null,over:{rate:null,wins:0,losses:0,noLine:records.length}}});
});
app.get('/api/no-stats-odds-waiting',(req,res)=>res.json({ok:true,records:[]}));
function historyRows(){
 return [...sent.values()].filter(r=>r&&r.id&&r.id!=='__control__'&&r.status==='sent').map(r=>({
  id:r.id,at:r.sentAt||null,goalTimeline:r.goalTimeline||'Chưa có dữ liệu diễn biến xác minh',league:r.league||matches.get(r.id)?.league||leagueNamesByFixture.get(String(r.id))||'',home:r.home,away:r.away,minute:r.minute,
  scoreH:Number(String(r.score).split('-')[0]),scoreA:Number(String(r.score).split('-')[1]),
  aiProbability:r.signalConfidence?.probability??null,signalConfidence:r.signalConfidence??null,
  expectedRemainingGoals:null,engine:'AI LIVE RUNG',alertSent:true,
  alertType:r.decision?.level||'BET NHẸ TAY',reason:r.decision?.reason||'',
  outcome:resultOf(r),ftHome:r.ft?.home??null,ftAway:r.ft?.away??null,
  overOdds:r.decision?.overOdds??null,overLine:r.decision?.line??null
 })).sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
}
function filteredHistory(rows,query){
 const status=String(query.status||'').toUpperCase(),q=String(query.q||'').trim().toLocaleLowerCase('vi');
 const group=String(query.group||'');
 return rows.filter(r=>{
  if(status&&r.outcome!==status)return false;
  if(q&&!`${r.home} ${r.away} ${r.league}`.toLocaleLowerCase('vi').includes(q))return false;
  if(group==='not_qualified')return false; // Only actually sent alerts are persisted here.
  if(group==='no_stats_ge088')return Number(r.aiProbability)>=88;
  if(group==='no_stats_lt088')return r.aiProbability!=null&&Number(r.aiProbability)<88;
  return true;
 });
}
app.get('/api/scan-history',(req,res)=>{
 const all=historyRows(),filtered=filteredHistory(all,req.query);
 const limit=Math.min(100,Math.max(1,parseInt(req.query.limit,10)||25));
 const totalPages=Math.max(1,Math.ceil(filtered.length/limit));
 const page=Math.min(totalPages,Math.max(1,parseInt(req.query.page,10)||1));
 const settled=all.filter(r=>r.outcome==='WIN'||r.outcome==='LOSS').length;
 res.json({ok:true,rows:filtered.slice((page-1)*limit,page*limit),total:filtered.length,
  page,totalPages,limit,summary:{scannedTotal:lastScan?.fixtures||0,uniqueFixtures:matches.size,
  settled,noStatsAvailable:all.length,noStatsQualified:all.filter(r=>Number(r.aiProbability)>=88).length,
  noData:all.filter(r=>r.aiProbability==null).length},
  last:{totalLive:uiLiveRows().length,uniqueLive:uiLiveRows().length,eligible:watchlist.size}});
});
// Original multi-page interface restored. Backend is exclusively AI LIVE RUNG.
const originalPages = {'/':'dashboard.html','/dashboard':'dashboard.html','/dashboard.html':'dashboard.html','/live-monitor':'live-monitor.html','/live-monitor.html':'live-monitor.html','/rung-bet':'rung-bet.html','/rung-bet.html':'rung-bet.html','/scan-history':'scan-history.html','/scan-history.html':'scan-history.html','/login':'login.html','/login.html':'login.html'};
for (const [route,file] of Object.entries(originalPages)) app.get(route,(req,res)=>res.sendFile(path.join(__dirname,file)));
// Original HTML files remain in project root. No public/ folder required.

async function start(){await init();app.listen(PORT,()=>console.log(`Bongdalu AI LIVE RUNG listening on ${PORT}`));setTimeout(()=>scan().catch(e=>console.error('[scan]',e.message)),1500);setInterval(()=>scan().catch(e=>console.error('[scan]',e.message)),5000);}
if(require.main===module)start().catch(e=>{console.error('Startup failure:',e);process.exit(1);});
module.exports={app,scan,norm,init,fetchFixtures,verifiedDeltaMinute,verifiedOddsMinute};
