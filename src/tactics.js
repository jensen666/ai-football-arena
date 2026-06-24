import { clamp, clone } from "./utils.js";
import { SUPPORTED_FORMATIONS, defaultTactics } from "./teamFactory.js";

export const PHASES = ["pre_match", "open_play", "out_of_play", "set_piece", "half_time", "extra_time", "penalty_shootout"];
export const INTENTS = ["high_press", "wide_attack", "compact_block", "counter", "control_possession", "protect_lead", "chase_goal"];
const VALID_ENUMS = {
  tempo: ["slow", "balanced", "fast"],
  pressing_height: ["low", "medium", "high"],
  pressing_intensity: ["low", "medium", "high"],
  defensive_line: ["low", "medium", "medium_high", "high"],
  attacking_width: ["narrow", "balanced", "wide"],
  defensive_width: ["narrow", "balanced", "wide"],
  passing_risk: ["low", "medium", "high"],
  transition: ["hold_shape", "counter", "counter_press"],
  focus_channel: ["left", "left_half_space", "center", "right_half_space", "right", "mixed"]
};

/** 根据球队生成默认决策。 */
export function createDefaultDecision(teamId, tick = 0, formation = "4-3-3", variant = 0) {
  const homeVariants = ["high_press", "wide_attack", "control_possession"];
  const awayVariants = ["compact_block", "counter", "wide_attack"];
  const intent = (teamId === "home" ? homeVariants : awayVariants)[variant % 3];
  const risk = intent === "high_press" || intent === "chase_goal" ? 0.68 : intent === "compact_block" ? 0.38 : 0.52;
  return {
    decision_id: `${teamId}_${String(tick).padStart(6, "0")}`,
    phase: "open_play",
    intent,
    risk_level: risk,
    formation: { base: formation, in_possession: intent === "wide_attack" ? "3-2-5" : "4-3-3", out_of_possession: intent === "compact_block" ? "5-4-1" : "4-4-2" },
    team_orders: decisionOrders(intent),
    player_orders: [
      { player_id: 7, role_adjustment: "inside_forward", priority: intent === "compact_block" ? "support_counter" : "press_ball_carrier", target_zone: intent === "wide_attack" ? "right_half_space" : "center" },
      { player_id: 10, role_adjustment: "advanced_playmaker", priority: "seek_through_pass", target_zone: "center", target_player_id: 9 }
    ],
    substitution: null,
    set_piece_plan: null,
    explanation: intentExplanation(intent)
  };
}

/** 校验并修复 CoachDecision。 */
export function validateCoachDecision(rawDecision, context) {
  const errors = [];
  const repairActions = [];
  let decision = parseDecision(rawDecision, errors, repairActions);
  if (!decision) return invalidResult(errors, repairActions, context.lastValidDecision);
  if (!decision.decision_id) {
    decision.decision_id = `${context.teamId}_${context.tick}`;
    repairActions.push("id_generated");
  }
  if (!PHASES.includes(decision.phase)) {
    decision.phase = phaseFromMatchState(context.matchState);
    repairActions.push("phase_replaced");
  }
  if (!INTENTS.includes(decision.intent)) {
    decision.intent = context.lastValidDecision?.intent || "control_possession";
    repairActions.push("intent_replaced");
  }
  const promptedIntent = inferPromptIntent(context.strategyPrompt);
  if (shouldAlignIntent(decision.intent, promptedIntent, context.strategyPrompt)) {
    decision.intent = promptedIntent;
    repairActions.push("intent_aligned_with_strategy_prompt");
  }
  const originalRisk = Number(decision.risk_level);
  decision.risk_level = normalizeRisk(originalRisk, decision.intent);
  if (decision.risk_level !== originalRisk) repairActions.push(Number.isFinite(originalRisk) ? "risk_aligned_with_intent" : "risk_filled");
  validateFormation(decision, context, repairActions);
  validateOrders(decision, context, errors, repairActions);
  validatePlayerOrders(decision, context, repairActions);
  validateSubstitution(decision, context, errors, repairActions);
  validateSetPiece(decision, context, repairActions);
  removeForbiddenFields(decision, repairActions);
  const result = errors.length ? (repairActions.length ? "repaired" : "invalid") : (repairActions.length ? "repaired" : "valid");
  if (result === "invalid") return invalidResult(errors, repairActions, context.lastValidDecision);
  return { decision, validation_result: result, validation_errors: errors, repair_actions: repairActions, fallback_used: false };
}

/** 将合法决策解释为引擎战术状态。 */
export function interpretDecision(decision, previous = defaultTactics(decision?.formation?.base)) {
  const orders = decision.team_orders || {};
  return {
    formation: decision.formation?.base || previous.formation,
    intent: decision.intent,
    riskLevel: clamp(decision.risk_level, 0, 1),
    tempo: orders.tempo || previous.tempo,
    pressingHeight: orders.pressing_height || previous.pressingingHeight || previous.pressingHeight,
    pressingIntensity: orders.pressing_intensity || previous.pressingIntensity,
    defensiveLine: orders.defensive_line || previous.defensiveLine,
    attackingWidth: orders.attacking_width || previous.attackingWidth,
    defensiveWidth: orders.defensive_width || previous.defensiveWidth,
    passingRisk: orders.passing_risk || previous.passingRisk,
    transition: orders.transition || previous.transition,
    focusChannel: orders.focus_channel || previous.focusChannel,
    playerOrders: decision.player_orders || [],
    behavior: behaviorWeights(decision)
  };
}

/** 根据比赛状态推导模型阶段。 */
export function phaseFromMatchState(matchState) {
  if (matchState === "pre_match") return "pre_match";
  if (matchState === "half_time") return "half_time";
  if (matchState === "extra_time_break") return "extra_time";
  if (matchState === "penalty_shootout") return "penalty_shootout";
  if (["throw_in", "goal_kick", "corner_kick", "free_kick", "penalty_kick"].includes(matchState)) return "set_piece";
  if (matchState === "in_play" || matchState === "kickoff") return "open_play";
  return "out_of_play";
}

/** 生成战术行为权重。 */
export function behaviorWeights(decision) {
  const risk = clamp(decision.risk_level ?? 0.5, 0, 1);
  return {
    passRisk: risk,
    shotThreshold: risk < 0.34 ? 0.1 : risk < 0.67 ? 0.08 : 0.055,
    pressBonus: decision.intent === "high_press" ? 0.22 : decision.intent === "compact_block" ? -0.12 : 0,
    wideBias: decision.intent === "wide_attack" ? 0.25 : 0,
    counterBias: decision.intent === "counter" ? 0.25 : 0,
    blockBias: decision.intent === "compact_block" ? 0.25 : 0
  };
}

/** 返回战术看板摘要。 */
export function decisionSummary(decision) {
  return {
    decision_id: decision.decision_id,
    intent: decision.intent,
    risk_level: decision.risk_level,
    formation: decision.formation,
    team_orders: decision.team_orders,
    explanation: displayExplanation(decision)
  };
}

function displayExplanation(decision = {}) {
  const explanation = String(decision.explanation || "").trim();
  if (containsCjk(explanation)) return explanation;
  return synthesizedChineseExplanation(decision);
}

function containsCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function synthesizedChineseExplanation(decision = {}) {
  const orders = decision.team_orders || {};
  const details = [
    labelPair("节奏", tempoLabel(orders.tempo)),
    labelPair("压迫", intensityLabel(orders.pressing_height || orders.pressing_intensity)),
    labelPair("防线", lineLabel(orders.defensive_line)),
    labelPair("转换", transitionLabel(orders.transition)),
    labelPair("进攻方向", channelLabel(orders.focus_channel))
  ].filter(Boolean).join("，");
  const intent = intentLabel(decision.intent);
  const risk = Number.isFinite(Number(decision.risk_level)) ? `风险 ${Number(decision.risk_level).toFixed(2)}` : "风险保持常规";
  return `调整为${intent}：${details || "保持阵型平衡"}，${risk}。`;
}

function labelPair(label, value) {
  return value ? `${label}${value}` : "";
}

function intentLabel(intent) {
  return {
    high_press: "高位逼抢",
    wide_attack: "边路进攻",
    compact_block: "密集防守",
    counter: "快速反击",
    control_possession: "控球推进",
    protect_lead: "守住领先",
    chase_goal: "加强进攻"
  }[intent] || "均衡策略";
}

function tempoLabel(value) {
  return { slow: "放慢", balanced: "均衡", fast: "加快" }[value] || "";
}

function intensityLabel(value) {
  return { low: "偏低", medium: "中等", high: "偏高" }[value] || "";
}

function lineLabel(value) {
  return { low: "回收", medium: "中位", medium_high: "适度前提", high: "前压" }[value] || "";
}

function transitionLabel(value) {
  return { hold_shape: "先稳住阵型", counter: "优先反击", counter_press: "丢球后立即反抢" }[value] || "";
}

function channelLabel(value) {
  return {
    left: "左路",
    left_half_space: "左肋",
    center: "中路",
    right_half_space: "右肋",
    right: "右路",
    mixed: "多点轮转"
  }[value] || "";
}

function parseDecision(rawDecision, errors, repairActions) {
  if (typeof rawDecision === "object" && rawDecision) return clone(rawDecision);
  if (typeof rawDecision !== "string") {
    errors.push("decision_not_object");
    return null;
  }
  const match = rawDecision.match(/\{[\s\S]*\}/);
  if (!match) {
    errors.push("invalid_json");
    return null;
  }
  try {
    if (match[0] !== rawDecision.trim()) repairActions.push("json_extracted");
    return JSON.parse(match[0]);
  } catch {
    errors.push("invalid_json");
    return null;
  }
}

function validateFormation(decision, context, repairActions) {
  if (typeof decision.formation === "string") {
    decision.formation = { base: decision.formation };
    repairActions.push("formation_normalized");
  } else if (!decision.formation || typeof decision.formation !== "object") {
    decision.formation = {};
    repairActions.push("formation_normalized");
  }
  if (!SUPPORTED_FORMATIONS.includes(decision.formation.base)) {
    decision.formation.base = context.lastValidDecision?.formation?.base || context.currentFormation || "4-3-3";
    repairActions.push("formation_replaced");
  }
  decision.formation.in_possession ||= "4-3-3";
  decision.formation.out_of_possession ||= "4-4-2";
}

function validateOrders(decision, context, errors, repairActions) {
  const inferred = inferTeamOrders(decision.intent, context);
  const fallback = { ...context.lastValidDecision?.team_orders, ...inferred };
  decision.team_orders = decision.team_orders && typeof decision.team_orders === "object" ? decision.team_orders : {};
  for (const [field, allowed] of Object.entries(VALID_ENUMS)) {
    if (!allowed.includes(decision.team_orders[field])) {
      decision.team_orders[field] = fallback[field] || allowed[0];
      repairActions.push(`order_${field}_filled`);
    } else if (shouldAlignOrder(field, decision.team_orders[field], inferred[field], decision.intent, context.strategyPrompt)) {
      decision.team_orders[field] = inferred[field];
      repairActions.push(`order_${field}_aligned`);
    }
  }
  if (decision.phase === "var_check") errors.push("phase_forbidden_var_check");
}

function validatePlayerOrders(decision, context, repairActions) {
  const validIds = new Set(context.team.players.map((player) => player.id));
  const original = Array.isArray(decision.player_orders) ? decision.player_orders : [];
  decision.player_orders = original.filter((order) => validIds.has(order.player_id) && (!order.target_player_id || validIds.has(order.target_player_id)));
  if (decision.player_orders.length !== original.length) repairActions.push("player_order_removed");
}

function validateSubstitution(decision, context, errors, repairActions) {
  if (!decision.substitution) return;
  const { out_player_id: outId, in_player_id: inId } = decision.substitution;
  const outPlayer = context.team.players.find((player) => player.id === outId);
  const inPlayer = context.team.players.find((player) => player.id === inId);
  const limit = context.extraTime ? 6 : 5;
  const returningPlayer = context.team.substitutions.usedPlayers.some((substitution) => substitution.out === inId);
  if (!outPlayer || !inPlayer || !outPlayer.onField || inPlayer.onField || context.team.substitutions.used >= limit || outPlayer.sentOff || returningPlayer || (outPlayer.position === "GK") !== (inPlayer.position === "GK")) {
    decision.substitution = null;
    repairActions.push("substitution_rejected");
  }
}

function validateSetPiece(decision, context, repairActions) {
  if (!decision.set_piece_plan) return;
  const allowed = ["corner_kick", "free_kick", "penalty_kick", "throw_in", "goal_kick", "out_of_play"].includes(context.matchState);
  if (!allowed) {
    decision.set_piece_plan = null;
    repairActions.push("set_piece_removed");
  }
}

function removeForbiddenFields(decision, repairActions) {
  const forbidden = ["score", "time", "match_state", "random_seed", "referee_override", "var_request"];
  for (const field of forbidden) {
    if (Object.hasOwn(decision, field)) {
      delete decision[field];
      repairActions.push("forbidden_field_removed");
    }
  }
}

function invalidResult(errors, repairActions, lastValidDecision) {
  return { decision: lastValidDecision || null, validation_result: "invalid", validation_errors: errors, repair_actions: repairActions, fallback_used: true };
}

function decisionOrders(intent) {
  const orders = {
    high_press: ["fast", "high", "high", "high", "wide", "balanced", "medium", "counter_press", "center"],
    wide_attack: ["fast", "medium", "medium", "medium_high", "wide", "balanced", "medium", "counter", "right_half_space"],
    compact_block: ["slow", "low", "medium", "low", "balanced", "narrow", "low", "hold_shape", "center"],
    counter: ["fast", "medium", "medium", "medium", "balanced", "balanced", "high", "counter", "mixed"],
    control_possession: ["balanced", "medium", "medium", "medium", "balanced", "balanced", "low", "hold_shape", "mixed"],
    protect_lead: ["slow", "low", "low", "low", "narrow", "narrow", "low", "hold_shape", "center"],
    chase_goal: ["fast", "high", "high", "high", "wide", "balanced", "high", "counter_press", "mixed"]
  }[intent] || ["balanced", "medium", "medium", "medium", "balanced", "balanced", "medium", "hold_shape", "mixed"];
  return {
    tempo: orders[0], pressing_height: orders[1], pressing_intensity: orders[2], defensive_line: orders[3],
    attacking_width: orders[4], defensive_width: orders[5], passing_risk: orders[6], transition: orders[7], focus_channel: orders[8]
  };
}

function inferTeamOrders(intent, context = {}) {
  const orders = { ...decisionOrders(intent) };
  const prompt = normalizedText(context.strategyPrompt);
  if (matchesAny(prompt, ["高位", "逼抢", "high press", "high_press"])) {
    orders.tempo = "fast";
    orders.pressing_height = "high";
    orders.pressing_intensity = "high";
    orders.defensive_line = "high";
    orders.transition = "counter_press";
    orders.passing_risk = orders.passing_risk === "low" ? "medium" : orders.passing_risk;
  }
  if (matchesAny(prompt, ["快速反抢", "反抢", "counter press", "counter_press"])) {
    orders.tempo = "fast";
    orders.pressing_intensity = "high";
    orders.transition = "counter_press";
  }
  if (matchesAny(prompt, ["右路", "右肋", "right"])) {
    orders.attacking_width = "wide";
    orders.focus_channel = prompt.includes("右肋") ? "right_half_space" : "right_half_space";
  }
  if (matchesAny(prompt, ["左路", "左肋", "left"])) {
    orders.attacking_width = "wide";
    orders.focus_channel = prompt.includes("左肋") ? "left_half_space" : "left_half_space";
  }
  if (matchesAny(prompt, ["低位", "low block", "low_block"])) {
    orders.pressing_height = "low";
    orders.defensive_line = "low";
    orders.defensive_width = "narrow";
    orders.pressing_intensity = matchesAny(prompt, ["反击", "counter"]) ? "medium" : "low";
  }
  if (matchesAny(prompt, ["反击", "counter"])) {
    orders.tempo = "fast";
    orders.transition = "counter";
    orders.passing_risk = "high";
  }
  if (matchesAny(prompt, ["保护肋部", "肋部", "half space", "half-space"])) {
    orders.defensive_width = "narrow";
  }
  return orders;
}

function inferPromptIntent(strategyPrompt = "") {
  const prompt = normalizedText(strategyPrompt);
  if (!prompt) return null;
  if (matchesAny(prompt, ["守住", "保住领先", "protect lead", "protect_lead"])) return "protect_lead";
  if (matchesAny(prompt, ["追平", "追分", "chase goal", "chase_goal"])) return "chase_goal";
  if (matchesAny(prompt, ["高位", "逼抢", "high press", "high_press"])) return "high_press";
  if (matchesAny(prompt, ["反击", "counter"])) return "counter";
  if (matchesAny(prompt, ["低位", "密集防守", "low block", "compact"])) return "compact_block";
  if (matchesAny(prompt, ["边路", "右路", "左路", "重载", "wide"])) return "wide_attack";
  return null;
}

function shouldAlignIntent(intent, promptedIntent, strategyPrompt = "") {
  if (!promptedIntent || promptedIntent === intent) return false;
  if (!strategyPrompt) return false;
  return intent === "control_possession";
}

function shouldAlignOrder(field, current, inferred, intent, strategyPrompt = "") {
  if (!inferred || current === inferred) return false;
  const prompt = normalizedText(strategyPrompt);
  const neutral = {
    tempo: ["balanced"],
    pressing_height: ["medium"],
    pressing_intensity: ["medium"],
    defensive_line: ["medium"],
    attacking_width: ["balanced"],
    defensive_width: ["balanced"],
    passing_risk: ["low", "medium"],
    transition: ["hold_shape"],
    focus_channel: ["mixed"]
  }[field] || [];
  if (!neutral.includes(current)) return false;
  if (prompt) return true;
  return ["high_press", "counter", "compact_block", "wide_attack", "chase_goal", "protect_lead"].includes(intent);
}

function normalizeRisk(value, intent) {
  const baseline = {
    high_press: 0.64,
    wide_attack: 0.56,
    compact_block: 0.36,
    counter: 0.52,
    control_possession: 0.5,
    protect_lead: 0.28,
    chase_goal: 0.74
  }[intent] ?? 0.5;
  if (!Number.isFinite(value)) return baseline;
  const clamped = clamp(value, 0, 1);
  if (["high_press", "chase_goal"].includes(intent)) return Math.max(clamped, baseline);
  if (intent === "wide_attack") return Math.max(clamped, 0.48);
  if (intent === "counter") return Math.max(clamped, 0.44);
  if (intent === "compact_block") return Math.min(clamped, 0.46);
  if (intent === "protect_lead") return Math.min(clamped, 0.34);
  return clamped;
}

function normalizedText(value = "") {
  return String(value || "").toLowerCase();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function intentExplanation(intent) {
  return {
    high_press: "提高压迫线，迫使对方后场仓促出球。",
    wide_attack: "扩大进攻宽度，利用边路和肋部制造机会。",
    compact_block: "降低阵型保护禁区，等待反击机会。",
    counter: "断球后快速向身后空间推进。",
    control_possession: "控制节奏，通过安全传递寻找空当。"
  }[intent] || "根据当前比赛状态保持平衡策略。";
}
