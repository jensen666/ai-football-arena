import test from "node:test";
import assert from "node:assert/strict";
import { MatchEngine } from "../src/matchEngine.js";
import { createRng } from "../src/utils.js";

function run(seed, ticks = 3000) {
  const config = { homeCoach: { provider: "local" }, awayCoach: { provider: "local" }, match: { seed, homeFormation: "4-3-3", awayFormation: "4-2-3-1" } };
  const engine = new MatchEngine(config, createRng(seed));
  engine.start();
  for (let index = 0; index < ticks; index += 1) engine.advanceTick();
  return {
    score: engine.snapshot().score,
    events: engine.matchLog.match_event_log.map((event) => [event.tick, event.event_type, event.team_id, event.player_id]),
    ticks: engine.matchLog.engine_tick_log.map((item) => item.tick)
  };
}

test("同一 seed 和本地规则流程产生相同关键事件序列", () => {
  const first = run("same-seed");
  const second = run("same-seed");
  assert.deepEqual(first.score, second.score);
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.ticks, second.ticks);
});

test("不同 seed 允许关键事件序列不同", () => {
  const first = run("seed-a");
  const second = run("seed-b");
  assert.notDeepEqual(first.events, second.events);
});
