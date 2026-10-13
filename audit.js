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
async function init(){if(initialized)return; if(pool){await pool.query('CREATE TABLE IF NOT EXISTS promax_alert_audit (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())');const {rows}=await pool.query('SELECT data FROM promax_alert_audit ORDER BY created_at DESC LIMIT 10000');records=rows.map(x=>x.data);}initialized=true;}
async function save(r){await init();const idx=records.findIndex(x=>x.id===r.id);if(idx>=0)records[idx]=r;else records.unshift(r);if(pool){await pool.query('INSERT INTO promax_alert_audit (id,data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data',[r.id,JSON.stringify(r)]);}else{fs.writeFileSync(FILE+'.tmp',JSON.stringify(records,null,2));fs.renameSync(FILE+'.tmp',FILE);}}
// Optional LIVE analytics. Keep null distinct from a confirmed zero.
const LIVE_FIELDS=['TotalShots','ShotsOnTarget','ShotsOffTarget','BlockedShots','Attacks','DangerousAttacks','Corners','Possession','BigChances','RedCards','YellowCards'];
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
async function addAlert(item,number,messageId){const id=`${item.alertKey}|${number}|${messageId}`;const rec=scoreResults({id,matchKey:item.alertKey,source:item.source||'',sourceId:String(item.id||''),sourceIds:{...(item.sourceIds||{}),...((item.source && item.id)?{[item.source]:String(item.id)}:{})},home:item.homeName,away:item.awayName,league:item.league,kickoffUTC:(()=>{const raw=item.kickoffUTC||item.kickoff||item.startTime||item.raw?.fixture?.date||item.raw?.startTime||item.raw?.startTimestamp;const n=typeof raw==='number'?(raw<1e12?raw*1000:raw):raw;const d=new Date(n);return raw&&Number.isFinite(d.getTime())?d.toISOString():null;})(),alertNumber:number,alertType:item.alertDecision?.bigBet?'BIG BET':'ALERT',minute:Number(item.minute),homeScore:Number(item.homeScore),awayScore:Number(item.awayScore),rule:safeNum(item.ai?.efficiency),v3Components:item.ai?.v3Components?JSON.parse(JSON.stringify(item.ai.v3Components)):null,aiGoalProbability:item.aiGoal?.percent==null?null:safeNum(item.aiGoal.percent),aiGoalCalibrated:false,momentum:safeNum(item.momentum?.score),ruleConfidence:captureConfidence(item.ruleConfidence),spike:captureSpike(item.alertDecision?.spike),alertReason:String(item.alertDecision?.reason||""),liveStats:captureLiveStats(item.stats),overLine:item.odds?.found?safeNum(item.odds.point):null,overPrice:item.odds?.found?safeNum(item.odds.price):null,telegramMessageId:messageId,createdAt:new Date().toISOString(),ftHome:null,ftAway:null,settledAt:null});await save(rec);return rec;}
async function settleMatch(matchKey,h,a){await init();if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)throw Error('FT must be nonnegative integers');let count=0;for(const r of records.filter(x=>x.matchKey===matchKey&&x.ftHome==null)){const next=scoreResults({...r,ftHome:h,ftAway:a,settledAt:new Date().toISOString()});await save(next);count++;}return count;}
function summarize(rows){const calc=key=>{const decided=rows.filter(r=>['WIN','LOSS'].includes(r[key]));const wins=decided.filter(r=>r[key]==='WIN').length;return {wins,losses:decided.length-wins,pending:rows.filter(r=>r[key]==='PENDING').length,push:rows.filter(r=>r[key]==='PUSH').length,noLine:rows.filter(r=>r[key]==='NO_LINE').length,rate:decided.length?+(wins/decided.length*100).toFixed(1):null};};return {sent:rows.length,settled:rows.filter(r=>r.ftHome!=null).length,goal:calc('goalResult'),over:calc('overResult')};}
function requireAuth(req,res,next){const pwd=process.env.DASHBOARD_PASSWORD;if(!pwd)return res.status(503).send('Set DASHBOARD_PASSWORD on Render.');const auth=req.headers.authorization||'';if(!auth.startsWith('Basic '))return challenge(res);let decoded='';try{decoded=Buffer.from(auth.slice(6),'base64').toString('utf8');}catch{}const given=decoded.slice(decoded.indexOf(':')+1);const a=Buffer.from(given),b=Buffer.from(pwd);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return challenge(res);next();}
function challenge(res){res.set('WWW-Authenticate','Basic realm="PROMAX Dashboard"').status(401).send('Authentication required');}
function setup(app){app.get('/dashboard',requireAuth,(req,res)=>{res.set('Cache-Control','no-store, no-cache, must-revalidate');res.sendFile(path.join(__dirname,'dashboard.html'));});app.get('/api/audit',requireAuth,async(req,res)=>{res.set('Cache-Control','no-store');try{await init();let data=records;const status=req.query.status;if(status==='pending')data=data.filter(r=>r.ftHome==null);if(status==='settled')data=data.filter(r=>r.ftHome!=null);const total=summarize(data);res.json({ok:true,summary:total,byAlert:[1,2].map(n=>({number:n,...summarize(data.filter(r=>r.alertNumber===n))})),records:data});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/audit/delete',requireAuth,async(req,res)=>{try{
 const ids=req.body?.ids;
 if(!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(x=>typeof x!=='string'||x.length>500))return res.status(400).json({ok:false,error:'Invalid ids (1-500)'});
 const deleted=await deleteAuditIds(ids);res.json({ok:true,deleted});
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
 const st=m?.status||{},reason=String(st.reason?.short||'').toUpperCase();
 if(st.finished!==true||st.cancelled===true||st.awarded===true||!['FT','AET','PEN'].includes(reason))return null;
 const h=m?.home?.score,a=m?.away?.score;
 if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)return null;
 return {h,a,kind:reason,matchId:String(m.id)};
}
function pendingMatchDate(r){
 // Prefer saved kickoff UTC; fallback to alert UTC day, checking neighbor days.
 const value=r.kickoffUTC||r.createdAt;
 const dt=new Date(value);
 return Number.isFinite(dt.getTime())?dt:null;
}
function dateStringUTC(d){return d.toISOString().slice(0,10).replace(/-/g,'');}
async function fetchLiveFootballByDate(date,key){
 const template=(process.env.LIVE_FOOTBALL_MATCHES_BY_DATE_URL_TEMPLATE||'https://free-api-live-football-data.p.rapidapi.com/football-get-matches-by-date?date={date}').trim();
 if(!template||!key)return [];
 const cacheKey=date;
 const cached=lfDateCache.get(cacheKey);
 if(cached&&Date.now()-cached.time<600000)return cached.matches;
 const url=template.replace(/\{date\}/g,encodeURIComponent(date));
 try{
  const {data}=await axios.get(url,{headers:{'x-rapidapi-key':key,'x-rapidapi-host':LF_HOST},timeout:10000});
  const matches=data?.response?.matches;
  if(!Array.isArray(matches))throw Error('response.matches is not an array');
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
function normTeam(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(fc|cf|sc|ac|club|football|the|u\d{2})\b/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function ftMatchCandidate(r,home,away,kickoff){
 const h=normTeam(home),a=normTeam(away),rh=normTeam(r.home),ra=normTeam(r.away);
 if(!h||!a||!rh||!ra)return false;
 const similar=(x,y)=>x===y || (x.length>=6&&y.length>=6&&(x.startsWith(y)||y.startsWith(x)));
 if(!similar(h,rh)||!similar(a,ra))return false;
 const t=Date.parse(kickoff||'');const rt=r.kickoffUTC?Date.parse(r.kickoffUTC):NaN;
 // Without a verified kickoff, only accept strong exact normalized names on the alert UTC date.
 if(!Number.isFinite(rt))return h===rh&&a===ra&&Number.isFinite(t)&&Math.abs(t-Date.parse(r.createdAt||''))<=24*3600000;
 return Number.isFinite(t)&&Math.abs(t-rt)<=3*3600000;
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
 const cacheKey='flash:'+date;const c=ftDateCache.get(cacheKey);if(c&&Date.now()-c.time<600000)return c.rows;
 try{const url=template.replace(/\{date\}/g,encodeURIComponent(date));const host=new URL(url).hostname;
 const {data}=await axios.get(url,{headers:{'x-rapidapi-key':key,'x-rapidapi-host':host},timeout:12000});
 const raw=Array.isArray(data)?data:Array.isArray(data?.matches)?data.matches:Array.isArray(data?.data?.matches)?data.data.matches:[];
 const rows=raw.flatMap(x=>Array.isArray(x?.matches)?x.matches:[x]);ftDateCache.set(cacheKey,{rows,time:Date.now()});return rows;
 }catch(e){console.warn('[FT FLASH DATE]',date,e.response?.status||e.message);return [];}
}
// Direct native-ID lookup. Never infer FT from a score without final status.
const flashIdCache=new Map();
async function fetchFlashById(id,key){
 if(!id||!key)return {row:null,reason:'FLASHSCORE_ID_OR_KEY_MISSING'};
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
async function reconcile(){
 if(checking)return;checking=true;
 try{
  await init();const rapidKey=process.env.RAPIDAPI_KEY;
  if(!rapidKey&&!process.env.APISPORTS_KEY)return;
  const now=Date.now();const pending=[...new Map(records.filter(r=>r.ftHome==null).map(r=>[r.matchKey,r])).values()]
    .filter(r=>now-(lastFTCheck.get(r.matchKey)||0)>=FT_RETRY_MS).slice(0,FT_MAX_PER_CYCLE);
  if(!pending.length)return;
  for(const r of pending)lastFTCheck.set(r.matchKey,now);
  const dates=[...new Set(pending.flatMap(dateCandidates))];
  const [lfPairs,apiPairs,flashPairs]=await Promise.all([
   rapidKey?Promise.all(dates.map(async d=>[d,await fetchLiveFootballByDate(d.replace(/-/g,''),rapidKey)])):Promise.resolve([]),
   process.env.APISPORTS_KEY?Promise.all(dates.map(async d=>[d,await fetchApiDate(d)])):Promise.resolve([]),
   rapidKey&&process.env.FLASHSCORE_MATCHES_BY_DATE_URL_TEMPLATE?Promise.all(dates.map(async d=>[d,await fetchFlashDate(d,rapidKey)])):Promise.resolve([])
  ]);
  const lf=lfPairs.flatMap(x=>x[1]),api=apiPairs.flatMap(x=>x[1]),flash=flashPairs.flatMap(x=>x[1]);
  console.log(`[FT BATCH] pending=${pending.length} dates=${dates.length} liveFootball=${lfPairs.length} apiSports=${apiPairs.length} flashScore=${flashPairs.length}`);
  for(const r of pending){
   const ids={...(r.sourceIds||{})};if(r.source&&r.sourceId&&!ids[r.source])ids[r.source]=String(r.sourceId);
   const candidates=[];
   const ftReasons=[];
   const lfRow=lf.find(x=>String(x.id)===String(ids['live-football']||'') || ftMatchCandidate(r,x.home?.name,x.away?.name,x.status?.utcTime||x.utcTime));
   if(lfRow){const ft=parseLiveFootballDateFT(lfRow);if(ft)candidates.push({...ft,source:'live-football'});else ftReasons.push('LIVEFOOTBALL_STATUS_NOT_FINAL_OR_SCORE_MISSING');if(!ids['live-football'])ids['live-football']=String(lfRow.id);}else ftReasons.push('LIVEFOOTBALL_NOT_FOUND');
   const apiRow=api.find(x=>String(x.fixture?.id)===String(ids.apisports||'') || ftMatchCandidate(r,x.teams?.home?.name,x.teams?.away?.name,x.fixture?.date));
   if(apiRow){const ft=apiFT(apiRow);if(ft)candidates.push(ft);else ftReasons.push('APISPORTS_STATUS_NOT_FINAL_OR_SCORE_MISSING');if(!ids.apisports)ids.apisports=String(apiRow.fixture.id);}else ftReasons.push('APISPORTS_NOT_FOUND');
   const flashRow=flash.find(x=>String(x.match_id||x.id)===String(ids.flashscore||'') || ftMatchCandidate(r,x.home_team?.name||x.home?.name,x.away_team?.name||x.away?.name,x.start_time||x.utcTime));
   if(flashRow){const ft=flashFT(flashRow);if(ft)candidates.push(ft);else ftReasons.push('FLASHSCORE_STATUS_NOT_FINAL_OR_SCORE_MISSING');if(!ids.flashscore)ids.flashscore=String(flashRow.match_id||flashRow.id);}else ftReasons.push(process.env.FLASHSCORE_MATCHES_BY_DATE_URL_TEMPLATE?'FLASHSCORE_NOT_FOUND':'FLASHSCORE_DATE_ENDPOINT_UNCONFIGURED');
   if(!candidates.length&&ids.flashscore&&rapidKey){
    const result=await fetchFlashById(ids.flashscore,rapidKey);
    const ft=flashFT(result.row);
    if(ft)candidates.push(ft);
    else ftReasons.push(result.reason);
   }
   // ID lookups are a fallback when the date-index does not contain the fixture.
   if(!candidates.length&&ids.apisports){const ft=await fetchApiSportsFT(ids.apisports);if(ft)candidates.push({...ft,source:'apisports'});}
   if(!candidates.length&&ids.sofascore&&rapidKey){const ft=await fetchSofaFT(ids.sofascore,rapidKey);if(ft)candidates.push({...ft,source:'sofascore'});}
   if(!candidates.length&&ids.fotmob&&rapidKey){const ft=await fetchFotmobFT(ids.fotmob,rapidKey);if(ft)candidates.push({...ft,source:'fotmob'});}
   // Persist discovered cross-source IDs, even when still pending.
   if(Object.keys(ids).some(k=>String(ids[k])!==String(r.sourceIds?.[k]||''))){for(const rec of records.filter(x=>x.matchKey===r.matchKey)){await save({...rec,sourceIds:{...rec.sourceIds,...ids}});}}
   const distinct=new Set(candidates.map(x=>`${x.h}-${x.a}`));
   if(distinct.size>1){console.warn(`[AUDIT FT] CONFLICT | ${r.home} vs ${r.away} | ${candidates.map(x=>x.source+':'+x.h+'-'+x.a).join(', ')}`);continue;}
   if(candidates.length){const ft=candidates[0],n=await settleMatch(r.matchKey,ft.h,ft.a);console.log(`[AUDIT FT] CONFIRMED | ${r.home} ${ft.h}-${ft.a} ${r.away} | ${ft.source} | updated ${n}`);}
   else console.log(`[AUDIT FT] PENDING | ${r.home} vs ${r.away} | sourceIds=${JSON.stringify(ids)} | reason=${ftReasons.join(',')} | kickoff=${r.kickoffUTC||'UNKNOWN'} | no confirmed FT`);
  }
 }catch(e){console.error('[AUDIT FT]',e.stack||e.message);}finally{checking=false;}
}
module.exports={setup,init,addAlert,reconcile,settleMatch,summarize,scoreResults,getAlertStates};
