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
