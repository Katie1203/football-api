'use strict';
// AI LIVE RUNG V2: evidence-based live market direction, independent of Telegram odds gate.
const WINDOW_MS=120000;
function decideLiveRung(match,market,at=Date.now()){
 const quote=(market?.bookmakers||[]).find(q=>String(q.bookmakerId)==='2');
 const overOdds=quote?.overDecimal??null;
 const empty={level:null,reason:'Chưa có bằng chứng Tài LIVE đủ rõ',overOdds,line:quote?.line??null};
 if(!quote||!Number.isFinite(quote.providerTime)||at-quote.providerTime>120000||at<quote.providerTime)return {...empty,reason:'Odds LIVE chưa xác minh hoặc đã cũ'};
 const changes=(market?.changes||[]).filter(c=>String(c.bookmakerId)==='2'&&c.marketMove===true&&c.scoreChanged===false&&c.previous&&Number.isFinite(c.observedAt)&&c.observedAt<=at&&at-c.observedAt<=WINDOW_MS).sort((a,b)=>a.observedAt-b.observedAt);
 const evidence={lineUp:0,lineDown:0,overShortening:0,overDrifting:0,observations:changes.length,windows:{}};
 for(const window of [15000,30000,60000,120000])evidence.windows[window]=changes.filter(c=>at-c.observedAt<=window).length;
 for(const c of changes){
  if(c.lineDelta>0)evidence.lineUp+=c.lineDelta;
  if(c.lineDelta<0)evidence.lineDown+=-c.lineDelta;
  if(c.lineDelta===0&&Number.isFinite(c.overPriceDelta)){
   if(c.overPriceDelta<0)evidence.overShortening+=-c.overPriceDelta;
   else evidence.overDrifting+=c.overPriceDelta;
  }
 }
 const bullishLine=evidence.lineUp>evidence.lineDown&&evidence.lineUp>0;
 const bullishPrice=evidence.overShortening>evidence.overDrifting&&evidence.overShortening>0;
 const corroborated=bullishLine&&bullishPrice;
 const scoreChangedRecently=(market?.changes||[]).some(c=>String(c.bookmakerId)==='2'&&c.scoreChanged&&at>=c.observedAt&&at-c.observedAt<=120000);
 // BIG BET is evaluated immediately on a newly observed goal, not contingent on an earlier BET.
 const goalJustOccurred=!!match?.goalJustOccurred;
 if(goalJustOccurred){
  // A post-goal quote is required; do not treat score-reset repricing as a new bullish movement.
  if(changes.length&&(bullishLine||bullishPrice))return {level:'BIG BET',reason:'Vừa có bàn thắng và thị trường tiếp tục xác nhận xu hướng Tài',overOdds,line:quote.line,evidence};
  return {...empty,reason:'Vừa có bàn thắng; đang chờ xác nhận xu hướng Tài sau điều chỉnh kèo',evidence};
 }
 if(!changes.length)return {...empty,evidence};
 if(corroborated&&evidence.windows[60000]>=2)return {level:'BIG BET',reason:'Mốc Tài tăng và Odds Tài giảm được xác nhận qua chuỗi biến động',overOdds,line:quote.line,evidence};
 if(bullishLine||bullishPrice)return {level:'BET NHẸ TAY',reason:bullishLine?'Mốc Tài tăng sau khi loại biến động đảo chiều':'Odds Tài giảm tích lũy tại cùng mốc',overOdds,line:quote.line,evidence};
 return {...empty,reason:scoreChangedRecently?'Biến động sau bàn thắng chưa xác nhận xu hướng Tài':'Xu hướng Tài chưa đủ rõ hoặc đang đảo chiều',evidence};
}
module.exports={decideLiveRung};
