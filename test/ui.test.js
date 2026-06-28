import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultConfig } from "../src/storage.js";
import { createMirrorTeams } from "../src/teamFactory.js";
import { createRng } from "../src/utils.js";
async function readFrontendSource() {
  const [app, renderer] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/pitchRenderer.js", import.meta.url), "utf8")
  ]);
  return `${app}\n${renderer}`;
}

/** 前端默认显示不能回退到旧模型名称。 */
test("前端默认显示和启动配置不再硬编码旧模型队名", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFrontendSource(),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  for (const staleName of ["DeepSeek High Press", "GLM Compact Block", "MiMo High Press", "DeepSeek Flash Block", "GPT Compact Block", "gpt-5.4-mini"]) {
    assert.equal(html.includes(staleName), false);
    assert.equal(app.includes(staleName), false);
  }
  assert.ok(html.includes("<span id=\"homeName\">主队</span>"));
  assert.ok(html.includes("<span id=\"awayName\">客队</span>"));
  assert.ok(app.includes("return coach.name || coach.model || coach.provider || fallback;"));
  assert.equal(app.includes("config?.homeCoach || homeCoach"), false);
  assert.equal(app.includes("config?.awayCoach || awayCoach"), false);
  assert.ok(app.includes("smoothDrawState"));
  assert.ok(app.includes("drawGoal"));
  assert.ok(styles.includes("border-radius: 18px"));
});

test("设置默认不预设策略提示和固定首发阵型", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const config = defaultConfig();
  assert.equal(config.homeCoach.free_strategy_prompt, "");
  assert.equal(config.awayCoach.free_strategy_prompt, "");
  assert.equal(config.match.homeFormation, "");
  assert.equal(config.match.awayFormation, "");
  assert.equal(html.includes("value=\"高位逼抢"), false);
  assert.equal(html.includes("value=\"低位防守"), false);
  assert.ok(html.includes("<option value=\"\">由模型决定</option>"));
  assert.equal(html.includes("<option>4-3-3</option>"), false);
  assert.equal(html.includes("<option>4-4-2</option>"), false);
  assert.equal(html.includes("<option>4-2-3-1</option>"), false);
  assert.equal(html.includes("<option>3-5-2</option>"), false);
  assert.equal(html.includes("<option>5-3-2</option>"), false);
  assert.ok(html.includes("可留空，由模型根据比赛态势自行决定"));
});

/** 前端绘制必须使用真实坐标，不得额外偏移重叠球员。 */
test("前端绘制球员时不使用显示层重叠偏移", async () => {
  const app = await readFrontendSource();
  assert.equal(app.includes("displayX"), false);
  assert.equal(app.includes("displayY"), false);
  assert.equal(app.includes("overlapIndex"), false);
  assert.equal(app.includes("occupied = new Map"), false);
  assert.equal(app.includes("point.x += Math.cos"), false);
  assert.equal(app.includes("point.y += Math.sin"), false);
  assert.match(app, /drawPlayer\(player, side, width, height, drawState, isHolder, time, isPassReceiver\)/);
  assert.match(app, /function drawPlayer\(player, side, width, height, state, isHolder = false, time = performance\.now\(\), isPassReceiver = false\) \{\n  const point = toCanvas\(player, width, height\);/);
});

/** 默认队名兜底不绑定具体模型品牌。 */
test("默认队名兜底使用通用文案", () => {
  const config = defaultConfig();
  const teams = createMirrorTeams({ match: config.match }, createRng("team-name-fallback"));
  assert.equal(config.homeCoach.name, "主队");
  assert.equal(config.awayCoach.name, "客队");
  assert.equal(teams.home.name, "主队");
  assert.equal(teams.away.name, "客队");
});

/** 模型请求等待时应保留上一轮决策展示。 */
test("模型决策等待态复用上一轮有效摘要", async () => {
  const app = await readFrontendSource();
  assert.ok(app.includes("lastCoachSummaries"));
  assert.ok(app.includes("rememberedDecisionSummary"));
  assert.ok(app.includes("decisionSummaryText"));
  assert.ok(app.includes("summary.decision_id"));
  assert.ok(app.includes("summary.team_orders"));
  assert.ok(app.includes("resetCoachSummaryCache(currentMatchId)"));
  assert.equal(app.includes("等待模型决策"), false);
  assert.ok(app.includes("暂无模型决策"));
});

/** 前端应包含实时播报列表与去重截断逻辑。 */
test("前端包含实时播报列表与去重截断逻辑", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFrontendSource(),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  const pitchIndex = html.indexOf("class=\"pitch-frame\"");
  const feedIndex = html.indexOf("id=\"commentaryFeed\"");
  const footerIndex = html.indexOf("<footer class=\"bottom-grid\">");
  assert.ok(html.includes("实时播报"));
  assert.ok(html.includes("class=\"broadcast-card\""));
  assert.ok(feedIndex > pitchIndex && feedIndex < footerIndex);
  assert.ok(app.includes("commentaryFeed"));
  assert.ok(app.includes("COMMENTARY_LIMIT = 12"));
  assert.ok(app.includes("action_event_id"));
  assert.ok(app.includes("recent_action_events"));
  assert.ok(app.includes("latestCommentary"));
  assert.ok(app.includes("formatClock(item.game_time)"));
  assert.ok(app.includes("<strong>--:--</strong>"));
  assert.ok(app.includes("function formatClock(seconds)"));
  assert.ok(app.includes("commentaryFeed.slice(-COMMENTARY_LIMIT).reverse()"));
  assert.ok(app.includes("index === 0 ? \"latest\" : \"\""));
  assert.ok(app.includes("ui.commentaryFeed.scrollTop = 0;"));
  assert.ok(styles.includes(".commentary-list"));
  assert.ok(styles.includes(".commentary-item.latest"));
  assert.ok(styles.includes("grid-template-columns: 44px 1fr"));
});

/** 前端应把动作事件中的轨迹元数据渲染成球路特效。 */
test("前端包含高低球和射门球路可视化", async () => {
  const app = await readFrontendSource();
  assert.ok(app.includes("visualEffects"));
  assert.ok(app.includes("seenVisualEffectIds"));
  assert.ok(app.includes("queueVisualEffect(event"));
  assert.ok(app.includes("drawVisualEffects"));
  assert.ok(app.includes("drawTrajectoryEffect"));
  assert.ok(app.includes("trajectory.height"));
  assert.ok(app.includes("highBall"));
  assert.ok(app.includes("activeBallAirHeight"));
  assert.ok(app.includes("trajectoryProgress"));
  assert.ok(app.includes("distanceToSegment"));
  assert.ok(app.includes("flightHeight"));
  assert.ok(app.includes("flightStartX"));
  assert.ok(app.includes("const lift ="));
  assert.ok(app.includes("const ballY = point.y - lift"));
  assert.ok(app.includes("goal_shot"));
  assert.ok(app.includes("VISUAL_EFFECT_MS = 1600"));
});

test("球门使用 2.5D 立体框架和球网绘制", async () => {
  const app = await readFrontendSource();
  assert.ok(app.includes("const goalHeight ="));
  assert.ok(app.includes("drawGoalNetPanel"));
  assert.ok(app.includes("drawGoalFrameLine"));
  assert.ok(app.includes("frontTopHigh"));
  assert.ok(app.includes("backBottomHigh"));
  assert.ok(app.includes("lerpPoint"));
});

test("主客队门将使用不同球衣颜色和队伍识别边", async () => {
  const app = await readFrontendSource();
  assert.ok(app.includes("playerKitPalette"));
  assert.ok(app.includes("#7c3cff"));
  assert.ok(app.includes("#b7ff1a"));
  assert.ok(app.includes("accent: \"#00d9ff\""));
  assert.ok(app.includes("accent: \"#ff3b30\""));
  assert.ok(app.includes("drawKeeperGlove"));
  assert.ok(app.includes("ctx.moveTo(-unit * 0.62"));
  assert.ok(app.includes("palette.number"));
  assert.equal(app.includes("goalkeeper ? \"#f4d06f\""), false);
});

/** 前端应根据动作事件和跑动方向绘制球员动作姿态。 */
test("前端包含球员动作姿态表现", async () => {
  const app = await readFrontendSource();
  assert.ok(app.includes("ACTION_EFFECT_MS = 900"));
  assert.ok(app.includes("PLAYER_ACTION_SYSTEM"));
  assert.ok(app.includes("playerPose"));
  assert.ok(app.includes("playerActionKey"));
  assert.ok(app.includes("movementPose"));
  assert.ok(app.includes("activePlayerAction"));
  assert.ok(app.includes("drawMascotLimbs"));
  assert.ok(app.includes("drawMascotBody"));
  assert.ok(app.includes("drawMascotHead"));
  assert.ok(app.includes("drawBentLimb"));
  assert.ok(app.includes("drawLimb"));
  assert.ok(app.includes("roundedRect"));
  assert.ok(app.includes("celebrate"));
  assert.ok(app.includes("receive"));
  assert.ok(app.includes("pass_completed"));
  assert.ok(app.includes("tackle_won"));
  assert.ok(app.includes("kick"));
  assert.ok(app.includes("arm"));
  assert.ok(app.includes("visualEffects.push({ id: event.action_event_id, type: event.action_type, actor: event.actor, target: event.target, trajectory: event.trajectory"));
});

/** 右侧长策略文本不应撑开左侧球场布局。 */
test("球场和比分按整页居中且底部面板不裁剪内容", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.app-shell \{[^}]*height: 100vh;[^}]*overflow: hidden;[^}]*grid-template-rows: 58px minmax\(0, 1fr\) minmax\(168px, 18vh\);/);
  assert.match(styles, /\.topbar \{[^}]*position: relative;[^}]*grid-template-columns: 280px minmax\(0, 1fr\) 250px;/);
  assert.match(styles, /\.scoreboard \{[^}]*position: absolute;[^}]*left: 50%;[^}]*transform: translate\(-50%, -50%\);/);
  assert.match(styles, /\.main-grid \{[^}]*overflow: hidden;/);
  assert.match(styles, /\.stage-card \{[^}]*min-height: 0;/);
  assert.match(styles, /\.pitch-frame \{[^}]*--stage-visual-height: min\(calc\(\(100vw - 780px\) \* \.633\), calc\(100vh - 340px\), 696px\);/);
  assert.match(styles, /\.broadcast-card \{[^}]*position: absolute;[^}]*height: var\(--stage-visual-height\);[^}]*display: grid;[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(styles, /#pitchCanvas \{[^}]*position: absolute;[^}]*left: 50vw;[^}]*height: var\(--stage-visual-height\);[^}]*transform: translate\(-50%, -50%\);/);
  assert.match(styles, /\.coach-panel \{[^}]*overflow: auto;/);
  assert.match(styles, /\.bottom-panel \{[^}]*overflow: hidden;[^}]*display: grid;[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.timeline \{[^}]*overflow: auto;/);
  assert.match(styles, /\.bottom-panel > \.stack, \.report-status \{[^}]*overflow: auto;/);
  assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*\.app-shell \{[^}]*height: auto;[^}]*overflow: visible;/);
  assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*\.brand, \.scoreboard, \.clock \{[^}]*position: static;[^}]*transform: none;/);
  assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*\.pitch-frame \{[^}]*grid-template-columns: 1fr;/);
  assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*#pitchCanvas \{[^}]*position: static;[^}]*width: min\(100%, 1120px\);[^}]*height: auto;[^}]*max-height: none;[^}]*transform: none;/);
});

test("设置表单支持比赛时长、进球节奏倍率并提交到开始比赛配置", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFrontendSource()
  ]);
  assert.ok(html.includes("比赛时长（分钟）<input name=\"matchMinutes\" type=\"number\" min=\"1\" max=\"90\" step=\"1\" value=\"90\" required>"));
  assert.ok(html.includes("进球节奏倍率（值越小进球越快，1 为正常）<input name=\"goalPaceMultiplier\" type=\"text\" inputmode=\"decimal\" pattern=\"[0-9]*[.]?[0-9]+\" min=\"0.01\" max=\"5\" value=\"1\" required>"));
  assert.ok(app.includes("matchMinutes: Number(form.get(\"matchMinutes\"))"));
  assert.ok(app.includes("goalPaceMultiplier: parseFloat(String(form.get(\"goalPaceMultiplier\") || \"1\").replace(\",\", \".\")) || 1"));
  assert.ok(app.includes("if (!ui.settingsForm.checkValidity())"));
  assert.ok(app.includes("showSettingsValidationMessage();"));
  assert.ok(app.includes("function showSettingsValidationMessage()"));
  assert.ok(app.includes("ui.settingsForm.querySelector(\":invalid\")?.focus();"));
  assert.ok(app.includes("ui.settingsMessage.textContent = \"请先修正比赛设置。\";"));
  assert.ok(app.includes("if (event.target !== ui.settingsModal) return;"));
  assert.ok(app.includes("ui.settingsForm.matchMinutes.value = nextConfig.match.matchMinutes || 90;"));
  assert.ok(app.includes("ui.settingsForm.goalPaceMultiplier.value"));
  assert.ok(app.includes("${config.match.matchMinutes || 90} 分钟"));
});

test("点击开始比赛立即进入启动状态且不重复保存配置", async () => {
  const app = await readFrontendSource();
  const startMatchStart = app.indexOf("async function startMatch()");
  const startMatchEnd = app.indexOf("async function postControl(action)");
  const startMatchBody = app.slice(startMatchStart, startMatchEnd);
  assert.ok(app.includes("let startingMatch = false;"));
  assert.ok(startMatchBody.includes("startingMatch = true;"));
  assert.ok(startMatchBody.includes("updateControls();"));
  assert.ok(startMatchBody.includes("比赛启动中..."));
  assert.ok(startMatchBody.includes("fetchJson(\"/api/match/start\""));
  assert.equal(startMatchBody.includes("fetchJson(\"/api/config\""), false);
  assert.ok(app.includes("ui.startBtn.disabled = running || startingMatch;"));
  assert.ok(app.includes("startingMatch = false;\n      latest = message.payload;"));
});

/** 设置表单应展示 API Key 保存状态，避免用户误以为密钥丢失。 */
test("设置表单展示 API Key 保存状态", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFrontendSource()
  ]);
  assert.ok(html.includes('id="homeKeyStatus"'));
  assert.ok(html.includes('id="awayKeyStatus"'));
  assert.ok(html.includes("留空则保留已保存密钥"));
  assert.ok(app.includes("homeKeyStatus: document.getElementById(\"homeKeyStatus\")"));
  assert.ok(app.includes("awayKeyStatus: document.getElementById(\"awayKeyStatus\")"));
  assert.ok(app.includes("nextConfig.homeCoach.api_key_set ? \"已保存密钥，留空保留\" : \"未设置密钥\""));
  assert.ok(app.includes("nextConfig.awayCoach.api_key_set ? \"已保存密钥，留空保留\" : \"未设置密钥\""));
});

/** 比分牌新增回放入口，且不破坏原有三列网格布局。 */
test("比分牌包含进球回放按钮且布局使用 flex 容器隔离", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFrontendSource(),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.ok(html.includes('id="replayBtn"'));
  assert.ok(html.includes('class="away-wrapper"'));
  assert.ok(html.includes('aria-label="进球回放"'));
  assert.ok(app.includes("replayBtn: document.getElementById(\"replayBtn\")"));
  assert.ok(styles.includes(".away-wrapper"));
  assert.ok(styles.includes(".replay-btn"));
  assert.match(styles, /\.scoreboard \{[^}]*grid-template-columns:\s*1fr auto 1fr/);
});

/** 存在回放列表弹窗和回放播放器弹窗。 */
test("存在进球回放列表弹窗与播放器弹窗", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFrontendSource()
  ]);
  assert.ok(html.includes('id="replayListModal"'));
  assert.ok(html.includes('id="replayPlayerModal"'));
  assert.ok(html.includes('id="replayCanvas"'));
  assert.ok(app.includes("replayListModal: document.getElementById(\"replayListModal\")"));
  assert.ok(app.includes("replayPlayerModal: document.getElementById(\"replayPlayerModal\")"));
  assert.ok(app.includes("replayCanvas: document.getElementById(\"replayCanvas\")"));
});

/** 前端渲染器支持独立 Canvas 回放，播放器支持 ESC 与 30fps 节流。 */
test("前端渲染器支持回放 Canvas 且播放器实现 ESC 与帧率控制", async () => {
  const [app, styles] = await Promise.all([
    readFrontendSource(),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.ok(app.includes("drawReplayFrame"));
  assert.ok(app.includes("drawPitchTo"));
  assert.ok(app.includes("FRAME_INTERVAL_MS"));
  assert.ok(app.includes("handleReplayKeydown"));
  assert.ok(app.includes("requestAnimationFrame(replayLoop)"));
  assert.ok(styles.includes(".replay-list-card"));
  assert.ok(styles.includes(".replay-player-card"));
  assert.ok(styles.includes("#replayCanvas"));
});
