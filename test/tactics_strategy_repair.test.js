import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { validateCoachDecision } from "../src/tactics.js";
import { createRng } from "../src/utils.js";

function setup() {
  const config = {
    homeCoach: { provider: "local", model: "rules-coach" },
    awayCoach: { provider: "local", model: "rules-coach" },
    match: { seed: "strategy-repair", homeFormation: "4-3-3", awayFormation: "4-2-3-1" }
  };
  const engine = new MatchEngine(config, createRng("strategy-repair"));
  engine.start();
  return { engine };
}

test("strategy prompt repairs high press orders into executable controls", () => {
  const { engine } = setup();
  const raw = {
    phase: "open_play",
    intent: "high_press",
    risk_level: 0,
    formation: { base: "4-3-3" },
    team_orders: {
      tempo: "balanced",
      pressing_height: "medium",
      pressing_intensity: "medium",
      defensive_line: "medium",
      attacking_width: "balanced",
      defensive_width: "balanced",
      passing_risk: "low",
      transition: "hold_shape",
      focus_channel: "mixed"
    },
    player_orders: [],
    explanation: "high press, right overload, counter press"
  };
  const result = validateCoachDecision(raw, {
    teamId: "home",
    team: engine.teams.home,
    tick: 2,
    matchState: "in_play",
    currentFormation: "4-3-3",
    strategyPrompt: "高位逼抢，右路重载，快速反抢"
  });
  assert.equal(result.validation_result, "repaired");
  assert.equal(result.decision.intent, "high_press");
  assert.ok(result.decision.risk_level >= 0.64);
  assert.equal(result.decision.team_orders.tempo, "fast");
  assert.equal(result.decision.team_orders.pressing_height, "high");
  assert.equal(result.decision.team_orders.pressing_intensity, "high");
  assert.equal(result.decision.team_orders.transition, "counter_press");
  assert.equal(result.decision.team_orders.attacking_width, "wide");
  assert.equal(result.decision.team_orders.focus_channel, "right_half_space");
});

test("strategy prompt repairs low-block counter away from neutral possession", () => {
  const { engine } = setup();
  const raw = {
    phase: "open_play",
    intent: "control_possession",
    risk_level: 0,
    formation: { base: "4-2-3-1" },
    team_orders: {},
    player_orders: [],
    explanation: "low block, counter first, protect half spaces"
  };
  const result = validateCoachDecision(raw, {
    teamId: "away",
    team: engine.teams.away,
    tick: 3,
    matchState: "in_play",
    currentFormation: "4-2-3-1",
    strategyPrompt: "低位防守，反击优先，保护肋部"
  });
  assert.equal(result.validation_result, "repaired");
  assert.equal(result.decision.intent, "counter");
  assert.ok(result.decision.risk_level >= 0.44);
  assert.equal(result.decision.team_orders.tempo, "fast");
  assert.equal(result.decision.team_orders.pressing_height, "low");
  assert.equal(result.decision.team_orders.defensive_line, "low");
  assert.equal(result.decision.team_orders.defensive_width, "narrow");
  assert.equal(result.decision.team_orders.transition, "counter");
  assert.equal(result.decision.team_orders.passing_risk, "high");
});
