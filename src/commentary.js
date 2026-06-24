const SIDE_LABELS = { home: "主队", away: "客队" };

/** 将动作事件转换为电视式中文播报。 */
export function buildCommentary(actionEvent = {}) {
  const actor = formatPlayerLabel(actionEvent.actor, actionEvent.team_id);
  const target = formatPlayerLabel(actionEvent.target);
  const team = teamLabel(actionEvent.team_id);
  switch (actionEvent.action_type) {
    case "pass_completed":
      return `${actor}把球交给${target}。`;
    case "pass_intercepted":
      return `${actor}的传球被${target}拦截。`;
    case "tackle_won":
      return `${actor}上抢成功，断下了${target}的脚下球。`;
    case "carry_progressive":
      return `${actor}带球向前推进。`;
    case "shot":
      return `${actor}起脚射门。`;
    case "goal":
      return `${actor}破门得分！`;
    case "foul":
      return `${actor}犯规，裁判响哨。`;
    case "throw_in":
      return `${team}获得界外球。`;
    case "corner_kick":
      return `${team}获得角球。`;
    case "goal_kick":
      return `${team}获得球门球。`;
    case "penalty_awarded":
      return `${team}获得点球。`;
    case "substitution":
      return actionEvent.description || `${team}完成换人调整。`;
    case "yellow_card":
      return `${actor}得到黄牌。`;
    case "red_card":
      return `${actor}被红牌罚下。`;
    default:
      return actionEvent.description || `${team}完成一次处理。`;
  }
}

/** 生成播报中的球员标签。 */
export function formatPlayerLabel(player = null, fallbackTeamId = null) {
  const side = teamLabel(player?.team_id || fallbackTeamId);
  if (player?.shirt) return `${side} ${player.shirt} 号`;
  if (player?.name) return player.name;
  return fallbackTeamId ? `${side}球员` : "对方球员";
}

/** 生成比赛分钟文本。 */
export function formatMinute(gameTime = 0) {
  return `${Math.floor((gameTime || 0) / 60)}'`;
}

/** 生成球队标签。 */
export function teamLabel(teamId = null) {
  return SIDE_LABELS[teamId] || "球队";
}
