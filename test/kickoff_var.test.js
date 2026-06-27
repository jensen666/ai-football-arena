import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { createRng } from "../src/utils.js";

function setup(seed = "kickoff-var-test") {
  const config = {
    homeCoach: { provider: "local", model: "rules-coach" },
    awayCoach: { provider: "local", model: "rules-coach" },
    match: { seed, knockout: false, homeFormation: "4-3-3", awayFormation: "4-2-3-1" }
  };
  const engine = new MatchEngine(config, createRng(seed));
  engine.start();
  return engine;
}

/** 让主队前锋在禁区射门并强制进球。 */
function forceGoal(engine, rngValues) {
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 88;
  shooter.y = 50;
  shooter.stamina = 80;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  engine.rng = { seed: "forced-goal", next: () => rngValues.shift() ?? 1 };
  engine.simulateShot();
}

test("VAR 复核进球维持原判后由中圈开球重启，而非任意球", () => {
  const engine = setup();
  // 射正 -> 扑救失败 -> 进球 -> 触发 VAR
  forceGoal(engine, [0.1, 0.95, 0.1]);
  assert.equal(engine.teams.home.score, 1);
  assert.equal(engine.state, "var_check");
  engine.completeVarCheck("维持原判");
  assert.equal(engine.state, "goal_scored");
  // goal_scored 超时后进入 kickoff
  engine.stateTicks = 200;
  engine.handleTimedStates();
  assert.equal(engine.state, "kickoff");
  // 进球后失球方（客队）开球，球回中圈
  assert.equal(engine.possessionTeam, "away");
  assert.equal(engine.ball.x, 50);
  assert.equal(engine.ball.y, 50);
  assert.equal(engine.ball.holderTeam, "away");
});

test("进球后球权交给失球方并回到中圈", () => {
  const engine = setup();
  forceGoal(engine, [0.1, 0.95, 0.9]);
  assert.equal(engine.teams.home.score, 1);
  assert.equal(engine.state, "goal_scored");
  engine.stateTicks = 200;
  engine.handleTimedStates();
  assert.equal(engine.state, "kickoff");
  assert.equal(engine.possessionTeam, "away");
  assert.equal(engine.ball.x, 50);
  assert.equal(engine.ball.y, 50);
});

test("中圈开球后球员归位到各自阵型位置", () => {
  const engine = setup();
  // 把球员打散
  const homePlayers = engine.teams.home.players.filter((player) => player.onField);
  homePlayers.forEach((player) => { player.x = 80; player.y = 80; });
  engine.enterKickoff("home");
  const allReset = homePlayers.every((player) => Math.abs(player.x - player.baseTargetX) < 0.01 && Math.abs(player.y - player.baseTargetY) < 0.01);
  assert.ok(allReset, "开球后场上球员应归位到阵型目标");
});

test("中场休息后由另一支球队开球", () => {
  const engine = setup();
  engine.period = "first_half";
  engine.changeState("half_time");
  engine.stateTicks = 200;
  engine.handleTimedStates();
  assert.equal(engine.period, "second_half");
  assert.equal(engine.state, "kickoff");
  // 上半场 home 开球，下半场应 away 开球
  assert.equal(engine.possessionTeam, "away");
  assert.equal(engine.ball.x, 50);
});

test("setupKickoff 把球放回中圈并交给指定开球方", () => {
  const engine = setup();
  engine.ball = { x: 90, y: 10, vx: 5, vy: 5, holderTeam: "home", holderId: 9 };
  engine.setupKickoff("away");
  assert.equal(engine.ball.x, 50);
  assert.equal(engine.ball.y, 50);
  assert.equal(engine.ball.holderTeam, "away");
  assert.equal(engine.possessionTeam, "away");
  assert.equal(engine.ball.holderId !== 9 || engine.ball.holderTeam === "away", true);
});

test("VAR 复核类型区分进球有效性与关键判罚", () => {
  const engine = setup();
  engine.changeState("in_play");
  engine.triggerVarCheck("关键判罚复核。", { reviewType: "goal_validity" });
  assert.equal(engine.varReviewType, "goal_validity");
  engine.completeVarCheck("维持原判");
  assert.equal(engine.state, "goal_scored");
  assert.equal(engine.varReviewType, null);

  // 关键判罚 VAR 维持原判后回任意球
  engine.changeState("in_play");
  engine.triggerVarCheck("关键判罚复核。");
  engine.completeVarCheck("维持原判");
  assert.equal(engine.state, "free_kick");
});

test("VAR 改判无效当前未实现，显式标注 implemented 并按维持原判流转", () => {
  const engine = setup();
  engine.changeState("in_play");
  engine.triggerVarCheck("进球有效性复核。", { reviewType: "goal_validity" });
  engine.completeVarCheck("改判无效");
  // 防御性标注：改判未实现，仍按维持原判流转到 goal_scored，不静默出错
  assert.equal(engine.state, "goal_scored");
  const varResult = [...engine.matchLog.match_event_log].reverse().find((event) => event.event_type === "var_result");
  assert.equal(varResult.implemented, false);
  assert.equal(varResult.final_decision, "改判无效");
  assert.match(varResult.description, /未实现改判/);
});

test("进球后 concedingTeam 在中圈开球时被清空，不泄漏到下一次开球", () => {
  const engine = setup();
  forceGoal(engine, [0.1, 0.95, 0.9]);
  assert.equal(engine.concedingTeam, "away");
  engine.stateTicks = 200;
  engine.handleTimedStates();
  assert.equal(engine.state, "kickoff");
  assert.equal(engine.concedingTeam, null);
});

test("setupKickoff 找不到开球手时 holderId 兜底为 null，不沿用旧持球人", () => {
  const engine = setup();
  engine.ball = { x: 90, y: 10, vx: 5, vy: 5, holderTeam: "home", holderId: 9 };
  // 极端情况：开球方场上无人可开球，触发 holderId 兜底
  for (const player of engine.teams.away.players) {
    player.onField = false;
  }
  engine.setupKickoff("away");
  assert.equal(engine.ball.holderTeam, "away");
  assert.equal(engine.ball.holderId, null);
});
