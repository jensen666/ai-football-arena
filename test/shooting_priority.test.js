import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { behaviorWeights } from "../src/tactics.js";
import { createRng } from "../src/utils.js";

function setup() {
  const config = {
    homeCoach: { provider: "local", model: "rules-coach" },
    awayCoach: { provider: "local", model: "rules-coach" },
    match: { seed: "shooting-priority", knockout: false, homeFormation: "4-3-3", awayFormation: "4-2-3-1" }
  };
  const engine = new MatchEngine(config, createRng("shooting-priority"));
  engine.start();
  engine.changeState("in_play");
  return engine;
}

test("central box chance shoots before the pass window even with low-risk tactics", () => {
  const engine = setup();
  engine.tick = 23640;
  engine.lastShotTick = 0;
  engine.possessionTeam = "home";
  engine.teams.home.tactics = {
    ...engine.teams.home.tactics,
    intent: "control_possession",
    riskLevel: 0,
    passingRisk: "low",
    behavior: behaviorWeights({ risk_level: 0, intent: "control_possession" })
  };
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 84.6;
  shooter.y = 48.4;
  shooter.stamina = 80;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  const nearestDefender = engine.teams.away.players.find((player) => player.position === "CB" && player.onField);
  nearestDefender.x = 78;
  nearestDefender.y = 42;
  const chance = engine.estimateShootingChance();
  assert.ok(chance.xG >= chance.threshold, `shot should clear tactic threshold: ${chance.xG} < ${chance.threshold}`);
  assert.equal(engine.hasImmediateShootingChance(), true);
  const values = [1, 1, 1];
  engine.rng = { seed: "central-box-shot-before-pass", next: () => values.shift() ?? 1 };
  engine.simulateOpenPlay();
  assert.equal(engine.teams.home.stats.shots, 1);
  assert.equal(engine.teams.home.stats.passes, 0);
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "shot"));
});
