import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { createRng } from "../src/utils.js";

function engine() {
  const instance = new MatchEngine({ homeCoach: { provider: "local" }, awayCoach: { provider: "local" }, match: { seed: "rules", knockout: true, homeFormation: "4-3-3", awayFormation: "4-2-3-1" } }, createRng("rules"));
  instance.start();
  instance.changeState("in_play");
  return instance;
}

test("越位按传球瞬间快照判定", () => {
  const match = engine();
  match.ball.x = 60;
  match.teams.home.players.find((player) => player.id === 9).x = 90;
  match.teams.away.players.find((player) => player.id === 4).x = 82;
  match.teams.away.players.find((player) => player.id === 5).x = 80;
  const snapshot = match.evaluateOffsideAtPass("home", 10, 9);
  assert.equal(snapshot.offsidePosition, true);
  match.teams.home.players.find((player) => player.id === 9).x = 70;
  const result = match.confirmOffsideIfInvolved();
  assert.equal(result.offside, true);
  assert.equal(match.state, "free_kick");
});

test("换人遵守 5 个名额和 3 个窗口，中场不计窗口", () => {
  const match = engine();
  assert.equal(match.attemptSubstitution("home", 2, 13).ok, true);
  assert.equal(match.attemptSubstitution("home", 3, 14).ok, true);
  match.tick += 10;
  assert.equal(match.attemptSubstitution("home", 4, 15).ok, true);
  match.tick += 10;
  assert.equal(match.attemptSubstitution("home", 5, 16).ok, true);
  assert.equal(match.teams.home.substitutions.windowsUsed, 3);
  assert.equal(match.attemptSubstitution("home", 6, 17, "half_time").ok, true);
  assert.equal(match.teams.home.substitutions.used, 5);
  assert.equal(match.attemptSubstitution("home", 7, 18).ok, false);
});

test("被换下球员不能再次上场", () => {
  const match = engine();
  assert.equal(match.attemptSubstitution("home", 7, 18).ok, true);
  match.tick += 10;
  const result = match.attemptSubstitution("home", 18, 7);
  assert.equal(result.ok, false);
  assert.equal(match.teams.home.players.find((player) => player.id === 7).onField, false);
  assert.equal(match.teams.home.players.find((player) => player.id === 18).onField, true);
});

test("两黄变一红并触发少打一人阵型重平衡", () => {
  const match = engine();
  match.cardPlayer("away", 6, "yellow");
  match.cardPlayer("away", 6, "yellow");
  const player = match.teams.away.players.find((item) => item.id === 6);
  assert.equal(player.sentOff, true);
  assert.equal(match.teams.away.players.filter((item) => item.onField && !item.sentOff).length, 10);
  assert.equal(match.teams.away.formation, "4-4-1");
});

test("真实 tick 流会触发定位球，点球事件能进入点球状态", () => {
  const match = engine();
  match.tick = 1799;
  match.changeState("in_play");
  match.advanceTick();
  assert.ok(["throw_in", "corner_kick", "goal_kick"].includes(match.state));
  assert.ok(match.matchLog.match_event_log.some((event) => ["throw_in", "corner_kick", "goal_kick"].includes(event.event_type)));

  match.changeState("in_play");
  match.simulatePenaltyIncident();
  assert.equal(match.state, "penalty_kick");
  assert.ok(match.matchLog.match_event_log.some((event) => event.event_type === "penalty_awarded"));
});

test("VAR 只能由引擎触发并写入复核结果", () => {
  const match = engine();
  match.triggerVarCheck("禁区内疑似犯规复核");
  assert.equal(match.state, "var_check");
  match.completeVarCheck("改判点球");
  assert.ok(match.matchLog.match_event_log.some((event) => event.event_type === "var_result" && event.referee_decision === "改判点球"));
});

test("点球大战支持前 5 轮和突然死亡规则", () => {
  const match = engine();
  const before = { home: match.teams.home.score, away: match.teams.away.score };
  const shootout = match.simulatePenaltyShootout();
  assert.equal(match.state, "full_time");
  assert.ok(shootout.kicks.length >= 10);
  assert.notEqual(shootout.home, shootout.away);
  assert.deepEqual({ home: match.teams.home.score, away: match.teams.away.score }, before);
  assert.deepEqual(match.snapshot().shootout_score, { home: shootout.home, away: shootout.away });
});
