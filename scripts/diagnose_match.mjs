import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const EDGE_PATH = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE_URL = process.env.FOOTBALL_BASE_URL || "http://127.0.0.1:3000";
const MATCH_MINUTES = Number(process.env.MATCH_MINUTES || 20);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 2000);
const SCREENSHOT_INTERVAL_MS = Number(process.env.SCREENSHOT_INTERVAL_MS || 5000);
const MAX_REAL_MS = Number(process.env.MAX_REAL_MS || Math.ceil(MATCH_MINUTES * 60 * 1000 * 1.45));
const RUN_ID = process.env.RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.resolve("cache", "diagnostics", RUN_ID);
const SHOT_DIR = path.join(OUT_DIR, "screenshots");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok || data.ok === false) throw new Error(data.error?.message || `${url} ${response.status}`);
  return data;
}

async function startMatch() {
  const current = await fetchJson(`${BASE_URL}/api/match/current`);
  if (current.match && current.match.state !== "full_time") await fetchJson(`${BASE_URL}/api/match/stop`, { method: "POST", body: "{}" });
  const { config } = await fetchJson(`${BASE_URL}/api/config`);
  const nextConfig = {
    ...config,
    match: {
      ...config.match,
      matchMinutes: MATCH_MINUTES,
      seed: `diagnostic-${RUN_ID}`,
      knockout: false
    }
  };
  const started = await fetchJson(`${BASE_URL}/api/match/start`, { method: "POST", body: JSON.stringify({ config: nextConfig }) });
  return started.match_id;
}

async function waitForCdp(port) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let index = 0; index < 80; index += 1) {
    try {
      const data = await fetchJson(endpoint);
      if (data.webSocketDebuggerUrl) return data;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Edge DevTools endpoint did not become ready");
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result || {});
      } else if (message.method) {
        this.events.push(message);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
    });
  }

  close() {
    this.ws?.close();
  }
}

async function launchBrowser() {
  const port = 9223 + Math.floor(Math.random() * 400);
  const profile = path.join(OUT_DIR, "edge-profile");
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--mute-audio",
    "--hide-scrollbars",
    "--window-size=1365,900",
    "about:blank"
  ];
  const process = spawn(EDGE_PATH, args, { stdio: "ignore", windowsHide: true });
  await waitForCdp(port);
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const pageTarget = targets.find((target) => target.type === "page") || targets[0];
  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable").catch(() => {});
  await cdp.send("Page.setViewport", {}).catch(() => {});
  await cdp.send("Page.navigate", { url: BASE_URL });
  await sleep(2500);
  return { process, cdp };
}

async function evalJson(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value ?? null;
}

async function collectUi(cdp) {
  return await evalJson(cdp, `(() => {
    const text = (id) => document.getElementById(id)?.textContent || "";
    const canvas = document.getElementById("pitchCanvas");
    let canvasStats = null;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlank = 0;
      let bright = 0;
      for (let i = 0; i < sample.length; i += 16) {
        const r = sample[i], g = sample[i + 1], b = sample[i + 2], a = sample[i + 3];
        if (a && (r || g || b)) nonBlank += 1;
        if (a && r + g + b > 520) bright += 1;
      }
      canvasStats = { width: canvas.width, height: canvas.height, nonBlank, bright };
    }
    return {
      url: location.href,
      homeName: text("homeName"),
      awayName: text("awayName"),
      homeScore: text("homeScore"),
      awayScore: text("awayScore"),
      matchTime: text("matchTime"),
      matchState: text("matchState"),
      reportStatus: text("reportStatus"),
      debug: window.__footballArenaDebug || null,
      canvasStats
    };
  })()`);
}

function pairDistance(left, right) {
  return Math.hypot((left.x ?? 0) - (right.x ?? 0), (left.y ?? 0) - (right.y ?? 0));
}

function snapshotIssues(match, ui) {
  const issues = [];
  if (!match) return ["missing_match_snapshot"];
  if (match.teams?.home?.players?.length !== 11 || match.teams?.away?.players?.length !== 11) issues.push("player_count_not_22");
  if (!match.ball || !Number.isFinite(match.ball.x) || !Number.isFinite(match.ball.y)) issues.push("ball_missing_or_invalid");
  else if (match.ball.x < -1 || match.ball.x > 101 || match.ball.y < -1 || match.ball.y > 101) issues.push(`ball_out_of_bounds:${match.ball.x.toFixed(1)},${match.ball.y.toFixed(1)}`);

  for (const side of ["home", "away"]) {
    const team = match.teams?.[side];
    if (!team) continue;
    const ids = new Set();
    for (const player of team.players || []) {
      if (ids.has(player.id)) issues.push(`${side}_duplicate_player_id:${player.id}`);
      ids.add(player.id);
      if (player.x < -1 || player.x > 101 || player.y < -1 || player.y > 101) issues.push(`${side}_player_out_of_bounds:${player.id}`);
      if (player.targetX < -1 || player.targetX > 101 || player.targetY < -1 || player.targetY > 101) issues.push(`${side}_target_out_of_bounds:${player.id}`);
    }
    const gk = team.players?.find((player) => player.position === "GK");
    if (gk) {
      const [minX, maxX] = side === "home" ? [4, 17] : [83, 96];
      if (gk.x < minX || gk.x > maxX || gk.y < 32 || gk.y > 68) issues.push(`${side}_goalkeeper_zone:${gk.x.toFixed(1)},${gk.y.toFixed(1)}`);
    }
    for (let i = 0; i < team.players.length; i += 1) {
      for (let j = i + 1; j < team.players.length; j += 1) {
        const gap = pairDistance(team.players[i], team.players[j]);
        if (gap < 1.05) issues.push(`${side}_visual_overlap:${team.players[i].id}-${team.players[j].id}:${gap.toFixed(2)}`);
      }
    }
  }

  if (ui) {
    if (!ui.matchTime || /总/.test(ui.matchTime)) issues.push(`bad_match_time:${ui.matchTime}`);
    if (ui.debug?.playerCount !== 22) issues.push(`debug_player_count:${ui.debug?.playerCount}`);
    if (ui.debug && ui.debug.ballVisible !== true) issues.push("debug_ball_not_visible");
    if (!ui.canvasStats || ui.canvasStats.nonBlank < 20000 || ui.canvasStats.bright < 200) issues.push("canvas_blank_or_under_rendered");
  }
  return issues;
}

function summarize(samples, consoleEvents, finalLog) {
  const issueCounts = {};
  for (const sample of samples) {
    for (const issue of sample.issues || []) issueCounts[issue.split(":")[0]] = (issueCounts[issue.split(":")[0]] || 0) + 1;
  }
  const final = samples.at(-1)?.match || null;
  const log = finalLog || {};
  const events = log.match_event_log || [];
  const decisions = log.model_decision_log || [];
  const goals = events.filter((event) => event.event_type === "goal");
  const shots = events.filter((event) => event.event_type === "shot" || event.event_type === "goal");
  const badDecisions = decisions.filter((decision) => decision.validation_result === "invalid" || decision.request_status === "error" || decision.fallback_used);
  const timeoutSafety = (log.safety_log || []).filter((item) => item.type === "model_timeout");
  const tickRefs = new Set((log.engine_tick_log || []).map((item) => item.tick));
  const eventsWithoutTick = events.filter((event) => !tickRefs.has(event.tick));
  return {
    run_id: RUN_ID,
    match_minutes: MATCH_MINUTES,
    sample_count: samples.length,
    screenshot_count: samples.filter((sample) => sample.screenshot).length,
    issue_counts: issueCounts,
    console_error_count: consoleEvents.filter((event) => event.method === "Runtime.exceptionThrown" || event.params?.type === "error").length,
    final_score: final?.score || null,
    final_state: final?.state || null,
    final_clock: final?.clock || null,
    match_log: {
      engine_ticks: log.engine_tick_log?.length || 0,
      events: events.length,
      actions: log.action_event_log?.length || 0,
      decisions: decisions.length,
      goals: goals.length,
      shots: shots.length,
      events_without_tick: eventsWithoutTick.length,
      bad_decisions: badDecisions.length,
      model_timeouts: timeoutSafety.length,
      safety_entries: log.safety_log?.length || 0
    }
  };
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "status.json"), JSON.stringify({ status: "starting", run_id: RUN_ID, started_at: new Date().toISOString() }, null, 2));
  const matchId = await startMatch();
  const { process: edgeProcess, cdp } = await launchBrowser();
  const samples = [];
  let lastScreenshotAt = 0;
  let stoppedByLimit = false;
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_REAL_MS) {
      const current = await fetchJson(`${BASE_URL}/api/match/current`);
      const match = current.match;
      const ui = await collectUi(cdp).catch((error) => ({ error: error.message }));
      let screenshot = null;
      if (Date.now() - lastScreenshotAt >= SCREENSHOT_INTERVAL_MS) {
        const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
        screenshot = `frame_${String(samples.length).padStart(4, "0")}_${String(Math.floor(match?.game_time || 0)).padStart(4, "0")}.png`;
        await writeFile(path.join(SHOT_DIR, screenshot), Buffer.from(capture.data, "base64"));
        lastScreenshotAt = Date.now();
      }
      const sample = {
        index: samples.length,
        at: new Date().toISOString(),
        screenshot,
        match,
        ui,
        issues: snapshotIssues(match, ui)
      };
      samples.push(sample);
      if (samples.length % 15 === 0) {
        await writeFile(path.join(OUT_DIR, "status.json"), JSON.stringify({ status: "running", run_id: RUN_ID, match_id: matchId, samples: samples.length, game_time: match?.display_time, state: match?.state, issue_samples: samples.filter((item) => item.issues?.length).length }, null, 2));
      }
      if (match?.state === "full_time" && match?.report_ready) break;
      await sleep(SNAPSHOT_INTERVAL_MS);
    }
    const current = await fetchJson(`${BASE_URL}/api/match/current`);
    if (current.match?.state !== "full_time") {
      stoppedByLimit = true;
      await fetchJson(`${BASE_URL}/api/match/stop`, { method: "POST", body: "{}" });
    }
  } finally {
    cdp.close();
    edgeProcess.kill();
  }

  let finalLog = null;
  try {
    finalLog = JSON.parse(await readFile(path.resolve("matches", matchId, "match_log.json"), "utf8"));
  } catch {}
  const consoleEvents = cdp.events;
  const analysis = { match_id: matchId, stopped_by_limit: stoppedByLimit, samples, summary: summarize(samples, consoleEvents, finalLog) };
  await writeFile(path.join(OUT_DIR, "console_events.json"), JSON.stringify(consoleEvents, null, 2));
  await writeFile(path.join(OUT_DIR, "analysis.json"), JSON.stringify(analysis, null, 2));
  await writeFile(path.join(OUT_DIR, "summary.md"), markdownSummary(analysis));
  await writeFile(path.join(OUT_DIR, "status.json"), JSON.stringify({ status: "complete", run_id: RUN_ID, match_id: matchId, summary: analysis.summary }, null, 2));
  console.log(JSON.stringify({ out_dir: OUT_DIR, match_id: matchId, summary: analysis.summary }, null, 2));
}

function markdownSummary(analysis) {
  const summary = analysis.summary;
  return [
    `# Diagnostic ${analysis.run_id}`,
    "",
    `- match_id: ${analysis.match_id}`,
    `- final_state: ${summary.final_state}`,
    `- final_score: ${JSON.stringify(summary.final_score)}`,
    `- samples: ${summary.sample_count}`,
    `- screenshots: ${summary.screenshot_count}`,
    `- stopped_by_limit: ${analysis.stopped_by_limit}`,
    "",
    "## Issue Counts",
    "",
    "```json",
    JSON.stringify(summary.issue_counts, null, 2),
    "```",
    "",
    "## Match Log",
    "",
    "```json",
    JSON.stringify(summary.match_log, null, 2),
    "```"
  ].join("\n");
}

main().catch(async (error) => {
  await mkdir(OUT_DIR, { recursive: true }).catch(() => {});
  await writeFile(path.join(OUT_DIR, "status.json"), JSON.stringify({ status: "error", run_id: RUN_ID, error: error.stack || error.message }, null, 2)).catch(() => {});
  console.error(error);
  process.exit(1);
});
