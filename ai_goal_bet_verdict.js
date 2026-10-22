'use strict';
// The prediction is P(at least one further goal after this observation).
// With a validated two-stage model, the decision uses its learned four-scenario
// probability, not a separate hand-built score or the projected FT score.
// Until a validated model exists, retain the existing production gate explicitly
// labelled as uncalibrated; never claim it is an independent trained decision.
function decide(aiGoal, rulePercent, goalThreshold=65, ruleThreshold=60) {
  const probability=aiGoal?.percent==null?NaN:Number(aiGoal.percent);
  const rule=rulePercent==null?NaN:Number(rulePercent);
  const trained=aiGoal?.source==='ai-goal-v4-two-stage-trained' && aiGoal?.calibrated===true;
  const eligible=Number.isFinite(probability)&&Number.isFinite(rule)&&
    probability>goalThreshold&&rule>ruleThreshold;
  return {
    verdict:eligible?'BET':'NO BET',
    eligible,
    probability:Number.isFinite(probability)?probability:null,
    rule:Number.isFinite(rule)?rule:null,
    mode:trained?'TRAINED_FOUR_SCENARIO':'BASELINE_NOT_CALIBRATED',
    reason:!Number.isFinite(probability)?'AI_GOAL_UNAVAILABLE':
      !Number.isFinite(rule)?'RULE_UNAVAILABLE':
      rule<=ruleThreshold?'RULE_BELOW_THRESHOLD':
      probability<=goalThreshold?'NEXT_GOAL_PROBABILITY_BELOW_THRESHOLD':'NEXT_GOAL_PROBABILITY_ABOVE_THRESHOLD'
  };
}
module.exports={decide};
