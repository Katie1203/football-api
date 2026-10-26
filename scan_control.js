'use strict';
// Operator controls only. A storage outage must not prevent pausing live discovery.
const fs=require('fs');
const path=require('path');
const FILE=process.env.SCAN_CONTROL_FILE||path.join(__dirname,'scan-control-state.json');
let paused=false,lowLambdaAlertsEnabled=true;
try{const saved=JSON.parse(fs.readFileSync(FILE,'utf8'));paused=saved.paused===true;lowLambdaAlertsEnabled=saved.lowLambdaAlertsEnabled!==false;}catch{}
let pool=null,ready=null,dbReady=false,dirty=false,lastError=null;
if(process.env.DATABASE_URL){
 try{const {Pool}=require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false},connectionTimeoutMillis:5000,query_timeout:8000});}
 catch(e){lastError=e.message;console.warn('[SCAN CONTROL] PostgreSQL unavailable:',e.message);}
}
function saveLocal(){
 try{fs.mkdirSync(path.dirname(FILE),{recursive:true});const tmp=FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify({paused,lowLambdaAlertsEnabled,updatedAt:new Date().toISOString()}));fs.renameSync(tmp,FILE);return true;}
 catch(e){console.warn('[SCAN CONTROL] Local state write failed:',e.message);return false;}
}
async function init(){
 if(!pool)return;
 if(dbReady)return;
 if(ready)return ready;
 ready=(async()=>{
  await pool.query('CREATE TABLE IF NOT EXISTS promax_scan_control (id TEXT PRIMARY KEY, paused BOOLEAN NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('ALTER TABLE promax_scan_control ADD COLUMN IF NOT EXISTS low_lambda_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE');
  const {rows}=await pool.query("SELECT paused,low_lambda_alerts_enabled FROM promax_scan_control WHERE id='main'");
  if(rows.length){
   if(!dirty){paused=rows[0].paused===true;lowLambdaAlertsEnabled=rows[0].low_lambda_alerts_enabled!==false;saveLocal();}
   else await pool.query("UPDATE promax_scan_control SET paused=$1,low_lambda_alerts_enabled=$2,updated_at=NOW() WHERE id='main'",[paused,lowLambdaAlertsEnabled]);
  }else await pool.query("INSERT INTO promax_scan_control (id,paused,low_lambda_alerts_enabled) VALUES ('main',$1,$2)",[paused,lowLambdaAlertsEnabled]);
  dbReady=true;dirty=false;lastError=null;
 })().catch(e=>{dbReady=false;lastError=e.message;console.warn('[SCAN CONTROL] DB degraded:',e.message);}).finally(()=>{ready=null;});
 return ready;
}
async function update(field,value){
 if(typeof value!=='boolean')throw new TypeError(field+' must be boolean');
 // First try the durable store; continue to accept operator controls if it is unavailable.
 await init();
 if(dbReady){
  try{
   const column=field==='paused'?'paused':'low_lambda_alerts_enabled';
   await pool.query(`UPDATE promax_scan_control SET ${column}=$1,updated_at=NOW() WHERE id='main'`,[value]);
  }catch(e){dbReady=false;lastError=e.message;console.warn('[SCAN CONTROL] DB update failed:',e.message);}
 }
 if(field==='paused')paused=value;else lowLambdaAlertsEnabled=value;
 if(!dbReady)dirty=true;
 saveLocal();
 return {ok:true,paused,enabled:lowLambdaAlertsEnabled,persistent:dbReady,storage:dbReady?'postgresql':'local-fallback',warning:dbReady?null:'PostgreSQL unavailable; state may reset on Render redeploy',...(lastError&&!dbReady?{storageError:lastError}:{})};
}
const status=()=>({ok:true,paused,enabled:lowLambdaAlertsEnabled,persistent:dbReady,storage:dbReady?'postgresql':'local-fallback',warning:dbReady?null:'PostgreSQL unavailable; state may reset on Render redeploy',...(lastError&&!dbReady?{storageError:lastError}:{})});
module.exports={init,status,setPaused:value=>update('paused',value),isPaused:()=>paused,isLowLambdaAlertsEnabled:()=>lowLambdaAlertsEnabled,setLowLambdaAlertsEnabled:value=>update('enabled',value)};
