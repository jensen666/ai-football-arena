import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { TICKS_PER_SECOND, createRng } from "../src/utils.js";

function config(seed = "engine-ballplay-test", match = {}) {
  return { homeCoach: { provider: "local", model: "rules-coach" }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed, knockout: false, homeFormation: "4-3-3", awayFormation: "4-2-3-1", ...match } };
}

function createEngine(seed = "engine-ballplay-test", match = {}) {
  const engine = new MatchEngine(config(seed, match), createRng(seed));
  engine.start();
  return engine;
}

test("成功传球后足球会沿路径移动而不是瞬移", () => {
  const engine = createEngine("ball-path-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const passer = engine.teams.home.players[0];
  const receiver = engine.teams.home.players[8];
  const values = [7 / 10, 0];
  engine.rng = { seed: "forced-pass", next: () => values.shift() ?? 0 };
  engine.ball = { x: passer.x, y: passer.y, vx: 0, vy: 0, holderTeam: "home", holderId: passer.id };
  engine.simulatePass();
  const distanceToReceiver = Math.hypot(engine.ball.x - receiver.x, engine.ball.y - receiver.y);
  assert.ok(distanceToReceiver > 1, "足球不应在传球事件同一 tick 瞬移到接球队员位置");
  const before = { x: engine.ball.x, y: engine.ball.y };
  engine.updatePlayers();
  const singleTickStep = Math.hypot(engine.ball.x - before.x, engine.ball.y - before.y);
  assert.ok(singleTickStep < 1, `足球单 tick 位移过大：${singleTickStep}`);
});

test("传球会区分到脚下和跑向前方落点", () => {
  const engine = createEngine("pass-reception-point-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const passer = { x: 42, y: 50 };
  const shortReceiver = { x: 48, y: 54 };
  const runner = { x: 68, y: 34 };
  engine.ball = { x: passer.x, y: passer.y, vx: 0, vy: 0, holderTeam: "home", holderId: 6 };
  const toFeet = engine.passTrajectory(passer, shortReceiver);
  const intoSpace = engine.passTrajectory(passer, runner);
  assert.equal(toFeet.reception_mode, "to_feet");
  assert.notDeepEqual(toFeet.end, shortReceiver);
  assert.ok(Math.hypot(toFeet.end.x - shortReceiver.x, toFeet.end.y - shortReceiver.y) > 0.5, "传脚下也应有迎球接应点，而不是站在原地等球");
  assert.ok(toFeet.end.x < shortReceiver.x, `接应点应朝传球人方向移动：${toFeet.end.x} >= ${shortReceiver.x}`);
  assert.equal(intoSpace.reception_mode, "into_space");
  assert.ok(intoSpace.end.x > runner.x, `前方落点应在接球人身前：${intoSpace.end.x} <= ${runner.x}`);
  assert.notDeepEqual(intoSpace.end, runner);
});

test("提前量传球后接球人会跑向落点", () => {
  const engine = createEngine("receiver-runs-to-pass-target-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const passer = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  const receiver = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  passer.x = 45;
  passer.y = 50;
  receiver.x = 68;
  receiver.y = 28;
  engine.ball = { x: passer.x, y: passer.y, vx: 0, vy: 0, holderTeam: "home", holderId: passer.id };
  const trajectory = engine.passTrajectory(passer, receiver);
  engine.passReception = { teamId: "home", passerId: passer.id, receiverId: receiver.id, mode: trajectory.reception_mode, targetX: trajectory.end.x, targetY: trajectory.end.y };
  engine.setBallTarget(trajectory.end.x, trajectory.end.y);
  engine.ball.pendingHolderTeam = "home";
  engine.ball.pendingHolderId = receiver.id;
  engine.ball.receptionMode = trajectory.reception_mode;
  engine.ball.flightHeight = trajectory.height;
  engine.ball.flightKind = trajectory.kind;
  engine.ball.flightStartX = trajectory.start.x;
  engine.ball.flightStartY = trajectory.start.y;
  engine.ball.flightEndX = trajectory.end.x;
  engine.ball.flightEndY = trajectory.end.y;
  engine.ball.inFlight = true;
  engine.updateDynamicTargets();
  assert.equal(engine.passReception.mode, "into_space");
  assert.ok(receiver.targetX > receiver.x, "接球人应开始朝空当跑动");
  assert.ok(receiver.targetX < trajectory.end.x, "接球人不应一开始就把目标锁死在最终落点");
  assert.ok(Math.abs(receiver.targetY - receiver.y) > 0.1, "接球人应沿传球线路调整横向位置");
  assert.equal(engine.ball.holderId, passer.id);
});

test("传球在球和人都到落点后才真正换持球人", () => {
  const engine = createEngine("pending-pass-reception-completes-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const passer = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  const receiver = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  passer.x = 45;
  passer.y = 50;
  receiver.x = 68;
  receiver.y = 28;
  engine.ball = { x: passer.x, y: passer.y, vx: 0, vy: 0, holderTeam: "home", holderId: passer.id };
  const trajectory = engine.passTrajectory(passer, receiver);
  engine.passReception = { teamId: "home", passerId: passer.id, receiverId: receiver.id, mode: trajectory.reception_mode, targetX: trajectory.end.x, targetY: trajectory.end.y };
  engine.setBallTarget(trajectory.end.x, trajectory.end.y);
  engine.ball.pendingHolderTeam = "home";
  engine.ball.pendingHolderId = receiver.id;
  engine.ball.receptionMode = trajectory.reception_mode;
  engine.ball.flightHeight = trajectory.height;
  engine.ball.flightKind = trajectory.kind;
  engine.ball.flightStartX = trajectory.start.x;
  engine.ball.flightStartY = trajectory.start.y;
  engine.ball.flightEndX = trajectory.end.x;
  engine.ball.flightEndY = trajectory.end.y;
  engine.ball.inFlight = true;

  for (let index = 0; index < 180 && engine.passReception; index += 1) {
    engine.updateDynamicTargets();
    engine.updatePlayers();
  }

  assert.equal(engine.passReception, null);
  assert.equal(engine.ball.holderTeam, "home");
  assert.equal(engine.ball.holderId, receiver.id);
  assert.equal(engine.ball.inFlight, null);
  assert.equal(engine.ball.flightHeight, null);
  assert.ok(Math.hypot(engine.ball.x - receiver.x, engine.ball.y - receiver.y) < 0.01);
});

test("传球飞行状态会保留高度和起落点", () => {
  const engine = createEngine("pass-flight-height-state-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const passer = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  const receiver = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  passer.x = 45;
  passer.y = 50;
  receiver.x = 76;
  receiver.y = 26;
  engine.ball = { x: passer.x, y: passer.y, vx: 0, vy: 0, holderTeam: "home", holderId: passer.id };
  const values = [0, 0];
  engine.rng = { seed: "pass-flight-height-state", next: () => values.shift() ?? 0 };
  engine.simulatePass();
  const action = engine.matchLog.action_event_log.at(-1);
  assert.equal(engine.ball.inFlight, true);
  assert.equal(engine.ball.flightHeight, action.trajectory.height);
  assert.equal(engine.ball.flightStartX, action.trajectory.start.x);
  assert.equal(engine.ball.flightEndX, action.trajectory.end.x);
  assert.ok(engine.ball.flightHeight >= 0.45, `高球应保留可视高度：${engine.ball.flightHeight}`);
});

test("传球必须由当前持球人发起且不刷关键事件日志", () => {
  const engine = createEngine("current-holder-pass-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players[6];
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  const values = [0, 0];
  engine.rng = { seed: "holder-pass", next: () => values.shift() ?? 0 };
  engine.simulatePass();
  assert.equal(engine.lastPassSnapshot.passerId, holder.id);
  assert.equal(engine.teams.home.stats.passes, 1);
  assert.equal(engine.teams.home.stats.completedPasses, 1);
  assert.equal(engine.matchLog.match_event_log.some((event) => event.event_type === "pass_completed"), false);
});

test("足球未到持球人脚下时不会继续传球", () => {
  const engine = createEngine("pass-waits-for-ball-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players[6];
  engine.ball = { x: holder.x - 18, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  engine.simulatePass();
  assert.equal(engine.matchLog.match_event_log.at(-1)?.event_type, "match_started");
  assert.equal(engine.ball.holderId, holder.id);
});

test("传球失败后由离球最近的对手接管", () => {
  const engine = createEngine("nearest-turnover-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players[0];
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  const expected = engine.teams.away.players
    .filter((player) => player.onField && !player.sentOff)
    .reduce((nearest, player) => (Math.hypot(player.x - engine.ball.x, player.y - engine.ball.y) < Math.hypot(nearest.x - engine.ball.x, nearest.y - engine.ball.y) ? player : nearest));
  const values = [0, 1];
  engine.rng = { seed: "nearest-turnover", next: () => values.shift() ?? 1 };
  engine.simulatePass();
  // 拦截新行为：传球瞬间不切球权，球先飞向拦截点，到达后才由对手接管。
  assert.equal(engine.possessionTeam, "home", "球未到达拦截点前不应切换球权");
  assert.equal(engine.pendingInterception?.teamId, "away");
  assert.equal(engine.ball.inFlight, true);
  for (let index = 0; index < 240 && engine.pendingInterception; index += 1) {
    engine.updateDynamicTargets();
    engine.updatePlayers();
  }
  assert.equal(engine.pendingInterception, null);
  assert.equal(engine.possessionTeam, "away");
  assert.equal(engine.ball.holderTeam, "away");
  assert.equal(engine.ball.holderId, expected.id);
  assert.equal(engine.ball.inFlight, null);
});

test("比赛会形成前场推进和射门", () => {
  const engine = createEngine("attacking-progression-test");
  let finalThirdEntries = 0;
  for (let index = 0; index < 3600; index += 1) {
    engine.advanceTick();
    if (engine.possessionTeam === "home" && engine.ball.x >= 75) finalThirdEntries += 1;
    if (engine.possessionTeam === "away" && engine.ball.x <= 25) finalThirdEntries += 1;
  }
  const shots = engine.matchLog.match_event_log.filter((event) => event.event_type === "shot" || event.event_type === "goal");
  assert.ok(finalThirdEntries >= 20, `前场推进采样过少：${finalThirdEntries}`);
  assert.ok(shots.length >= 1, "比赛应至少产生一次射门");
});

test("禁区内高质量机会在传球前优先射门", () => {
  const engine = createEngine("box-shot-before-pass-test");
  engine.changeState("in_play");
  engine.tick = 120;
  engine.possessionTeam = "home";
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 88;
  shooter.y = 50;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  const values = [1, 1];
  engine.rng = { seed: "box-shot-before-pass", next: () => values.shift() ?? 1 };
  engine.simulateOpenPlay();
  assert.equal(engine.teams.home.stats.shots, 1);
  assert.equal(engine.teams.home.stats.passes, 0);
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "shot"));
});

/** 门前高质量机会不能等到下一次传球节拍才射门。 */
test("近门高质量机会会立即射门", () => {
  const engine = createEngine("near-goal-immediate-shot-test");
  engine.changeState("in_play");
  engine.tick = 121;
  engine.possessionTeam = "home";
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 88;
  shooter.y = 50;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  const chance = engine.estimateShootingChance();
  assert.ok(chance.xG >= chance.threshold, `射门机会应高于阈值：${chance.xG} < ${chance.threshold}`);
  assert.equal(engine.tick % 120, 1);
  assert.notEqual(engine.tick % 3000, 0);
  const values = [1, 1];
  engine.rng = { seed: "near-goal-immediate-shot", next: () => values.shift() ?? 1 };
  engine.simulateOpenPlay();
  assert.equal(engine.teams.home.stats.shots, 1);
  assert.equal(engine.teams.home.stats.passes, 0);
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "shot"));
});

test("禁区中路机会不需等到射门节拍", () => {
  const engine = createEngine("screenshot-box-shot-test");
  engine.changeState("in_play");
  engine.tick = 121;
  engine.possessionTeam = "home";
  const shooter = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  shooter.x = 84.2;
  shooter.y = 49;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  const chance = engine.estimateShootingChance();
  assert.equal(engine.tick % 120, 1);
  assert.notEqual(engine.tick % 3000, 0);
  assert.ok(chance.shotDistance > 12, `应覆盖非小禁区低距离：d=${chance.shotDistance}`);
  assert.equal(engine.hasImmediateShootingChance(), true);
  const values = [1, 1];
  engine.rng = { seed: "screenshot-box-shot", next: () => values.shift() ?? 1 };
  engine.simulateOpenPlay();
  assert.equal(engine.teams.home.stats.shots, 1);
  assert.equal(engine.teams.home.stats.passes, 0);
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "shot"));
});

test("根因样本中的近门机会不会在传球窗口被传走", () => {
  const engine = createEngine("reported-box-shot-boundary-test");
  engine.changeState("in_play");
  engine.tick = 1440;
  engine.possessionTeam = "home";
  engine.teams.home.tactics.behavior = { ...(engine.teams.home.tactics.behavior || {}), shotThreshold: 0.08 };
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 85.3;
  shooter.y = 51.6;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  const chance = engine.estimateShootingChance();
  assert.equal(engine.tick % 120, 0);
  assert.notEqual(engine.tick % 3000, 0);
  assert.ok(chance.xG >= chance.threshold, `射门机会应高于阈值：${chance.xG} < ${chance.threshold}`);
  assert.equal(engine.hasImmediateShootingChance(), true);
  const values = [1, 1];
  engine.rng = { seed: "reported-box-shot-boundary", next: () => values.shift() ?? 1 };
  engine.simulateOpenPlay();
  assert.equal(engine.teams.home.stats.shots, 1);
  assert.equal(engine.teams.home.stats.passes, 0);
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "shot"));
});

test("射门只能发生在进攻三区", () => {
  const engine = createEngine("shot-zone-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  const shooter = engine.teams.away.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 78;
  shooter.y = 50;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "away", holderId: shooter.id };
  engine.simulateShot();
  assert.equal(engine.matchLog.match_event_log.some((event) => event.event_type === "shot" || event.event_type === "goal"), false);
  shooter.x = 22;
  engine.ball.x = shooter.x;
  const values = [1, 1];
  engine.rng = { seed: "shot-zone", next: () => values.shift() ?? 1 };
  engine.simulateShot();
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "shot"));
});

test("足球未到射门人脚下时不会射门", () => {
  const engine = createEngine("shot-waits-for-ball-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 80;
  shooter.y = 50;
  engine.ball = { x: 60, y: 50, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  engine.simulateShot();
  assert.equal(engine.matchLog.match_event_log.some((event) => event.event_type === "shot" || event.event_type === "goal"), false);
});

/** 射偏/被扑出也必须走飞行时间轴：先按 flightSpeed 飞出，到达出界点后才切定位球。 */
test("射偏后足球先飞向出界点再切换到球门球", () => {
  const engine = createEngine("shot-miss-flight-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 88;
  shooter.y = 50;
  shooter.stamina = 80;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  const values = [0.99, 0.99];
  engine.rng = { seed: "shot-miss-flight", next: () => values.shift() ?? 0.99 };
  engine.simulateShot();
  assert.equal(engine.ball.inFlight, true);
  assert.equal(engine.ball.flightSpeed, 2.2);
  assert.equal(engine.ball.flightKind, "shot");
  assert.equal(engine.ball.flightStartX, shooter.x);
  assert.ok(engine.ball.flightEndX > shooter.x, `射偏球路仍应飞向球门方向：${engine.ball.flightEndX}`);
  assert.equal(engine.state, "in_play", "射门瞬间不应立即切定位球状态");
  assert.equal(engine.pendingRestart?.restart, "goal_kick");
  assert.equal(engine.ball.holderId, null, "射门后足球不再属于任何持球人");
  const before = { x: engine.ball.x, y: engine.ball.y };
  engine.updatePlayers();
  const firstStep = Math.hypot(engine.ball.x - before.x, engine.ball.y - before.y);
  assert.ok(firstStep > 2 && firstStep <= 2.2 + 1e-9, `射门飞行单 tick 位移应接近 flightSpeed：${firstStep}`);
  for (let index = 0; index < 120 && engine.pendingRestart; index += 1) {
    engine.updateDynamicTargets();
    engine.updatePlayers();
  }
  assert.equal(engine.pendingRestart, null);
  assert.ok(["goal_kick", "corner_kick"].includes(engine.state), `球到出界点后应切定位球，实际 ${engine.state}`);
  assert.equal(engine.ball.inFlight, null, "定位球重启后应结束飞行状态");
});

/** 拦截同理：球按 1.0 的飞行速度飞向拦截点，到达后才切换球权。 */
test("传球被拦截后球飞向拦截点并延迟切换球权", () => {
  const engine = createEngine("interception-flight-delay-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  const values = [0, 1];
  engine.rng = { seed: "interception-flight-delay", next: () => values.shift() ?? 1 };
  engine.simulatePass();
  assert.equal(engine.possessionTeam, "home", "传球瞬间不应切换球权");
  assert.ok(engine.pendingInterception, "应有待结算的拦截");
  assert.equal(engine.pendingInterception.teamId, "away");
  assert.equal(engine.ball.flightSpeed, 1.0);
  assert.equal(engine.ball.inFlight, true);
  const target = { x: engine.pendingInterception.targetX, y: engine.pendingInterception.targetY };
  const gapBefore = Math.hypot(target.x - engine.ball.x, target.y - engine.ball.y);
  const before = { x: engine.ball.x, y: engine.ball.y };
  engine.updatePlayers();
  const firstStep = Math.hypot(engine.ball.x - before.x, engine.ball.y - before.y);
  assert.ok(Math.abs(firstStep - Math.min(gapBefore, 1.0)) < 1e-9, `拦截飞行单 tick 位移应为 min(距离, flightSpeed)：${firstStep}`);
  for (let index = 0; index < 240 && engine.pendingInterception; index += 1) {
    engine.updateDynamicTargets();
    engine.updatePlayers();
  }
  assert.equal(engine.pendingInterception, null);
  assert.equal(engine.possessionTeam, "away");
  assert.equal(engine.ball.holderTeam, "away");
  assert.equal(engine.ball.inFlight, null);
});

/** 进球后球速 2.0，且 goal_scored 状态从 3 秒延长到 5 秒。 */
test("进球后球速为 2.0 且庆祝状态持续 5 秒", () => {
  const engine = createEngine("goal-scored-duration-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const shooter = engine.teams.home.players.find((player) => player.position === "ST" && player.onField);
  shooter.x = 88;
  shooter.y = 50;
  shooter.stamina = 80;
  engine.ball = { x: shooter.x, y: shooter.y, vx: 0, vy: 0, holderTeam: "home", holderId: shooter.id };
  const values = [0.001, 0.9, 0.99];
  engine.rng = { seed: "goal-scored-duration", next: () => values.shift() ?? 0.99 };
  engine.simulateShot();
  assert.equal(engine.teams.home.score, 1);
  assert.equal(engine.state, "goal_scored");
  assert.equal(engine.ball.flightSpeed, 2.0);
  assert.equal(engine.ball.inFlight, true);
  for (let index = 0; index < TICKS_PER_SECOND * 5 - 1; index += 1) engine.advanceTick();
  assert.equal(engine.state, "goal_scored", "进球状态应持续 5 秒");
  engine.advanceTick();
  assert.equal(engine.state, "kickoff", "5 秒后应由失球方中圈开球");
  assert.equal(engine.possessionTeam, "away");
});

/** 动帧只含运动必需字段，players 为 22 名场上球员且速度字段完整。 */
test("motionFrame 返回 22 名球员且字段齐全", () => {
  const engine = createEngine("motion-frame-test");
  for (let index = 0; index < 15; index += 1) engine.advanceTick();
  const frame = engine.motionFrame();
  for (const key of ["match_id", "tick", "state", "paused", "game_time", "display_time", "period_label", "period_display_time", "period_total_display_time", "score", "ball", "players"]) {
    assert.ok(key in frame, `动帧缺少字段 ${key}`);
  }
  assert.equal(frame.tick, 15);
  assert.equal(frame.players.length, 22);
  for (const player of frame.players) {
    assert.ok(["home", "away"].includes(player.team_id), `动帧球队标识非法：${player.team_id}`);
    assert.ok(Number.isFinite(player.id));
    for (const key of ["x", "y", "vx", "vy"]) {
      assert.ok(Number.isFinite(player[key]), `${player.team_id}-${player.id} 动帧字段 ${key} 非数值：${player[key]}`);
    }
  }
  for (const key of ["x", "y", "holderTeam", "holderId", "inFlight", "flightKind"]) assert.ok(key in frame.ball, `动帧 ball 缺少字段 ${key}`);
  assert.deepEqual(frame.score, { home: 0, away: 0 });
});
