import test from "node:test";
import assert from "node:assert/strict";
import { CoachOrchestrator, REQUEST_TIMEOUT_MS, createCoachRequestBody, extractCoachDecision } from "../src/coachOrchestrator.js";
import { MatchEngine } from "../src/matchEngine.js";
import { behaviorWeights, createDefaultDecision, decisionSummary, interpretDecision, validateCoachDecision } from "../src/tactics.js";
import { createRng } from "../src/utils.js";

function setup() {
  const config = { homeCoach: { provider: "local", model: "rules-coach" }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed: "tactics", homeFormation: "4-3-3", awayFormation: "4-2-3-1" } };
  const engine = new MatchEngine(config, createRng("tactics"));
  engine.start();
  return { config, engine };
}

test("合法 CoachDecision 能通过校验并解释为战术状态", () => {
  const { engine } = setup();
  const raw = createDefaultDecision("home", 1, "4-3-3");
  const result = validateCoachDecision(raw, { teamId: "home", team: engine.teams.home, tick: 1, matchState: "in_play", currentFormation: "4-3-3" });
  assert.equal(result.validation_result, "valid");
  const tactics = interpretDecision(result.decision, engine.teams.home.tactics);
  assert.equal(tactics.intent, raw.intent);
});

test("非法字段会被修复或拒绝，越权字段不会进入结果", () => {
  const { engine } = setup();
  const raw = "说明文字 {\"phase\":\"open_play\",\"intent\":\"high_press\",\"risk_level\":2,\"formation\":{\"base\":\"9-9-9\"},\"team_orders\":{},\"player_orders\":[{\"player_id\":999}],\"score\":{\"home\":99},\"explanation\":\"x\"}";
  const result = validateCoachDecision(raw, { teamId: "home", team: engine.teams.home, tick: 2, matchState: "in_play", currentFormation: "4-3-3" });
  assert.equal(result.validation_result, "repaired");
  assert.equal(result.decision.risk_level, 1);
  assert.equal(result.decision.formation.base, "4-3-3");
  assert.equal(result.decision.player_orders.length, 0);
  assert.equal(Object.hasOwn(result.decision, "score"), false);
});

test("字符串 formation 会被规范化为阵型对象", () => {
  const { engine } = setup();
  const raw = { ...createDefaultDecision("away", 3, "4-2-3-1"), formation: "4-2-3-1" };
  const result = validateCoachDecision(raw, { teamId: "away", team: engine.teams.away, tick: 3, matchState: "kickoff", currentFormation: "4-2-3-1" });
  assert.equal(result.validation_result, "repaired");
  assert.equal(result.decision.formation.base, "4-2-3-1");
  assert.equal(result.decision.formation.in_possession, "4-3-3");
  assert.equal(result.decision.formation.out_of_possession, "4-4-2");
});

test("模型换人决策会拒绝门将与非门将直接互换", () => {
  const { engine } = setup();
  const raw = { ...createDefaultDecision("home", 4, "4-3-3"), substitution: { out_player_id: 7, in_player_id: 12, reason: "fresh legs" } };
  const result = validateCoachDecision(raw, { teamId: "home", team: engine.teams.home, tick: 4, matchState: "in_play", currentFormation: "4-3-3" });
  assert.equal(result.validation_result, "repaired");
  assert.equal(result.decision.substitution, null);
  assert.ok(result.repair_actions.includes("substitution_rejected"));
});

test("模型换人决策会拒绝被换下球员再次上场", () => {
  const { engine } = setup();
  engine.changeState("in_play");
  assert.equal(engine.attemptSubstitution("home", 7, 18, "in_play").ok, true);
  const raw = { ...createDefaultDecision("home", 5, "4-3-3"), substitution: { out_player_id: 18, in_player_id: 7, reason: "return" } };
  const result = validateCoachDecision(raw, { teamId: "home", team: engine.teams.home, tick: 5, matchState: "in_play", currentFormation: "4-3-3" });
  assert.equal(result.validation_result, "repaired");
  assert.equal(result.decision.substitution, null);
  assert.ok(result.repair_actions.includes("substitution_rejected"));
});

test("单队同一时间最多 1 个在途请求，超时后沿用上一有效战术", () => {
  const { config, engine } = setup();
  const orchestrator = new CoachOrchestrator(engine, config);
  assert.equal(orchestrator.scheduleIfNeeded("home", "pre_match"), true);
  assert.equal(orchestrator.scheduleIfNeeded("home", "event"), false);
  orchestrator.state.home.requestStartedAt = Date.now() - (REQUEST_TIMEOUT_MS + 1000);
  orchestrator.tick();
  assert.equal(orchestrator.state.home.status, "timeout");
  assert.equal(orchestrator.state.home.inFlight, false);
});

test("超时后的迟到模型响应不会应用战术", async () => {
  const { config, engine } = setup();
  class SlowOrchestrator extends CoachOrchestrator {
    getLocalLatency() { return 0; }
    async callCoach(side) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return createDefaultDecision(side, this.engine.tick, this.engine.teams[side].formation, 1);
    }
  }
  const orchestrator = new SlowOrchestrator(engine, config);
  assert.equal(orchestrator.scheduleIfNeeded("home", "pre_match"), true);
  orchestrator.state.home.requestStartedAt = Date.now() - (REQUEST_TIMEOUT_MS + 1000);
  orchestrator.tick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(orchestrator.state.home.status, "timeout");
  assert.equal(orchestrator.state.home.lastAppliedTick, -1);
  assert.equal(engine.matchLog.match_event_log.some((event) => event.event_type === "tactic_applied" && event.team_id === "home"), false);
});

test("暂停期间模型响应只暂存，恢复后再应用战术", async () => {
  const { config, engine } = setup();
  class PausedOrchestrator extends CoachOrchestrator {
    getLocalLatency() { return 0; }
    async callCoach(side) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return createDefaultDecision(side, this.engine.tick, this.engine.teams[side].formation, 1);
    }
  }
  const orchestrator = new PausedOrchestrator(engine, config);
  assert.equal(orchestrator.scheduleIfNeeded("home", "pre_match"), true);
  engine.pause();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(orchestrator.state.home.status, "pending");
  assert.ok(orchestrator.state.home.pendingResponse);
  assert.equal(engine.matchLog.match_event_log.some((event) => event.event_type === "tactic_applied" && event.team_id === "home"), false);
  engine.resume();
  orchestrator.tick();
  assert.equal(orchestrator.state.home.pendingResponse, null);
  assert.equal(orchestrator.state.home.status, "applied");
  assert.equal(engine.matchLog.match_event_log.some((event) => event.event_type === "tactic_applied" && event.team_id === "home"), true);
});

test("合法模型换人决策会进入比赛执行器", () => {
  const { config, engine } = setup();
  engine.changeState("in_play");
  const orchestrator = new CoachOrchestrator(engine, config);
  const decision = { ...createDefaultDecision("home", engine.tick, "4-3-3"), substitution: { out_player_id: 7, in_player_id: 18, reason: "fresh legs" } };
  orchestrator.applyResolvedDecision("home", {
    input: { summary: { side: "home", trigger: "event" }, included_event_ids: [] },
    rawOutput: decision,
    validation: { decision, validation_result: "valid", validation_errors: [], repair_actions: [], fallback_used: false },
    decision,
    tokenStats: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    status: "success",
    error: null,
    startedAt: Date.now()
  });
  assert.equal(engine.teams.home.players.find((player) => player.id === 7).onField, false);
  assert.equal(engine.teams.home.players.find((player) => player.id === 18).onField, true);
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "substitution"));
});

test("周期模型决策按配置间隔节流", () => {
  const { config, engine } = setup();
  config.match.decisionIntervalTicks = 90;
  engine.changeState("in_play");
  const orchestrator = new CoachOrchestrator(engine, config);
  orchestrator.state.home.lastRequestTick = 100;
  engine.tick = 189;
  assert.equal(orchestrator.shouldRequestPeriodicDecision("home"), false);
  engine.tick = 190;
  assert.equal(orchestrator.shouldRequestPeriodicDecision("home"), true);
});

test("在途请求之后产生的 pending event 不会被旧请求清空", () => {
  const { config, engine } = setup();
  const orchestrator = new CoachOrchestrator(engine, config);
  engine.pendingEvents.home = [];
  const first = engine.logEvent("goal", "home", 10, "first", {});
  const second = engine.logEvent("red_card", "away", 6, "second", {});
  const included = orchestrator.drainIncludedEvents("home", [first.event_id]);
  assert.deepEqual(included.map((event) => event.event_id), [first.event_id]);
  assert.deepEqual(engine.pendingEvents.home.map((event) => event.event_id), [second.event_id]);
});

test("首次模型输出无效时使用默认决策记录日志", () => {
  const { config, engine } = setup();
  const orchestrator = new CoachOrchestrator(engine, config);
  const decision = createDefaultDecision("home", engine.tick, engine.teams.home.formation);
  orchestrator.applyResolvedDecision("home", {
    input: { summary: { side: "home" } },
    rawOutput: "not json",
    validation: { decision: null, validation_result: "invalid", validation_errors: ["invalid_json"], repair_actions: [], fallback_used: true },
    decision,
    tokenStats: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    status: "success",
    error: null,
    startedAt: Date.now()
  });
  const record = engine.matchLog.model_decision_log.at(-1);
  assert.equal(record.decision_id, decision.decision_id);
  assert.equal(record.request_status, "invalid");
  assert.equal(record.fallback_used, true);
});

test("DeepSeek ?????? Chat Completions ?????????", () => {
  const input = { summary: { side: "home", score: { home: 0, away: 0 }, phase: "open_play" } };
  const body = createCoachRequestBody({ provider: "deepseek", model: "deepseek-v4-flash", endpoint: "https://api.deepseek.com/chat/completions", free_strategy_prompt: "" }, input);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(Array.isArray(body.messages), true);
  assert.equal(body.messages.at(-1).role, "user");
  assert.ok(body.messages.at(0).content.includes("strategy_prompt"));
  assert.ok(body.messages.at(-1).content.includes("zh-CN"));
  const payload = JSON.parse(body.messages.at(-1).content);
  assert.equal(payload.strategy_prompt, "");
  assert.ok(payload.allowed_formations.includes("4-3-3"));
  assert.ok(payload.instruction.includes("formation.base"));
  assert.deepEqual(payload.coach_input, input.summary);
  assert.deepEqual(body.response_format, { type: "json_object" });
  const decision = createDefaultDecision("home", 1, "4-3-3");
  assert.equal(extractCoachDecision({ choices: [{ message: { content: JSON.stringify(decision) } }] }), JSON.stringify(decision));
});

test("英文模型解释进入看板前会生成中文战术摘要", () => {
  const decision = createDefaultDecision("away", 12, "4-2-3-1");
  decision.intent = "counter";
  decision.risk_level = 0.42;
  decision.team_orders = {
    tempo: "fast",
    pressing_height: "low",
    pressing_intensity: "medium",
    defensive_line: "low",
    attacking_width: "balanced",
    defensive_width: "narrow",
    passing_risk: "high",
    transition: "counter",
    focus_channel: "right"
  };
  decision.explanation = "Adjusted tactic from control possession to counter attack because field context demands rapid transitions.";
  const summary = decisionSummary(decision);
  assert.match(summary.explanation, /调整为快速反击/);
  assert.match(summary.explanation, /进攻方向右路/);
  assert.equal(summary.explanation.includes("Adjusted tactic"), false);
});

test("模型输入包含局势上下文以减少同质化决策", () => {
  const { config, engine } = setup();
  config.homeCoach.free_strategy_prompt = "高位逼抢，右路重载";
  engine.changeState("in_play");
  const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 78;
  holder.y = 28;
  engine.possessionTeam = "home";
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  const orchestrator = new CoachOrchestrator(engine, config);
  const input = orchestrator.createCoachInput("home", "after_response");
  assert.equal(input.summary.strategy_prompt, "高位逼抢，右路重载");
  assert.equal(input.summary.current_tactic.intent, "control_possession");
  assert.equal(input.summary.field_context.in_possession, true);
  assert.equal(input.summary.field_context.ball_zone, "final_third");
  assert.equal(input.summary.match_stats.own.shots, 0);
  assert.ok(input.summary.decision_guidance.includes("避免模板化"));
});

test("四类战术会改变行为权重", () => {
  const highPress = interpretDecision(createDefaultDecision("home", 1, "4-3-3", 0));
  const wide = interpretDecision(createDefaultDecision("home", 2, "4-3-3", 1));
  const block = interpretDecision(createDefaultDecision("away", 3, "5-3-2", 0));
  const counter = interpretDecision(createDefaultDecision("away", 4, "5-3-2", 1));
  assert.ok(highPress.behavior.pressBonus > 0);
  assert.ok(wide.behavior.wideBias > 0);
  assert.ok(block.behavior.blockBias > 0);
  assert.ok(counter.behavior.counterBias > 0);
});

test("低风险模型战术不会把射门阈值抬到无射门区间", () => {
  const behavior = behaviorWeights({ risk_level: 0, intent: "control_possession" });
  assert.equal(behavior.shotThreshold, 0.1);
});
