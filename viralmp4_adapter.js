'use strict';
// Adapter for viralmp4.in /v3/matches response; provider odds are decimal.
function numeric(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function minute(v){const n=numeric(v);return n!==null&&n>=1&&n<130?Math.floor(n):null;}
function score(info,side){
 const a=info?.[side+'Scores'];
 if(!Array.isArray(a))return null;
 const n=numeric(a[0]);
 return n!==null&&Number.isInteger(n)&&n>=0?n:null;
}
function halfScore(info,side){
 const a=info?.[side+'Scores'];
 if(!Array.isArray(a)||a.length<2)return null;
 const n=numeric(a[1]);
 return n!==null&&Number.isInteger(n)&&n>=0?n:null;
}
function transform(payload,competitionNames=new Map()){
 const source=payload?.data?.matches?payload.data:payload;
 if(!Array.isArray(source?.matches))throw Error('Viralmp4 v3 response missing data.matches');
 const teams=new Map((Array.isArray(source?.relation?.teams)?source.relation.teams:[]).filter(t=>t?.id!=null&&typeof t.name==='string'&&t.name.trim()).map(t=>[String(t.id),t.name.trim()]));
 const competitions=new Map((Array.isArray(source?.relation?.competitions)?source.relation.competitions:[]).filter(c=>c?.id!=null&&typeof c.name==='string'&&c.name.trim()).map(c=>[String(c.id),c.name.trim()]));
 const fixtures=[],odds=[];
 for(const match of source.matches){
  const info=match?.info,id=String(info?.id||match?.id||'');if(!id)continue;
  const status=Number(info?.statusId);
  // Provider 2 = first half, 4 = second half. Other statuses are not inferred as LIVE.
  const state=status===2?1:status===4?3:status===8?-1:0;
  const h=score(info,'home'),a=score(info,'away');
  const raw=match?.bs?.['2'];const valid=Array.isArray(raw)&&raw.length>=8;
  // Minute belongs to the latest Bet365 OU quote, not a guaranteed match clock.
  // Use only when the provider actually supplies a valid numeric minute.
  const minuteValue=minute(raw?.[1]) ?? minute(match?.asia?.['2']?.[1]) ?? minute(match?.eu?.['2']?.[1]);
  // Provider score arrays: [current score, first-half score, ...].
  const htH=status===4?halfScore(info,'home'):null;
  const htA=status===4?halfScore(info,'away'):null;
  const homeName=String(info?.homeTeamName||info?.homeName||info?.homeTeam?.name||teams.get(String(info?.homeTeamId))||info?.homeTeamId||'');
  const awayName=String(info?.awayTeamName||info?.awayName||info?.awayTeam?.name||teams.get(String(info?.awayTeamId))||info?.awayTeamId||'');
  fixtures.push({ScheduleID:id,MatchState:state,homeTeam:homeName,guestTeam:awayName,HomeScore:h,GuestScore:a,HomeHalfScore:htH,GuestHalfScore:htA,minute:minuteValue,LeagueName:String(info?.competitionName||info?.competition?.name||competitions.get(String(info?.competitionId))||competitionNames.get(String(info?.competitionId))||info?.competitionId||''),matchTime:info?.matchTime,matchTime2:info?.matchTime2});
  if(!valid||state!==3||h===null||a===null||minute(raw[1])===null)continue;
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
