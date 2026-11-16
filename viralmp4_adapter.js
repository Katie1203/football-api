'use strict';
// Adapter for viralmp4.in /v3/matches response; provider odds are decimal.
function numeric(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function minute(v){const n=numeric(v);return n!==null&&n>=1&&n<130?Math.floor(n):null;}
function score(info,side,status){
 const a=info?.[side+'Scores'];if(!Array.isArray(a))return null;
 const n=i=>numeric(a[i]);
 if(status===2)return n(0);
 if(status===4||status===8||status===-1)return n(4)??(n(0)!==null&&n(3)!==null?n(0)+n(3):null);
 return n(4)??n(0);
}
function transform(payload,competitionNames=new Map()){
 const source=payload?.data?.matches?payload.data:payload;
 if(!Array.isArray(source?.matches))throw Error('Viralmp4 v3 response missing data.matches');
 const fixtures=[],odds=[];
 for(const match of source.matches){
  const info=match?.info,id=String(info?.id||match?.id||'');if(!id)continue;
  const status=Number(info?.statusId);
  // Provider 2 = first half, 4 = second half. Other statuses are not inferred as LIVE.
  const state=status===2?1:status===4?3:status===8?-1:0;
  const h=score(info,'home',status),a=score(info,'away',status);
  const raw=match?.bs?.['2'];const valid=Array.isArray(raw)&&raw.length>=8;
  const minuteValue=valid?minute(raw[1]):null;
  // Half-time score is not independently supplied in this response. Do not invent it.
  const htH=status===4?numeric(info?.homeScores?.[0]):null;
  const htA=status===4?numeric(info?.awayScores?.[0]):null;
  const homeName=String(info?.homeTeamName||info?.homeName||info?.homeTeam?.name||info?.homeTeamId||'');
  const awayName=String(info?.awayTeamName||info?.awayName||info?.awayTeam?.name||info?.awayTeamId||'');
  fixtures.push({ScheduleID:id,MatchState:state,homeTeam:homeName,guestTeam:awayName,HomeScore:h,GuestScore:a,HomeHalfScore:htH,GuestHalfScore:htA,minute:minuteValue,LeagueName:String(info?.competitionName||info?.competition?.name||competitionNames.get(String(info?.competitionId))||info?.competitionId||''),matchTime:info?.matchTime,matchTime2:info?.matchTime2});
  if(!valid||state!==3||h===null||a===null)continue;
  const [ts,clock,over,line,under]=raw;
  if(![ts,over,line,under].every(x=>numeric(x)!==null))continue;
  const providerTime=numeric(ts);
  // Decimal odds -> Malay-positive equivalent expected by the existing market collector.
  if(numeric(over)<=1||numeric(under)<=1)continue;
  odds.push({match_id:id,company_id:2,market:'OU',provider_time:providerTime,time_of_the_match:minuteValue,match_status:4,score:`${h}-${a}`,line:numeric(line),v1:numeric(over)-1,v2:numeric(under)-1});
 }
 return {fixtures,odds,total:source.total??fixtures.length};
}
module.exports={transform};
