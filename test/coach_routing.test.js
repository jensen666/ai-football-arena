import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { CoachOrchestrator, extractModelIds, resolveChatEndpoint, resolveModelsEndpoint } from "../src/coachOrchestrator.js";
import { MatchEngine } from "../src/matchEngine.js";
import { MatchController } from "../src/matchController.js";
import { createRng } from "../src/utils.js";

process.env.FOOTBALL_CONFIG_PATH = path.join(os.tmpdir(), `afa-coach-config-${process.pid}.json`);
const CONFIG_PATH = process.env.FOOTBALL_CONFIG_PATH;

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

test("resolveModelsEndpoint 从 endpoint 推导 /models 路径", () => {
  assert.equal(resolveModelsEndpoint({ endpoint: "" }), "");
  assert.equal(resolveModelsEndpoint({ endpoint: "https://api.deepseek.com/v1" }), "https://api.deepseek.com/v1/models");
  assert.equal(resolveModelsEndpoint({ endpoint: "https://api.deepseek.com/v1/" }), "https://api.deepseek.com/v1/models");
  assert.equal(resolveModelsEndpoint({ endpoint: "https://api.deepseek.com/v1/chat/completions" }), "https://api.deepseek.com/v1/models");
  assert.equal(resolveModelsEndpoint({ endpoint: "https://api.deepseek.com/v1/chat/completions/" }), "https://api.deepseek.com/v1/models");
});

test("extractModelIds 提取并去重模型 id", () => {
  assert.deepEqual(extractModelIds({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }, {}, { id: "" }] }), ["model-a", "model-b"]);
  assert.deepEqual(extractModelIds({ data: ["model-x", "model-y"] }), ["model-x", "model-y"]);
  assert.deepEqual(extractModelIds([{ id: "model-z" }]), ["model-z"]);
  assert.deepEqual(extractModelIds({}), []);
  assert.deepEqual(extractModelIds(null), []);
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

test("updateConfig 在显式改用 env: 引用时清除已保存的原始密钥", async () => {
  const original = await readFile(CONFIG_PATH, "utf8").catch(() => null);
  try {
    await rm(CONFIG_PATH, { force: true });
    const controller = new MatchController();
    await controller.init();
    await controller.updateConfig({ homeCoach: { endpoint: "https://api.example.com/v1", api_key: "sk-saved-raw" }, awayCoach: {}, match: {} });
    assert.equal(controller.config.homeCoach.api_key, "sk-saved-raw");
    await controller.updateConfig({ homeCoach: { endpoint: "https://api.example.com/v1", api_key: "", api_key_ref: "env:MY_MODEL_KEY" }, awayCoach: {}, match: {} });
    assert.equal(controller.config.homeCoach.api_key, "");
    assert.equal(controller.config.homeCoach.api_key_ref, "env:MY_MODEL_KEY");
    // 增量更新省略 api_key_ref 时应保留已保存引用
    await controller.updateConfig({ homeCoach: { endpoint: "https://api.example.com/v1", api_key: "" }, awayCoach: {}, match: {} });
    assert.equal(controller.config.homeCoach.api_key_ref, "env:MY_MODEL_KEY");
  } finally {
    if (original === null) await rm(CONFIG_PATH, { force: true });
    else await writeFile(CONFIG_PATH, original, "utf8");
  }
});

test("updateConfig 增量更新未提交字段时保留现有教练配置", async () => {
  const original = await readFile(CONFIG_PATH, "utf8").catch(() => null);
  try {
    await rm(CONFIG_PATH, { force: true });
    const controller = new MatchController();
    await controller.init();
    await controller.updateConfig({ homeCoach: { endpoint: "https://api.example.com/v1", model: "model-a", api_key: "sk-keep-me" }, awayCoach: { endpoint: "https://api.example.com/v2", model: "model-b" }, match: {} });
    await controller.updateConfig({ match: { matchMinutes: 45 } });
    assert.equal(controller.config.homeCoach.endpoint, "https://api.example.com/v1");
    assert.equal(controller.config.homeCoach.model, "model-a");
    assert.equal(controller.config.homeCoach.api_key, "sk-keep-me");
    assert.equal(controller.config.awayCoach.endpoint, "https://api.example.com/v2");
    assert.equal(controller.config.match.matchMinutes, 45);
  } finally {
    if (original === null) await rm(CONFIG_PATH, { force: true });
    else await writeFile(CONFIG_PATH, original, "utf8");
  }
});
