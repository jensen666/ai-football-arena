import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "../src/httpServer.js";
import { CONFIG_PATH, matchPaths, mergeConfig } from "../src/storage.js";

async function startServer() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  return { response, data };
}

function waitForWs(ws, type, predicate = () => true, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null, new Error(`等待 WebSocket ${type} 超时`)), timeout);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === type && predicate(message)) finish(message);
    };
    const onError = () => finish(null, new Error("WebSocket 连接失败"));
    const finish = (message, error = null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      error ? reject(error) : resolve(message);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
  });
}

test("配置合并会规范化本地演示比赛时长", () => {
  assert.equal(mergeConfig({}).match.matchMinutes, 90);
  assert.equal(mergeConfig({ match: { matchMinutes: 12 } }).match.matchMinutes, 12);
  for (const invalid of ["", "abc", 0, -1, 1.5, 91]) {
    assert.equal(mergeConfig({ match: { matchMinutes: invalid } }).match.matchMinutes, 90);
  }
});

test("HTTP API 支持配置脱敏、开始、暂停、恢复、停止和报告读取", async () => {
  let server = null;
  let baseUrl = "";
  let matchId = null;
  let ws = null;
  let originalConfig = null;
  try {
    try {
      originalConfig = await readFile(CONFIG_PATH, "utf8");
    } catch {}
    await rm(CONFIG_PATH, { force: true });
    ({ server, baseUrl } = await startServer());
    const configResponse = await request(baseUrl, "/api/config");
    assert.equal(configResponse.response.status, 200);
    assert.equal(Object.hasOwn(configResponse.data.config.homeCoach, "api_key"), false);
    assert.equal(configResponse.data.config.match.matchMinutes, 90);

    const config = configResponse.data.config;
    const secret = "sk-test-secret-should-not-leak";
    config.homeCoach.api_key = secret;
    config.match.matchMinutes = 12;
    const saved = await request(baseUrl, "/api/config", { method: "POST", body: JSON.stringify(config) });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.config.homeCoach.api_key_set, true);
    assert.equal(saved.data.config.match.matchMinutes, 12);
    assert.equal(JSON.stringify(saved.data).includes(secret), false);
    assert.equal((await readFile(CONFIG_PATH, "utf8")).includes(secret), true);
    const hidden = await request(baseUrl, "/api/config");
    assert.equal(hidden.data.config.homeCoach.api_key_set, true);
    assert.equal(hidden.data.config.match.matchMinutes, 12);
    assert.equal(JSON.stringify(hidden.data).includes(secret), false);

    const startConfig = structuredClone(config);
    delete startConfig.homeCoach.api_key;
    const started = await request(baseUrl, "/api/match/start", { method: "POST", body: JSON.stringify({ config: startConfig }) });
    assert.equal(started.response.status, 200);
    matchId = started.data.match_id;
    assert.ok(started.data.ws_url.includes(matchId));

    const duplicate = await request(baseUrl, "/api/match/start", { method: "POST", body: JSON.stringify({ config: startConfig }) });
    assert.equal(duplicate.response.status, 409);

    ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/match/${matchId}`);
    const snapshotMessage = await waitForWs(ws, "snapshot");
    assert.equal(snapshotMessage.match_id, matchId);
    const commentaryMessage = await waitForWs(ws, "commentary", (message) => Boolean(message.payload?.commentary && message.payload?.action_type && Number.isFinite(message.payload?.game_time)), 8000);
    assert.equal(commentaryMessage.match_id, matchId);
    assert.ok(commentaryMessage.payload.action_event_id);
    assert.ok(commentaryMessage.payload.tick > 0);
    assert.equal(JSON.stringify(commentaryMessage).includes(secret), false);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const pausedEvent = waitForWs(ws, "event", (message) => message.payload.event_type === "match_paused");
    const paused = await request(baseUrl, "/api/match/pause", { method: "POST", body: "{}" });
    assert.equal((await pausedEvent).payload.event_type, "match_paused");
    const pausedTime = paused.data.match.game_time;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const currentPaused = await request(baseUrl, "/api/match/current");
    assert.equal(currentPaused.data.match.game_time, pausedTime);

    const resumed = await request(baseUrl, "/api/match/resume", { method: "POST", body: "{}" });
    assert.equal(resumed.response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const currentRunning = await request(baseUrl, "/api/match/current");
    assert.ok(currentRunning.data.match.game_time > pausedTime);

    const stopped = await request(baseUrl, "/api/match/stop", { method: "POST", body: "{}" });
    assert.equal(stopped.response.status, 200);
    const report = await request(baseUrl, `/api/reports/${matchId}`);
    assert.equal(report.response.status, 200);
    assert.ok(report.data.summary.includes("赛后总结"));
    assert.equal(JSON.stringify(report.data).includes("sk-test-secret-should-not-leak"), false);
  } finally {
    ws?.close();
    server?.close();
    if (originalConfig === null) await rm(CONFIG_PATH, { force: true });
    else await writeFile(CONFIG_PATH, originalConfig, "utf8");
    if (matchId) {
      const paths = matchPaths(matchId);
      await rm(paths.matchDir, { recursive: true, force: true });
      await rm(paths.reportDir, { recursive: true, force: true });
    }
  }
});

test("HTTP API 对非法 JSON 返回 400", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.error.code, "invalid_json");
  } finally {
    server.close();
  }
});
