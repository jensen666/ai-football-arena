import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { CoachOrchestrator, resolveChatEndpoint } from "../src/coachOrchestrator.js";
import { MatchEngine } from "../src/matchEngine.js";
import { MatchController } from "../src/matchController.js";
import { CONFIG_PATH } from "../src/storage.js";
import { createRng } from "../src/utils.js";

/** 用 mock fetch 替换全局 fetch，返回捕获到的请求记录，便于断言真实模型是否被调用。 */
function withMockFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test("resolveChatEndpoint 自动补全 chat completions 路径", () => {
  assert.equal(resolveChatEndpoint({ endpoint: "" }), "");
  assert.equal(resolveChatEndpoint({ endpoint: "https://api.example.com/v1" }), "https://api.example.com/v1/chat/completions");
  assert.equal(resolveChatEndpoint({ endpoint: "https://api.example.com/v1/" }), "https://api.example.com/v1/chat/completions");
  assert.equal(resolveChatEndpoint({ endpoint: "https://api.deepseek.com/chat/completions" }), "https://api.deepseek.com/chat/completions");
  assert.equal(resolveChatEndpoint({ endpoint: "https://api.deepseek.com/chat/completions/" }), "https://api.deepseek.com/chat/completions");
});

test("callCoach 在 provider=local 但有 endpoint 时调用真实模型而非规则教练", async () => {
  const { calls, restore } = withMockFetch(() => ({ ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }));
  try {
    const config = { homeCoach: { provider: "local", model: "mimo-v2.5", endpoint: "https://api.example.com/v1", api_key: "sk-test-routing" }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed: "routing" } };
    const engine = new MatchEngine(config, createRng("routing"));
    engine.start();
    const orchestrator = new CoachOrchestrator(engine, config);
    await orchestrator.callCoach("home", { summary: {} }, new AbortController().signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
    assert.match(calls[0].options.headers.Authorization, /^Bearer sk-test-routing$/);
    assert.ok(calls[0].options.body.includes("\"messages\""));
  } finally {
    restore();
  }
});

test("callCoach 在无 endpoint 时走规则教练且不调用 fetch", async () => {
  const { calls, restore } = withMockFetch(() => ({ ok: true, json: async () => ({}) }));
  try {
    const config = { homeCoach: { provider: "local", model: "rules-coach", endpoint: "" }, awayCoach: { provider: "local", model: "rules-coach" }, match: { seed: "no-endpoint" } };
    const engine = new MatchEngine(config, createRng("no-endpoint"));
    engine.start();
    const orchestrator = new CoachOrchestrator(engine, config);
    const decision = await orchestrator.callCoach("home", { summary: {} }, new AbortController().signal);
    assert.equal(calls.length, 0);
    assert.ok(decision);
  } finally {
    restore();
  }
});

test("updateConfig 运行时热更新进行中比赛的 orchestrator 配置", async () => {
  const original = await readFile(CONFIG_PATH, "utf8").catch(() => null);
  try {
    await rm(CONFIG_PATH, { force: true });
    const controller = new MatchController();
    await controller.init();
    controller.orchestrator = { config: null };
    await controller.updateConfig({ homeCoach: { provider: "mimo", model: "mimo-v2.5", endpoint: "https://api.example.com/v1", api_key: "sk-hot-update" }, awayCoach: { provider: "local", model: "rules-coach" }, match: {} });
    assert.equal(controller.orchestrator.config, controller.config);
    assert.equal(controller.config.homeCoach.endpoint, "https://api.example.com/v1");
    assert.equal(controller.config.homeCoach.api_key, "sk-hot-update");
  } finally {
    if (original === null) await rm(CONFIG_PATH, { force: true });
    else await writeFile(CONFIG_PATH, original, "utf8");
  }
});
