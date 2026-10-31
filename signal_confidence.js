'use strict';
// Evidence-based reliability of an ALERT SIGNAL, not Poisson goal probability.
// No synthetic percentages: publish only after >=30 settled comparable historical signals.
const MIN_SAMPLES=30;
function features(market, at=Date.now()){
 const changes=(market?.changes||[]).filter(c=>c.marketMove===true&&c.scoreChanged===false&&Number(c.lineDelta)>0);
 const ids=new Set(changes.map(c=>String(c.bookmakerId)));
 const quotes=(market?.bookmakers||[]).filter(q=>Number.isFinite(q.observedAt));
 const latest=quotes.length?Math.max(...quotes.map(q=>q.observedAt)):null;
 const fresh=latest!==null&&at-latest>=0&&at-latest<=15000;
 const recent=changes.filter(c=>Number.isFinite(c.observedAt)&&at-c.observedAt<=300000&&at>=c.observedAt);
 const recentIds=new Set(recent.map(c=>String(c.bookmakerId)));
 return {bookmakerCount:ids.size,recentBookmakerCount:recentIds.size,positiveMoves:changes.length,recentMoves:recent.length,
   maxLineIncrease:changes.length?Math.max(...changes.map(c=>Number(c.lineDelta))):0,
   fresh,latestObservedAt:latest};
}
function signalConfidence(level,market,records,at=Date.now()){
 const evidence=features(market,at);
 const comparable=[...records].filter(r=>r?.status==='sent'&&r?.decision?.level===level&&r.ft&&r.marketEvidenceAtAlert?.fresh===true);
 const settled=comparable.filter(r=>{const [h,a]=String(r.score).split('-').map(Number);return Number.isFinite(h)&&Number.isFinite(a)&&Number.isFinite(Number(r.ft.home))&&Number.isFinite(Number(r.ft.away));});
 // Use only same alert type and comparable market-evidence quality.
 const cohort=settled.filter(r=>{
   const e=r.marketEvidenceAtAlert;
   return (e.bookmakerCount>=2)===(evidence.bookmakerCount>=2) &&
          (e.recentBookmakerCount>=2)===(evidence.recentBookmakerCount>=2) &&
          (e.maxLineIncrease>=0.5)===(evidence.maxLineIncrease>=0.5);
 });
 const wins=cohort.filter(r=>{const [h,a]=String(r.score).split('-').map(Number);return Number(r.ft.home)+Number(r.ft.away)>h+a;}).length;
 const n=cohort.length;
 // Wilson 95% interval for transparency; percent is observed historical hit rate, not certainty.
 let interval=null;
 if(n){const z=1.96,p=wins/n,den=1+z*z/n,center=(p+z*z/(2*n))/den,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
   interval=[Number((100*(center-half)).toFixed(1)),Number((100*(center+half)).toFixed(1))];}
 return {probability:evidence.fresh&&n>=MIN_SAMPLES?Number((100*wins/n).toFixed(1)):null,
   method:'historical_signal_win_rate',sampleSize:n,wins,interval95:interval,minSamples:MIN_SAMPLES,
   reason:!evidence.fresh?'Dữ liệu thị trường không đủ mới':n<MIN_SAMPLES?'Chưa đủ tín hiệu FT tương đồng để ước lượng %':'Tỷ lệ WIN lịch sử của tín hiệu thị trường tương đồng',
   evidence};
}
module.exports={signalConfidence,features,MIN_SAMPLES};
