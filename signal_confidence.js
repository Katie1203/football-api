'use strict';
// Live market-evidence indicators only. No FT results, historical win rates or fabricated %.
function signalConfidence(level,market,_records,at=Date.now()){
 const changes=(market?.changes||[]).filter(c=>c.marketMove===true&&!c.scoreChanged&&Number.isFinite(c.observedAt)&&at>=c.observedAt&&at-c.observedAt<=120000);
 const quotes=(market?.bookmakers||[]).filter(q=>Number.isFinite(q.providerTime));
 const latest=quotes.length?Math.max(...quotes.map(q=>q.providerTime)):null;
 const fresh=latest!==null&&at>=latest&&at-latest<=120000;
 const lineUp=changes.filter(c=>c.lineDelta>0).reduce((s,c)=>s+c.lineDelta,0);
 const shortening=changes.filter(c=>c.lineDelta===0&&c.overPriceDelta<0).reduce((s,c)=>s-c.overPriceDelta,0);
 const evidence={fresh,latestProviderTime:latest,observations:changes.length,bookmakerCount:new Set(quotes.map(q=>String(q.bookmakerId))).size,lineUp,overShortening:shortening};
 return {probability:null,method:'live_market_evidence_only',sampleSize:null,wins:null,interval95:null,reason:'Chưa có mô hình xác suất được kiểm định từ bằng chứng LIVE; không hiển thị phần trăm tự tạo',evidence};
}
module.exports={signalConfidence};
