import { createDefaultDecision, decisionSummary, interpretDecision, phaseFromMatchState, validateCoachDecision } from "./tactics.js";
import { SUPPORTED_FORMATIONS } from "./teamFactory.js";
import { TICKS_PER_SECOND, redactSensitive } from "./utils.js";

export const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_DECISION_INTERVAL_TICKS = TICKS_PER_SECOND * 15;

/** 大模型教练连续调度器。 */
export class CoachOrchestrator {
  constructor(engine, config, onUpdate = () => {}) {
    this.engine = engine;
    this.config = config;
    this.onUpdate = onUpdate;
    this.state = {
      home: this.createSideState("home"),
      away: this.createSideState("away")
    };
  }

  /** 启动双方赛前决策。 */
  start() {
    this.scheduleIfNeeded("home", "pre_match");
    this.scheduleIfNeeded("away", "pre_match");
    return this.waitForPreMatchDecisions();
  }

  /** 等待赛前模型决策落地，供控制器在开球前锁定初始战术。 */
  async waitForPreMatchDecisions(timeoutMs = REQUEST_TIMEOUT_MS + 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const settled = ["home", "away"].every((side) => {
        const state = this.state[side];
        return state.requestCount > 0 && !state.inFlight && !state.pendingResponse && (state.lastAppliedTick >= 0 || state.status === "timeout" || state.status === "error");
      });
      if (settled) return this.dashboard();
      await delay(25);
    }
    return this.dashboard();
  }

  /** 每个引擎 tick 检查调度状态。 */
  tick() {
    for (const side of ["home", "away"]) {
      const state = this.state[side];
      if (!this.engine.paused && state.pendingResponse) {
        this.applyResolvedDecision(side, state.pendingResponse);
        state.pendingResponse = null;
        this.onUpdate("coach", this.dashboard());
        continue;
      }
      if (state.inFlight && Date.now() - state.requestStartedAt > REQUEST_TIMEOUT_MS) {
        this.timeoutRequest(side);
        continue;
      }
      if (this.engine.pendingEvents[side].length) this.scheduleIfNeeded(side, "event");
      else if (this.engine.state === "half_time" && state.lastHalfTimePeriod !== this.engine.period) this.scheduleIfNeeded(side, "half_time");
      else if (this.shouldRequestPeriodicDecision(side)) this.scheduleIfNeeded(side, "periodic");
    }
  }

  /** 按需发起模型请求。 */
  scheduleIfNeeded(side, trigger = "after_response") {
    const sideState = this.state[side];
    if (this.engine.paused || this.engine.state === "full_time" || sideState.inFlight) return false;
    if (sideState.lastAppliedTick === this.engine.tick && trigger === "after_response") return false;
    sideState.inFlight = true;
    sideState.status = "requesting";
    sideState.requestStartedAt = Date.now();
    sideState.currentTrigger = trigger;
    sideState.requestCount += 1;
    sideState.requestId += 1;
    sideState.lastRequestTick = this.engine.tick;
    sideState.abortController = new AbortController();
    const requestId = sideState.requestId;
    const input = this.createCoachInput(side, trigger);
    sideState.requestEventIds = input.included_event_ids || [];
    sideState.lastInputSummary = input.summary;
    const latency = this.getLocalLatency(side);
    sideState.timeoutTimer = setTimeout(() => {
      if (this.isActiveRequest(side, requestId)) this.timeoutRequest(side);
    }, REQUEST_TIMEOUT_MS);
    setTimeout(() => this.resolveRequest(side, input, requestId), latency);
    this.onUpdate("coach", this.dashboard());
    return true;
  }

  /** 处理模型响应。 */
  async resolveRequest(side, input, requestId) {
    const sideState = this.state[side];
    if (!this.isActiveRequest(side, requestId) || this.engine.state === "full_time") return;
    sideState.status = "validating";
    const startedAt = sideState.requestStartedAt;
    let rawOutput;
    let status = "success";
    let error = null;
    try {
      rawOutput = await this.callCoach(side, input, sideState.abortController.signal);
      if (!this.isActiveRequest(side, requestId)) return;
    } catch (caught) {
      if (!this.isActiveRequest(side, requestId)) return;
      status = "error";
      error = caught.message;
      rawOutput = sideState.lastValidDecision || createDefaultDecision(side, this.engine.tick, this.engine.teams[side].formation);
      sideState.errorCount += 1;
    }
    const validation = validateCoachDecision(rawOutput, {
      teamId: side,
      team: this.engine.teams[side],
      tick: this.engine.tick,
      matchState: this.engine.state,
      currentFormation: this.engine.teams[side].formation,
      lastValidDecision: sideState.lastValidDecision,
      strategyPrompt: input.summary.strategy_prompt,
      fieldContext: input.summary.field_context,
      extraTime: this.engine.period.startsWith("extra")
    });
    if (validation.validation_result === "invalid") sideState.invalidCount += 1;
    if (validation.validation_result === "repaired") sideState.repairedCount += 1;
    const decision = validation.decision || sideState.lastValidDecision || createDefaultDecision(side, this.engine.tick, this.engine.teams[side].formation);
    const tokenStats = estimateTokens(input, rawOutput);
    const response = { input, rawOutput, validation, decision, tokenStats, status, error, startedAt };
    this.clearRequestTimer(side);
    sideState.inFlight = false;
    sideState.abortController = null;
    if (this.engine.paused) {
      sideState.pendingResponse = response;
      sideState.status = "pending";
      this.onUpdate("coach", this.dashboard());
      return;
    }
    this.applyResolvedDecision(side, response);
    this.onUpdate("coach", this.dashboard());
  }

  applyResolvedDecision(side, response) {
    const sideState = this.state[side];
    const { input, rawOutput, validation, decision, tokenStats, status, error, startedAt } = response;
    const tacticalState = interpretDecision(decision, this.engine.teams[side].tactics);
    this.engine.applyTactics(side, tacticalState, decision);
    this.applySubstitutionDecision(side, decision);
    sideState.status = validation.fallback_used || status === "error" ? "error" : "applied";
    sideState.lastValidDecision = decision?.substitution ? { ...decision, substitution: null } : decision;
    sideState.lastDecisionSummary = decisionSummary(decision);
    sideState.lastAppliedTick = this.engine.tick;
    if (response.input?.summary?.trigger === "half_time") sideState.lastHalfTimePeriod = this.engine.period;
    sideState.validDecisionCount += validation.validation_result === "invalid" ? 0 : 1;
    sideState.lastLatencyMs = Date.now() - startedAt;
    sideState.maxLatencyMs = Math.max(sideState.maxLatencyMs, sideState.lastLatencyMs);
    sideState.inputTokens += tokenStats.input_tokens;
    sideState.outputTokens += tokenStats.output_tokens;
    sideState.totalTokens += tokenStats.total_tokens;
    sideState.lastTokens = tokenStats;
    const includedEvents = this.drainIncludedEvents(side, sideState.requestEventIds);
    sideState.requestEventIds = [];
    this.logDecision(side, input, rawOutput, validation, decision, tokenStats, status, error, includedEvents, startedAt);
  }

  /** 记录模型超时。 */
  timeoutRequest(side) {
    const sideState = this.state[side];
    this.clearRequestTimer(side);
    sideState.timeoutCount += 1;
    sideState.abortController?.abort();
    sideState.abortController = null;
    sideState.inFlight = false;
    sideState.status = "timeout";
    this.engine.matchLog.safety_log.push({ tick: this.engine.tick, type: "model_timeout", side, message: `模型请求超过 ${REQUEST_TIMEOUT_MS / 1000} 秒，沿用上一有效战术。` });
    this.onUpdate("coach", this.dashboard());
  }

  /** 返回模型看板。 */
  dashboard() {
    return {
      home: this.sideDashboard("home"),
      away: this.sideDashboard("away")
    };
  }

  /** 创建单侧状态。 */
  createSideState(side) {
    return { side, status: "idle", inFlight: false, requestStartedAt: 0, requestId: 0, abortController: null, timeoutTimer: null, pendingResponse: null, requestCount: 0, validDecisionCount: 0, errorCount: 0, timeoutCount: 0, invalidCount: 0, repairedCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, lastTokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, lastLatencyMs: 0, maxLatencyMs: 0, lastInputSummary: null, lastDecisionSummary: null, lastValidDecision: null, lastAppliedTick: -1, lastRequestTick: -Infinity, lastHalfTimePeriod: null, requestEventIds: [], currentTrigger: "pre_match" };
  }

  /** 创建 CoachInput 摘要。 */
  createCoachInput(side, trigger) {
    const snapshot = this.engine.snapshot();
    const team = snapshot.teams[side];
    const opponentSide = side === "home" ? "away" : "home";
    const opponent = snapshot.teams[opponentSide];
    const coach = side === "home" ? this.config.homeCoach : this.config.awayCoach;
    const includedEvents = this.engine.pendingEvents[side].slice(-6);
    const summary = {
      side,
      trigger,
      score: snapshot.score,
      score_state: scoreState(side, snapshot.score),
      time: snapshot.display_time,
      possession_team: snapshot.possession_team,
      ball: snapshot.ball,
      formation: team.formation,
      strategy_prompt: coach?.free_strategy_prompt || "",
      current_tactic: tacticSummary(team.tactics),
      opponent_tactic: opponent.tactics.intent,
      opponent_tactic_detail: tacticSummary(opponent.tactics),
      field_context: fieldContext(side, snapshot),
      match_stats: { own: statSummary(team.stats), opponent: statSummary(opponent.stats) },
      stamina: Math.round(team.players.reduce((sum, player) => sum + player.stamina, 0) / team.players.length),
      stamina_summary: {
        own: Math.round(team.players.reduce((sum, player) => sum + player.stamina, 0) / team.players.length),
        opponent: Math.round(opponent.players.reduce((sum, player) => sum + player.stamina, 0) / opponent.players.length)
      },
      available_substitutions: availableSubstitutions(this.engine.teams[side], this.engine.period),
      recent_events: includedEvents.map((event) => ({ type: event.event_type, time: event.game_time, description: event.description })),
      pending_events: includedEvents.map((event) => event.event_id),
      output_language: "zh-CN",
      decision_guidance: "避免模板化复制 current_tactic；若 strategy_prompt 为空，基于 field_context、match_stats 和 opponent_tactic_detail 自主判断阵型、风险、节奏、压迫、转换和进攻通道。explanation 必须使用简体中文，不能输出英文说明。若确需保持上一策略，必须在 explanation 说明保持原因。",
      phase: phaseFromMatchState(snapshot.state)
    };
    return { summary, snapshot: redactSensitive(snapshot), included_event_ids: includedEvents.map((event) => event.event_id) };
  }

  /** 调用真实或本地规则教练。有 endpoint 即调用真实模型，无 endpoint 才走规则教练。 */
  async callCoach(side, input, signal) {
    const coach = side === "home" ? this.config.homeCoach : this.config.awayCoach;
    if (!coach || !coach.endpoint) return createDefaultDecision(side, this.engine.tick, this.engine.teams[side].formation, this.state[side].requestCount);
    const apiKey = resolveApiKey(coach);
    if (!apiKey) throw new Error("缺少模型 API Key");
    const endpoint = resolveChatEndpoint(coach);
    const response = await fetch(endpoint, { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(createCoachRequestBody(coach, input)) });
    if (!response.ok) throw new Error(`模型接口返回 ${response.status}`);
    const payload = await response.json();
    return extractCoachDecision(payload);
  }

  /** 记录模型决策日志。 */
  logDecision(side, input, rawOutput, validation, appliedDecision, tokenStats, status, error, includedEvents, startedAt) {
    const sideState = this.state[side];
    const decision = validation.decision || appliedDecision;
    const record = {
      decision_id: decision?.decision_id || `${side}_${this.engine.tick}`,
      team_id: side,
      coach_id: `${side}_coach`,
      provider: (side === "home" ? this.config.homeCoach : this.config.awayCoach)?.provider || "local",
      model: (side === "home" ? this.config.homeCoach : this.config.awayCoach)?.model || "rules-coach",
      request_start_tick: sideState.lastAppliedTick,
      request_start_game_time: this.engine.gameTime,
      request_end_tick: this.engine.tick,
      latency_ms: Date.now() - startedAt,
      request_status: validation.validation_result === "invalid" ? "invalid" : status,
      request_timeout_sec: REQUEST_TIMEOUT_MS / 1000,
      coach_input_hash: `${side}_${this.engine.tick}_${sideState.requestCount}`,
      coach_input_summary: input.summary,
      coach_input_payload_ref: null,
      raw_model_output_ref: `raw_outputs/${decision?.decision_id || side}.txt`,
      raw_model_output: rawOutput,
      parsed_decision_json: decisionSummary(decision),
      validation_result: validation.validation_result,
      validation_errors: validation.validation_errors,
      repair_actions: validation.repair_actions,
      applied: !validation.fallback_used,
      applied_tick: this.engine.tick,
      applied_tactical_state: this.engine.teams[side].tactics,
      fallback_used: validation.fallback_used || status === "error",
      pending_events_included: includedEvents.map((event) => event.event_id),
      input_tokens: tokenStats.input_tokens,
      output_tokens: tokenStats.output_tokens,
      total_tokens: tokenStats.total_tokens,
      error
    };
    this.engine.matchLog.model_decision_log.push(redactSensitive(record));
  }

  shouldRequestPeriodicDecision(side) {
    const state = this.state[side];
    const interval = Number(this.config.match?.decisionIntervalTicks || DEFAULT_DECISION_INTERVAL_TICKS);
    return this.engine.tick - state.lastRequestTick >= interval && ["kickoff", "in_play"].includes(this.engine.state);
  }

  applySubstitutionDecision(side, decision) {
    const substitution = decision?.substitution;
    if (!substitution) return;
    const context = this.engine.state === "half_time" || this.engine.state === "extra_time_break" ? this.engine.state : "in_play";
    const result = this.engine.attemptSubstitution(side, substitution.out_player_id, substitution.in_player_id, context);
    if (!result.ok) {
      this.engine.matchLog.safety_log.push({ tick: this.engine.tick, type: "substitution_rejected", side, message: result.reason });
    }
  }

  drainIncludedEvents(side, eventIds = []) {
    if (!eventIds.length) return [];
    const ids = new Set(eventIds);
    const included = [];
    this.engine.pendingEvents[side] = this.engine.pendingEvents[side].filter((event) => {
      if (!ids.has(event.event_id)) return true;
      included.push(event);
      return false;
    });
    return included;
  }

  isActiveRequest(side, requestId) {
    const state = this.state[side];
    return state.inFlight && state.requestId === requestId;
  }

  clearRequestTimer(side) {
    const state = this.state[side];
    if (!state.timeoutTimer) return;
    clearTimeout(state.timeoutTimer);
    state.timeoutTimer = null;
  }

  sideDashboard(side) {
    const state = this.state[side];
    return {
      status: state.status,
      in_flight: state.inFlight,
      elapsed_ms: state.inFlight ? Date.now() - state.requestStartedAt : 0,
      request_started_at: state.inFlight && state.requestStartedAt ? new Date(state.requestStartedAt).toISOString() : null,
      request_timeout_sec: REQUEST_TIMEOUT_MS / 1000,
      request_count: state.requestCount,
      valid_decision_count: state.validDecisionCount,
      error_count: state.errorCount,
      timeout_count: state.timeoutCount,
      invalid_count: state.invalidCount,
      repaired_count: state.repairedCount,
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      total_tokens: state.totalTokens,
      last_tokens: state.lastTokens,
      last_latency_ms: state.lastLatencyMs,
      max_latency_ms: state.maxLatencyMs,
      last_input_summary: state.lastInputSummary,
      last_decision_summary: state.lastDecisionSummary,
      pending_events: this.engine.pendingEvents[side].map((event) => event.event_type),
      fallback_status: state.status === "pending" ? "暂停待应用" : state.status === "timeout" || state.status === "error" ? "沿用上一有效战术" : "正常"
    };
  }

  getLocalLatency(side) {
    return side === "home" ? 180 : 240;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造模型请求体。 */
export function createCoachRequestBody(coach, input) {
  if (usesChatCompletions(coach)) {
    const body = {
      model: coach.model,
      messages: coachMessages(coach, input)
    };
    if (supportsJsonObjectResponse(coach)) body.response_format = { type: "json_object" };
    return body;
  }
  return { model: coach.model, input: input.summary };
}

/** 提取模型决策内容。 */
export function extractCoachDecision(payload) {
  if (payload?.decision) return payload.decision;
  return payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || payload;
}

/** 判断是否使用 Chat Completions 协议。 */
function coachMessages(coach, input) {
  return [
    { role: "system", content: "你是 11v11 足球比赛的战术教练。只返回合法 CoachDecision JSON，不要 Markdown 或解释性包裹。根据 field_context、match_stats、current_tactic、opponent_tactic_detail 和可用阵型自主决策；strategy_prompt 为空时不要臆造预设战术。若保持不变，必须在 explanation 说明保持原因。" },
    {
      role: "user",
      content: JSON.stringify({
        output_language: "zh-CN",
        instruction: "CoachDecision.explanation 必须使用简体中文。必须输出 formation.base、完整 team_orders；formation.base 必须来自 allowed_formations；team_orders 字段名必须是 snake_case，取值必须来自 allowed_team_orders。不要只在 explanation 中描述战术。",
        strategy_prompt: String(coach.free_strategy_prompt || "").trim(),
        allowed_formations: SUPPORTED_FORMATIONS,
        allowed_team_orders: {
          tempo: ["slow", "balanced", "fast"],
          pressing_height: ["low", "medium", "high"],
          pressing_intensity: ["low", "medium", "high"],
          defensive_line: ["low", "medium", "medium_high", "high"],
          attacking_width: ["narrow", "balanced", "wide"],
          defensive_width: ["narrow", "balanced", "wide"],
          passing_risk: ["low", "medium", "high"],
          transition: ["hold_shape", "counter", "counter_press"],
          focus_channel: ["left", "left_half_space", "center", "right_half_space", "right", "mixed"]
        },
        coach_input: input.summary
      })
    }
  ];
}

export function usesChatCompletions(coach = {}) {
  return ["deepseek", "openai", "glm", "mimo"].includes(String(coach.provider || "").toLowerCase()) || /chat\/completions/i.test(resolveChatEndpoint(coach));
}

/** 判断模型接口是否支持强制 JSON 响应。 */
export function supportsJsonObjectResponse(coach = {}) {
  return ["deepseek", "openai"].includes(String(coach.provider || "").toLowerCase()) || /(?:deepseek|openai)\.com\/.*chat\/completions/i.test(coach.endpoint || "");
}

/** 从本地配置或环境变量引用解析密钥。 */
export function resolveApiKey(coach) {
  if (coach.api_key) return coach.api_key;
  if (coach.api_key_once) return coach.api_key_once;
  if (coach.api_key_ref?.startsWith("env:")) return process.env[coach.api_key_ref.slice(4)] || "";
  return "";
}

/** 解析模型 chat completions 端点，未带路径时自动补全，避免 provider 误填导致请求打错地址。 */
export function resolveChatEndpoint(coach = {}) {
  const endpoint = String(coach.endpoint || "").trim();
  if (!endpoint) return "";
  if (/chat\/completions/i.test(endpoint)) return endpoint.replace(/\/+$/, "");
  return `${endpoint.replace(/\/+$/, "")}/chat/completions`;
}

/** 返回策略摘要，避免把行为权重噪声传给模型。 */
function tacticSummary(tactics = {}) {
  return {
    intent: tactics.intent,
    riskLevel: tactics.riskLevel,
    tempo: tactics.tempo,
    pressingHeight: tactics.pressingHeight,
    pressingIntensity: tactics.pressingIntensity,
    defensiveLine: tactics.defensiveLine,
    attackingWidth: tactics.attackingWidth,
    defensiveWidth: tactics.defensiveWidth,
    passingRisk: tactics.passingRisk,
    transition: tactics.transition,
    focusChannel: tactics.focusChannel
  };
}

/** 返回本队视角的球场局势。 */
function fieldContext(side, snapshot) {
  const ball = snapshot.ball || { x: 50, y: 50 };
  const attackingDepth = side === "home" ? ball.x : 100 - ball.x;
  return {
    in_possession: snapshot.possession_team === side,
    attacking_depth: Math.round(attackingDepth),
    ball_zone: attackingDepth >= 70 ? "final_third" : attackingDepth >= 45 ? "middle_third" : "defensive_third",
    ball_lane: ball.y < 33 ? "right" : ball.y > 67 ? "left" : "center",
    holder_team: ball.holderTeam || snapshot.possession_team,
    holder_id: ball.holderId || null
  };
}

/** 返回模型需要比较的核心比赛数据。 */
function statSummary(stats = {}) {
  return {
    shots: stats.shots || 0,
    shotsOnTarget: stats.shotsOnTarget || 0,
    xG: Number((stats.xG || 0).toFixed(3)),
    passes: stats.passes || 0,
    completedPasses: stats.completedPasses || 0,
    tackles: stats.tackles || 0,
    fouls: stats.fouls || 0,
    boxEntries: stats.boxEntries || 0
  };
}

/** Return the substitution budget visible to a coach decision. */
function availableSubstitutions(team, period) {
  const limit = String(period || "").startsWith("extra") ? 6 : 5;
  const windowLimit = String(period || "").startsWith("extra") ? 4 : 3;
  const bench = team.players
    .filter((player) => !player.onField && !player.sentOff && !team.substitutions.usedPlayers.some((substitution) => substitution.out === player.id))
    .map((player) => ({ player_id: player.id, position: player.position, stamina: player.stamina }));
  return {
    remaining_slots: Math.max(0, limit - team.substitutions.used),
    remaining_windows: Math.max(0, windowLimit - team.substitutions.windowsUsed),
    bench
  };
}

/** 返回比分态势。 */
function scoreState(side, score = {}) {
  const diff = side === "home" ? (score.home || 0) - (score.away || 0) : (score.away || 0) - (score.home || 0);
  return diff > 0 ? "leading" : diff < 0 ? "trailing" : "level";
}

/** 估算 token。 */
function estimateTokens(input, output) {
  const inputTokens = Math.ceil(JSON.stringify(input.summary).length / 4);
  const outputTokens = Math.ceil(JSON.stringify(output).length / 4);
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}
