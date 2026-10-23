'use strict';
const fs=require('fs'); const path=require('path'); const crypto=require('crypto');
const axios=require('axios');
const FILE=process.env.AUDIT_DATA_FILE || path.join(__dirname,'audit-data.json');
const dbUrl=process.env.DATABASE_URL;
let pool=null, initialized=false;
if(dbUrl){try{const {Pool}=require('pg');pool=new Pool({connectionString:dbUrl,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});}catch(e){console.error('[AUDIT] pg unavailable',e.message);}}
let records=[];try{records=JSON.parse(fs.readFileSync(FILE,'utf8'));if(!Array.isArray(records))records=[];}catch{}
const clone=x=>JSON.parse(JSON.stringify(x));
const safeNum=v=>Number.isFinite(Number(v))?Number(v):null;
function scoreResults(r){if(r.ftHome==null||r.ftAway==null)return {...r,goalResult:'PENDING',overResult:r.overLine==null?'NO_LINE':'PENDING'};
const goals=r.ftHome+r.ftAway, before=r.homeScore+r.awayScore;
const goalResult=goals>before?'WIN':'LOSS';let overResult='NO_LINE';
if(r.overLine!=null){overResult=goals>r.overLine?'WIN':goals<r.overLine?'LOSS':'PUSH';}
return {...r,goalResult,overResult};}
// AI NO-STATS shares V4's promax_alert_audit table and database connection.
// A namespaced id prevents collision with V4 alerts; source keeps the models separate.
const noStatsAuditId=key=>'AI_NO_STATS:'+String(key);
async function loadNoStatsAlertRecords(){
 if(!pool){
  return records.filter(r=>r?.source==='AI_NO_STATS').map(r=>r.noStatsPayload||r);
 }
 await init();
 // Read shared audit, including records written by previous deployments.
 const {rows}=await pool.query("SELECT data FROM promax_alert_audit WHERE LEFT(id,12) = 'AI_NO_STATS:' ORDER BY created_at ASC LIMIT 10000");
 const merged=new Map(rows.map(x=>x.data?.noStatsPayload||x.data).filter(x=>x?.key).map(x=>[x.key,x]));
 // One-time compatibility migration: preserve existing alerts from the former table.
 const legacy=await pool.query("SELECT to_regclass('public.promax_no_stats_alert_audit') AS name");
 if(legacy.rows[0]?.name){
  const old=await pool.query('SELECT data FROM promax_no_stats_alert_audit ORDER BY created_at ASC LIMIT 10000');
  for(const {data} of old.rows){
   if(!data?.key||merged.has(data.key))continue;
   await saveNoStatsAlertRecord(data);
   merged.set(data.key,data);
  }
 }
 return [...merged.values()];
}
async function saveNoStatsAlertRecord(row){
 if(!row?.key)throw new Error('AI NO-STATS alert key missing');
 const payload={...row,source:'AI NO-STATS'};
 const rec={id:noStatsAuditId(row.key),source:'AI_NO_STATS',matchKey:row.key,
  alertNumber:1,home:row.home,away:row.away,league:row.league,
  minute:row.minute,homeScore:Number(String(row.score||'').split(/[-–:]/)[0]),
  awayScore:Number(String(row.score||'').split(/[-–:]/)[1]),
  telegramMessageId:row.telegramMessageId,createdAt:row.sentAt,
  noStatsPayload:payload};
 if(pool){
  await init();
  await pool.query('INSERT INTO promax_alert_audit (id,data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data',[rec.id,JSON.stringify(rec)]);
 }else{
  // Same V4 local audit file when PostgreSQL is not configured.
  const existing=records.findIndex(x=>x.id===rec.id);
  if(existing>=0)records[existing]=rec;else records.unshift(rec);
  fs.writeFileSync(FILE+'.tmp',JSON.stringify(records,null,2));fs.renameSync(FILE+'.tmp',FILE);
 }
}
async function init(){if(initialized)return; if(pool){await pool.query('CREATE TABLE IF NOT EXISTS promax_alert_audit (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())');const {rows}=await pool.query('SELECT data FROM promax_alert_audit ORDER BY created_at DESC LIMIT 10000');records=rows.map(x=>x.data).filter(x=>x.source!=='AI_NO_STATS');}initialized=true;}
async function save(r){await init();const idx=records.findIndex(x=>x.id===r.id);if(idx>=0)records[idx]=r;else records.unshift(r);if(pool){await pool.query('INSERT INTO promax_alert_audit (id,data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data',[r.id,JSON.stringify(r)]);}else{fs.writeFileSync(FILE+'.tmp',JSON.stringify(records,null,2));fs.renameSync(FILE+'.tmp',FILE);}}
// Optional LIVE analytics. Keep null distinct from a confirmed zero.
const LIVE_FIELDS=['TotalShots','ShotsOnTarget','ShotsOffTarget','BlockedShots','Attacks','DangerousAttacks','Corners','Possession','BigChances','ExpectedGoals','ShotsInsideBox','RedCards','YellowCards'];
function captureLiveStats(stats){
 const out={};if(!stats)return out;
 for(const field of LIVE_FIELDS){for(const side of ['home','away']){
  const key=side+field;
  if(stats._present?.[key]===true){const n=safeNum(stats[key]);if(n!==null)out[key]=n;}
 }}return out;
}
function captureConfidence(c){if(!c)return null;
 const out={coverage:safeNum(c.coverage),total:safeNum(c.total),percent:safeNum(c.percent),label:String(c.label||''),method:String(c.method||'coverage-v1')};
 if(c.components && typeof c.components==='object'){
  out.components={};for(const k of ['quality','agreement','momentumReliability','stability'])out.components[k]=safeNum(c.components[k]);
 }return out;
}
function captureSpike(spike){if(!spike)return null;
 return {confirmed:spike.confirmed===true,score:safeNum(spike.score),groups:safeNum(spike.groups),cornerDensity:safeNum(spike.cornerDensity),reason:String(spike.reason||''),signals:spike.signals&&typeof spike.signals==='object'?{
 finishing:spike.signals.finishing===true,corners:spike.signals.corners===true,pressure:spike.signals.pressure===true,cards:spike.signals.cards===true}:null};
}
async function addAlert(item,number,messageId){const id=`${item.alertKey}|${number}|${messageId}`;const rec=scoreResults({id,matchKey:item.alertKey,source:item.source||'',sourceId:String(item.id||''),sourceIds:{...(item.sourceIds||{}),...((item.source && item.id)?{[item.source]:String(item.id)}:{})},home:item.homeName,away:item.awayName,league:item.league,kickoffUTC:(()=>{const raw=item.kickoffUTC||item.kickoff||item.startTime||item.raw?.fixture?.date||item.raw?.startTime||item.raw?.startTimestamp;const n=typeof raw==='number'?(raw<1e12?raw*1000:raw):raw;const d=new Date(n);return raw&&Number.isFinite(d.getTime())?d.toISOString():null;})(),alertNumber:number,alertType:item.alertDecision?.bigBet?'BIG BET':'ALERT',minute:Number(item.minute),homeScore:Number(item.homeScore),awayScore:Number(item.awayScore),rule:safeNum(item.ai?.efficiency),v3Components:item.ai?.v3Components?JSON.parse(JSON.stringify(item.ai.v3Components)):null,aiGoalProbability:item.aiGoal?.percent==null?null:safeNum(item.aiGoal.percent),aiGoalCalibrated:item.aiGoal?.calibrated===true,scenarioAnalysis:item.scenarioAnalysis?clone(item.scenarioAnalysis):null,momentum:safeNum(item.momentum?.score),ruleConfidence:captureConfidence(item.ruleConfidence),spike:captureSpike(item.alertDecision?.spike),alertReason:String(item.alertDecision?.reason||""),liveStats:captureLiveStats(item.stats),trainingWindows:item.trainingWindows?JSON.parse(JSON.stringify({five:item.trainingWindows.five,ten:item.trainingWindows.ten})):null,overLine:item.odds?.found?safeNum(item.odds.point):null,overPrice:item.odds?.found?safeNum(item.odds.price):null,telegramMessageId:messageId,createdAt:new Date().toISOString(),ftHome:null,ftAway:null,settledAt:null});await save(rec);return rec;}
async function settleMatch(matchKey,h,a){await init();if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)throw Error('FT must be nonnegative integers');let count=0;for(const r of records.filter(x=>x.matchKey===matchKey&&x.ftHome==null)){const next=scoreResults({...r,ftHome:h,ftAway:a,settledAt:new Date().toISOString()});await save(next);count++;}return count;}
// Update display-only LIVE score of sent V4 alerts; preserve original alert score and FT audit.
async function updateLiveScores(matches=[]){
 await init();
 const normalize=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
 const byId=new Map(),byName=new Map();
 for(const m of matches){
  const home=String(m.homeName||m.home||''),away=String(m.awayName||m.away||'');
  const h=Number(m.homeScore),w=Number(m.awayScore);
  if(!home||!away||!Number.isInteger(h)||!Number.isInteger(w)||h<0||w<0)continue;
  const entry={h,w,minute:Number(m.minute),home,away};
  const ids=[m.sourceIds?.apisports,m.sourceIds?.sofascore,m.sourceIds?.livescore,m.id];
  for(const id of ids)if(id!=null&&String(id))byId.set(String(id),entry);
  byName.set(normalize(home)+'|'+normalize(away),entry);
 }
 let updated=0;
 for(const r of records){
  if(r.ftHome!=null||r.ftAway!=null)continue;
  let m=null;
  for(const id of [r.sourceIds?.apisports,r.sourceIds?.sofascore,r.sourceIds?.livescore,r.sourceId]){
   if(id!=null&&byId.has(String(id))){const candidate=byId.get(String(id));
    if(normalize(candidate.home)===normalize(r.home)&&normalize(candidate.away)===normalize(r.away)){m=candidate;break;}
   }
  }
  if(!m)m=byName.get(normalize(r.home)+'|'+normalize(r.away));
  if(!m)continue;
  const before=Number(r.homeScore)+Number(r.awayScore),current=m.h+m.w;
  if(current<before)continue;
  const prev=Number(r.liveHomeScore)+Number(r.liveAwayScore);
  if(r.liveHomeScore!=null&&r.liveAwayScore!=null&&current<prev)continue;
  if(r.liveHomeScore===m.h&&r.liveAwayScore===m.w)continue;
  await save({...r,liveHomeScore:m.h,liveAwayScore:m.w,liveMinute:Number.isFinite(m.minute)?m.minute:null,liveUpdatedAt:new Date().toISOString()});updated++;
 }
 return updated;
}
function summarize(rows){const calc=key=>{const decided=rows.filter(r=>['WIN','LOSS'].includes(r[key]));const wins=decided.filter(r=>r[key]==='WIN').length;return {wins,losses:decided.length-wins,pending:rows.filter(r=>r[key]==='PENDING').length,push:rows.filter(r=>r[key]==='PUSH').length,noLine:rows.filter(r=>r[key]==='NO_LINE').length,rate:decided.length?+(wins/decided.length*100).toFixed(1):null};};return {sent:rows.length,settled:rows.filter(r=>r.ftHome!=null).length,goal:calc('goalResult'),over:calc('overResult')};}
function requireAuth(req,res,next){const pwd=process.env.DASHBOARD_PASSWORD;if(!pwd)return res.status(503).send('Set DASHBOARD_PASSWORD on Render.');const auth=req.headers.authorization||'';if(!auth.startsWith('Basic '))return challenge(res);let decoded='';try{decoded=Buffer.from(auth.slice(6),'base64').toString('utf8');}catch{}const given=decoded.slice(decoded.indexOf(':')+1);const a=Buffer.from(given),b=Buffer.from(pwd);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return challenge(res);next();}
function challenge(res){res.set('WWW-Authenticate','Basic realm="PROMAX Dashboard"').status(401).send('Authentication required');}
function setup(app){const scanObserver=require('./scan_observer');app.get('/live-monitor',requireAuth,(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(__dirname,'live-monitor.html'));});app.get('/api/live-monitor',requireAuth,(req,res)=>{res.set('Cache-Control','no-store');const view=scanObserver.liveView();
 const noStats=typeof app.locals.noStatsLiveView==='function'?app.locals.noStatsLiveView():[];
 res.json({...view,noStats});});app.get('/scan-history',requireAuth,(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(__dirname,'scan-history.html'));});app.get('/api/scan-history',requireAuth,(req,res)=>{res.set('Cache-Control','no-store');res.json(scanObserver.view(req.query));});app.get('/dashboard',requireAuth,(req,res)=>{res.set('Cache-Control','no-store, no-cache, must-revalidate');res.sendFile(path.join(__dirname,'dashboard.html'));});app.get('/ai-no-stats',requireAuth,(req,res)=>{res.set('Cache-Control','no-store, no-cache, must-revalidate');res.sendFile(path.join(__dirname,'ai-no-stats.html'));});app.get('/api/no-stats-alerts',requireAuth,async(req,res)=>{
 res.set('Cache-Control','no-store');
 try{if(typeof app.locals.ensureNoStatsAlertReady==='function')await app.locals.ensureNoStatsAlertReady();
 res.json(typeof app.locals.noStatsAlertView==='function'?app.locals.noStatsAlertView():{ok:true,summary:{sent:0,wins:0,losses:0,pending:0,settled:0,winRate:null},records:[]});}
 catch(e){res.status(503).json({ok:false,error:'NO-STATS history unavailable: '+e.message});}
});
app.get('/api/audit',requireAuth,async(req,res)=>{res.set('Cache-Control','no-store');try{await init();let data=records.filter(r=>r.source!=='AI_NO_STATS');const status=req.query.status;if(status==='pending')data=data.filter(r=>r.ftHome==null);if(status==='settled')data=data.filter(r=>r.ftHome!=null);const total=summarize(data);const globalSummary=summarize(records.filter(r=>r.source!=='AI_NO_STATS'));res.json({ok:true,summary:total,globalSummary,byAlert:[1,2].map(n=>({number:n,...summarize(data.filter(r=>r.alertNumber===n))})),records:data});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/audit/delete',requireAuth,async(req,res)=>{try{
 const ids=req.body?.ids;
 if(!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(x=>typeof x!=='string'||x.length>500))return res.status(400).json({ok:false,error:'Invalid ids (1-500)'});
 const deleted=await deleteAuditIds(ids);console.log(`[AUDIT DELETE] requested=${ids.length} deleted=${deleted} remaining=${records.length} pending=${records.filter(r=>r.ftHome==null).length}`);res.json({ok:true,deleted,remaining:records.length,pending:records.filter(r=>r.ftHome==null).length});
 }catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/audit/settle',requireAuth,async(req,res)=>{try{const {matchKey,ftHome,ftAway}=req.body||{};if(typeof matchKey!=='string'||!matchKey)return res.status(400).json({error:'matchKey required'});const count=await settleMatch(matchKey,Number(ftHome),Number(ftAway));res.json({ok:true,updated:count});}catch(e){res.status(400).json({ok:false,error:e.message});}});}
// Delete audit records only (never affect live match state or Telegram history).
async function deleteAuditIds(ids){
 await init();
 const unique=[...new Set(ids.filter(x=>typeof x==='string'&&x.length>0))];
 if(!unique.length)return 0;
 const existing=new Set(records.map(r=>r.id));const found=unique.filter(id=>existing.has(id));
 if(!found.length)return 0;
 if(pool)await pool.query('DELETE FROM promax_alert_audit WHERE id = ANY($1::text[])',[found]);
 records=records.filter(r=>!found.includes(r.id));
 if(!pool){fs.writeFileSync(FILE+'.tmp',JSON.stringify(records,null,2));fs.renameSync(FILE+'.tmp',FILE);}
 return found.length;
}
// Reconcile only on a provider-confirmed finished match. Never treat a live score as FT.
let checking=false;
const lastFTCheck=new Map();
const FT_RETRY_MS=Math.max(60000,Number(process.env.FT_RETRY_MS)||300000);
const FT_MAX_PER_CYCLE=Math.max(1,Math.min(30,Number(process.env.FT_MAX_PER_CYCLE)||12));
const statusString=v=>String(v??'').trim().toLowerCase();
function extractFT(payload){
 const e=payload?.event||payload?.data?.event||payload?.data?.match||payload?.match||payload?.data||payload;
 const st=e?.status||e?.matchStatus||e?.general?.matchStatus||{};
 const status=[st?.type,st?.description,st?.name,st?.code,typeof st==='string'?st:'',e?.statusDescription,e?.statusText].map(statusString);
 const finished=status.some(x=>['finished','ended','ft','full time','fulltime','afterpenalties','after penalties','aet','after extra time'].includes(x))||st?.code===100||st?.type===100;
 if(!finished)return null;
 const hs=e?.homeScore,as=e?.awayScore;
 const h=safeNum(hs?.current??hs?.display??hs?.normaltime??e?.home?.score??e?.score?.home);
 const a=safeNum(as?.current??as?.display??as?.normaltime??e?.away?.score??e?.score?.away);
 if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)return null;
 return {h,a};
}
async function fetchSofaFT(id,key){
 const host='sofascore.p.rapidapi.com';
 const paths=[`/matches/detail?matchId=${encodeURIComponent(id)}`,`/matches/detail?eventId=${encodeURIComponent(id)}`];
 for(const url of paths){
  try{const {data}=await axios.get(`https://${host}${url}`,{headers:{'x-rapidapi-key':key,'x-rapidapi-host':host},timeout:7000});
   const ft=extractFT(data);if(ft)return ft;
  }catch(e){console.warn(`[AUDIT FT] SofaScore id=${id} ${url.split('?')[0]} HTTP ${e.response?.status||e.message}`);if(e.response?.status===429)break;}
 }
 return null;
}
async function fetchFotmobFT(id,key){
 const host='fotmob-api.p.rapidapi.com';
 try{const {data}=await axios.get(`https://${host}/api/v1/matches/${encodeURIComponent(id)}`,{headers:{'x-rapidapi-key':key,'x-rapidapi-host':host},timeout:7000});
  const header=data?.header||data?.data?.header||{};
  const st=header.status||{};
  const finished=st.finished===true||['finished','ft','full time','after penalties'].includes(statusString(st.reason?.short||st.reason?.long||st.name));
  if(!finished)return null;
  const h=safeNum(header.teams?.[0]?.score??header.home?.score);
  const a=safeNum(header.teams?.[1]?.score??header.away?.score);
  return Number.isInteger(h)&&Number.isInteger(a)&&h>=0&&a>=0?{h,a}:null;
 }catch(e){console.warn(`[AUDIT FT] FotMob id=${id} HTTP ${e.response?.status||e.message}`);return null;}
}
async function getAlertStates(){
 await init();
 const byMatch=new Map();
 for(const r of records){
  if(!r.matchKey || !Number.isInteger(Number(r.alertNumber))) continue;
  const prev=byMatch.get(r.matchKey);
  if(!prev || Number(r.alertNumber)>Number(prev.alertNumber)) byMatch.set(r.matchKey,r);
 }
 return [...byMatch.values()];
}
async function fetchApiSportsFT(id){
 const key=(process.env.APISPORTS_KEY||'').trim();
 if(!key || !/^\d+$/.test(String(id||'')))return null;
 try{
  const {data}=await axios.get('https://v3.football.api-sports.io/fixtures',{
   params:{id},headers:{'x-apisports-key':key},timeout:9000
  });
  const row=data?.response?.[0];
  if(!row || !['FT','AET','PEN'].includes(row.fixture?.status?.short))return null;
  // Football 90-minute markets should settle at regulation score when available.
  const score=row.score?.fulltime;
  const h=safeNum(score?.home),a=safeNum(score?.away);
  return Number.isInteger(h)&&Number.isInteger(a)&&h>=0&&a>=0?{h,a}:null;
 }catch(e){console.warn(`[AUDIT FT] API-Football id=${id} HTTP ${e.response?.status||e.message}`);return null;}
}
// LiveFootball date-results provider. Configure exact RapidAPI endpoint in Render;
// URL example template shape: https://HOST/VERIFIED_PATH?date={date}
// Do not assume an undocumented route or query parameter.
const LF_HOST='free-api-live-football-data.p.rapidapi.com';
const lfDateCache=new Map();
function parseLiveFootballDateFT(m){
 const st=m?.status||m?.matchStatus||m?.fixture?.status||{};
 const reason=String(st?.reason?.short||st?.short||st?.name||st?.description||st?.type|| (typeof st==='string'?st:'')).toUpperCase().trim();
 if(st?.cancelled===true||st?.awarded===true||!['FT','AET','PEN','FULL TIME','FULLTIME','FINISHED','ENDED','AFTER PENALTIES'].includes(reason))return null;
 const h=Number(m?.home?.score??m?.homeScore?.current??m?.homeScore??m?.score?.home??m?.goals?.home);
 const a=Number(m?.away?.score??m?.awayScore?.current??m?.awayScore??m?.score?.away??m?.goals?.away);
 if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)return null;
 return {h,a,kind:reason,matchId:String(m.id||m.matchId||'')};
}
function pendingMatchDate(r){
 // Prefer saved kickoff UTC; fallback to alert UTC day, checking neighbor days.
 const value=r.kickoffUTC||r.createdAt;
 const dt=new Date(value);
 return Number.isFinite(dt.getTime())?dt:null;
}
function dateStringUTC(d){return d.toISOString().slice(0,10).replace(/-/g,'');}
// Provider response wrappers vary by endpoint/version. Never treat a wrapper as a fixture.
function unwrapFTList(data){
 const roots=[data,data?.response,data?.data,data?.response?.data,data?.data?.response];
 for(const root of roots){
  if(Array.isArray(root))return root;
  for(const key of ['matches','fixtures','events','results','games']){
   if(Array.isArray(root?.[key]))return root[key].flatMap(x=>Array.isArray(x?.matches)?x.matches:[x]);
  }
 }
 return [];
}
function teamNameFT(v){return typeof v==='string'?v:(v?.name||v?.team?.name||v?.shortName||v?.short_name||v?.title||'');}
function kickoffFT(row){const raw=row?.fixture?.date||row?.startTime||row?.start_time||row?.utcTime||row?.status?.utcTime||row?.startTimestamp||row?.timestamp;
 if(typeof raw==='number')return new Date(raw<1e12?raw*1000:raw).toISOString();return raw||null;}
async function fetchLiveFootballByDate(date,key){
 const template=(process.env.LIVE_FOOTBALL_MATCHES_BY_DATE_URL_TEMPLATE||'https://free-api-live-football-data.p.rapidapi.com/football-get-matches-by-date?date={date}').trim();
 if(!template||!key)return [];
 const cacheKey=date;
 const cached=lfDateCache.get(cacheKey);
 if(cached&&Date.now()-cached.time<600000)return cached.matches;
 const url=template.replace(/\{date\}/g,encodeURIComponent(date));
 try{
  const {data}=await axios.get(url,{headers:{'x-rapidapi-key':key,'x-rapidapi-host':LF_HOST},timeout:10000});
  const matches=unwrapFTList(data);
  if(!Array.isArray(matches))throw Error('LiveFootball date response has no match list');
  lfDateCache.set(cacheKey,{time:Date.now(),matches});
  return matches;
 }catch(e){console.warn(`[AUDIT FT] LiveFootball date=${date} HTTP ${e.response?.status||e.message}`);return [];}
}
async function fetchLiveFootballFT(r,key){
 const id=r.sourceIds?.['live-football']||(r.source==='live-football'?r.sourceId:null);
 if(!id||!key)return null;
 const d=pendingMatchDate(r);if(!d)return null;
 // Dates can be interpreted differently by provider timezone; check adjacent days.
 const dates=[-1,0,1].map(n=>dateStringUTC(new Date(d.getTime()+n*86400000)));
 for(const date of dates){
  const rows=await fetchLiveFootballByDate(date,key);
  const match=rows.find(x=>String(x.id)===String(id));
  if(match){const ft=parseLiveFootballDateFT(match);if(ft)return ft;}
 }
 return null;
}
// FT discovery: batch by date, match provider-native IDs first, then strict name/time matching.
const ftDateCache=new Map();
function normTeam(s){
 return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/\b(fc|cf|sc|ac|club|football|the)\b/g,'')
  .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function teamCompatibleFT(a,b){
 const x=normTeam(a),y=normTeam(b);if(!x||!y)return false;
 if(x===y)return true;
 // Allow a documented initial/short-form expansion only; preserve Uxx, B, women and reserves.
 const xt=x.split(' '),yt=y.split(' ');
 const matches=(short,long)=>short.length===long.length&&short.every((t,i)=>t===long[i]||(t.length===1&&long[i].startsWith(t)));
 if(matches(xt,yt)||matches(yt,xt))return true;
 // Prefix expansion only on a final token, e.g. 'Pohro' vs 'Pohronie'.
 const prefix=(short,long)=>short.length===long.length&&short.every((t,i)=>t===long[i]||(t.length>=4&&long[i].startsWith(t)));
 return prefix(xt,yt)||prefix(yt,xt);
}
function ftMatchCandidate(r,home,away,kickoff){
 if(!teamCompatibleFT(home,r.home)||!teamCompatibleFT(away,r.away))return false;
 const t=Date.parse(kickoff||'');const rt=r.kickoffUTC?Date.parse(r.kickoffUTC):NaN;
 if(Number.isFinite(rt)&&Number.isFinite(t))return Math.abs(t-rt)<=3*3600000;
 // Without kickoff, name-based matches must be unique in the date search window.
 return true;
}
function candidateChronologyOK(r,rowTime){
 const t=Date.parse(rowTime||'');const alert=Date.parse(r.createdAt||'');
 // Reject a different day's match when the provider gives a timestamp.
 return !Number.isFinite(t)||!Number.isFinite(alert)||(t<=alert+6*3600000&&t>=alert-72*3600000);
}
function uniqueFTFixture(rows,r,idOf,namesOf,timeOf,nativeId){
 // Native IDs are authoritative only within the same provider; otherwise require
 // a unique team/time match. Never settle ambiguous same-name fixtures.
 if(nativeId){const byId=rows.filter(x=>String(idOf(x)||'')===String(nativeId));
  if(byId.length===1){const row=byId[0];const [h,a]=namesOf(row);
   if(!h||!a||!ftMatchCandidate(r,h,a,timeOf(row)))return null;
   return candidateChronologyOK(r,timeOf(row))?row:null;
  }if(byId.length>1)return null;}
 const matches=rows.filter(x=>{const [h,a]=namesOf(x);return ftMatchCandidate(r,h,a,timeOf(x))&&candidateChronologyOK(r,timeOf(x));});
 return matches.length===1?matches[0]:null;
}
function dateCandidates(r){const d=pendingMatchDate(r);return d?[-1,0,1].map(n=>new Date(d.getTime()+n*86400000).toISOString().slice(0,10)):[];}
function apiFT(row){
 const st=row?.fixture?.status?.short;
 if(!['FT','AET','PEN'].includes(st))return null;
 const score=row.score?.fulltime;
 const h=score?.home,a=score?.away;
 return Number.isInteger(h)&&Number.isInteger(a)&&h>=0&&a>=0?{h,a,source:'apisports'}:null;
}
async function fetchApiDate(date){
 const key=(process.env.APISPORTS_KEY||'').trim();if(!key)return [];
 const cacheKey='api:'+date;const c=ftDateCache.get(cacheKey);if(c&&Date.now()-c.time<600000)return c.rows;
 try{const {data}=await axios.get('https://v3.football.api-sports.io/fixtures',{params:{date},headers:{'x-apisports-key':key},timeout:12000});
 const rows=Array.isArray(data?.response)?data.response:[];ftDateCache.set(cacheKey,{rows,time:Date.now()});return rows;
 }catch(e){console.warn('[FT API DATE]',date,e.response?.status||e.message);return [];}
}
async function fetchFlashDate(date,key){
 const template=(process.env.FLASHSCORE_MATCHES_BY_DATE_URL_TEMPLATE||'').trim();if(!template||!key)return [];
 if(Date.now()<flashRateLimitedUntil)return [];
 const cacheKey='flash:'+date;const c=ftDateCache.get(cacheKey);if(c&&Date.now()-c.time<600000)return c.rows;
 try{const url=template.replace(/\{date\}/g,encodeURIComponent(date));const host=new URL(url).hostname;
 const {data}=await axios.get(url,{headers:{'x-rapidapi-key':key,'x-rapidapi-host':host},timeout:12000});
 const rows=unwrapFTList(data);ftDateCache.set(cacheKey,{rows,time:Date.now()});return rows;
 }catch(e){if(e.response?.status===429)flashRateLimitedUntil=Date.now()+FLASH_429_BACKOFF_MS;console.warn('[FT FLASH DATE]',date,e.response?.status||e.message);return [];}
}
// Direct native-ID lookup. Never infer FT from a score without final status.
const flashIdCache=new Map();
let flashRateLimitedUntil=0;
const FLASH_429_BACKOFF_MS=Math.max(600000,Number(process.env.AUDIT_FLASH_429_BACKOFF_MS)||1800000);
async function fetchFlashById(id,key){
 if(!id||!key)return {row:null,reason:'FLASHSCORE_ID_OR_KEY_MISSING'};
 if(Date.now()<flashRateLimitedUntil)return {row:null,reason:'FLASHSCORE_RATE_LIMIT_BACKOFF'};
 const cached=flashIdCache.get(String(id));
 if(cached&&Date.now()-cached.time<600000)return cached.result;
 const host='flashscore4.p.rapidapi.com';
 const url=`https://${host}/api/flashscore/v2/matches/match/summary`;
 try{
  const {data}=await axios.get(url,{params:{match_id:id},headers:{'x-rapidapi-key':key,'x-rapidapi-host':host},timeout:10000});
  const row=data?.response?.match||data?.response?.summary||data?.response||data?.data?.match||data?.data||data;
  const result={row,reason:'FLASHSCORE_ID_STATUS_NOT_FINAL_OR_SCHEMA_UNKNOWN'};
  flashIdCache.set(String(id),{time:Date.now(),result});return result;
 }catch(e){
  if(e.response?.status===429)flashRateLimitedUntil=Date.now()+FLASH_429_BACKOFF_MS;
  const reason=`FLASHSCORE_ID_HTTP_${e.response?.status||'NETWORK'}`;
  const result={row:null,reason};flashIdCache.set(String(id),{time:Date.now(),result});return result;
 }
}
function flashFT(m){
 const status=String(m?.match_status?.status||m?.match_status?.name||m?.status?.short||m?.status||'').toUpperCase().trim();
 if(!['FT','FULL TIME','FULLTIME','AET','PEN','FINISHED'].includes(status))return null;
 const hs=m?.home_team?.score??m?.home?.score??m?.home_score;
 const as=m?.away_team?.score??m?.away?.score??m?.away_score;
 const h=Number(hs),a=Number(as);
 return Number.isInteger(h)&&Number.isInteger(a)&&h>=0&&a>=0?{h,a,source:'flashscore'}:null;
}
// Each provider is independent: a missing ID, empty date result or 429 on one
// provider must never prevent discovery on another provider.
async function reconcile(){
 if(checking)return;checking=true;
 try{
  await init();const rapidKey=(process.env.RAPIDAPI_KEY||'').trim();
  if(!rapidKey&&!process.env.APISPORTS_KEY)return;
  const now=Date.now();
  const pending=[...new Map(records.filter(r=>r.source!=='AI_NO_STATS'&&r.ftHome==null).slice().reverse().map(r=>[r.matchKey,r])).values()]
   .filter(r=>now-(lastFTCheck.get(r.matchKey)||0)>=FT_RETRY_MS).slice(0,FT_MAX_PER_CYCLE);
  if(!pending.length)return;
  for(const r of pending)lastFTCheck.set(r.matchKey,now);
  const dates=[...new Set(pending.flatMap(dateCandidates))];
  const safeBatch=async (fn)=>Promise.all(dates.map(async d=>{try{return [d,await fn(d)];}catch(e){console.warn('[AUDIT FT] date fallback',d,e.message);return [d,[]];}}));
  const [apiPairs,flashPairs]=await Promise.all([
   process.env.APISPORTS_KEY?safeBatch(fetchApiDate):[],
   rapidKey&&process.env.FLASHSCORE_MATCHES_BY_DATE_URL_TEMPLATE?safeBatch(d=>fetchFlashDate(d,rapidKey)):[]
  ]);
  const api=apiPairs.flatMap(x=>x[1]),flash=flashPairs.flatMap(x=>x[1]);
  console.log(`[FT BATCH] pending=${pending.length} apiSports=${api.length} flashScore=${flash.length}`);
  for(const r of pending){
   try{
    const ids={...(r.sourceIds||{})};if(r.source&&r.sourceId&&!ids[r.source])ids[r.source]=String(r.sourceId);
    const candidates=[],reasons=[];
    const apiRow=uniqueFTFixture(api,r,x=>x.fixture?.id,x=>[x.teams?.home?.name,x.teams?.away?.name],x=>x.fixture?.date,ids.apisports);
    if(apiRow && apiRow.goals?.home!=null && apiRow.goals?.away!=null){
      const h=Number(apiRow.goals.home),a=Number(apiRow.goals.away);
      if(Number.isInteger(h)&&Number.isInteger(a)&&h>=Number(r.homeScore)&&a>=Number(r.awayScore)&&
        (r.liveHomeScore==null||h+a>=Number(r.liveHomeScore)+Number(r.liveAwayScore))&&
        (r.liveHomeScore!==h||r.liveAwayScore!==a)){
        for(const old of records.filter(x=>x.matchKey===r.matchKey&&x.ftHome==null))
          await save({...old,liveHomeScore:h,liveAwayScore:a,liveUpdatedAt:new Date().toISOString()});
      }
    }
    if(apiRow){const ft=apiFT(apiRow);if(ft)candidates.push(ft);else reasons.push('APISPORTS_NOT_FINAL');if(!ids.apisports)ids.apisports=String(apiRow.fixture.id);}else reasons.push('APISPORTS_NOT_FOUND');
    const flashRow=uniqueFTFixture(flash,r,x=>x.match_id||x.id,x=>[x.home_team?.name||x.home?.name,x.away_team?.name||x.away?.name],kickoffFT,ids.flashscore);
    if(flashRow){const ft=flashFT(flashRow);if(ft)candidates.push(ft);else reasons.push('FLASHSCORE_NOT_FINAL');if(!ids.flashscore)ids.flashscore=String(flashRow.match_id||flashRow.id);}else reasons.push(process.env.FLASHSCORE_MATCHES_BY_DATE_URL_TEMPLATE?'FLASHSCORE_NOT_FOUND':'FLASHSCORE_DATE_ENDPOINT_UNCONFIGURED');
    // Direct ID lookups are tried independently of date-discovery success.
    // An ID from one provider is never reused as an ID for another.
    const lookups=[];
    if(ids.apisports&&process.env.APISPORTS_KEY&&!apiRow)lookups.push(['apisports',()=>fetchApiSportsFT(ids.apisports)]);
    if(ids.flashscore&&rapidKey&&!flashRow)lookups.push(['flashscore',async()=>{const v=await fetchFlashById(ids.flashscore,rapidKey);if(!v.row)reasons.push(v.reason);return flashFT(v.row);}]);
    const results=await Promise.all(lookups.map(async ([source,fn])=>{try{return {source,ft:await fn()};}catch(e){reasons.push(source+'_LOOKUP_ERROR');return {source,ft:null};}}));
    for(const {source,ft} of results){if(ft)candidates.push({...ft,source});else reasons.push(source.toUpperCase()+'_ID_NOT_CONFIRMED');}
    if(Object.keys(ids).some(k=>String(ids[k])!==String(r.sourceIds?.[k]||''))){for(const rec of records.filter(x=>x.matchKey===r.matchKey))await save({...rec,sourceIds:{...rec.sourceIds,...ids}});}
    const primary=candidates.filter(x=>x.source==='apisports');
    const preferred=primary.length?primary:candidates.filter(x=>x.source==='flashscore');
    const distinct=new Set(preferred.map(x=>`${x.h}-${x.a}`));
    if(distinct.size>1){console.warn(`[AUDIT FT] CONFLICT | ${r.home} vs ${r.away} | ${candidates.map(x=>x.source+':'+x.h+'-'+x.a).join(', ')}`);continue;}
    if(preferred.length){const ft=preferred[0];
     // A valid FT cannot be below the score already seen when alerting.
     if(ft.h<Number(r.homeScore)||ft.a<Number(r.awayScore)){console.warn(`[AUDIT FT] SCORE_CONFLICT | ${r.home} vs ${r.away} | alert=${r.homeScore}-${r.awayScore} FT=${ft.h}-${ft.a}`);continue;}
     const n=await settleMatch(r.matchKey,ft.h,ft.a);
     console.log(`[AUDIT FT] CONFIRMED | ${r.home} ${ft.h}-${ft.a} ${r.away} | ${ft.source} | updated ${n}`);
    }else console.log(`[AUDIT FT] PENDING | ${r.home} vs ${r.away} | sourceIds=${JSON.stringify(ids)} | candidates=${candidates.length} | scanned=API:${api.length},FLASH:${flash.length} | reason=${reasons.join(',')} | kickoff=${r.kickoffUTC||'UNKNOWN'} | no confirmed FT`);
   }catch(e){console.error(`[AUDIT FT] MATCH_ERROR | ${r.home} vs ${r.away} | ${e.message}`);}
  }
 }catch(e){console.error('[AUDIT FT]',e.stack||e.message);}finally{checking=false;}
}

// Read-only FT fallback for an AI NO-STATS Telegram alert, using the same
// verified FlashScore date resolver as the V4 audit. No unverified scores.
async function flashNoStatsFT(row){
 const key=(process.env.RAPIDAPI_KEY||'').trim();
 if(!key)return null;
 const r={home:row.home,away:row.away,createdAt:row.sentAt,kickoffUTC:null};
 const dates=dateCandidates(r);
 const matches=(await Promise.all(dates.map(d=>fetchFlashDate(d,key)))).flat();
 const candidate=uniqueFTFixture(matches,r,x=>x.match_id||x.id,
   x=>[x.home_team?.name||x.home?.name,x.away_team?.name||x.away?.name],kickoffFT,null);
 return candidate?flashFT(candidate):null;
}
async function getSettledTrainingRows(){await init();return records.filter(r=>r.source!=='AI_NO_STATS' && r.alertNumber===1 && (r.goalResult==='WIN'||r.goalResult==='LOSS')).map(r=>({matchKey:r.matchKey,createdAt:r.createdAt,goalResult:r.goalResult,aiGoalProbability:r.aiGoalProbability,rule:r.rule,liveStats:r.liveStats,trainingWindows:r.trainingWindows||null}));}
module.exports={setup,init,addAlert,reconcile,settleMatch,summarize,scoreResults,getAlertStates,getSettledTrainingRows,updateLiveScores,loadNoStatsAlertRecords,saveNoStatsAlertRecord,flashNoStatsFT};
