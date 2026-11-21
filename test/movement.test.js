import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { createRng } from "../src/utils.js";

function setup(seed = "movement-freeze-test") {
  const config = {
    homeCoach: { provider: "local", model: "rules-coach" },
    awayCoach: { provider: "local", model: "rules-coach" },
    match: { seed, knockout: false, homeFormation: "4-3-3", awayFormation: "4-2-3-1" }
  };
  const engine = new MatchEngine(config, createRng(seed));
  engine.start();
  return engine;
}

/** 把球放到持球人脚下并清除目标点，模拟接球后球粘脚下的状态。 */
function stickBallToHolder(engine, side, position) {
  engine.changeState("in_play");
  engine.possessionTeam = side;
  const holder = engine.teams[side].players.find((player) => player.position === position && player.onField);
  holder.x = 50;
  holder.y = 50;
  engine.ball = { x: 50, y: 50, vx: 0, vy: 0, holderTeam: side, holderId: holder.id };
  engine.clearBallTarget();
  engine.resetCarryTracker();
  return holder;
}

/** 收集所有场上球员的当前跑位目标。 */
function snapshotTargets(engine) {
  const map = {};
  for (const side of ["home", "away"]) {
    for (const player of engine.teams[side].players) {
      if (player.onField) map[`${side}_${player.id}`] = { x: player.targetX, y: player.targetY };
    }
  }
  return map;
}

/** 球粘脚下期间场上球员目标应持续变化，不再整体冻结。 */
test("球粘脚下时场上球员目标持续变化，不再整体冻结", () => {
  const engine = setup();
  stickBallToHolder(engine, "home", "ST");
  engine.updateDynamicTargets();
  const before = snapshotTargets(engine);
  engine.tick += 5;
  engine.updateDynamicTargets();
  const after = snapshotTargets(engine);
  let changed = 0;
  for (const key of Object.keys(before)) {
    if (before[key].x !== after[key].x || before[key].y !== after[key].y) changed += 1;
  }
  assert.ok(changed >= 6, `球粘脚下期间应有至少 6 名球员目标变化，实际 ${changed}`);
});

/** 持球人接球后应向进攻方向带球推进，而不是原地冻结。 */
test("持球人接球后向进攻方向带球推进", () => {
  const engine = setup();
  const holder = stickBallToHolder(engine, "home", "ST");
  engine.updateDynamicTargets();
  const targetAtStart = holder.targetX;
  engine.tick += 120;
  engine.updateDynamicTargets();
  const targetAfter = holder.targetX;
  assert.ok(targetAfter > targetAtStart, `主队持球人应向 +x 推进，start=${targetAtStart}, after=${targetAfter}`);
});

/** 客队进攻方向为 -x，持球人目标应随推进向 -x 移动。 */
test("客队持球人接球后向 -x 方向带球推进", () => {
  const engine = setup();
  const holder = stickBallToHolder(engine, "away", "ST");
  engine.updateDynamicTargets();
  const targetAtStart = holder.targetX;
  engine.tick += 120;
  engine.updateDynamicTargets();
  const targetAfter = holder.targetX;
  assert.ok(targetAfter < targetAtStart, `客队持球人应向 -x 推进，start=${targetAtStart}, after=${targetAfter}`);
});

/** 引擎输出的 vx/vy 必须等于本 tick 的实际坐标差，且全部为有限数值。 */
test("球员 vx/vy 等于本 tick 实际位移且无非法值", () => {
  const engine = setup("movement-velocity-field-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  engine.updateDynamicTargets();
  const before = new Map(engine.teams.home.players.filter((player) => player.onField).map((player) => [player.id, { x: player.x, y: player.y }]));
  engine.updatePlayers();
  for (const player of engine.teams.home.players.filter((item) => item.onField)) {
    const start = before.get(player.id);
    assert.ok(Number.isFinite(player.vx) && Number.isFinite(player.vy), `${player.id} 号球员 vx/vy 出现非法值`);
    assert.ok(Math.abs(player.vx - (player.x - start.x)) < 1e-9, `${player.id} 号球员 vx 与实际位移不一致`);
    assert.ok(Math.abs(player.vy - (player.y - start.y)) < 1e-9, `${player.id} 号球员 vy 与实际位移不一致`);
  }
});

/** 球员速度标量每 tick 变化不能超过减速上限 0.05，且不能出现 NaN。 */
test("球员 speed 每 tick 变化不超过 0.05 且无 NaN", () => {
  const engine = setup("movement-speed-acceleration-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  const holder = engine.teams.away.players.find((player) => player.position === "ST" && player.onField);
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "away", holderId: holder.id };
  for (let tickIndex = 0; tickIndex < 120; tickIndex += 1) {
    engine.updateDynamicTargets();
    const before = new Map(engine.teams.home.players.filter((player) => player.onField).map((player) => [player.id, player.speed]));
    engine.updatePlayers();
    for (const player of engine.teams.home.players.filter((item) => item.onField)) {
      assert.ok(Number.isFinite(player.speed), `${player.id} 号球员 speed 出现 NaN`);
      assert.ok(Number.isFinite(player.vx) && Number.isFinite(player.vy), `${player.id} 号球员 vx/vy 出现 NaN`);
      assert.ok(Math.abs(player.speed - before.get(player.id)) <= 0.0500001, `${player.id} 号球员 speed 单 tick 变化过大：${before.get(player.id)} -> ${player.speed}`);
    }
  }
});

/** 从静止启动时首 tick 位移受加速度限制，不会瞬间满速。 */
test("静止球员启动不会瞬间满速", () => {
  const engine = setup("movement-startup-acceleration-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const runner = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  engine.ball = { x: runner.x, y: runner.y, vx: 0, vy: 0, holderTeam: "home", holderId: runner.id };
  runner.targetX = 96;
  runner.targetY = 50;
  runner.speed = 0;
  const before = { x: runner.x, y: runner.y };
  engine.updatePlayers();
  const step = Math.hypot(runner.x - before.x, runner.y - before.y);
  assert.ok(step <= 0.0251, `静止球员首 tick 位移应受加速度限制：${step}`);
  assert.ok(runner.speed <= 0.0251, `首 tick 速度应受加速度限制：${runner.speed}`);
});

/** 开球归位必须清零上一 tick 的位移速度，避免渲染残留抖动。 */
test("开球归位会清零球员 vx/vy", () => {
  const engine = setup("movement-kickoff-reset-test");
  const player = engine.teams.home.players.find((item) => item.onField);
  player.vx = 3;
  player.vy = -2;
  engine.enterKickoff("home");
  assert.equal(player.vx, 0);
  assert.equal(player.vy, 0);
});
