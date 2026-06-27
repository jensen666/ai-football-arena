import { clearVisualEffects, cloneDrawState, drawPitch, initPitchRenderer, mockState, queueVisualEffect } from "./pitchRenderer.js";

const canvas = document.getElementById("pitchCanvas");
const ui = collectUi();
let config = null;
let latest = null;
let renderState = null;
let socket = null;
let socketVersion = 0;
let reconnectTimer = null;
let currentMatchId = null;
let startingMatch = false;
let reportCache = null;
let coachSummaryMatchId = null;
let lastCoachSummaries = { home: null, away: null };
let commentaryFeed = [];
let fps = 60;
let frameTimes = [];
const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const COMMENTARY_LIMIT = 12;
window.__footballArenaDebug = { fps, latestState: null, playerCount: 0, ballVisible: false, commentaryCount: 0, latestCommentary: null, visualEffectCount: 0 };
initPitchRenderer(canvas, window.__footballArenaDebug);

init();
requestAnimationFrame(drawLoop);

/** 初始化页面。 */
async function init() {
  bindEvents();
  await loadConfig();
  await loadCurrentMatch();
  updateControls();
}

/** 收集页面元素。 */
function collectUi() {
  return {
    homeName: document.getElementById("homeName"), awayName: document.getElementById("awayName"), homeScore: document.getElementById("homeScore"), awayScore: document.getElementById("awayScore"), matchTime: document.getElementById("matchTime"), matchState: document.getElementById("matchState"), matchSummary: document.getElementById("matchSummary"),
    startBtn: document.getElementById("startBtn"), pauseBtn: document.getElementById("pauseBtn"), resumeBtn: document.getElementById("resumeBtn"), restartBtn: document.getElementById("restartBtn"), stopBtn: document.getElementById("stopBtn"), reportBtn: document.getElementById("reportBtn"),
    settingsOpen: document.getElementById("settingsOpen"), settingsClose: document.getElementById("settingsClose"), settingsModal: document.getElementById("settingsModal"), settingsForm: document.getElementById("settingsForm"), settingsMessage: document.getElementById("settingsMessage"), homeKeyStatus: document.getElementById("homeKeyStatus"), awayKeyStatus: document.getElementById("awayKeyStatus"), testHomeBtn: document.getElementById("testHomeBtn"), testAwayBtn: document.getElementById("testAwayBtn"),
    coachDashboard: document.getElementById("coachDashboard"), tacticPanel: document.getElementById("tacticPanel"), modelStats: document.getElementById("modelStats"), commentaryFeed: document.getElementById("commentaryFeed"), eventTimeline: document.getElementById("eventTimeline"), matchStats: document.getElementById("matchStats"), reportStatus: document.getElementById("reportStatus"),
    reportModal: document.getElementById("reportModal"), reportClose: document.getElementById("reportClose"), reportContent: document.getElementById("reportContent")
  };
}

/** 绑定交互事件。 */
function bindEvents() {
  ui.settingsOpen.addEventListener("click", () => openModal(ui.settingsModal));
  ui.settingsClose.addEventListener("click", () => closeModal(ui.settingsModal));
  ui.reportClose.addEventListener("click", () => closeModal(ui.reportModal));
  ui.settingsModal.addEventListener("click", (event) => {
    if (event.target !== ui.settingsModal) return;
    if (!ui.settingsForm.checkValidity()) {
      showSettingsValidationMessage();
      return;
    }
    closeModal(ui.settingsModal);
  });
  ui.reportModal.addEventListener("click", (event) => { if (event.target === ui.reportModal) closeModal(ui.reportModal); });
  ui.settingsForm.addEventListener("submit", saveSettings);
  ui.testHomeBtn.addEventListener("click", () => testModel("home"));
  ui.testAwayBtn.addEventListener("click", () => testModel("away"));
  ui.startBtn.addEventListener("click", startMatch);
  ui.pauseBtn.addEventListener("click", () => postControl("pause"));
  ui.resumeBtn.addEventListener("click", () => postControl("resume"));
  ui.restartBtn.addEventListener("click", restartMatch);
  ui.stopBtn.addEventListener("click", stopMatch);
  ui.reportBtn.addEventListener("click", openReport);
}

/** 读取本地配置。 */
async function loadConfig() {
  const data = await fetchJson("/api/config");
  config = data.config;
  fillForm(config);
  updateConfigSummary();
}

/** 读取当前比赛。 */
async function loadCurrentMatch() {
  const data = await fetchJson("/api/match/current");
  if (data.match) {
    latest = data.match;
    currentMatchId = latest.match_id;
    replaceCommentaryFeed(latest.recent_action_events || []);
    if (isMatchRunning()) connectWs(`/ws/match/${currentMatchId}`);
    updateUi();
  } else {
    resetClientMatchState("服务已重启，当前没有正在运行的比赛。");
  }
}

function resetClientMatchState(message = "当前没有正在运行的比赛。") {
  disconnectWs();
  latest = null;
  renderState = null;
  currentMatchId = null;
  startingMatch = false;
  reportCache = null;
  replaceCommentaryFeed([]);
  clearVisualEffects();
  resetCoachSummaryCache(null);
  updateConfigSummary();
  ui.homeScore.textContent = "0";
  ui.awayScore.textContent = "0";
  ui.matchTime.textContent = defaultClockText();
  ui.matchState.textContent = "未开始";
  ui.coachDashboard.innerHTML = "";
  ui.tacticPanel.innerHTML = "";
  ui.modelStats.innerHTML = "";
  ui.eventTimeline.innerHTML = "<div class=\"event\"><strong>--</strong>等待比赛事件</div>";
  ui.matchStats.innerHTML = "";
  ui.reportStatus.textContent = message;
  window.__footballArenaDebug.latestState = null;
  updateControls();
}

/** 保存设置。 */
async function saveSettings(event) {
  event.preventDefault();
  config = formConfig();
  const data = await fetchJson("/api/config", { method: "POST", body: JSON.stringify(config) });
  config = data.config;
  fillForm(config);
  updateConfigSummary();
  ui.settingsMessage.textContent = "设置已保存。";
}

/** 测试模型连接。 */
async function testModel(side) {
  const nextConfig = formConfig();
  const coach = side === "home" ? nextConfig.homeCoach : nextConfig.awayCoach;
  const data = await fetchJson("/api/model/test", { method: "POST", body: JSON.stringify({ side, coach }) });
  ui.settingsMessage.textContent = `${side === "home" ? "主队" : "客队"}连接测试：${data.result.message}`;
}

/** 开始比赛。 */
async function startMatch() {
  if (isMatchRunning() || startingMatch) {
    ui.reportStatus.textContent = "比赛正在启动或运行，无需重复开始。";
    return;
  }
  if (!ui.settingsForm.checkValidity()) {
    openModal(ui.settingsModal);
    showSettingsValidationMessage();
    return;
  }
  startingMatch = true;
  ui.reportStatus.textContent = "比赛启动中...";
  updateControls();
  try {
    config = formConfig();
    const data = await fetchJson("/api/match/start", { method: "POST", body: JSON.stringify({ config }) });
    currentMatchId = data.match_id;
    reportCache = null;
    replaceCommentaryFeed([]);
    resetCoachSummaryCache(currentMatchId);
    connectWs(data.ws_url);
    ui.reportStatus.textContent = "比赛运行中，报告将在停止或完场后生成。";
  } catch (error) {
    startingMatch = false;
    ui.reportStatus.textContent = `比赛启动失败：${error.message}`;
    updateControls();
  }
}

/** 暂停或恢复比赛。 */
async function postControl(action) {
  const data = await fetchJson(`/api/match/${action}`, { method: "POST", body: "{}" });
  latest = data.match;
  updateUi();
}

/** 停止比赛。 */
async function stopMatch() {
  const data = await fetchJson("/api/match/stop", { method: "POST", body: "{}" });
  latest = data.match;
  reportCache = null;
  mergeCommentaryEvents(latest.recent_action_events || []);
  disconnectWs();
  ui.reportStatus.textContent = "报告已生成：match_log.json、summary.md、report.md。";
  updateUi();
}

/** 重新开始比赛：先停止当前比赛（生成报告），再使用最新配置开启新比赛。 */
async function restartMatch() {
  if (startingMatch) {
    ui.reportStatus.textContent = "比赛正在启动，请稍候再试。";
    return;
  }
  if (!ui.settingsForm.checkValidity()) {
    openModal(ui.settingsModal);
    showSettingsValidationMessage();
    return;
  }
  startingMatch = true;
  ui.reportStatus.textContent = "正在重新开始比赛...";
  updateControls();
  try {
    config = formConfig();
    disconnectWs();
    const data = await fetchJson("/api/match/restart", { method: "POST", body: JSON.stringify({ config }) });
    reportCache = null;
    replaceCommentaryFeed([]);
    resetCoachSummaryCache(data.match_id);
    currentMatchId = data.match_id;
    connectWs(data.ws_url);
    const reused = data.restarted_from ? `（已结束上一场 ${data.restarted_from}）` : "";
    ui.reportStatus.textContent = `新比赛已启动 ${reused}，报告将在停止或完场后生成。`;
  } catch (error) {
    startingMatch = false;
    ui.reportStatus.textContent = `重新开始失败：${error.message}`;
    updateControls();
  }
}

/** 打开报告。 */
async function openReport() {
  if (!currentMatchId && !latest?.match_id) return;
  const matchId = currentMatchId || latest.match_id;
  if (!reportCache) {
    const data = await fetchJson(`/api/reports/${matchId}`);
    reportCache = `${data.summary}\n\n---\n\n${data.report}`;
  }
  ui.reportContent.textContent = reportCache;
  openModal(ui.reportModal);
}

/** 连接 WebSocket。 */
function connectWs(url) {
  const version = ++socketVersion;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) socket.close();
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${url}`;
  socket = new WebSocket(wsUrl);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.match_id) currentMatchId = message.match_id;
    if (message.payload?.teams?.home && message.payload?.teams?.away) {
      startingMatch = false;
      latest = message.payload;
      mergeCommentaryEvents(latest.recent_action_events || []);
    } else if (message.type === "commentary") {
      appendCommentary(message.payload);
    } else if (message.type === "coach" && latest) {
      latest = { ...latest, coach_dashboard: message.payload };
    }
    updateUi();
  });
  socket.addEventListener("close", () => {
    handleSocketClose(version);
  });
}

async function handleSocketClose(version) {
  if (version !== socketVersion || !isMatchRunning()) return;
  try {
    const data = await fetchJson("/api/match/current");
    if (version !== socketVersion) return;
    if (!data.match) {
      resetClientMatchState("服务已重启，旧比赛已清空。");
      return;
    }
    latest = data.match;
    currentMatchId = latest.match_id;
    updateUi();
  } catch {
    if (version !== socketVersion) return;
  }
  if (version === socketVersion && isMatchRunning()) reconnectTimer = setTimeout(() => connectWs(`/ws/match/${currentMatchId}`), 1200);
}

/** 断开当前 WebSocket。 */
function disconnectWs() {
  socketVersion += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) socket.close();
  socket = null;
}

/** 根据最新状态刷新界面。 */
function updateUi() {
  if (!latest) return;
  ui.homeName.textContent = latest.teams.home.name;
  ui.awayName.textContent = latest.teams.away.name;
  ui.homeScore.textContent = latest.score.home;
  ui.awayScore.textContent = latest.score.away;
  ui.matchTime.textContent = clockText(latest.clock, latest);
  ui.matchState.textContent = clockStatusText(latest);
  ui.matchSummary.textContent = `${latest.teams.home.formation} vs ${latest.teams.away.formation} · 控球 ${latest.possession_team === "home" ? "主队" : "客队"}`;
  if (latest.match_id !== coachSummaryMatchId) resetCoachSummaryCache(latest.match_id);
  renderCoachDashboard(latest.coach_dashboard);
  renderTactics(latest);
  renderStats(latest);
  renderCommentary();
  renderEvents(latest.recent_events || []);
  ui.reportStatus.textContent = latest.report_ready ? "报告已生成：match_log.json、summary.md、report.md。" : "比赛结束或停止后生成 summary.md 与 report.md。";
  window.__footballArenaDebug.latestState = latest;
  window.__footballArenaDebug.playerCount = playerCount(latest);
  window.__footballArenaDebug.ballVisible = Boolean(latest.ball);
  window.__footballArenaDebug.commentaryCount = commentaryFeed.length;
  window.__footballArenaDebug.latestCommentary = commentaryFeed.at(-1) || null;
  updateControls();
}

/** 根据比赛状态更新控制按钮。 */
function updateControls() {
  const running = isMatchRunning();
  ui.startBtn.disabled = running || startingMatch;
  ui.pauseBtn.disabled = !running || latest?.paused;
  ui.resumeBtn.disabled = !running || !latest?.paused;
  ui.restartBtn.disabled = startingMatch;
  ui.stopBtn.disabled = !running;
}

/** 判断当前是否已有未完场比赛。 */
function isMatchRunning() {
  return Boolean(latest?.match_id && latest.state !== "full_time");
}

/** 渲染模型看板。 */
function renderCoachDashboard(dashboard) {
  if (!dashboard) return;
  ui.coachDashboard.innerHTML = [coachCard("home", "主队", dashboard.home), coachCard("away", "客队", dashboard.away)].join("");
  ui.modelStats.innerHTML = [statLine("请求", dashboard.home.request_count, dashboard.away.request_count), statLine("有效", dashboard.home.valid_decision_count, dashboard.away.valid_decision_count), statLine("超时", dashboard.home.timeout_count, dashboard.away.timeout_count), statLine("错误", dashboard.home.error_count, dashboard.away.error_count), statLine("Tokens", dashboard.home.total_tokens, dashboard.away.total_tokens)].join("");
}

/** 渲染当前战术。 */
function renderTactics(state) {
  ui.tacticPanel.innerHTML = [tacticCard("home", "主队", state.teams.home.tactics), tacticCard("away", "客队", state.teams.away.tactics)].join("");
}

/** 渲染比赛数据。 */
function renderStats(state) {
  const home = state.stats.home;
  const away = state.stats.away;
  ui.matchStats.innerHTML = [statLine("射门", home.shots, away.shots), statLine("xG", home.xG.toFixed(2), away.xG.toFixed(2)), statLine("传球", home.passes, away.passes), statLine("犯规", home.fouls, away.fouls)].join("");
}

/** 渲染实时播报。 */
function renderCommentary() {
  const items = commentaryFeed.slice(-COMMENTARY_LIMIT).reverse();
  ui.commentaryFeed.innerHTML = items.map((item, index) => `<div class="commentary-item ${index === 0 ? "latest" : ""}"><strong>${formatClock(item.game_time)}</strong><span>${escapeHtml(item.commentary || item.description || "比赛继续进行。")}</span></div>`).join("") || "<div class=\"commentary-item\"><strong>--:--</strong><span>等待实时播报</span></div>";
  ui.commentaryFeed.scrollTop = 0;
}

/** 渲染关键事件。 */
function renderEvents(events) {
  ui.eventTimeline.innerHTML = events.slice(-4).map((event) => `<div class="event"><strong>${formatMinute(event.game_time)}</strong>${escapeHtml(event.description)}</div>`).join("") || "<div class=\"event\"><strong>--</strong>等待比赛事件</div>";
}

/** 绘制循环。 */
function drawLoop(time) {
  updateFps(time);
  drawPitch(smoothDrawState(latest), time);
  requestAnimationFrame(drawLoop);
}

/** 平滑服务器快照之间的球员和足球坐标。 */
function smoothDrawState(state) {
  const source = state || mockState();
  const alpha = reducedMotionQuery?.matches ? 1 : 0.3;
  if (!renderState || renderState.match_id !== source.match_id) renderState = cloneDrawState(source);
  for (const side of ["home", "away"]) {
    const previous = new Map(renderState.teams[side].players.map((player) => [player.id, player]));
    renderState.teams[side] = { ...source.teams[side], players: source.teams[side].players.map((player) => {
      const last = previous.get(player.id) || player;
      return { ...player, x: last.x + (player.x - last.x) * alpha, y: last.y + (player.y - last.y) * alpha };
    }) };
  }
  if (source.ball) {
    const lastBall = renderState.ball || source.ball;
    renderState.ball = { ...source.ball, x: lastBall.x + (source.ball.x - lastBall.x) * alpha, y: lastBall.y + (source.ball.y - lastBall.y) * alpha };
  }
  return { ...source, teams: renderState.teams, ball: renderState.ball };
}

/** 构造设置表单配置。 */
function formConfig() {
  const form = new FormData(ui.settingsForm);
  const homeCoach = { provider: formText(form, "homeProvider"), model: formText(form, "homeModel"), endpoint: formText(form, "homeEndpoint"), api_key_ref: formText(form, "homeKeyRef"), api_key: formText(form, "homeApiKey"), free_strategy_prompt: formText(form, "homePrompt") };
  const awayCoach = { provider: formText(form, "awayProvider"), model: formText(form, "awayModel"), endpoint: formText(form, "awayEndpoint"), api_key_ref: formText(form, "awayKeyRef"), api_key: formText(form, "awayApiKey"), free_strategy_prompt: formText(form, "awayPrompt") };
  homeCoach.name = coachDisplayName(homeCoach, "主队");
  awayCoach.name = coachDisplayName(awayCoach, "客队");
  return {
    homeCoach,
    awayCoach,
    match: { homeFormation: formText(form, "homeFormation"), awayFormation: formText(form, "awayFormation"), matchMinutes: Number(form.get("matchMinutes")), seed: formText(form, "seed"), knockout: form.get("knockout") === "on" }
  };
}

function formText(form, name) {
  return String(form.get(name) || "").trim();
}

/** 填充设置表单。 */
function fillForm(nextConfig) {
  ui.settingsForm.homeProvider.value = nextConfig.homeCoach.provider;
  ui.settingsForm.homeModel.value = nextConfig.homeCoach.model;
  ui.settingsForm.homeEndpoint.value = nextConfig.homeCoach.endpoint || "";
  ui.settingsForm.homeKeyRef.value = nextConfig.homeCoach.api_key_ref || "";
  ui.settingsForm.homeApiKey.value = "";
  ui.homeKeyStatus.textContent = nextConfig.homeCoach.api_key_set ? "已保存密钥，留空保留" : "未设置密钥";
  ui.settingsForm.homePrompt.value = nextConfig.homeCoach.free_strategy_prompt || "";
  ui.settingsForm.awayProvider.value = nextConfig.awayCoach.provider;
  ui.settingsForm.awayModel.value = nextConfig.awayCoach.model;
  ui.settingsForm.awayEndpoint.value = nextConfig.awayCoach.endpoint || "";
  ui.settingsForm.awayKeyRef.value = nextConfig.awayCoach.api_key_ref || "";
  ui.settingsForm.awayApiKey.value = "";
  ui.awayKeyStatus.textContent = nextConfig.awayCoach.api_key_set ? "已保存密钥，留空保留" : "未设置密钥";
  ui.settingsForm.awayPrompt.value = nextConfig.awayCoach.free_strategy_prompt || "";
  ui.settingsForm.homeFormation.value = nextConfig.match.homeFormation || "";
  ui.settingsForm.awayFormation.value = nextConfig.match.awayFormation || "";
  ui.settingsForm.matchMinutes.value = nextConfig.match.matchMinutes || 90;
  ui.settingsForm.seed.value = nextConfig.match.seed || "";
  ui.settingsForm.knockout.checked = Boolean(nextConfig.match.knockout);
}

/** 更新设置摘要。 */
function updateConfigSummary() {
  ui.homeName.textContent = coachDisplayName(config.homeCoach, "主队");
  ui.awayName.textContent = coachDisplayName(config.awayCoach, "客队");
  ui.matchSummary.textContent = `${config.homeCoach.provider} vs ${config.awayCoach.provider} · ${config.match.matchMinutes || 90} 分钟 · 镜像阵容 · seed ${config.match.seed || "自动"}`;
}

/** 返回教练展示名称。 */
function coachDisplayName(coach = {}, fallback) {
  return coach.name || coach.model || coach.provider || fallback;
}

/** 请求 JSON。 */
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error?.message || "请求失败");
  return data;
}

/** 打开弹窗。 */
function openModal(modal) {
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

/** 关闭弹窗。 */
function closeModal(modal) {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

/** 显示设置表单校验提示。 */
function showSettingsValidationMessage() {
  ui.settingsForm.reportValidity();
  ui.settingsForm.querySelector(":invalid")?.focus();
  ui.settingsMessage.textContent = "请先修正比赛设置。";
  ui.reportStatus.textContent = "请先修正比赛设置。";
}

/** 用快照动作事件替换实时播报列表。 */
function replaceCommentaryFeed(events = []) {
  commentaryFeed = [];
  mergeCommentaryEvents(events);
}

/** 合并快照中的动作事件。 */
function mergeCommentaryEvents(events = []) {
  for (const event of events) appendCommentary(event, false);
  commentaryFeed = commentaryFeed.sort((left, right) => commentaryOrder(left) - commentaryOrder(right)).slice(-COMMENTARY_LIMIT);
}

/** 追加单条实时播报。 */
function appendCommentary(event, trim = true) {
  if (!event?.action_event_id) return;
  const existingIndex = commentaryFeed.findIndex((item) => item.action_event_id === event.action_event_id);
  if (existingIndex >= 0) commentaryFeed[existingIndex] = event;
  else {
    commentaryFeed.push(event);
    queueVisualEffect(event, commentaryFeed);
  }
  if (trim) commentaryFeed = commentaryFeed.sort((left, right) => commentaryOrder(left) - commentaryOrder(right)).slice(-COMMENTARY_LIMIT);
}

/** 返回播报排序值。 */
function commentaryOrder(event = {}) {
  const match = String(event.action_event_id || "").match(/(\d+)$/);
  return Number(match?.[1] || event.tick || 0);
}

/** 清空当前比赛的模型决策展示缓存。 */
function resetCoachSummaryCache(matchId = null) {
  coachSummaryMatchId = matchId;
  lastCoachSummaries = { home: null, away: null };
}

/** 返回当前队伍最近一次可展示的模型决策摘要。 */
function rememberedDecisionSummary(side, summary = {}) {
  if (summary.explanation || summary.intent || summary.decision_id) lastCoachSummaries[side] = { ...summary };
  return lastCoachSummaries[side] || summary;
}

/** 将模型决策摘要转成看板主文案。 */
function decisionSummaryText(summary = {}) {
  if (summary.explanation) return summary.explanation;
  const orders = summary.team_orders || {};
  const details = [
    summary.intent,
    orders.tempo ? `节奏 ${orders.tempo}` : "",
    orders.pressing_height ? `压迫 ${orders.pressing_height}` : "",
    orders.pressing_intensity ? `强度 ${orders.pressing_intensity}` : "",
    orders.defensive_line ? `防线 ${orders.defensive_line}` : "",
    orders.focus_channel ? `通道 ${orders.focus_channel}` : ""
  ].filter(Boolean);
  return details.join(" · ") || "暂无模型决策";
}

function coachCard(side, label, data = {}) {
  const summary = rememberedDecisionSummary(side, data.last_decision_summary || {});
  return `<div class="feed-item ${side}"><div class="feed-title"><span>${label} · ${escapeHtml(data.status || "idle")}</span><span>${Math.round(data.elapsed_ms || data.last_latency_ms || 0)}ms</span></div><div class="feed-main">${escapeHtml(decisionSummaryText(summary))}</div><div class="pill-row"><span class="pill">risk ${Number(summary.risk_level || 0).toFixed(2)}</span><span class="pill">${escapeHtml(summary.intent || "pending")}</span><span class="pill">${escapeHtml(data.fallback_status || "正常")}</span></div></div>`;
}

function tacticCard(side, label, tactics = {}) {
  return `<div class="feed-item ${side}"><div class="feed-title"><span>${label}</span><span>${escapeHtml(tactics.formation || "--")}</span></div><div class="feed-main">${escapeHtml(tactics.intent || "等待战术")} · 压迫 ${escapeHtml(tactics.pressingHeight || "medium")} · 宽度 ${escapeHtml(tactics.attackingWidth || "balanced")}</div></div>`;
}

function statLine(label, home, away) {
  const left = Number(home) + Number(away) === 0 ? 50 : Math.round((Number(home) / (Number(home) + Number(away))) * 100);
  return `<div class="stat-row"><span>${home}</span><div class="bar" style="--left:${left}%"><span></span><span></span></div><span>${away}</span><small>${label}</small></div>`;
}

function defaultClockText() {
  const totalSeconds = Number(config?.match?.matchMinutes || 90) * 60;
  const halfSeconds = Math.floor(totalSeconds / 2);
  return `00:00 / ${formatClock(halfSeconds)}`;
}

function clockText(clock, state = {}) {
  if (!clock) {
    const elapsed = state.display_time || formatClock(state.game_time || 0);
    const total = formatClock(Number(config?.match?.matchMinutes || 90) * 60);
    return `${elapsed} / ${total}`;
  }
  const periodElapsed = clock.period_display_time || clock.display_time || formatClock(clock.period_elapsed_seconds || 0);
  const periodTotal = clock.period_total_display_time || formatClock(clock.period_total_seconds || 0);
  return `${periodElapsed} / ${periodTotal}`;
}

function clockStatusText(state = {}) {
  const label = state.clock?.period_label;
  if (state.paused && label) return `${label} \u00b7 \u5df2\u6682\u505c`;
  return label || stateText(state.state, state.paused);
}

function stateText(state, paused) {
  if (paused) return "已暂停";
  return { pre_match: "赛前", kickoff: "开球", in_play: "比赛中", throw_in: "界外球", goal_kick: "球门球", corner_kick: "角球", free_kick: "任意球", penalty_kick: "点球", half_time: "中场", full_time: "完场", var_check: "VAR" }[state] || state;
}

function formatMinute(seconds) {
  return `${Math.floor((seconds || 0) / 60)}'`;
}

function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const minute = Math.floor(whole / 60);
  const second = whole % 60;
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}

function playerCount(state) {
  if (!state) return 22;
  return state.teams.home.players.length + state.teams.away.players.length;
}

function updateFps(time) {
  frameTimes.push(time);
  frameTimes = frameTimes.filter((item) => time - item <= 5000);
  fps = frameTimes.length / 5;
  window.__footballArenaDebug.fps = fps;
}
