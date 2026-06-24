import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fallbackMatchPaths, matchPaths, writeJson } from "./storage.js";
import { redactSensitive } from "./utils.js";

/** 保存比赛日志、总结和报告。 */
export async function saveMatchArtifacts(engine, orchestrator, extraSecrets = []) {
  let paths = matchPaths(engine.matchId);
  try {
    await mkdir(paths.rawOutputDir, { recursive: true });
    await mkdir(paths.reportDir, { recursive: true });
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code) || process.env.FOOTBALL_RUNTIME_DIR) throw error;
    paths = fallbackMatchPaths(engine.matchId);
    await mkdir(paths.rawOutputDir, { recursive: true });
    await mkdir(paths.reportDir, { recursive: true });
  }
  const dashboard = orchestrator?.dashboard?.() || { home: {}, away: {} };
  engine.matchLog.match_meta.home_coach_summary = sanitizeCoach(engine.config.homeCoach);
  engine.matchLog.match_meta.away_coach_summary = sanitizeCoach(engine.config.awayCoach);
  await writeRawOutputs(paths.rawOutputDir, engine.matchLog.model_decision_log, extraSecrets);
  await writeJson(paths.matchLog, engine.matchLog, extraSecrets);
  const summary = buildSummary(engine, dashboard);
  const report = buildReport(engine, dashboard);
  await writeFile(paths.summary, redactSensitive(summary, extraSecrets), "utf8");
  await writeFile(paths.report, redactSensitive(report, extraSecrets), "utf8");
  engine.reportPaths = paths;
  return { paths, summary, report };
}

/** 生成赛后总结。 */
export function buildSummary(engine, dashboard) {
  const events = engine.matchLog.match_event_log;
  const keyEvents = events.filter((event) => ["goal", "yellow_card", "red_card", "var_result", "substitution", "shootout_finished"].includes(event.event_type));
  return `# AI Football Arena 赛后总结\n\n` +
    `## 比分\n\n${scoreLine(engine)}\n\n` +
    `## 关键事件\n\n${markdownEvents(keyEvents)}\n\n` +
    `## 模型统计\n\n${modelStatsTable(dashboard)}\n\n` +
    `## 战术风格摘要\n\n- 主队：${styleLabel(engine.teams.home.tactics)}。\n- 客队：${styleLabel(engine.teams.away.tactics)}。\n\n` +
    `## 胜负转折点\n\n${keyEvents[0]?.description || "本场没有出现决定性进球，双方战术差异主要体现在站位和推进方向。"}\n`;
}

/** 生成赛后报告。 */
export function buildReport(engine, dashboard) {
  const home = engine.teams.home;
  const away = engine.teams.away;
  return `# AI Football Arena 战术报告\n\n` +
    `## 技术信息\n\n- match_id：${engine.matchId}\n- engine_version：${engine.matchLog.match_meta.engine_version}\n- rules_version：${engine.matchLog.match_meta.rules_version}\n- random_seed：${engine.matchLog.match_meta.random_seed}\n\n` +
    `## 比赛数据统计\n\n| 数据 | 主队 | 客队 |\n| --- | ---: | ---: |\n` +
    statRow("射门", home.stats.shots, away.stats.shots) +
    statRow("射正", home.stats.shotsOnTarget, away.stats.shotsOnTarget) +
    statRow("xG", home.stats.xG.toFixed(2), away.stats.xG.toFixed(2)) +
    statRow("传球", home.stats.passes, away.stats.passes) +
    statRow("犯规", home.stats.fouls, away.stats.fouls) +
    statRow("黄牌", home.stats.yellowCards, away.stats.yellowCards) +
    statRow("红牌", home.stats.redCards, away.stats.redCards) +
    statRow("越位", home.stats.offsides, away.stats.offsides) +
    `\n## 阵型与战术变化\n\n- 主队当前阵型：${home.formation}，战术：${styleLabel(home.tactics)}。\n- 客队当前阵型：${away.formation}，战术：${styleLabel(away.tactics)}。\n\n` +
    `## 模型决策审计\n\n${modelStatsTable(dashboard)}\n\n` +
    `## 有效决策与风险\n\n${decisionBullets(engine.matchLog.model_decision_log)}\n\n` +
    `## fallback 与异常\n\n${safetyBullets(engine.matchLog.safety_log)}\n`;
}

/** 写入原始模型输出引用文件。 */
async function writeRawOutputs(rawOutputDir, decisions, extraSecrets) {
  for (const decision of decisions) {
    const fileName = path.basename(decision.raw_model_output_ref || `${decision.decision_id}.txt`);
    const raw = decision.raw_model_output ?? decision.parsed_decision_json ?? {};
    const content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    await writeFile(path.join(rawOutputDir, fileName), redactSensitive(content, extraSecrets), "utf8");
  }
}

/** 生成事件 Markdown。 */
function markdownEvents(events) {
  if (!events.length) return "- 暂无进球、牌罚或 VAR 等关键事件。";
  return events.map((event) => `- ${Math.floor(event.game_time / 60)}' ${event.description}`).join("\n");
}

function scoreLine(engine) {
  const base = `${engine.teams.home.name} ${engine.teams.home.score} - ${engine.teams.away.score} ${engine.teams.away.name}`;
  return engine.shootout ? `${base}，点球 ${engine.shootout.home}-${engine.shootout.away}` : base;
}

/** 生成模型统计表。 */
function modelStatsTable(dashboard) {
  return `| 指标 | 主队 | 客队 |\n| --- | ---: | ---: |\n` +
    statRow("请求次数", dashboard.home.request_count || 0, dashboard.away.request_count || 0) +
    statRow("有效决策", dashboard.home.valid_decision_count || 0, dashboard.away.valid_decision_count || 0) +
    statRow("请求错误", dashboard.home.error_count || 0, dashboard.away.error_count || 0) +
    statRow("请求超时", dashboard.home.timeout_count || 0, dashboard.away.timeout_count || 0) +
    statRow("非法输出", dashboard.home.invalid_count || 0, dashboard.away.invalid_count || 0) +
    statRow("input tokens", dashboard.home.input_tokens || 0, dashboard.away.input_tokens || 0) +
    statRow("output tokens", dashboard.home.output_tokens || 0, dashboard.away.output_tokens || 0) +
    statRow("total tokens", dashboard.home.total_tokens || 0, dashboard.away.total_tokens || 0) +
    statRow("最长响应 ms", dashboard.home.max_latency_ms || 0, dashboard.away.max_latency_ms || 0);
}

/** 生成表格行。 */
function statRow(label, home, away) {
  return `| ${label} | ${home} | ${away} |\n`;
}

/** 生成风格标签。 */
function styleLabel(tactics) {
  const labels = [];
  if (tactics.pressingHeight === "high") labels.push("高位压迫");
  if (tactics.attackingWidth === "wide") labels.push("边路推进");
  if (tactics.transition === "counter") labels.push("反击优先");
  if (tactics.defensiveLine === "low") labels.push("低位防守");
  if (!labels.length) labels.push("平衡控制");
  return labels.join("、");
}

/** 生成决策摘要。 */
function decisionBullets(decisions) {
  if (!decisions.length) return "- 暂无模型决策记录。";
  return decisions.slice(-8).map((decision) => `- ${decision.team_id} ${decision.decision_id}：${decision.parsed_decision_json?.intent || "unknown"}，校验 ${decision.validation_result}，fallback ${decision.fallback_used ? "是" : "否"}。`).join("\n");
}

/** 生成安全摘要。 */
function safetyBullets(safetyLog) {
  if (!safetyLog.length) return "- 未记录安全异常。";
  return safetyLog.map((item) => `- tick ${item.tick ?? "-"}：${item.type}，${item.message || "已处理"}`).join("\n");
}

/** 脱敏教练摘要。 */
function sanitizeCoach(coach = {}) {
  return redactSensitive({ provider: coach.provider, model: coach.model, api_key_ref: coach.api_key_ref, free_strategy_prompt: coach.free_strategy_prompt });
}
