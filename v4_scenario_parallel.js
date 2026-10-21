'use strict';
// Observation-only: no model fitting or probability changes until labelled data exist.
// Emit one structured observation per match/minute, without network calls or persistence side effects.
const lastSeen = new Map();
function observe({key, match, minute, stats, rule, aiGoal, scenario, decision}) {
  if (!Number.isFinite(Number(minute))) return;
  const id = String(key || `${match?.homeName}|${match?.awayName}`);
  const dedup = `${id}|${minute}`;
  if (lastSeen.has(dedup)) return;
  lastSeen.set(dedup, Date.now());
  if (lastSeen.size > 4000) {
    const oldest = [...lastSeen.keys()].slice(0, 2000);
    for (const k of oldest) lastSeen.delete(k);
  }
  const present = stats?._present || {};
  const fields = ['TotalShots','ShotsOnTarget','Corners','BigChances','ExpectedGoals'];
  const h2 = {};
  for (const f of fields) {
    const h = 'home' + f, a = 'away' + f;
    h2[f] = present[h] === true && present[a] === true &&
      Number.isFinite(Number(stats[h])) && Number.isFinite(Number(stats[a]))
      ? [Number(stats[h]), Number(stats[a])] : null;
  }
  const row = {
    schema:'V4_SCENARIO_PARALLEL_V1',
    observedAt:new Date().toISOString(),
    matchKey:id,home:match?.homeName,away:match?.awayName,
    minute:Number(minute),score:[match?.homeScore,match?.awayScore],
    ruleV4Percent:rule == null ? null : (Number.isFinite(Number(rule))?Number(rule):null),
    aiGoalPercent:aiGoal == null ? null : (Number.isFinite(Number(aiGoal))?Number(aiGoal):null),
    scenarios:Array.isArray(scenario?.groups)?scenario.groups:[],
    coverage:scenario?.coverage || {},
    statsAsProvided:h2,
    decision:decision?.reason || null,
    sent:decision?.send === true,
    // Explicitly not a trained Enhanced prediction or a verified H2-only reconstruction.
    enhancedProbability:null, outcomeAfterObservation:null
  };
  console.log('[V4 PARALLEL DATA] '+JSON.stringify(row));
  return row;
}
module.exports={observe};
