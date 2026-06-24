import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { behaviorWeights } from "../src/tactics.js";
import { DEFAULT_MATCH_MINUTES, TICKS_PER_SECOND, createRng } from "../src/utils.js";

function config(seed = "engine-test", match = {}) {
  return { homeCoach: { provider: "local", model: "rules-coach" }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed, knockout: false, homeFormation: "4-3-3", awayFormation: "4-2-3-1", ...match } };
}

function createEngine(seed = "engine-test", match = {}) {
  const engine = new MatchEngine(config(seed, match), createRng(seed));
  engine.start();
  return engine;
}

/** 计算球员基础站位到指定点的距离。 */
function baseDistance(player, point) {
  return Math.hypot((player.baseTargetX ?? player.targetX) - point.x, (player.baseTargetY ?? player.targetY) - point.y);
}

/** 计算球员动态目标到指定点的距离。 */
function targetDistance(player, point) {
  return Math.hypot(player.targetX - point.x, player.targetY - point.y);
}

/** 计算球员沿进攻方向的纵深。 */
function attackingDepth(side, player) {
  const x = player.baseTargetX ?? player.targetX ?? player.x;
  return side === "home" ? x : 100 - x;
}

/** 按基础站位找出最接近指定点的非门将防守人。 */
function nearestDefenderByBase(engine, teamId, point) {
  return engine.teams[teamId].players
    .filter((player) => player.onField && !player.sentOff && player.position !== "GK")
    .reduce((nearest, player) => (baseDistance(player, point) < baseDistance(nearest, point) ? player : nearest));
}

function runToFullTime(engine) {
  let guard = 0;
  while (engine.state !== "full_time" && guard < 190000) {
    engine.advanceTick();
    guard += 1;
  }
  assert.equal(engine.state, "full_time");
}

function applyLowRiskModelTactics(engine) {
  for (const team of Object.values(engine.teams)) {
    team.tactics = {
      ...team.tactics,
      intent: "control_possession",
      riskLevel: 0,
      passingRisk: "low",
      behavior: behaviorWeights({ risk_level: 0, intent: "control_possession" })
    };
  }
}

test("镜像阵容包含双方 23 人和首发 11 人，对应能力一致", () => {
  const engine = createEngine();
  assert.equal(engine.teams.home.players.length, 23);
  assert.equal(engine.teams.away.players.length, 23);
  assert.equal(engine.teams.home.players.filter((player) => player.onField).length, 11);
  assert.equal(engine.teams.away.players.filter((player) => player.onField).length, 11);
  for (let index = 0; index < 23; index += 1) {
    assert.deepEqual(engine.teams.home.players[index].attributes, engine.teams.away.players[index].attributes);
  }
  assert.deepEqual(engine.teams.home.players.slice(0, 11).map((player) => player.position), ["GK", "RB", "CB", "CB", "LB", "DM", "CM", "AM", "RW", "ST", "LW"]);
});

test("阵型槽位按球员角色分配关键进攻职责", () => {
  const engine = createEngine("role-aware-formation-slot-test");
  const away = engine.teams.away;
  const striker = away.players.find((player) => player.position === "ST" && player.onField);
  const leftWinger = away.players.find((player) => player.position === "LW" && player.onField);
  const rightWinger = away.players.find((player) => player.position === "RW" && player.onField);
  assert.ok(attackingDepth("away", striker) > attackingDepth("away", leftWinger) + 5, `客队中锋没有站在边锋前方：ST=${attackingDepth("away", striker)}, LW=${attackingDepth("away", leftWinger)}`);
  assert.ok(Math.abs((striker.baseTargetY ?? striker.targetY) - 50) <= 8, `客队中锋没有占据中路：${striker.baseTargetY ?? striker.targetY}`);
  assert.ok((leftWinger.baseTargetY ?? leftWinger.targetY) > 60, `左边锋没有留在左路：${leftWinger.baseTargetY ?? leftWinger.targetY}`);
  assert.ok((rightWinger.baseTargetY ?? rightWinger.targetY) < 40, `右边锋没有留在右路：${rightWinger.baseTargetY ?? rightWinger.targetY}`);
});

/** 默认阵型应更接近真实足球的错层站位，而不是简单三条竖列。 */
test("默认阵型基础站位保持足球式错层", () => {
  const engine = createEngine("football-shape-stagger-test");
  for (const side of ["home", "away"]) {
    const players = engine.teams[side].players.filter((player) => player.onField);
    const fullbacks = players.filter((player) => ["RB", "LB"].includes(player.position));
    const centerBacks = players.filter((player) => player.position === "CB");
    const midfielders = players.filter((player) => ["DM", "CM", "AM"].includes(player.position));
    const striker = players.find((player) => player.position === "ST");
    const wingers = players.filter((player) => ["RW", "LW"].includes(player.position));
    const averageDepth = (items) => items.reduce((sum, player) => sum + attackingDepth(side, player), 0) / items.length;
    assert.ok(averageDepth(fullbacks) > averageDepth(centerBacks) + 2, `${side} 边后卫应比中卫更靠前`);
    assert.ok(new Set(midfielders.map((player) => Math.round(attackingDepth(side, player)))).size >= 2, `${side} 中场不应排成同一竖列`);
    assert.ok(striker && wingers.every((winger) => attackingDepth(side, striker) > attackingDepth(side, winger) + 4), `${side} 中锋应比边锋更靠前`);
  }
});

test("match minutes configure regulation boundaries and clock snapshot", () => {
  const defaultEngine = createEngine("default-match-minutes-test");
  assert.equal(defaultEngine.matchMinutes, DEFAULT_MATCH_MINUTES);
  assert.equal(defaultEngine.halfSeconds, 45 * 60);
  assert.equal(defaultEngine.fullTimeSeconds, 90 * 60);

  const shortEngine = createEngine("short-match-minutes-test", { matchMinutes: 2 });
  assert.equal(shortEngine.matchMinutes, 2);
  assert.equal(shortEngine.halfSeconds, 60);
  assert.equal(shortEngine.fullTimeSeconds, 120);
  assert.equal(shortEngine.snapshot().clock.period_label, "\u4e0a\u534a\u573a");
  assert.equal(shortEngine.snapshot().clock.period_total_display_time, "01:00");
  assert.equal(shortEngine.snapshot().clock.match_total_display_time, "02:00");

  shortEngine.changeState("in_play");
  shortEngine.gameTime = shortEngine.halfSeconds - 1 / TICKS_PER_SECOND;
  shortEngine.advanceTick();
  assert.equal(shortEngine.state, "half_time");
  assert.equal(shortEngine.snapshot().clock.period_label, "\u4e2d\u573a");
  assert.equal(shortEngine.snapshot().clock.period_display_time, "01:00");
  assert.equal(shortEngine.snapshot().clock.match_total_display_time, "02:00");

  shortEngine.period = "second_half";
  shortEngine.changeState("in_play");
  shortEngine.gameTime = shortEngine.fullTimeSeconds - 1 / TICKS_PER_SECOND;
  shortEngine.advanceTick();
  assert.equal(shortEngine.state, "full_time");
  assert.equal(shortEngine.snapshot().clock.period_label, "\u5168\u573a");
  assert.equal(shortEngine.snapshot().clock.display_time, "02:00");
  assert.ok(shortEngine.matchLog.match_event_log.some((event) => event.event_type === "full_time"));
});

test("match clock snapshot distinguishes halves and extra-time totals", () => {
  const engine = createEngine("extra-time-clock-test", { matchMinutes: 2, knockout: true });
  engine.period = "full_time";
  engine.changeState("extra_time_break");
  engine.gameTime = engine.fullTimeSeconds;
  assert.equal(engine.snapshot().clock.period_label, "\u52a0\u65f6\u524d\u4f11\u606f");
  assert.equal(engine.snapshot().clock.period_display_time, "00:00");
  assert.equal(engine.snapshot().clock.period_total_display_time, "15:00");
  assert.equal(engine.snapshot().clock.match_total_display_time, "32:00");

  engine.period = "extra_first";
  engine.changeState("in_play");
  engine.gameTime = engine.fullTimeSeconds + 450;
  assert.equal(engine.snapshot().clock.period_label, "\u52a0\u65f6\u4e0a\u534a\u573a");
  assert.equal(engine.snapshot().clock.period_display_time, "07:30");
  assert.equal(engine.snapshot().clock.match_total_display_time, "32:00");
});

test("比赛能从赛前推进到完场并生成每 5 tick 压缩快照", () => {
  const engine = createEngine("full-time-test");
  runToFullTime(engine);
  assert.ok(engine.teams.home.score >= 0);
  assert.ok(engine.teams.away.score >= 0);
  const eventCounts = engine.matchLog.match_event_log.reduce((counts, event) => {
    counts[event.event_type] = (counts[event.event_type] || 0) + 1;
    return counts;
  }, {});
  const totalShots = (eventCounts.shot || 0) + (eventCounts.goal || 0);
  const totalXg = engine.teams.home.stats.xG + engine.teams.away.stats.xG;
  assert.ok(engine.teams.home.score + engine.teams.away.score <= 8, `全场进球过多：${engine.teams.home.score + engine.teams.away.score}`);
  assert.ok(totalXg <= 4.5, `全场 xG 过高：${totalXg}`);
  assert.ok(totalShots >= 12, `比赛射门过少：${totalShots}`);
  assert.ok(totalShots <= 36, `比赛射门过多：${totalShots}`);
  assert.ok(engine.matchLog.match_event_log.length <= 240, `关键事件过多：${engine.matchLog.match_event_log.length}`);
  assert.equal(eventCounts.pass_completed || 0, 0);
  assert.equal(eventCounts.turnover || 0, 0);
  assert.ok((eventCounts.penalty_awarded || 0) <= 3, `点球过多：${eventCounts.penalty_awarded || 0}`);
  assert.ok((eventCounts.red_card || 0) <= 2, `红牌过多：${eventCounts.red_card || 0}`);
  const uniqueTicks = [...new Set(engine.matchLog.engine_tick_log.map((item) => item.tick))].sort((a, b) => a - b);
  for (let index = 1; index < uniqueTicks.length; index += 1) {
    assert.ok(uniqueTicks[index] - uniqueTicks[index - 1] <= 5, `快照间隔过大：${uniqueTicks[index - 1]} -> ${uniqueTicks[index]}`);
  }
  for (const event of engine.matchLog.match_event_log) {
    assert.ok(uniqueTicks.includes(event.tick), `关键事件 tick ${event.tick} 缺少快照`);
  }
});

test("多 seed 全场事件节奏保持在足球比赛合理区间", () => {
  const seeds = Array.from({ length: 8 }, (_, index) => `review-${index}`);
  let totalShotsAcrossSeeds = 0;
  let totalGoalsAcrossSeeds = 0;
  for (const seed of seeds) {
    const engine = createEngine(seed);
    runToFullTime(engine);
    const eventCounts = engine.matchLog.match_event_log.reduce((counts, event) => {
      counts[event.event_type] = (counts[event.event_type] || 0) + 1;
      return counts;
    }, {});
    const totalGoals = engine.teams.home.score + engine.teams.away.score;
    const totalShots = (eventCounts.shot || 0) + (eventCounts.goal || 0);
    const totalXg = engine.teams.home.stats.xG + engine.teams.away.stats.xG;
    totalShotsAcrossSeeds += totalShots;
    totalGoalsAcrossSeeds += totalGoals;
    assert.ok(totalGoals <= 8, `${seed} 全场进球过多：${totalGoals}`);
    assert.ok(totalXg <= 4.5, `${seed} 全场 xG 过高：${totalXg}`);
    assert.ok(totalShots <= 36, `${seed} 全场射门过多：${totalShots}`);
    assert.ok(totalShots >= 10, `${seed} 全场射门过少：${totalShots}`);
    assert.ok(engine.matchLog.match_event_log.length <= 240, `${seed} 关键事件过多：${engine.matchLog.match_event_log.length}`);
    assert.equal(eventCounts.pass_completed || 0, 0);
    assert.equal(eventCounts.turnover || 0, 0);
  }
  assert.ok(totalGoalsAcrossSeeds / seeds.length <= 4.5, `平均进球过多：${totalGoalsAcrossSeeds / seeds.length}`);
  assert.ok(totalShotsAcrossSeeds / seeds.length >= 16, `平均射门过少：${totalShotsAcrossSeeds / seeds.length}`);
});

test("连续 3 场自动比赛均能正常结束", () => {
  for (let index = 0; index < 3; index += 1) {
    const engine = createEngine(`three-match-${index}`);
    runToFullTime(engine);
    assert.equal(engine.state, "full_time");
    assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "full_time"));
  }
});

test("低风险模型战术半场前仍会产生射门", () => {
  const seeds = ["20260620", "review-0", "review-1", "review-2", "review-7"];
  for (const seed of seeds) {
    const engine = createEngine(`low-risk-shot-${seed}`);
    applyLowRiskModelTactics(engine);
    for (let index = 0; index < 81000; index += 1) engine.advanceTick();
    const totalShots = engine.teams.home.stats.shots + engine.teams.away.stats.shots;
    assert.ok(totalShots >= 3, `${seed} 低风险半场射门过少：${totalShots}`);
    assert.ok(totalShots <= 18, `${seed} 低风险半场射门过多：${totalShots}`);
  }
});

test("暂停状态下 game_time 不推进，恢复后继续推进", () => {
  const engine = createEngine("pause-test");
  for (let index = 0; index < 90; index += 1) engine.advanceTick();
  const beforePause = engine.gameTime;
  engine.pause();
  for (let index = 0; index < 90; index += 1) engine.advanceTick();
  assert.equal(engine.gameTime, beforePause);
  engine.resume();
  for (let index = 0; index < 30; index += 1) engine.advanceTick();
  assert.ok(engine.gameTime > beforePause);
});

test("比赛进行时场上球员会持续移动", () => {
  const engine = createEngine("movement-test");
  for (let index = 0; index < 70; index += 1) engine.advanceTick();
  const before = engine.snapshot().teams.home.players.map((player) => ({ x: player.x, y: player.y }));
  for (let index = 0; index < 90; index += 1) engine.advanceTick();
  const after = engine.snapshot().teams.home.players;
  const moved = after.filter((player, index) => Math.hypot(player.x - before[index].x, player.y - before[index].y) > 0.05);
  const visibleRuns = after.filter((player, index) => player.position !== "GK" && Math.hypot(player.x - before[index].x, player.y - before[index].y) > 0.35);
  assert.ok(moved.length >= 10, `移动球员过少：${moved.length}`);
  assert.ok(visibleRuns.length >= 6, `可见穿插球员过少：${visibleRuns.length}`);
});

test("进攻无球跑位会主动贴近越位线而不是集体越线", () => {
  const engine = createEngine("onside-support-run-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  holder.x = 72;
  holder.y = 50;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  for (const defender of engine.teams.away.players.filter((player) => player.onField && player.position !== "GK")) defender.x = 76;
  engine.updateDynamicTargets();
  const attackers = engine.teams.home.players.filter((player) => ["ST", "RW", "LW"].includes(player.position) && player.onField && player.id !== holder.id);
  const overLine = attackers.filter((player) => player.targetX > 76.2);
  assert.equal(overLine.length, 0, `进攻目标不应集体越线：${overLine.map((player) => `${player.position}:${player.targetX.toFixed(1)}`).join(", ")}`);
});

test("客队进攻无球跑位同样会主动贴近越位线", () => {
  const engine = createEngine("away-onside-support-run-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  const holder = engine.teams.away.players.find((player) => player.position === "CM" && player.onField);
  holder.x = 28;
  holder.y = 50;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "away", holderId: holder.id };
  for (const defender of engine.teams.home.players.filter((player) => player.onField && player.position !== "GK")) defender.x = 24;
  engine.updateDynamicTargets();
  const attackers = engine.teams.away.players.filter((player) => ["ST", "RW", "LW"].includes(player.position) && player.onField && player.id !== holder.id);
  const overLine = attackers.filter((player) => player.targetX < 23.8);
  assert.equal(overLine.length, 0, `客队进攻目标不应集体越线：${overLine.map((player) => `${player.position}:${player.targetX.toFixed(1)}`).join(", ")}`);
});

/** 无球接应不能和持球人挤到同一个实际跑位点。 */
test("进攻接应目标与持球人保持真实可读间距", () => {
  const engine = createEngine("support-display-gap-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  const holder = engine.teams.away.players.find((player) => player.position === "AM" && player.onField);
  holder.x = 25;
  holder.y = 50;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "away", holderId: holder.id };
  for (const defender of engine.teams.home.players.filter((player) => player.onField && player.position !== "GK")) defender.x = 21;
  engine.updateDynamicTargets();
  const supports = engine.teams.away.players.filter((player) => ["ST", "RW", "LW"].includes(player.position) && player.onField && player.id !== holder.id);
  const tooClose = supports.filter((player) => targetDistance(player, holder) < 4.1);
  assert.equal(tooClose.length, 0, `进攻接应不应贴住持球人：${tooClose.map((player) => `${player.position}:${targetDistance(player, holder).toFixed(1)}`).join(", ")}`);
});

/** 前场接应不能被越位线保护压成同一条纵向通道。 */
test("前场接应目标保持纵深错层", () => {
  const engine = createEngine("support-depth-stagger-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  const holder = engine.teams.away.players.find((player) => player.position === "AM" && player.onField);
  holder.x = 34;
  holder.y = 52;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "away", holderId: holder.id };
  for (const defender of engine.teams.home.players.filter((player) => player.onField && player.position !== "GK")) defender.x = 24;
  engine.updateDynamicTargets();
  const striker = engine.teams.away.players.find((player) => player.position === "ST" && player.onField);
  const wingers = engine.teams.away.players.filter((player) => ["RW", "LW"].includes(player.position) && player.onField);
  const stacked = wingers.filter((player) => Math.abs(player.targetX - striker.targetX) < 3.2);
  assert.equal(stacked.length, 0, `边锋不应和中锋挤在同一纵深：ST=${striker.targetX.toFixed(1)}, ${stacked.map((player) => `${player.position}:${player.targetX.toFixed(1)}`).join(", ")}`);
});

/** 前腰、边锋和中锋在压线接应时也要保持职责层次。 */
test("前场三线接应目标保持职责层次", () => {
  const engine = createEngine("support-front-line-stagger-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  const holder = engine.teams.away.players.find((player) => player.position === "CM" && player.onField);
  holder.x = 34;
  holder.y = 52;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "away", holderId: holder.id };
  for (const defender of engine.teams.home.players.filter((player) => player.onField && player.position !== "GK")) defender.x = 24;
  engine.updateDynamicTargets();
  const striker = engine.teams.away.players.find((player) => player.position === "ST" && player.onField);
  const attackingMidfielder = engine.teams.away.players.find((player) => player.position === "AM" && player.onField);
  const wingers = engine.teams.away.players.filter((player) => ["RW", "LW"].includes(player.position) && player.onField);
  const shallowestWinger = Math.max(...wingers.map((player) => player.targetX));
  assert.ok(Math.min(...wingers.map((player) => player.targetX)) >= striker.targetX + 3.2, `边锋应比中锋后撤：ST=${striker.targetX.toFixed(1)}, ${wingers.map((player) => `${player.position}:${player.targetX.toFixed(1)}`).join(", ")}`);
  assert.ok(attackingMidfielder.targetX >= shallowestWinger + 0.5, `前腰应比边锋再后撤：AM=${attackingMidfielder.targetX.toFixed(1)}, winger=${shallowestWinger.toFixed(1)}`);
});

test("球员追向远端目标时单 tick 位移保持连续", () => {
  const engine = createEngine("player-step-limit-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const runner = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  engine.ball = { x: runner.x, y: runner.y, vx: 0, vy: 0, holderTeam: "home", holderId: runner.id, targetX: 93, targetY: 4 };
  const before = { x: runner.x, y: runner.y };
  engine.updateDynamicTargets();
  engine.updatePlayers();
  const step = Math.hypot(runner.x - before.x, runner.y - before.y);
  assert.ok(step <= 0.75, `球员单 tick 位移过大：${step}`);
});

test("防守方最近非门将会向持球人主动上抢", () => {
  const engine = createEngine("defensive-press-target-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 74;
  holder.y = 68;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  const defender = nearestDefenderByBase(engine, "away", holder);
  const goalkeeper = engine.teams.away.players.find((player) => player.position === "GK" && player.onField);
  const baseGap = baseDistance(defender, holder);
  const baseLaneGap = Math.abs((defender.baseTargetY ?? defender.targetY) - holder.y);
  engine.updateDynamicTargets();
  const targetGap = targetDistance(defender, holder);
  const targetLaneGap = Math.abs(defender.targetY - holder.y);
  assert.ok(targetGap <= baseGap - 2, `最近防守人没有明显靠近持球人：${baseGap} -> ${targetGap}`);
  assert.ok(targetLaneGap < baseLaneGap, `最近防守人没有向持球通道收缩：${baseLaneGap} -> ${targetLaneGap}`);
  assert.ok(goalkeeper.targetX >= 84 && goalkeeper.targetX <= 95, `客队门将目标越界：${goalkeeper.targetX}`);
  assert.ok(goalkeeper.targetY >= 34 && goalkeeper.targetY <= 66, `客队门将纵向目标越界：${goalkeeper.targetY}`);
});

test("主队防守时同样会对客队持球人上抢", () => {
  const engine = createEngine("home-defensive-press-target-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  const holder = engine.teams.away.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 26;
  holder.y = 32;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "away", holderId: holder.id };
  const defender = nearestDefenderByBase(engine, "home", holder);
  const goalkeeper = engine.teams.home.players.find((player) => player.position === "GK" && player.onField);
  const baseGap = baseDistance(defender, holder);
  engine.updateDynamicTargets();
  const targetGap = targetDistance(defender, holder);
  assert.ok(targetGap <= baseGap - 2, `镜像防守人没有明显靠近持球人：${baseGap} -> ${targetGap}`);
  assert.ok(goalkeeper.targetX >= 5 && goalkeeper.targetX <= 16, `主队门将目标越界：${goalkeeper.targetX}`);
  assert.ok(goalkeeper.targetY >= 34 && goalkeeper.targetY <= 66, `主队门将纵向目标越界：${goalkeeper.targetY}`);
});

test("压迫强度会影响最近防守人的上抢距离", () => {
  const pressedGap = (intensity) => {
    const engine = createEngine(`pressing-intensity-${intensity}-test`);
    engine.changeState("in_play");
    engine.possessionTeam = "home";
    engine.teams.away.tactics.pressingIntensity = intensity;
    const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
    holder.x = 74;
    holder.y = 68;
    engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
    const defender = nearestDefenderByBase(engine, "away", holder);
    engine.updateDynamicTargets();
    return targetDistance(defender, holder);
  };
  const lowGap = pressedGap("low");
  const highGap = pressedGap("high");
  assert.ok(highGap + 0.4 < lowGap, `高压迫应比低压迫更贴近持球人：low=${lowGap}, high=${highGap}`);
});

/** 贴身逼抢也要保留最短真实距离，避免和持球人重叠。 */
test("最近防守人上抢时保持最短真实间距", () => {
  const engine = createEngine("press-display-gap-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  engine.teams.away.tactics.pressingIntensity = "high";
  const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 78;
  holder.y = 72;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  engine.updateDynamicTargets();
  const nearest = engine.teams.away.players
    .filter((player) => player.onField && player.position !== "GK")
    .map((player) => ({ player, gap: targetDistance(player, holder) }))
    .sort((left, right) => left.gap - right.gap)[0];
  assert.ok(nearest.gap >= 3.5, `最近防守人真实间距过短：${nearest.player.position}:${nearest.gap.toFixed(1)}`);
});

test("防守三区中场会回收到禁区前沿形成屏障", () => {
  const engine = createEngine("defensive-box-screen-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 84.2;
  holder.y = 49;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  engine.updateDynamicTargets();
  const screeners = engine.teams.away.players.filter((player) => ["DM", "CM"].includes(player.position) && player.onField);
  assert.ok(screeners.every((player) => player.targetX > 72 && player.targetX < holder.x), `防守中场没有回收到球外侧：${screeners.map((player) => `${player.position}:${player.targetX.toFixed(1)}`).join(", ")}`);
  const backLine = engine.teams.away.players.filter((player) => ["CB", "RB", "LB"].includes(player.position) && player.onField);
  assert.ok(backLine.some((player) => player.targetX > holder.x && Math.abs(player.targetY - holder.y) <= 8), `后卫线没有人在球门侧封线：${backLine.map((player) => `${player.position}:${player.targetX.toFixed(1)},${player.targetY.toFixed(1)}`).join(", ")}`);
});

test("定位球重启不会让足球瞬移到角球点", () => {
  const engine = createEngine("restart-ball-target-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  engine.ball = { x: 56.9, y: 41.5, vx: 0, vy: 0, holderTeam: "away", holderId: 6 };
  const values = [9 / 10, 0];
  engine.rng = { seed: "restart-target", next: () => values.shift() ?? 0 };
  const before = { x: engine.ball.x, y: engine.ball.y };
  engine.simulateBallOut("corner_kick");
  assert.equal(engine.state, "corner_kick");
  assert.deepEqual({ x: engine.ball.x, y: engine.ball.y }, before);
  assert.equal(engine.ball.targetX, 7);
  assert.ok([4, 96].includes(engine.ball.targetY));
  engine.updateDynamicTargets();
  engine.updatePlayers();
  const singleTickStep = Math.hypot(engine.ball.x - before.x, engine.ball.y - before.y);
  assert.ok(singleTickStep < 1, `定位球重启足球单 tick 位移过大：${singleTickStep}`);
});

test("普通球员传球不会把门将当作常规接球人", () => {
  const engine = createEngine("field-pass-excludes-goalkeeper-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const passer = engine.teams.home.players.find((player) => player.position !== "GK" && player.onField);
  engine.ball = { x: passer.x, y: passer.y, vx: 0, vy: 0, holderTeam: "home", holderId: passer.id };
  const values = [0, 0];
  engine.rng = { seed: "field-pass-excludes-goalkeeper", next: () => values.shift() ?? 0 };
  engine.simulatePass();
  const receiver = engine.teams.home.players.find((player) => player.id === engine.ball.pendingHolderId);
  assert.equal(engine.teams.home.stats.completedPasses, 1);
  assert.notEqual(receiver.position, "GK");
});

test("门将开球时仍能传给非门将队友", () => {
  const engine = createEngine("goalkeeper-pass-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const goalkeeper = engine.teams.home.players.find((player) => player.position === "GK" && player.onField);
  engine.ball = { x: goalkeeper.x, y: goalkeeper.y, vx: 0, vy: 0, holderTeam: "home", holderId: goalkeeper.id };
  const values = [0, 0];
  engine.rng = { seed: "goalkeeper-pass", next: () => values.shift() ?? 0 };
  engine.simulatePass();
  const receiver = engine.teams.home.players.find((player) => player.id === engine.ball.pendingHolderId);
  assert.equal(engine.lastPassSnapshot.passerId, goalkeeper.id);
  assert.notEqual(receiver.id, goalkeeper.id);
  assert.notEqual(receiver.position, "GK");
});

test("比赛中阵型调整只更新目标站位不瞬移当前坐标", () => {
  const engine = createEngine("smooth-formation-change-test");
  engine.changeState("in_play");
  for (let index = 0; index < 240; index += 1) engine.advanceTick();
  const before = engine.teams.away.players
    .filter((player) => player.onField && !player.sentOff)
    .map((player) => ({ id: player.id, x: player.x, y: player.y, targetX: player.targetX, targetY: player.targetY }));
  engine.applyTactics("away", { formation: "3-5-2", intent: "compact_counter" });
  const after = engine.teams.away.players.filter((player) => player.onField && !player.sentOff);
  for (const player of after) {
    const previous = before.find((item) => item.id === player.id);
    assert.equal(player.x, previous.x, `${player.id} 号球员阵型调整时不应重置 x 坐标`);
    assert.equal(player.y, previous.y, `${player.id} 号球员阵型调整时不应重置 y 坐标`);
  }
  const targetChanged = after.some((player) => {
    const previous = before.find((item) => item.id === player.id);
    return Math.hypot(player.targetX - previous.targetX, player.targetY - previous.targetY) > 0.1;
  });
  assert.ok(targetChanged, "阵型调整仍应更新球员目标站位");
});

test("比赛中换人不会重置其他场上球员当前坐标", () => {
  const engine = createEngine("smooth-substitution-test");
  engine.changeState("in_play");
  for (let index = 0; index < 240; index += 1) engine.advanceTick();
  const before = engine.teams.home.players
    .filter((player) => player.onField && !player.sentOff)
    .map((player) => ({ id: player.id, x: player.x, y: player.y, targetX: player.targetX, targetY: player.targetY, formationSlot: player.formationSlot }));
  const outPlayer = before.find((player) => player.id === 7);
  const result = engine.attemptSubstitution("home", 7, 18, "in_play");
  assert.equal(result.ok, true);
  const after = engine.teams.home.players.filter((player) => player.onField && !player.sentOff);
  const substitute = after.find((player) => player.id === 18);
  assert.equal(substitute.formationSlot, outPlayer.formationSlot);
  assert.equal(substitute.x, outPlayer.x);
  assert.equal(substitute.y, outPlayer.y);
  for (const player of after.filter((item) => item.id !== 18)) {
    const previous = before.find((item) => item.id === player.id);
    assert.equal(player.x, previous.x, `${player.id} 号球员换人时不应重置 x 坐标`);
    assert.equal(player.y, previous.y, `${player.id} 号球员换人时不应重置 y 坐标`);
  }
  const targetChanged = after.some((player) => {
    const previous = before.find((item) => item.id === player.id);
    return previous && Math.hypot(player.targetX - previous.targetX, player.targetY - previous.targetY) > 0.1;
  });
  assert.ok(targetChanged, "换人后仍应更新目标站位");
});

test("非门将不能直接换上替补门将", () => {
  const engine = createEngine("goalkeeper-substitution-rejected-test");
  engine.changeState("in_play");
  const result = engine.attemptSubstitution("home", 7, 12, "in_play");
  assert.equal(result.ok, false);
  assert.equal(engine.teams.home.players.find((player) => player.id === 7).onField, true);
  assert.equal(engine.teams.home.players.find((player) => player.id === 12).onField, false);
});

test("合法门将替补继承门将阵型槽位", () => {
  const engine = createEngine("goalkeeper-substitution-slot-test");
  engine.changeState("in_play");
  for (let index = 0; index < 120; index += 1) engine.advanceTick();
  const outgoing = engine.teams.home.players.find((player) => player.id === 1);
  const result = engine.attemptSubstitution("home", 1, 12, "in_play");
  assert.equal(result.ok, true);
  const substitute = engine.teams.home.players.find((player) => player.id === 12);
  const rightBack = engine.teams.home.players.find((player) => player.id === 2);
  assert.equal(substitute.formationSlot, outgoing.formationSlot);
  assert.equal(substitute.baseTargetX, 7);
  assert.equal(substitute.baseTargetY, 50);
  assert.equal(rightBack.baseTargetX, 22);
  assert.equal(rightBack.baseTargetY, 24);
});

test("比赛中红牌重平衡不会重置剩余球员当前坐标", () => {
  const engine = createEngine("smooth-red-card-test");
  engine.changeState("in_play");
  for (let index = 0; index < 240; index += 1) engine.advanceTick();
  const before = engine.teams.away.players
    .filter((player) => player.onField && !player.sentOff)
    .map((player) => ({ id: player.id, x: player.x, y: player.y, targetX: player.targetX, targetY: player.targetY }));
  engine.cardPlayer("away", 6, "red");
  assert.equal(engine.teams.away.formation, "4-4-1");
  const goalkeeper = engine.teams.away.players.find((player) => player.position === "GK" && player.onField && !player.sentOff);
  assert.equal(goalkeeper.baseTargetX, 93);
  assert.equal(goalkeeper.baseTargetY, 50);
  const after = engine.teams.away.players.filter((player) => player.onField && !player.sentOff);
  for (const player of after) {
    const previous = before.find((item) => item.id === player.id);
    assert.equal(player.x, previous.x, `${player.id} 号球员红牌重平衡时不应重置 x 坐标`);
    assert.equal(player.y, previous.y, `${player.id} 号球员红牌重平衡时不应重置 y 坐标`);
  }
  const targetChanged = after.some((player) => {
    const previous = before.find((item) => item.id === player.id);
    return Math.hypot(player.targetX - previous.targetX, player.targetY - previous.targetY) > 0.1;
  });
  assert.ok(targetChanged, "红牌重平衡仍应更新目标站位");
});

test("传球动作事件写入独立日志且不污染关键事件", () => {
  const engine = createEngine("action-event-pass-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const passer = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  engine.ball = { x: passer.x, y: passer.y, vx: 0, vy: 0, holderTeam: "home", holderId: passer.id };
  const values = [0, 0];
  engine.rng = { seed: "action-event-pass", next: () => values.shift() ?? 0 };
  engine.simulatePass();
  const action = engine.matchLog.action_event_log.at(-1);
  assert.equal(action.action_type, "pass_completed");
  assert.equal(action.actor.shirt, passer.shirt);
  assert.ok(action.target.shirt);
  assert.equal(action.trajectory.outcome, "completed");
  assert.ok(["ground_pass", "through_pass", "lofted_pass", "cross"].includes(action.trajectory.kind));
  assert.ok(Number.isFinite(action.trajectory.height));
  assert.deepEqual(Object.keys(action.trajectory.start).sort(), ["x", "y"]);
  assert.deepEqual(Object.keys(action.trajectory.end).sort(), ["x", "y"]);
  assert.ok(action.commentary.includes("主队"));
  assert.ok(action.commentary.includes("号"));
  assert.equal(engine.matchLog.match_event_log.some((event) => event.event_type === "pass_completed"), false);
  assert.ok(engine.snapshot().recent_action_events.some((event) => event.action_event_id === action.action_event_id));
});

test("持球推进达到阈值后生成一次推进播报", () => {
  const engine = createEngine("carry-action-event-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players.find((player) => player.position === "CM" && player.onField);
  holder.x = 40;
  holder.y = 50;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  engine.resetCarryTracker();
  engine.gameTime = 11;
  holder.x = 47;
  engine.ball.x = holder.x;
  engine.maybeLogCarryProgression();
  assert.equal(engine.matchLog.action_event_log.some((event) => event.action_type === "carry_progressive"), false);
  holder.x = 48.5;
  engine.ball.x = holder.x;
  engine.gameTime = 12;
  engine.maybeLogCarryProgression();
  const carries = engine.matchLog.action_event_log.filter((event) => event.action_type === "carry_progressive");
  assert.equal(carries.length, 1);
  assert.ok(carries[0].commentary.includes("带球向前推进"));
  holder.x = 57;
  engine.ball.x = holder.x;
  engine.gameTime = 15;
  engine.maybeLogCarryProgression();
  assert.equal(engine.matchLog.action_event_log.filter((event) => event.action_type === "carry_progressive").length, 1);
});

test("长时间推进中门将保持在本方门前活动区", () => {
  const engine = createEngine("goalkeeper-zone-test");
  engine.changeState("in_play");
  for (let index = 0; index < 6000; index += 1) {
    engine.advanceTick();
    for (const side of ["home", "away"]) {
      const goalkeeper = engine.teams[side].players.find((player) => player.position === "GK" && player.onField && !player.sentOff);
      if (!goalkeeper) continue;
      if (side === "home") assert.ok(goalkeeper.x >= 5 && goalkeeper.x <= 16, `主队门将越界：x=${goalkeeper.x}, tick=${engine.tick}`);
      else assert.ok(goalkeeper.x >= 84 && goalkeeper.x <= 95, `客队门将越界：x=${goalkeeper.x}, tick=${engine.tick}`);
      assert.ok(goalkeeper.y >= 34 && goalkeeper.y <= 66, `${side} 门将纵向越界：y=${goalkeeper.y}, tick=${engine.tick}`);
    }
  }
});
test("high press keeps a rest-defense back line behind the pressing front", () => {
  const engine = createEngine("high-press-rest-defense-shape-test");
  engine.changeState("in_play");
  engine.possessionTeam = "away";
  engine.teams.home.tactics = {
    ...engine.teams.home.tactics,
    pressingHeight: "high",
    pressingIntensity: "high",
    defensiveLine: "high",
    defensiveWidth: "narrow"
  };
  const holder = engine.teams.away.players.find((player) => player.position === "LB" && player.onField);
  holder.x = 90;
  holder.y = 72;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "away", holderId: holder.id };
  engine.updateDynamicTargets();
  const backLine = engine.teams.home.players.filter((player) => ["RB", "CB", "LB"].includes(player.position) && player.onField);
  const pressingFront = engine.teams.home.players.filter((player) => ["RW", "ST", "LW"].includes(player.position) && player.onField);
  const deepestBackTarget = Math.max(...backLine.map((player) => player.targetX));
  const shallowestPressingTarget = Math.min(...pressingFront.map((player) => player.targetX));
  assert.ok(deepestBackTarget <= 44, `back line overcommitted: ${backLine.map((player) => `${player.position}:${player.targetX.toFixed(1)}`).join(", ")}`);
  assert.ok(shallowestPressingTarget - deepestBackTarget >= 24, `pressing front and back line collapsed: back=${deepestBackTarget.toFixed(1)}, front=${shallowestPressingTarget.toFixed(1)}`);
});

test("away box defense targets keep readable spacing", () => {
  const engine = createEngine("away-box-target-separation-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  engine.teams.away.tactics = {
    ...engine.teams.away.tactics,
    pressingHeight: "low",
    pressingIntensity: "medium",
    defensiveLine: "low",
    defensiveWidth: "narrow"
  };
  const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 86;
  holder.y = 43;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  for (let index = 0; index < 16; index += 1) {
    engine.updateDynamicTargets();
    engine.updatePlayers();
  }
  const defenders = engine.teams.away.players.filter((player) => player.onField);
  const tightPairs = [];
  for (let i = 0; i < defenders.length; i += 1) {
    for (let j = i + 1; j < defenders.length; j += 1) {
      const targetGap = Math.hypot(defenders[i].targetX - defenders[j].targetX, defenders[i].targetY - defenders[j].targetY);
      const visualGap = Math.hypot(defenders[i].x - defenders[j].x, defenders[i].y - defenders[j].y);
      if (targetGap < 1.8 || visualGap < 1.05) tightPairs.push(`${defenders[i].position}${defenders[i].id}-${defenders[j].position}${defenders[j].id}:${targetGap.toFixed(2)}/${visualGap.toFixed(2)}`);
    }
  }
  assert.equal(tightPairs.length, 0, `away defenders should not visually overlap: ${tightPairs.join(", ")}`);
});

test("wide final-third attacks keep a central connector", () => {
  const engine = createEngine("central-connector-on-wide-attack-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  engine.teams.home.tactics = {
    ...engine.teams.home.tactics,
    attackingWidth: "wide",
    pressingHeight: "high"
  };
  const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 86;
  holder.y = 70;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  engine.updateDynamicTargets();
  const connector = engine.teams.home.players.find((player) => player.position === "DM" && player.onField);
  assert.ok(connector.targetX >= 45 && connector.targetX <= 60, `central connector depth drifted out: ${connector.targetX.toFixed(1)}`);
  assert.ok(connector.targetY >= 45 && connector.targetY <= 56, `central connector left the middle lane: ${connector.targetY.toFixed(1)}`);
});

test("defending team keeps a central screen outside the box", () => {
  const engine = createEngine("central-screen-on-deep-defense-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const holder = engine.teams.home.players.find((player) => player.position === "RW" && player.onField);
  holder.x = 86;
  holder.y = 70;
  engine.ball = { x: holder.x, y: holder.y, vx: 0, vy: 0, holderTeam: "home", holderId: holder.id };
  engine.updateDynamicTargets();
  const screeners = engine.teams.away.players.filter((player) => ["DM", "CM", "AM"].includes(player.position) && player.onField);
  const centralScreen = screeners.find((player) => player.targetX >= 68 && player.targetX <= 82 && player.targetY >= 45 && player.targetY <= 62);
  assert.ok(centralScreen, `defense left the central screen empty: ${screeners.map((player) => `${player.position}:${player.targetX.toFixed(1)},${player.targetY.toFixed(1)}`).join(", ")}`);
});

test("same-team players are separated after movement when they visually overlap", () => {
  const engine = createEngine("same-team-position-separation-test");
  engine.changeState("in_play");
  engine.possessionTeam = "home";
  const away = engine.teams.away.players;
  const centerBack = away.find((player) => player.position === "CB" && player.id === 3);
  const defensiveMidfielder = away.find((player) => player.position === "DM" && player.onField);
  centerBack.x = 88;
  centerBack.y = 44;
  centerBack.targetX = 88;
  centerBack.targetY = 44;
  defensiveMidfielder.x = 88.2;
  defensiveMidfielder.y = 44.1;
  defensiveMidfielder.targetX = 88.2;
  defensiveMidfielder.targetY = 44.1;
  engine.ball = { x: 82, y: 45, vx: 0, vy: 0, holderTeam: "home", holderId: 9 };
  engine.updatePlayers();
  const gap = Math.hypot(centerBack.x - defensiveMidfielder.x, centerBack.y - defensiveMidfielder.y);
  assert.ok(gap >= 1.05, `overlapping teammates were not separated enough: ${gap.toFixed(2)}`);
});

test("stamina drain scales to configured match length", () => {
  const engine = createEngine("stamina-scaled-match-test", { matchMinutes: 20 });
  const cost = engine.staminaTickCost({ pressingHeight: "high", pressingIntensity: "high", tempo: "fast" });
  const halfMatchDrain = cost * TICKS_PER_SECOND * 10 * 60;
  const fullMatchDrain = cost * TICKS_PER_SECOND * 20 * 60;
  assert.ok(halfMatchDrain < 18, `high press half-match stamina drain too high: ${halfMatchDrain}`);
  assert.ok(fullMatchDrain <= 34.1, `high press full-match stamina drain too high: ${fullMatchDrain}`);
});
