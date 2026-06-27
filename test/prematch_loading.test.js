import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CoachOrchestrator } from "../src/coachOrchestrator.js";
import { MatchEngine } from "../src/matchEngine.js";
import { createRng } from "../src/utils.js";

async function readFrontendSource() {
  const [app] = await Promise.all([readFile(new URL("../public/app.js", import.meta.url), "utf8")]);
  return app;
}

/** 本地规则教练赛前请求中，看板应暴露 request_started_at 供前端本地计时。 */
test("赛前请求中看板暴露 request_started_at，空闲时为 null", () => {
  const config = { homeCoach: { provider: "local", model: "rules-coach" }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed: "prematch-field" } };
  const engine = new MatchEngine(config, createRng("prematch-field"));
  const orchestrator = new CoachOrchestrator(engine, config);
  const idle = orchestrator.dashboard();
  assert.equal(idle.home.request_started_at, null, "空闲时 request_started_at 应为 null");
  assert.equal(idle.away.request_started_at, null, "空闲时 request_started_at 应为 null");
  assert.equal(idle.home.in_flight, false);
  orchestrator.scheduleIfNeeded("home", "pre_match");
  const requesting = orchestrator.dashboard();
  assert.equal(requesting.home.in_flight, true);
  assert.ok(requesting.home.request_started_at, "请求中 request_started_at 应非空");
  assert.notEqual(Number(new Date(requesting.home.request_started_at).getTime()), NaN, "request_started_at 应为合法 ISO 时间");
});

/** 前端应包含赛前覆盖层 DOM、本地计时与中文状态文案。 */
test("前端包含赛前覆盖层、本地计时与中文状态文案", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFrontendSource(),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.ok(html.includes('class="pre-match-overlay" id="preMatchOverlay"'));
  assert.ok(html.includes('id="preMatchTitle"'));
  assert.ok(html.includes('id="preMatchHome"'));
  assert.ok(html.includes('id="preMatchAway"'));
  assert.ok(app.includes("preMatchOverlay: document.getElementById"));
  assert.ok(app.includes("let preMatchTimer = null;"));
  assert.ok(app.includes("function renderPreMatch(state)"));
  assert.ok(app.includes("function startPreMatchTimer"));
  assert.ok(app.includes("function coachStatusText(status)"));
  assert.ok(app.includes("制定战术中"));
  assert.ok(app.includes("校验战术中"));
  assert.ok(app.includes("战术已就绪"));
  assert.ok(app.includes("双方教练正在制定战术"));
  assert.ok(app.includes("formatPreMatchElapsed"));
  assert.ok(styles.includes(".pre-match-overlay"));
  assert.ok(styles.includes("@keyframes pre-match-spin"));
  assert.ok(styles.includes(".pre-match-overlay.open"));
});

/** coach 消息在 snapshot 未到达时不应丢失，应被缓存待合并。 */
test("前端 coach 消息先于 snapshot 到达时被缓存", async () => {
  const app = await readFrontendSource();
  assert.ok(app.includes("let pendingCoachDashboard = null;"));
  assert.ok(app.includes("if (latest) latest = { ...latest, coach_dashboard: message.payload };"));
  assert.ok(app.includes("else pendingCoachDashboard = message.payload;"));
});
