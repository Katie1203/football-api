'use strict';
// Shadow-only evidence monitor. No probability or Telegram decisions without calibration.
const EVENT_WORDS = [
  ['shot', /shot|attempt|blocked shot|sút|on target/i],
  ['corner', /corner|phạt góc/i],
  ['red_card', /red.card|red card|second yellow|thẻ đỏ/i],
  ['penalty', /penalty|penalt/i],
  ['goal', /\bgoal\b|bàn thắng/i]
];
function collectEvents(payload) {
  const root = payload?.response ?? payload?.data ?? payload?.result ?? payload;
  const arrays = [root, root?.events, root?.incidents, root?.timeline, root?.matchEvents,
    root?.content?.matchFacts?.events?.events, root?.content?.matchFacts?.events,
    root?.matchFacts?.events?.events, root?.header?.events];
  const events = arrays.find(Array.isArray) || [];
  return events.map(e => {
    const type = [e?.type?.name, e?.type, e?.incidentType?.name, e?.incidentType,
      e?.eventType?.name, e?.eventType, e?.detail, e?.name, e?.text].filter(x => typeof x === 'string').join(' ');
    const rawMinute = e?.time?.elapsed ?? e?.time?.minute ?? e?.minute ?? e?.elapsed ?? e?.matchTime;
    const minute = Number.parseInt(String(rawMinute ?? ''), 10);
    const kind = EVENT_WORDS.find(([, regex]) => regex.test(type))?.[0];
    return {minute, kind};
  }).filter(e => Number.isInteger(e.minute) && e.minute >= 0 && e.minute <= 130 && e.kind);
}
function historyFromFixtures(fixtures, teamId) {
  const rows = (Array.isArray(fixtures) ? fixtures : []).filter(f =>
    ['FT', 'AET', 'PEN'].includes(String(f?.fixture?.status?.short || '')) &&
    f?.goals?.home != null && f?.goals?.away != null &&
    (String(f?.teams?.home?.id) === String(teamId) || String(f?.teams?.away?.id) === String(teamId))
  ).slice(0, 5);
  if (!rows.length) return null;
  const total = rows.reduce((sum, f) => sum + Number(f.goals.home) + Number(f.goals.away), 0);
  const scored = rows.reduce((sum, f) => sum + Number(String(f.teams.home.id) === String(teamId) ? f.goals.home : f.goals.away), 0);
  return {sample: rows.length, goalsPerMatch: +(total / rows.length).toFixed(2), scoredPerMatch: +(scored / rows.length).toFixed(2)};
}
// Transparent provisional Poisson baseline, NOT a trained/calibrated AI probability.
// Two teams' recent scored/conceded averages estimate goals per 90 minutes.
// Live events are displayed as evidence, not assigned arbitrary probability weights.
function provisionalProbability(minute, homeHistory, awayHistory) {
  if (!homeHistory || !awayHistory || homeHistory.sample < 3 || awayHistory.sample < 3) return null;
  const fields = [homeHistory.goalsPerMatch, homeHistory.scoredPerMatch,
    awayHistory.goalsPerMatch, awayHistory.scoredPerMatch];
  if (!fields.every(v => Number.isFinite(v) && v >= 0)) return null;
  const homeConceded = homeHistory.goalsPerMatch - homeHistory.scoredPerMatch;
  const awayConceded = awayHistory.goalsPerMatch - awayHistory.scoredPerMatch;
  if (homeConceded < -0.01 || awayConceded < -0.01) return null;
  const homeExpected = (homeHistory.scoredPerMatch + awayConceded) / 2;
  const awayExpected = (awayHistory.scoredPerMatch + homeConceded) / 2;
  const remainingFraction = Math.max(0, 90 - Math.max(0, minute)) / 90;
  const lambda = (homeExpected + awayExpected) * remainingFraction;
  return { probability: Math.round((1 - Math.exp(-lambda)) * 1000) / 10,
    expectedRemainingGoals: Math.round(lambda * 100) / 100,
    model: 'POISSON_HISTORY_BASELINE', calibrated: false,
    description: 'Ước lượng Poisson từ 5 trận gần nhất; sự kiện LIVE chỉ hiển thị, chưa có hệ số được kiểm chứng.' };
}
function evaluate({match, minute, events, homeHistory, awayHistory, eventSource}) {
  const recent = events.filter(e => e.minute <= minute && e.minute > minute - 10);
  const counts = Object.fromEntries(EVENT_WORDS.map(([name]) => [name, recent.filter(e => e.kind === name).length]));
  const hasLive = events.length > 0;
  const hasHistory = Boolean(homeHistory && awayHistory);
  const evidence = hasLive && hasHistory ? 'LIVE + LỊCH SỬ' : hasLive ? 'CHỈ SỰ KIỆN LIVE' : hasHistory ? 'CHỈ LỊCH SỬ' : 'THIẾU DỮ LIỆU';
  const estimate = provisionalProbability(minute, homeHistory, awayHistory);
  return {
    key: `${match.source}:${match.id}`, source: match.source, sourceId: String(match.id),
    league: match.league || '', home: match.homeName, away: match.awayName,
    minute, score: `${match.homeScore ?? '?'}-${match.awayScore ?? '?'}`,
    eventSource: eventSource || null, eventsAvailable: events.length, recent10: counts,
    homeHistory: homeHistory || null, awayHistory: awayHistory || null,
    evidence, probability: estimate?.probability ?? null, expectedRemainingGoals: estimate?.expectedRemainingGoals ?? null, probabilityModel: estimate?.model ?? null, calibrated: false, mode: 'SHADOW_ONLY', evaluation: 'PENDING_FT',
    note: estimate ? estimate.description : 'Thiếu lịch sử tối thiểu 3 trận mỗi đội; không đủ cơ sở tính xác suất.',
    updatedAt: new Date().toISOString()
  };
}
module.exports = {collectEvents, historyFromFixtures, provisionalProbability, evaluate};
