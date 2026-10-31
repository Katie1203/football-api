'use strict';
// Bongdalu-only, event-driven market observation. No old provider dependencies.
const {parseResponse, malayToDecimal} = require('./bongdalu_type4');
class LiveRungMarket {
  constructor(){this.matches=new Map();}
  observe(matchId, payload, observedAt=Date.now()){
    const id=String(matchId), bookmakers=parseResponse(payload).filter(b=>b.matchId===id);
    const state=this.matches.get(id)||{id,books:new Map(),changes:[],lastObservedAt:null};
    const updates=[];
    for(const book of bookmakers){
      // Last complete second OU quote in latest event. Missing/closed prices are not inferred.
      const latest=[...book.changes].reverse().find(c=>c.ouSecond);
      if(!latest)continue;
      const quote=latest.ouSecond;
      const next={bookmakerId:book.bookmakerId,bookmaker:book.bookmaker,minute:latest.minute,
        homeScore:latest.homeScore,awayScore:latest.awayScore,
        overRaw:quote.overRaw,underRaw:quote.underRaw,line:quote.line,
        overDecimal:malayToDecimal(quote.overRaw),underDecimal:malayToDecimal(quote.underRaw),
        observedAt};
      const previous=state.books.get(book.bookmakerId);
      if(previous && previous.minute===next.minute && previous.homeScore===next.homeScore && previous.awayScore===next.awayScore && previous.line===next.line && previous.overRaw===next.overRaw && previous.underRaw===next.underRaw)continue;
      const scoreChanged=!!previous&&(previous.homeScore!==next.homeScore||previous.awayScore!==next.awayScore);
      const change={...next,previous:previous?{line:previous.line,overRaw:previous.overRaw,underRaw:previous.underRaw}:null,
        scoreChanged,marketMove:!!previous&&!scoreChanged,
        lineDelta:previous&&!scoreChanged?next.line-previous.line:null,
        overPriceDelta:previous&&!scoreChanged&&next.line===previous.line?next.overRaw-previous.overRaw:null};
      state.books.set(book.bookmakerId,next);state.changes.push(change);updates.push(change);
    }
    state.lastObservedAt=observedAt;
    // Bound in-memory history without fixed minute windows.
    if(state.changes.length>1000)state.changes.splice(0,state.changes.length-1000);
    this.matches.set(id,state);
    return {matchId:id,bookmakers:[...state.books.values()],updates,historySize:state.changes.length,
      status:bookmakers.length?'OBSERVED':'NO_MARKET_DATA'};
  }
  get(matchId){const s=this.matches.get(String(matchId));return s?{matchId:s.id,bookmakers:[...s.books.values()],changes:[...s.changes],lastObservedAt:s.lastObservedAt}:null;}
  // This collector intentionally does NOT manufacture a high-probability BIG BET verdict.
  // Such a classifier must be trained and verified against settled historical matches.
}
module.exports={LiveRungMarket};
