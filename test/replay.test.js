import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { defaultConfig } from "../src/storage.js";
import { createRng } from "../src/utils.js";

const TICKS_PER_SECOND = 30;

function createEngine(seed = "replay-test") {
  const config = defaultConfig();
  config.match.seed = seed;
  config.match.matchMinutes = 90;
  return new MatchEngine(config, createRng(seed));
}

/** 推进指定 tick 数，默认不暂停。 */
function advanceTicks(engine, count) {
  for (let index = 0; index < count; index += 1) engine.advanceTick();
}

/** 强制触发一个进球并返回射手信息。 */
function forceGoal(engine, teamId = "home") {
  const team = engine.teams[teamId];
  const shooter = team.players.find((player) => player.onField && player.position === "ST") || team.players.find((player) => player.onField);
  team.score += 1;
  engine.replayRecorder.startReplay(engine.tick, teamId, shooter.id, shooter.name, { home: engine.teams.home.score, away: engine.teams.away.score }, engine.gameTime);
  return { shooter, teamId };
}

/** 环形缓冲区会保留最近 10 秒的比赛帧。 */
test("正常推进后环形缓冲区保留最近 300 帧", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 350);
  assert.equal(engine.replayRecorder.ringBuffer.length, 300);
  assert.equal(engine.replayRecorder.ringBuffer[0].tick, 51);
  assert.equal(engine.replayRecorder.ringBuffer.at(-1).tick, 350);
});

/** 进球后应立即生成 pending 回放片段。 */
test("进球后立即生成 pending 回放片段", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 200);
  const beforeTick = engine.tick;
  forceGoal(engine, "home");
  assert.equal(engine.replayRecorder.pendingReplays.length, 1);
  const replay = engine.replayRecorder.pendingReplays[0];
  assert.equal(replay.goalTick, beforeTick);
  assert.equal(replay.teamId, "home");
  assert.ok(replay.playerName);
  assert.equal(replay.frames.length, 200);
  assert.equal(replay.postFrames.length, 0);
  assert.equal(replay.completed, false);
});

/** 进球后 3 秒（90 tick，不含进球帧）应完成回放片段。 */
test("进球后 91 tick 回放片段进入 completed", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 300);
  forceGoal(engine, "away");
  advanceTicks(engine, 91);
  assert.equal(engine.replayRecorder.pendingReplays.length, 0);
  assert.equal(engine.replayRecorder.completedReplays.length, 1);
  const replay = engine.replayRecorder.completedReplays[0];
  assert.equal(replay.completed, true);
  assert.equal(replay.postFrames.length, 90);
  assert.equal(replay.frames.length + replay.postFrames.length, 390);
});

/** 比赛开始 10 秒内进球时，前段帧不足 300 帧。 */
test("开场 5 秒进球时前段帧为 150 帧", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 150);
  forceGoal(engine, "home");
  advanceTicks(engine, 91);
  const replay = engine.replayRecorder.completedReplays[0];
  assert.equal(replay.frames.length, 150);
  assert.equal(replay.postFrames.length, 90);
});

/** 连续快速进球应生成独立的回放片段。 */
test("连续快速进球生成两个独立回放片段", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 300);
  forceGoal(engine, "home");
  advanceTicks(engine, 50);
  forceGoal(engine, "away");
  advanceTicks(engine, 91);
  assert.equal(engine.replayRecorder.completedReplays.length, 2);
  const first = engine.replayRecorder.completedReplays[0];
  const second = engine.replayRecorder.completedReplays[1];
  assert.equal(first.frames.length, 300);
  assert.equal(second.frames.length, 300);
  assert.notEqual(first.goalTick, second.goalTick);
});

/** 重新开始比赛应清空所有回放数据。 */
test("重新开始比赛清空回放数据", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 300);
  forceGoal(engine, "home");
  advanceTicks(engine, 91);
  assert.equal(engine.replayRecorder.completedReplays.length, 1);
  engine.start();
  assert.equal(engine.replayRecorder.ringBuffer.length, 0);
  assert.equal(engine.replayRecorder.pendingReplays.length, 0);
  assert.equal(engine.replayRecorder.completedReplays.length, 0);
});

/** snapshot 中应包含回放列表元数据。 */
test("snapshot 包含已完成的回放列表元数据", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 300);
  forceGoal(engine, "home");
  advanceTicks(engine, 91);
  const snapshot = engine.snapshot();
  assert.ok(Array.isArray(snapshot.replays));
  assert.equal(snapshot.replays.length, 1);
  const meta = snapshot.replays[0];
  assert.ok(meta.replay_id);
  assert.equal(meta.team_id, "home");
  assert.ok(meta.player_name);
  assert.ok(meta.score_after);
  assert.equal(typeof meta.game_time, "number");
});

/** getReplay 应返回完整帧数据，错误 id 返回 null。 */
test("getReplay 返回完整帧或 null", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 300);
  forceGoal(engine, "home");
  advanceTicks(engine, 91);
  const meta = engine.snapshot().replays[0];
  const replay = engine.getReplay(meta.replay_id);
  assert.ok(replay);
  assert.equal(replay.frames.length, 390);
  assert.equal(replay.replay_id, meta.replay_id);
  assert.equal(engine.getReplay("replay_nonexistent"), null);
});

/** 回放帧中只包含渲染所需的最小字段。 */
test("回放帧仅包含必要的渲染字段", () => {
  const engine = createEngine();
  engine.start();
  advanceTicks(engine, 10);
  const frame = engine.replayRecorder.ringBuffer.at(-1);
  assert.ok(frame.tick);
  assert.ok(frame.ball);
  assert.ok(frame.teams.home.players.length > 0);
  const player = frame.teams.home.players[0];
  assert.ok("id" in player);
  assert.ok("x" in player);
  assert.ok("y" in player);
  assert.ok("shirt" in player);
  assert.equal("attributes" in player, false);
  assert.equal("tactics" in player, false);
});
