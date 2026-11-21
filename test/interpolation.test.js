import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFrameToDrawState,
  createDrawStateCache,
  createStreamState,
  estimateTickMs,
  frameFromMotion,
  frameFromSnapshot,
  frameScalars,
  interpolateReplayFrames,
  latestFrame,
  pushFrame,
  sampleAt
} from "../public/interpolation.js";

/** 断言数值在容差内，避免浮点误差导致测试脆弱。 */
function assertClose(actual, expected, tolerance = 1e-6, message = "") {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} 期望 ${expected}，实际 ${actual}`);
}

/** 构造两名球员 + 足球的极简帧。 */
function makeFrame(tick, positions, ball) {
  return {
    tick,
    players: positions.map(([team_id, id, x, y, vx = 0, vy = 0]) => ({ team_id, id, x, y, vx, vy })),
    ball: ball ? { ...ball } : { x: 50, y: 50 },
    state: "in_play",
    paused: false,
    score: { home: 0, away: 0 },
    clock: { period_label: "上半场", period_display_time: "00:00", period_total_display_time: "45:00" }
  };
}

test("createStreamState 初始为空缓冲且带默认 tickMs", () => {
  const state = createStreamState();
  assert.deepEqual(state.frames, []);
  assert.equal(state.tickMs, 33.33);
});

test("pushFrame 按 tick 排序、去重并只保留最近 30 帧", () => {
  const state = createStreamState();
  for (let tick = 1; tick <= 35; tick += 1) {
    pushFrame(state, makeFrame(tick, [["home", 1, tick, tick]]), tick * 33.3);
  }
  assert.equal(state.frames.length, 30);
  assert.equal(state.frames[0].tick, 6);
  assert.equal(state.frames.at(-1).tick, 35);
  const ticks = state.frames.map((frame) => frame.tick);
  assert.deepEqual(ticks, [...ticks].sort((left, right) => left - right));

  // 同 tick 重复到达只保留一份，且内容被新数据替换，帧数不增长。
  const before = state.frames.length;
  pushFrame(state, makeFrame(35, [["home", 1, 99, 88]]), 1400);
  assert.equal(state.frames.length, before);
  assert.equal(state.frames.at(-1).players[0].x, 99);
});

test("estimateTickMs 用相邻帧中位数估计并 clamp 到 15~80ms", () => {
  const empty = createStreamState();
  assert.equal(estimateTickMs(empty), 33.33);

  const stable = createStreamState();
  [0, 100, 200].forEach((receivedAt, index) => pushFrame(stable, makeFrame((index + 1) * 3, [["home", 1, 0, 0]]), receivedAt));
  assertClose(estimateTickMs(stable), 100 / 3, 1e-6, "10Hz 动帧应估计出约 33.3ms/tick");

  const tooFast = createStreamState();
  [0, 10, 20].forEach((receivedAt, index) => pushFrame(tooFast, makeFrame((index + 1) * 3, [["home", 1, 0, 0]]), receivedAt));
  assert.equal(estimateTickMs(tooFast), 15);

  const tooSlow = createStreamState();
  [0, 5000].forEach((receivedAt, index) => pushFrame(tooSlow, makeFrame(index + 1, [["home", 1, 0, 0]]), receivedAt));
  assert.equal(estimateTickMs(tooSlow), 80);

  // 单帧异常样本不应污染中位数：两对正常样本 + 一对丢帧样本，结果仍约为 33.3ms/tick。
  const jitter = createStreamState();
  [0, 100, 200, 500].forEach((receivedAt, index) => pushFrame(jitter, makeFrame([3, 6, 9, 18][index], [["home", 1, 0, 0]]), receivedAt));
  assertClose(estimateTickMs(jitter), 100 / 3, 1e-6, "丢帧产生的大样本应被中位数过滤");
});

test("sampleAt 在相邻两帧之间做球员与足球的中点插值", () => {
  const state = createStreamState();
  pushFrame(state, makeFrame(0, [["home", 7, 10, 20], ["away", 9, 80, 60]], { x: 40, y: 50 }), 1000);
  pushFrame(state, makeFrame(3, [["home", 7, 40, 20], ["away", 9, 80, 60]], { x: 70, y: 50 }), 1100);
  // 最新帧 receivedAt=1100、tick=3、tickMs≈33.33：显示 tick 1.5 对应 now=1100+(1.5-3)*33.33+120≈1170。
  const sample = sampleAt(state, 1170, 120);
  assert.ok(sample);
  assertClose(sample.tick, 1.5, 1e-4, "显示 tick");
  const home = sample.players.find((player) => player.team_id === "home" && player.id === 7);
  const away = sample.players.find((player) => player.team_id === "away" && player.id === 9);
  assertClose(home.x, 25, 1e-4, "主队球员 x 应取中点");
  assertClose(home.y, 20, 1e-4, "主队球员 y 不变");
  assertClose(away.x, 80, 1e-4, "客队球员坐标不变");
  assertClose(sample.ball.x, 55, 1e-4, "足球 x 应取中点");
  assert.equal(sample.state, "in_play");
  assert.equal(sample.paused, false);
  assert.equal(sample.clock.period_label, "上半场");
  assert.equal(sample.displayTime, null);
});

test("sampleAt 跨帧球员按 team_id+id 匹配，缺失一侧保留另一侧坐标", () => {
  const state = createStreamState();
  pushFrame(state, makeFrame(0, [["home", 1, 10, 10], ["away", 2, 50, 20]], { x: 0, y: 0 }), 0);
  pushFrame(state, makeFrame(3, [["home", 1, 40, 10], ["home", 3, 70, 30]], { x: 30, y: 0 }), 100);
  const sample = sampleAt(state, 170, 120);
  assert.equal(sample.players.length, 3, "两帧并集应包含 3 名球员");
  assertClose(sample.players.find((player) => player.team_id === "home" && player.id === 1).x, 25);
  const kept = sample.players.find((player) => player.team_id === "away" && player.id === 2);
  assert.equal(kept.x, 50, "较新帧缺失的球员保留较旧帧坐标");
  assert.equal(sample.players.find((player) => player.team_id === "home" && player.id === 3).x, 70);
});

test("sampleAt 越界时 clamp 到最近帧", () => {
  const state = createStreamState();
  pushFrame(state, makeFrame(0, [["home", 1, 10, 10]], { x: 10, y: 10 }), 0);
  pushFrame(state, makeFrame(3, [["home", 1, 40, 40]], { x: 40, y: 40 }), 100);
  // 目标时间远早于最旧帧：固定显示最旧帧。
  const oldest = sampleAt(state, 0, 120);
  assert.equal(oldest.tick, 0);
  assert.equal(oldest.players[0].x, 10);
  assert.equal(oldest.ball.x, 10);
});

test("sampleAt 落后时按两帧差速外推，最多外推 80ms", () => {
  const state = createStreamState();
  pushFrame(state, makeFrame(0, [["home", 1, 0, 0]], { x: 0, y: 0 }), 0);
  pushFrame(state, makeFrame(3, [["home", 1, 30, 0]], { x: 30, y: 0 }), 100);
  const tickMs = estimateTickMs(state);
  const maxExtraTicks = 80 / tickMs;
  // 显示时刻远超最新帧：最多外推 80ms（即 maxExtraTicks 个 tick）。
  const sample = sampleAt(state, 5000, 120);
  assertClose(sample.tick, 3 + maxExtraTicks, 1e-4, "外推 tick 应被 80ms 上限截断");
  assertClose(sample.players[0].x, 30 + 10 * maxExtraTicks, 1e-4, "外推距离 = 每 tick 速度 × 上限 tick 数");
  assert.ok(sample.players[0].x < 100, "外推不应无限放大坐标");
});

test("sampleAt 没有动帧时返回 null，且不修改传入对象", () => {
  const empty = createStreamState();
  assert.equal(sampleAt(empty, 1000, 120), null);
  assert.equal(latestFrame(empty), null);

  const state = createStreamState();
  const frame = makeFrame(5, [["home", 1, 12, 34]], { x: 5, y: 6 });
  const frameSnapshot = JSON.stringify(frame);
  pushFrame(state, frame, 100);
  assert.equal(JSON.stringify(frame), frameSnapshot, "pushFrame 不应修改入参帧");
  frame.players[0].x = 999;
  assert.equal(state.frames[0].players[0].x, 12, "缓冲帧应是深拷贝");

  const stateSnapshot = JSON.stringify(state.frames);
  const sample = sampleAt(state, 200, 120);
  assert.equal(JSON.stringify(state.frames), stateSnapshot, "sampleAt 不应修改缓冲");
  sample.players[0].x = -1;
  sample.clock.period_label = "篡改";
  assert.equal(state.frames[0].players[0].x, 12, "返回结果与缓冲隔离");
  assert.equal(state.frames[0].clock.period_label, "上半场", "clock 应深拷贝");
});

test("frameFromMotion 生成内部帧：球员坐标/速度、扁平时钟、比分", () => {
  const frame = frameFromMotion({
    tick: 120,
    state: "in_play",
    paused: false,
    game_time: 12.5,
    display_time: "12:30",
    period_label: "上半场",
    period_display_time: "12:30",
    period_total_display_time: "45:00",
    score: { home: 1, away: 2 },
    ball: { x: 30, y: 40, holderTeam: "home", holderId: 9, inFlight: false, flightKind: null },
    players: [{ team_id: "home", id: 7, x: 30, y: 40, vx: 0.1, vy: -0.2 }, { team_id: "away", id: 8, x: 60, y: 20, vx: 0, vy: 0 }]
  });
  assert.equal(frame.tick, 120);
  assert.equal(frame.state, "in_play");
  assert.equal(frame.paused, false);
  assert.deepEqual(frame.score, { home: 1, away: 2 });
  assert.equal(frame.ball.holderTeam, "home");
  assert.equal(frame.clock.period_label, "上半场");
  assert.equal(frame.clock.period_display_time, "12:30");
  assert.equal(frame.clock.elapsed_seconds, 12.5);
  assert.equal(frame.players.length, 2);
  assert.deepEqual(frame.players[0], { team_id: "home", id: 7, x: 30, y: 40, vx: 0.1, vy: -0.2 });
  assert.equal(frameFromMotion(null), null);
});

test("frameFromSnapshot 把全量快照的场上球员摊平为动帧", () => {
  const frame = frameFromSnapshot({
    tick: 88,
    state: "in_play",
    paused: true,
    game_time: 30,
    clock: { period_label: "上半场", period_display_time: "00:30", period_total_display_time: "45:00", display_time: "00:30" },
    score: { home: 0, away: 0 },
    ball: { x: 51, y: 49 },
    teams: {
      home: { players: [{ id: 1, x: 10, y: 20 }, { id: 2, x: 30, y: 40 }] },
      away: { players: [{ id: 3, x: 70, y: 60 }] }
    }
  });
  assert.equal(frame.tick, 88);
  assert.equal(frame.players.length, 3);
  assert.deepEqual(frame.players[0], { team_id: "home", id: 1, x: 10, y: 20, vx: undefined, vy: undefined });
  assert.deepEqual(frame.players[2], { team_id: "away", id: 3, x: 70, y: 60, vx: undefined, vy: undefined });
  assert.equal(frame.clock.period_label, "上半场");
  assert.equal(frame.displayTime, "00:30");
  assert.equal(frameFromSnapshot({ tick: 1 }), null);
});

test("frameScalars 只返回帧内已定义的标量，供 latest 增量覆盖", () => {
  const scalars = frameScalars(frameFromMotion({ tick: 5, state: "paused_state", paused: true, score: { home: 2, away: 1 }, period_label: "上半场", period_display_time: "05:00", period_total_display_time: "45:00" }));
  assert.equal(scalars.tick, 5);
  assert.equal(scalars.state, "paused_state");
  assert.equal(scalars.paused, true);
  assert.deepEqual(scalars.score, { home: 2, away: 1 });
  assert.equal(scalars.clock.period_label, "上半场");
  assert.equal("game_time" in scalars, false, "缺失字段不应覆盖 latest 的原值");
  assert.equal(frameScalars(null), null);
});

test("latestFrame 返回最新帧副本且不插值", () => {
  const state = createStreamState();
  pushFrame(state, makeFrame(0, [["home", 1, 10, 10]], { x: 0, y: 0 }), 0);
  pushFrame(state, makeFrame(3, [["home", 1, 40, 40]], { x: 30, y: 30 }), 100);
  const newest = latestFrame(state);
  assert.equal(newest.tick, 3);
  assert.equal(newest.players[0].x, 40, "reduced-motion 直接取最新帧坐标");
  newest.players[0].x = 0;
  assert.equal(state.frames.at(-1).players[0].x, 40, "副本与缓冲隔离");
});

test("interpolateReplayFrames 在相邻回放帧之间插值球员和球", () => {
  const from = {
    tick: 100,
    game_time: 10,
    state: "in_play",
    score: { home: 0, away: 0 },
    ball: { x: 40, y: 50, holderTeam: "home" },
    teams: { home: { players: [{ id: 1, x: 10, y: 10 }, { id: 2, x: 20, y: 20 }] }, away: { players: [{ id: 3, x: 80, y: 80 }] } }
  };
  const to = {
    tick: 101,
    game_time: 10.1,
    state: "goal_scored",
    score: { home: 1, away: 0 },
    ball: { x: 60, y: 50, holderTeam: null },
    teams: { home: { players: [{ id: 1, x: 30, y: 10 }, { id: 4, x: 50, y: 50 }] }, away: { players: [{ id: 3, x: 80, y: 80 }] } }
  };
  const frame = interpolateReplayFrames(from, to, 0.5);
  assert.equal(frame.state, "goal_scored", "标量字段取较新帧");
  assert.deepEqual(frame.score, { home: 1, away: 0 });
  assertClose(frame.ball.x, 50, 1e-6, "回放足球 x 插值");
  assert.equal(frame.ball.holderTeam, null, "足球其它字段取较新帧");
  assertClose(frame.teams.home.players.find((player) => player.id === 1).x, 20, 1e-6, "回放球员 x 插值");
  assert.equal(frame.teams.home.players.find((player) => player.id === 2).x, 20, "较新帧缺失的球员保留较旧帧坐标");
  assert.equal(frame.teams.home.players.find((player) => player.id === 4).x, 50, "较旧帧缺失的球员取较新帧坐标");
  assertClose(frame.tick, 100.5, 1e-6, "回放帧 tick 连续插值");

  // 只传一侧时直接返回另一侧，alpha 越界会被 clamp。
  assert.equal(interpolateReplayFrames(null, to, 0.5), to);
  assert.equal(interpolateReplayFrames(from, null, 0.5), from);
  assertClose(interpolateReplayFrames(from, to, 5).tick, 101, 1e-6);
});

/** 构造渲染模板：两名主队球员 + 球，带渲染层依赖的球路字段。 */
function makeTemplate(matchId = "m1") {
  return {
    match_id: matchId,
    tick: 10,
    state: "in_play",
    paused: false,
    score: { home: 0, away: 0 },
    clock: { period_label: "上半场", period_display_time: "00:10" },
    possession_team: "home",
    ball: { x: 10, y: 20, inFlight: true, flightStartX: 1, flightEndX: 30, flightHeight: 0.5 },
    teams: {
      home: { name: "主队", tactics: { intent: "high_press" }, players: [{ id: 1, shirt: 9, x: 0, y: 0, vx: 0, vy: 0 }, { id: 2, shirt: 7, x: 5, y: 5, vx: 0, vy: 0 }] },
      away: { name: "客队", tactics: { intent: "compact_block" }, players: [{ id: 3, shirt: 1, x: 90, y: 50, vx: 0, vy: 0 }] }
    }
  };
}

test("createDrawStateCache 同模板复用对象，换模板才重建副本", () => {
  const template = makeTemplate();
  const cache = createDrawStateCache(template);
  assert.equal(cache.template, template);
  assert.equal(cache.players.size, 3);
  assert.equal(cache.state.teams.home.players.length, 2);
  assert.equal(cache.state.ball.inFlight, true, "快照里的球路细节应带入绘制缓存");
  assert.equal(createDrawStateCache(template, cache), cache, "同模板应原样复用缓存");
  const rebuilt = createDrawStateCache(makeTemplate("m2"), cache);
  assert.notEqual(rebuilt, cache);
  assert.equal(rebuilt.template.match_id, "m2");
});

test("applyFrameToDrawState 用动帧覆盖坐标/速度/标量，并保留快照球路细节", () => {
  const template = makeTemplate();
  const cache = createDrawStateCache(template);
  const frame = sampleAt(
    (() => {
      const state = createStreamState();
      pushFrame(state, makeFrame(9, [["home", 1, 10, 10], ["away", 3, 80, 50]], { x: 40, y: 30 }), 0);
      pushFrame(state, makeFrame(12, [["home", 1, 40, 20]], { x: 50, y: 40, holderTeam: "home", holderId: 1, inFlight: false }), 100);
      return state;
    })(),
    170,
    120
  );
  const result = applyFrameToDrawState(cache, frame);
  assert.equal(result, cache, "应复用同一缓存对象");
  const player1 = cache.state.teams.home.players.find((player) => player.id === 1);
  assertClose(player1.x, 25, 1e-4, "球员 x 应写入插值坐标");
  assertClose(player1.y, 15, 1e-4, "球员 y 应写入插值坐标");
  assert.equal(player1.shirt, 9, "球员静态字段保留模板值");
  const player2 = cache.state.teams.home.players.find((player) => player.id === 2);
  assert.equal(player2.x, 5, "动帧缺失的球员保留模板坐标");
  assert.equal(cache.ball.x > 40 && cache.ball.x < 50, true, "足球 x 应写入插值坐标");
  assert.equal(cache.ball.flightStartX, 1, "动帧缺省字段时保留快照球路细节");
  assert.equal(cache.ball.holderTeam, "home", "足球最新持有者字段取动帧");
  assert.equal(cache.state.ball, cache.ball, "绘制状态引用缓存足球对象");
  assert.equal(template.teams.home.players[0].x, 0, "不应修改模板（最新快照）对象");

  // 速度使用动帧覆盖值（渲染层速度兜底），而非模板里 1Hz 快照的旧速度。
  const fastFrame = { players: [{ team_id: "home", id: 1, x: 50, y: 50, vx: 0.2, vy: -0.1 }], ball: null };
  applyFrameToDrawState(cache, fastFrame);
  assert.equal(cache.state.teams.home.players[0].vx, 0.2);
  assert.equal(cache.state.teams.home.players[0].vy, -0.1);
});

