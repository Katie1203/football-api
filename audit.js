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
async function addAlert(item,number,messageId){const id=`${item.alertKey}|${number}|${messageId}`;const rec=scoreResults({id,matchKey:item.alertKey,source:item.source||'',sourceId:String(item.id||''),sourceIds:item.sourceIds||{},home:item.homeName,away:item.awayName,league:item.league,alertNumber:number,alertType:item.alertDecision?.bigBet?'BIG BET':'ALERT',minute:Number(item.minute),homeScore:Number(item.homeScore),awayScore:Number(item.awayScore),rule:safeNum(item.ai?.efficiency),momentum:safeNum(item.momentum?.score),overLine:item.odds?.found?safeNum(item.odds.point):null,overPrice:item.odds?.found?safeNum(item.odds.price):null,telegramMessageId:messageId,createdAt:new Date().toISOString(),ftHome:null,ftAway:null,settledAt:null});await save(rec);return rec;}
async function settleMatch(matchKey,h,a){await init();if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)throw Error('FT must be nonnegative integers');let count=0;for(const r of records.filter(x=>x.matchKey===matchKey&&x.ftHome==null)){const next=scoreResults({...r,ftHome:h,ftAway:a,settledAt:new Date().toISOString()});await save(next);count++;}return count;}
function summarize(rows){const calc=key=>{const decided=rows.filter(r=>['WIN','LOSS'].includes(r[key]));const wins=decided.filter(r=>r[key]==='WIN').length;return {wins,losses:decided.length-wins,pending:rows.filter(r=>r[key]==='PENDING').length,push:rows.filter(r=>r[key]==='PUSH').length,noLine:rows.filter(r=>r[key]==='NO_LINE').length,rate:decided.length?+(wins/decided.length*100).toFixed(1):null};};return {sent:rows.length,settled:rows.filter(r=>r.ftHome!=null).length,goal:calc('goalResult'),over:calc('overResult')};}
function requireAuth(req,res,next){const pwd=process.env.DASHBOARD_PASSWORD;if(!pwd)return res.status(503).send('Set DASHBOARD_PASSWORD on Render.');const auth=req.headers.authorization||'';if(!auth.startsWith('Basic '))return challenge(res);let decoded='';try{decoded=Buffer.from(auth.slice(6),'base64').toString('utf8');}catch{}const given=decoded.slice(decoded.indexOf(':')+1);const a=Buffer.from(given),b=Buffer.from(pwd);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return challenge(res);next();}
function challenge(res){res.set('WWW-Authenticate','Basic realm="PROMAX Dashboard"').status(401).send('Authentication required');}
function setup(app){app.get('/dashboard',requireAuth,(req,res)=>res.sendFile(path.join(__dirname,'dashboard.html')));app.get('/api/audit',requireAuth,async(req,res)=>{try{await init();let data=records;const status=req.query.status;if(status==='pending')data=data.filter(r=>r.ftHome==null);if(status==='settled')data=data.filter(r=>r.ftHome!=null);const total=summarize(data);res.json({ok:true,summary:total,byAlert:[1,2,3].map(n=>({number:n,...summarize(data.filter(r=>r.alertNumber===n))})),records:data.slice(0,500)});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/audit/settle',requireAuth,async(req,res)=>{try{const {matchKey,ftHome,ftAway}=req.body||{};if(typeof matchKey!=='string'||!matchKey)return res.status(400).json({error:'matchKey required'});const count=await settleMatch(matchKey,Number(ftHome),Number(ftAway));res.json({ok:true,updated:count});}catch(e){res.status(400).json({ok:false,error:e.message});}});}
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
async function reconcile(){
 if(checking)return;checking=true;
 try{await init();const key=process.env.RAPIDAPI_KEY;if(!key)return;
  const now=Date.now();const pending=[...new Map(records.filter(r=>r.ftHome==null).map(r=>[r.matchKey,r])).values()]
   .filter(r=>now-(lastFTCheck.get(r.matchKey)||0)>=FT_RETRY_MS).slice(0,FT_MAX_PER_CYCLE);
  for(const r of pending){lastFTCheck.set(r.matchKey,Date.now());
   const ids=r.sourceIds||{};const sofa=ids.sofascore||(r.source==='sofascore'?r.sourceId:null);
   const fotmob=ids.fotmob||(r.source==='fotmob'?r.sourceId:null);
   let ft=null;
   if(sofa&&/^\d+$/.test(String(sofa)))ft=await fetchSofaFT(sofa,key);
   if(!ft&&fotmob&&/^\d+$/.test(String(fotmob)))ft=await fetchFotmobFT(fotmob,key);
   if(ft){const n=await settleMatch(r.matchKey,ft.h,ft.a);console.log(`[AUDIT FT] ${r.home} ${ft.h}-${ft.a} ${r.away} | updated ${n}`);}
   else console.log(`[AUDIT FT] PENDING | ${r.home} vs ${r.away} | sourceIds=${JSON.stringify(ids)} | not confirmed finished`);
  }
 }catch(e){console.error('[AUDIT FT]',e.message);}finally{checking=false;}
}
module.exports={setup,init,addAlert,reconcile,settleMatch,summarize,scoreResults};
