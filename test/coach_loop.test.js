import test from "node:test";
import assert from "node:assert/strict";
import { CoachOrchestrator } from "../src/coachOrchestrator.js";
import { MatchEngine } from "../src/matchEngine.js";
import { createRng } from "../src/utils.js";

/** 构造一场使用本地规则教练（endpoint 为空）的测试比赛。 */
function setup(seed = "coach-loop-no-self-excite") {
  const config = {
    homeCoach: { provider: "local", model: "rules-coach", endpoint: "" },
    awayCoach: { provider: "local", model: "rules-coach", endpoint: "" },
    match: { seed, knockout: false, homeFormation: "4-3-3", awayFormation: "4-2-3-1" }
  };
  const engine = new MatchEngine(config, createRng(seed));
  engine.start();
  return { engine, orchestrator: new CoachOrchestrator(engine, config) };
}

/** 本地规则教练毫秒级返回时，事件触发必须节流，不能每个 tick 反复请求-应用-再请求。 */
test("本地规则教练在 300 tick 内不会形成教练自激循环", async () => {
  const { engine, orchestrator } = setup();
  await orchestrator.start();
  for (let index = 0; index < 300; index += 1) {
    engine.advanceTick();
    orchestrator.tick();
    // 让本地规则教练的 async 请求在下一个宏任务前完成结算；用 setImmediate 而非 setTimeout(0)，
    // 因为 Windows 定时器精度约 15.6ms，setTimeout(0) 会把 300 tick 拖到 4 秒以上。
    await new Promise((resolve) => setImmediate(resolve));
  }
  const tacticAppliedCount = engine.matchLog.match_event_log.filter((event) => event.event_type === "tactic_applied").length;
  assert.ok(engine.matchLog.model_decision_log.length <= 10, `300 tick 内模型决策次数过多（疑似自激）：${engine.matchLog.model_decision_log.length}`);
  assert.ok(tacticAppliedCount <= 10, `300 tick 内 tactic_applied 次数过多（疑似自激）：${tacticAppliedCount}`);
  assert.equal(orchestrator.state.home.inFlight, false);
  assert.equal(orchestrator.state.away.inFlight, false);
  assert.ok(engine.tick >= 300);
});

test("tactic_applied 不进入教练待处理事件队列，且每侧队列最多保留 30 条", () => {
  const { engine } = setup("coach-event-queue-limit");
  engine.applyTactics("home", { ...engine.teams.home.tactics, intent: "counter" }, null);
  assert.ok(engine.matchLog.match_event_log.some((event) => event.event_type === "tactic_applied"), "战术应用仍应写入比赛日志");
  assert.equal(engine.pendingEvents.home.some((event) => event.event_type === "tactic_applied"), false, "战术应用不应进入待处理事件队列");
  for (let index = 0; index < 40; index += 1) engine.logEvent("goal", "home", 9, `测试事件 ${index}`, {});
  assert.ok(engine.pendingEvents.home.length <= 30, `主队待处理事件超过上限：${engine.pendingEvents.home.length}`);
  assert.ok(engine.pendingEvents.away.length <= 30, `客队待处理事件超过上限：${engine.pendingEvents.away.length}`);
  assert.equal(engine.pendingEvents.home.at(-1).description, "测试事件 39", "队列应保留最新事件");
});

test("engine_tick_log 只保留最近 4000 条", () => {
  const { engine } = setup("coach-tick-log-limit");
  engine.matchLog.engine_tick_log.length = 0;
  for (let tick = 1; tick <= 4200; tick += 1) {
    engine.tick = tick;
    engine.recordTick(true);
  }
  assert.equal(engine.matchLog.engine_tick_log.length, 4000);
  assert.equal(engine.matchLog.engine_tick_log[0].tick, 201);
  assert.equal(engine.matchLog.engine_tick_log.at(-1).tick, 4200);
});
