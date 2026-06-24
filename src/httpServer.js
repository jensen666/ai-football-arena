import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MatchController } from "./matchController.js";
import { WebSocketHub } from "./ws.js";
import { ensureRuntimeDirs, matchPaths, readJson } from "./storage.js";
import { redactSensitive } from "./utils.js";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const MAX_BODY_BYTES = 1_048_576;

/** 创建本地 HTTP 服务。 */
export function createServer() {
  const wsHub = new WebSocketHub();
  const controller = new MatchController((matchId, message) => wsHub.broadcast(matchId, message));
  const server = http.createServer(async (request, response) => {
    try {
      await ensureRuntimeDirs();
      await routeRequest(request, response, controller);
    } catch (error) {
      sendJson(response, error.status || 500, { ok: false, error: { code: error.code || "internal_error", message: error.message || "服务内部错误" } });
    }
  });
  server.on("upgrade", (request, socket, head) => wsHub.handleUpgrade(request, socket, head, (matchId) => {
    const current = controller.current();
    return current?.match_id === matchId ? current : null;
  }));
  controller.init().catch((error) => console.error("配置初始化失败", error));
  return server;
}

/** 路由请求。 */
async function routeRequest(request, response, controller) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) return await routeApi(request, response, controller, url);
  return await serveStatic(response, url.pathname);
}

/** 路由 API。 */
async function routeApi(request, response, controller, url) {
  if (request.method === "GET" && url.pathname === "/api/config") return sendJson(response, 200, { ok: true, config: await controller.getConfig() });
  if (request.method === "POST" && url.pathname === "/api/config") return sendJson(response, 200, { ok: true, config: await controller.updateConfig(await readBody(request)) });
  if (request.method === "POST" && url.pathname === "/api/model/test") return sendJson(response, 200, { ok: true, result: await controller.testModel(await readBody(request)) });
  if (request.method === "POST" && url.pathname === "/api/match/start") return sendJson(response, 200, { ok: true, ...(await controller.start((await readBody(request)).config)) });
  if (request.method === "POST" && url.pathname === "/api/match/pause") return sendJson(response, 200, { ok: true, match: controller.pause() });
  if (request.method === "POST" && url.pathname === "/api/match/resume") return sendJson(response, 200, { ok: true, match: controller.resume() });
  if (request.method === "POST" && url.pathname === "/api/match/stop") return sendJson(response, 200, { ok: true, match: await controller.stop() });
  if (request.method === "GET" && url.pathname === "/api/match/current") return sendJson(response, 200, { ok: true, match: controller.current() });
  if (request.method === "GET" && url.pathname.startsWith("/api/reports/")) return await sendReport(response, url.pathname.split("/").pop());
  sendJson(response, 404, { ok: false, error: { code: "not_found", message: "接口不存在" } });
}

/** 发送报告。 */
async function sendReport(response, matchId) {
  const paths = matchPaths(matchId);
  try {
    const [summary, report, log] = await Promise.all([readFile(paths.summary, "utf8"), readFile(paths.report, "utf8"), readJson(paths.matchLog)]);
    sendJson(response, 200, { ok: true, match_id: matchId, summary, report, log: redactSensitive(log) });
  } catch {
    sendJson(response, 404, { ok: false, error: { code: "report_not_found", message: "报告尚未生成" } });
  }
}

/** 提供静态资源。 */
async function serveStatic(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath).replace(/^([/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(response, 403, "Forbidden");
  try {
    const data = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeType(filePath), "Cache-Control": "no-store" });
    response.end(data);
  } catch {
    sendText(response, 404, "Not found");
  }
}

/** 读取 JSON 请求体。 */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求体超过 1MB 限制");
      error.status = 413;
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是合法 JSON");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
}

/** 发送 JSON 响应。 */
function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(redactSensitive(data)));
}

/** 发送文本响应。 */
function sendText(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

/** 判断静态资源 MIME。 */
function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}
