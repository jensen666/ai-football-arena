import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { CoachOrchestrator, resolveApiKey } from "../src/coachOrchestrator.js";
import { MatchEngine } from "../src/matchEngine.js";
import { saveMatchArtifacts } from "../src/reporting.js";
import { matchPaths, sanitizeConfig } from "../src/storage.js";
import { containsSensitiveText, createRng, redactSensitive } from "../src/utils.js";

const SECRET = "sk-test-secret-should-not-leak";

function setup() {
  const config = { homeCoach: { provider: "local", model: "rules-coach", api_key: SECRET, api_key_ref: "env:DEEPSEEK_API_KEY" }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed: "safety", homeFormation: "4-3-3", awayFormation: "4-2-3-1" } };
  const engine = new MatchEngine(config, createRng("safety"));
  engine.start();
  return { config, engine, orchestrator: new CoachOrchestrator(engine, config) };
}

test("配置、日志和报告不会泄漏明文 API Key", async () => {
  const { config, engine, orchestrator } = setup();
  const safeConfig = sanitizeConfig(config, [SECRET]);
  assert.equal(containsSensitiveText(safeConfig, [SECRET]), false);
  engine.matchLog.safety_log.push({ tick: 1, type: "secret_redacted", message: `密钥 ${SECRET} 已处理` });
  engine.matchLog.model_decision_log.push({
    decision_id: "raw_test",
    raw_model_output_ref: "raw_outputs/raw_test.txt",
    raw_model_output: `{"decision":"keep raw","secret":"${SECRET}"}`,
    parsed_decision_json: { intent: "control_possession" }
  });
  const artifacts = await saveMatchArtifacts(engine, orchestrator, [SECRET]);
  try {
    const log = await readFile(artifacts.paths.matchLog, "utf8");
    const summary = await readFile(artifacts.paths.summary, "utf8");
    const report = await readFile(artifacts.paths.report, "utf8");
    const raw = await readFile(`${artifacts.paths.rawOutputDir}/raw_test.txt`, "utf8");
    assert.equal(log.includes(SECRET), false);
    assert.equal(summary.includes(SECRET), false);
    assert.equal(report.includes(SECRET), false);
    assert.equal(raw.includes("keep raw"), true);
    assert.equal(raw.includes(SECRET), false);
  } finally {
    await rm(matchPaths(engine.matchId).matchDir, { recursive: true, force: true });
    await rm(matchPaths(engine.matchId).reportDir, { recursive: true, force: true });
  }
});

test("非 sk 格式保存密钥也不会进入日志和报告", async () => {
  const plainSecret = "plain-local-secret-12345";
  const config = { homeCoach: { provider: "local", model: "rules-coach", api_key: plainSecret }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed: "plain-secret", homeFormation: "4-3-3", awayFormation: "4-2-3-1" } };
  const engine = new MatchEngine(config, createRng("plain-secret"));
  engine.start();
  const orchestrator = new CoachOrchestrator(engine, config);
  engine.matchLog.safety_log.push({ tick: 1, type: "secret_redacted", message: `密钥 ${plainSecret} 已处理` });
  const artifacts = await saveMatchArtifacts(engine, orchestrator, [plainSecret]);
  try {
    const log = await readFile(artifacts.paths.matchLog, "utf8");
    const summary = await readFile(artifacts.paths.summary, "utf8");
    const report = await readFile(artifacts.paths.report, "utf8");
    assert.equal(log.includes(plainSecret), false);
    assert.equal(summary.includes(plainSecret), false);
    assert.equal(report.includes(plainSecret), false);
  } finally {
    await rm(matchPaths(engine.matchId).matchDir, { recursive: true, force: true });
    await rm(matchPaths(engine.matchId).reportDir, { recursive: true, force: true });
  }
});

test("模型输出越权字段不会进入权威状态", () => {
  const { engine } = setup();
  const beforeScore = engine.teams.home.score;
  engine.applyTactics("home", { intent: "high_press", riskLevel: 1, formation: "4-3-3", pressingHeight: "high" });
  assert.equal(engine.teams.home.score, beforeScore);
});

test("脱敏保留模型 token 统计并隐藏密钥引用", () => {
  const safe = redactSensitive({ api_key: SECRET, api_key_ref: "env:DEEPSEEK_API_KEY", api_key_set: true, access_token: "secret-token-value", input_tokens: 12, total_tokens: 34, last_tokens: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } }, [SECRET]);
  assert.equal(safe.api_key, "[已脱敏]");
  assert.equal(safe.api_key_ref, "env:DEE***");
  assert.equal(safe.api_key_set, true);
  assert.equal(safe.access_token, "[已脱敏]");
  assert.equal(safe.input_tokens, 12);
  assert.equal(safe.total_tokens, 34);
  assert.deepEqual(safe.last_tokens, { input_tokens: 5, output_tokens: 7, total_tokens: 12 });
});

test("模型调用优先读取本地保存的 API Key", () => {
  assert.equal(resolveApiKey({ api_key: SECRET, api_key_ref: "env:DEEPSEEK_API_KEY" }), SECRET);
});
