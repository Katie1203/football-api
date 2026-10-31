'use strict';
// Parser for verified Bongdalu SoccerAjax?type=4 response.
// This module deliberately does NOT assume the provider's odds display convention.
function finite(x){if(x===null||x===undefined||x==='')return null;const n=Number(x);return Number.isFinite(n)?n:null;}
function triplet(fields,at){const a=finite(fields[at]),line=finite(fields[at+1]),b=finite(fields[at+2]);return a===null||line===null||b===null?null:{overRaw:a,line,underRaw:b};}
function parseRow(segment){
 const [initial,...history]=String(segment).split('^');
 const [identity,opening='']=initial.split('#');
 const idFields=identity.split(',');
 const matchId=idFields[0],bookmakerId=finite(idFields[1]),bookmaker=idFields[2]||'';
 if(!/^\d+$/.test(matchId)||bookmakerId===null)return null;
 // Opening payload: market pairs occur after 18 handicap cells; preserve raw
 // instead of inferring whether the two triplets mean opening/current.
 const initialFields=opening.split(',');
 const changes=history.map(h=>{
  const fields=h.split(',');
  // Verified by supplied examples: minute, home, away, followed by 6 x 6 market cells.
  return {minute:fields[0],homeScore:finite(fields[1]),awayScore:finite(fields[2]),
   ouFirst:triplet(fields,21),ouSecond:triplet(fields,24),raw:fields};
 }).filter(c=>c.ouFirst||c.ouSecond);
 return {matchId,bookmakerId,bookmaker,opening:initialFields,changes};
}
function parseResponse(payload){
 if(typeof payload==='string'){try{payload=JSON.parse(payload);}catch{return [];}}
 if(!payload||payload.ErrCode!==0||typeof payload.Data!=='string')return [];
 return payload.Data.split('!').map(parseRow).filter(Boolean);
}
// Asian odds displayed as Malay odds, ONLY after independent display verification.
function malayToDecimal(raw){const x=finite(raw);if(x===null||x===0||x>1||x< -1)return null;return x>0?1+x:1+1/Math.abs(x);}
module.exports={parseResponse,malayToDecimal};
