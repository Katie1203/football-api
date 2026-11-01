'use strict';
// BET365-only Bongdalu live odds snapshot collector. No synthetic odds.
function oddsDecimal(v){
 const n=Number(v);if(v===null||v===undefined||String(v).trim()===""||!Number.isFinite(n)||n===0)return null;
 // Bongdalu commonly supplies Malay odds; convert positive and negative prices.
 return n>=0?Number((1+n).toFixed(4)):Number((1+1/Math.abs(n)).toFixed(4));
}
class LiveRungMarket{
 constructor(){this.matches=new Map();}
 observe(matchId,rows,observedAt=Date.now()){
  const id=String(matchId),state=this.matches.get(id)||{id,books:new Map(),changes:[],lastObservedAt:null};
  const updates=[];
  for(const r of Array.isArray(rows)?rows:[]){
   if(String(r.match_id)!==id||Number(r.company_id)!==2||String(r.market).toUpperCase()!=='OU')continue;
   const line=Number(r.line),overRaw=Number(r.v1),underRaw=Number(r.v2),provider=Number(r.provider_time)*1000;
   if([r.line,r.v1,r.v2,r.provider_time].some(v=>v===null||v===undefined||String(v).trim()===""))continue;
   if(!Number.isFinite(line)||!Number.isFinite(overRaw)||!Number.isFinite(underRaw)||!Number.isFinite(provider)||provider<=0||Math.abs(observedAt-provider)>120000)continue;
   const [homeScore,awayScore]=String(r.score||'').split('-').map(Number);
   if(!Number.isFinite(homeScore)||!Number.isFinite(awayScore))continue;
   const bookmakerId='2';
   const next={bookmakerId,bookmaker:'BET365',minute:Number(r.time_of_the_match)||null,homeScore,awayScore,overRaw,underRaw,line,overDecimal:oddsDecimal(overRaw),underDecimal:oddsDecimal(underRaw),observedAt,providerTime:provider};
   const prev=state.books.get(bookmakerId);
   if(prev&&provider<prev.providerTime)continue;
   if(prev&&prev.line===line&&prev.overRaw===overRaw&&prev.underRaw===underRaw&&prev.homeScore===homeScore&&prev.awayScore===awayScore){
    // Refresh timestamp on an unchanged, newly verified provider quote; do not fabricate a price move.
    state.books.set(bookmakerId,{...next});continue;
   }
   const scoreChanged=!!prev&&(prev.homeScore!==homeScore||prev.awayScore!==awayScore);
   const change={...next,previous:prev?{line:prev.line,overRaw:prev.overRaw,underRaw:prev.underRaw}:null,scoreChanged,marketMove:!!prev&&!scoreChanged,lineDelta:prev&&!scoreChanged?line-prev.line:null,overPriceDelta:prev&&!scoreChanged&&line===prev.line?overRaw-prev.overRaw:null};
   state.books.set(bookmakerId,next);state.changes.push(change);updates.push(change);
  }
  state.lastObservedAt=observedAt;
  if(state.changes.length>1000)state.changes.splice(0,state.changes.length-1000);
  this.matches.set(id,state);
  return {matchId:id,bookmakers:[...state.books.values()],updates,historySize:state.changes.length,status:updates.length?'OBSERVED':(Array.isArray(rows)&&rows.length?'UNCHANGED':'NO_MARKET_DATA')};
 }
 get(matchId){const s=this.matches.get(String(matchId));return s?{matchId:s.id,bookmakers:[...s.books.values()],changes:[...s.changes],lastObservedAt:s.lastObservedAt}:null;}
}
module.exports={LiveRungMarket,oddsDecimal};
