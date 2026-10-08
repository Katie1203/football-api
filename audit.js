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
async function addAlert(item,number,messageId){const id=`${item.alertKey}|${number}|${messageId}`;const rec=scoreResults({id,matchKey:item.alertKey,source:item.source||'',sourceId:String(item.id||''),home:item.homeName,away:item.awayName,league:item.league,alertNumber:number,alertType:item.alertDecision?.bigBet?'BIG BET':'ALERT',minute:Number(item.minute),homeScore:Number(item.homeScore),awayScore:Number(item.awayScore),rule:safeNum(item.ai?.efficiency),momentum:safeNum(item.momentum?.score),overLine:item.odds?.found?safeNum(item.odds.point):null,overPrice:item.odds?.found?safeNum(item.odds.price):null,telegramMessageId:messageId,createdAt:new Date().toISOString(),ftHome:null,ftAway:null,settledAt:null});await save(rec);return rec;}
async function settleMatch(matchKey,h,a){await init();if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)throw Error('FT must be nonnegative integers');let count=0;for(const r of records.filter(x=>x.matchKey===matchKey&&x.ftHome==null)){const next=scoreResults({...r,ftHome:h,ftAway:a,settledAt:new Date().toISOString()});await save(next);count++;}return count;}
function summarize(rows){const calc=key=>{const decided=rows.filter(r=>['WIN','LOSS'].includes(r[key]));const wins=decided.filter(r=>r[key]==='WIN').length;return {wins,losses:decided.length-wins,pending:rows.filter(r=>r[key]==='PENDING').length,push:rows.filter(r=>r[key]==='PUSH').length,noLine:rows.filter(r=>r[key]==='NO_LINE').length,rate:decided.length?+(wins/decided.length*100).toFixed(1):null};};return {sent:rows.length,settled:rows.filter(r=>r.ftHome!=null).length,goal:calc('goalResult'),over:calc('overResult')};}
function requireAuth(req,res,next){const pwd=process.env.DASHBOARD_PASSWORD;if(!pwd)return res.status(503).send('Set DASHBOARD_PASSWORD on Render.');const auth=req.headers.authorization||'';if(!auth.startsWith('Basic '))return challenge(res);let decoded='';try{decoded=Buffer.from(auth.slice(6),'base64').toString('utf8');}catch{}const given=decoded.slice(decoded.indexOf(':')+1);const a=Buffer.from(given),b=Buffer.from(pwd);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return challenge(res);next();}
function challenge(res){res.set('WWW-Authenticate','Basic realm="PROMAX Dashboard"').status(401).send('Authentication required');}
function setup(app){app.get('/dashboard',requireAuth,(req,res)=>res.sendFile(path.join(__dirname,'dashboard.html')));app.get('/api/audit',requireAuth,async(req,res)=>{try{await init();let data=records;const status=req.query.status;if(status==='pending')data=data.filter(r=>r.ftHome==null);if(status==='settled')data=data.filter(r=>r.ftHome!=null);const total=summarize(data);res.json({ok:true,summary:total,byAlert:[1,2,3].map(n=>({number:n,...summarize(data.filter(r=>r.alertNumber===n))})),records:data.slice(0,500)});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/audit/settle',requireAuth,async(req,res)=>{try{const {matchKey,ftHome,ftAway}=req.body||{};if(typeof matchKey!=='string'||!matchKey)return res.status(400).json({error:'matchKey required'});const count=await settleMatch(matchKey,Number(ftHome),Number(ftAway));res.json({ok:true,updated:count});}catch(e){res.status(400).json({ok:false,error:e.message});}});}
// FT reconciliation: retry a small set of provider routes; never settle unless FT is confirmed.
// Optional: set SOFASCORE_FT_URL_TEMPLATE to the exact endpoint documented by your RapidAPI provider.
// Use {id} as the event ID placeholder. Do not put API keys in this variable.
let checking=false;
const unavailableRoutes=new Set();
const nextCheckAt=new Map();
const FT_RETRY_MS=15*60*1000;
function ftRoutes(id){
  const encoded=encodeURIComponent(id);
  const configured=process.env.SOFASCORE_FT_URL_TEMPLATE;
  const candidates=[];
  if(configured && configured.includes('{id}')) candidates.push(configured.replaceAll('{id}',encoded));
  candidates.push(`https://sofascore.p.rapidapi.com/matches/get-event?eventId=${encoded}`);
  candidates.push(`https://sofascore.p.rapidapi.com/events/get-event?eventId=${encoded}`);
  return [...new Set(candidates)];
}
function extractFinalScore(data){
  const event=data?.event||data?.data?.event||data?.data||data;
  const status=String(event?.status?.type||event?.status?.description||event?.status?.name||event?.match_status||'').toLowerCase().replace(/[\s_-]+/g,'');
  const finalStatuses=new Set(['finished','ended','ft','fulltime','afterpenalties','afterextratime','aet']);
  if(!finalStatuses.has(status))return null;
  const home=event?.homeScore?.current??event?.homeScore?.display??event?.home_score??event?.scores?.home;
  const away=event?.awayScore?.current??event?.awayScore?.display??event?.away_score??event?.scores?.away;
  if(home==null||away==null)return null;
  const h=Number(home),a=Number(away);
  return Number.isInteger(h)&&Number.isInteger(a)&&h>=0&&a>=0?{h,a}:null;
}
async function reconcile(){
  if(checking)return;
  checking=true;
  try{
    await init();
    const key=process.env.RAPIDAPI_KEY?.trim();
    if(!key){console.warn('[AUDIT FT] RAPIDAPI_KEY missing');return;}
    const pending=[...new Map(records.filter(r=>r.ftHome==null&&r.source==='sofascore'&&/^\d+$/.test(String(r.sourceId))).map(r=>[r.matchKey,r])).values()].slice(0,25);
    let checked=0, settled=0, failures=0;
    for(const r of pending){
      if((nextCheckAt.get(r.matchKey)||0)>Date.now())continue;
      nextCheckAt.set(r.matchKey,Date.now()+FT_RETRY_MS);
      checked++;
      let found=false;
      for(const url of ftRoutes(r.sourceId)){
        const route=url.replace(/([?&]eventId=)[^&]+/,'$1{id}');
        if(unavailableRoutes.has(route))continue;
        try{
          const {data}=await axios.get(url,{headers:{'x-rapidapi-key':key,'x-rapidapi-host':'sofascore.p.rapidapi.com'},timeout:7000});
          const score=extractFinalScore(data);
          if(score){const n=await settleMatch(r.matchKey,score.h,score.a);settled+=n;console.log(`[AUDIT FT] SETTLED ${r.home} ${score.h}-${score.a} ${r.away} | records=${n}`);found=true;break;}
          // A successful response without FT is not an endpoint failure.
          found=true;break;
        }catch(e){
          const status=e.response?.status;
          if(status===404){unavailableRoutes.add(route);console.warn(`[AUDIT FT] endpoint 404: ${route}`);continue;}
          failures++;
          console.warn(`[AUDIT FT] provider HTTP ${status||'NETWORK'} | ${r.home} vs ${r.away} | ${String(e.message).slice(0,90)}`);
          if(status===401||status===403||status===429)break;
        }
      }
      if(!found && unavailableRoutes.size>=ftRoutes(r.sourceId).length){
        console.warn('[AUDIT FT] All configured SofaScore FT endpoints returned 404; verify route in RapidAPI documentation.');
        break;
      }
    }
    if(checked)console.log(`[AUDIT FT] checked=${checked} settled_records=${settled} failures=${failures}`);
  }catch(e){console.error('[AUDIT FT]',e.message);}
  finally{checking=false;}
}
module.exports={setup,init,addAlert,reconcile,settleMatch,summarize,scoreResults};
