'use strict';
// Issue 11: server-side scan switch; FT reconciliation is intentionally independent.
const fs=require('fs');
const path=require('path');
const FILE=process.env.SCAN_CONTROL_FILE||path.join(__dirname,'scan-control-state.json');
let paused=false;
try {paused=JSON.parse(fs.readFileSync(FILE,'utf8')).paused===true;}catch{}
let pool=null;
if(process.env.DATABASE_URL){
 try {const {Pool}=require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});}catch(e){console.warn('[SCAN CONTROL] DB unavailable:',e.message);}
}
let ready=null;
async function init(){
 if(!pool)return;
 if(!ready)ready=(async()=>{
  await pool.query('CREATE TABLE IF NOT EXISTS promax_scan_control (id TEXT PRIMARY KEY, paused BOOLEAN NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
  const {rows}=await pool.query("SELECT paused FROM promax_scan_control WHERE id='main'");
  if(rows.length)paused=rows[0].paused===true;
  else await pool.query("INSERT INTO promax_scan_control (id,paused) VALUES ('main',$1)",[paused]);
 })().catch(e=>{ready=null;throw e;});
 return ready;
}
async function setPaused(value){
 if(typeof value!=='boolean')throw new TypeError('paused must be boolean');
 await init();
 if(pool)await pool.query("INSERT INTO promax_scan_control (id,paused,updated_at) VALUES ('main',$1,NOW()) ON CONFLICT (id) DO UPDATE SET paused=EXCLUDED.paused,updated_at=NOW()",[value]);
 else{const tmp=FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify({paused:value,updatedAt:new Date().toISOString()}));fs.renameSync(tmp,FILE);}
 paused=value;return {ok:true,paused};
}
module.exports={init,setPaused,isPaused:()=>paused};
