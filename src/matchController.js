import { MatchEngine } from "./matchEngine.js";
import { CoachOrchestrator, createCoachRequestBody, extractCoachDecision, resolveApiKey, resolveChatEndpoint } from "./coachOrchestrator.js";
import { saveMatchArtifacts } from "./reporting.js";
import { loadConfig, mergeConfig, saveConfig, sanitizeConfig } from "./storage.js";
import { createRng, redactSensitive } from "./utils.js";

/** 管理当前本地比赛会话。 */
export class MatchController {
  constructor(broadcaster = () => {}) {
    this.broadcaster = broadcaster;
    this.engine = null;
    this.orchestrator = null;
    this.interval = null;
    this.lastStepAt = 0;
    this.config = null;
    this.extraSecrets = [];
  }

  /** 初始化本地配置。 */
  async init() {
    this.config = await loadConfig();
    this.extraSecrets = this.collectSecrets(this.config);
    return sanitizeConfig(this.config, this.extraSecrets);
  }

  /** 读取脱敏配置。 */
  async getConfig() {
    if (!this.config) await this.init();
    return sanitizeConfig(this.config, this.extraSecrets);
  }

  /** 保存脱敏配置。 */
  async updateConfig(input) {
    this.config = await saveConfig(this.withSavedKeys(input));
    this.extraSecrets = this.collectSecrets(this.config);
    if (this.orchestrator) this.orchestrator.config = this.config;
    return sanitizeConfig(this.config, this.extraSecrets);
  }

  /** 测试模型连接。 */
  async testModel({ side = "home", coach = {} }) {
    const apiKey = coach.api_key || coach.api_key_once || "";
    if (apiKey) this.extraSecrets = [...new Set([...this.extraSecrets, apiKey])];
    if (!coach.endpoint) return { status: "success", message: "本地规则教练可用。" };
    if (!apiKey && !coach.api_key_ref) return { status: "missing_key", message: "缺少 API Key 或环境变量引用。" };
    const resolvedKey = resolveApiKey(coach);
    if (!resolvedKey) return { status: "missing_key", message: "无法解析 API Key。" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const input = {
        summary: {
          side,
          trigger: "connection_test",
          phase: "pre_match",
          score: { home: 0, away: 0 },
          time: "00:00",
          instruction: "Return one minimal legal CoachDecision JSON for connectivity testing."
        }
      };
      const response = await fetch(resolveChatEndpoint(coach), {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolvedKey}` },
        body: JSON.stringify(createCoachRequestBody(coach, input))
      });
      if (!response.ok) return { status: "error", message: `模型接口返回 ${response.status}` };
      const payload = await response.json();
      const decision = extractCoachDecision(payload);
      return { status: "success", message: "模型连接成功。", sample_received: Boolean(decision) };
    } catch (error) {
      return { status: "error", message: error.name === "AbortError" ? "模型连接测试超时。" : `模型连接失败：${error.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 开始比赛。 */
  async start(configInput = null) {
    if (this.engine && this.engine.state !== "full_time") {
      const error = new Error("已有比赛正在运行");
      error.status = 409;
      error.code = "match_already_running";
      throw error;
    }
    const merged = this.withSavedKeys(configInput || this.config || await loadConfig());
    this.config = await saveConfig(merged);
    this.extraSecrets = this.collectSecrets(this.config);
    const seed = this.config.match.seed || Date.now().toString();
    this.engine = new MatchEngine(this.config, createRng(seed));
    this.engine.onEvent = (event) => this.broadcast("event", event);
    this.engine.onActionEvent = (event) => this.broadcast("commentary", event);
    this.orchestrator = new CoachOrchestrator(this.engine, this.config, (type, payload) => this.broadcast(type, payload));
    this.orchestrator.start();
    this.broadcast("snapshot", this.currentPayload());
    void this.kickoffAfterPreMatch();
    return { match_id: this.engine.matchId, ws_url: `/ws/match/${this.engine.matchId}` };
  }

  /** 推进运行中比赛。 */
  step() {
    if (!this.engine) return;
    this.lastStepAt = Date.now();
    const beforeTick = this.engine.tick;
    const snapshot = this.engine.advanceTick();
    this.orchestrator?.tick();
    if (snapshot.tick !== beforeTick && snapshot.tick % 5 === 0) this.broadcast("tick", this.currentPayload());
    if (this.engine.state === "full_time") this.finishIfNeeded();
  }

  /** 暂停比赛。 */
  pause() {
    this.ensureEngine();
    this.engine.pause();
    this.broadcast("snapshot", this.currentPayload());
    return this.currentPayload();
  }

  /** 恢复比赛。 */
  resume() {
    this.ensureEngine();
    if (!this.engine.paused) {
      const error = new Error("比赛未暂停");
      error.status = 409;
      error.code = "match_not_paused";
      throw error;
    }
    this.engine.resume();
    this.broadcast("snapshot", this.currentPayload());
    return this.currentPayload();
  }

  /** 停止比赛并生成报告。 */
  async stop() {
    this.ensureEngine();
    this.engine.stop();
    return await this.finishIfNeeded();
  }

  /** 重新开始比赛：先停止当前比赛（生成报告），再用相同配置启动新比赛。 */
  async restart(configInput = null) {
    let restartedFrom = null;
    if (this.engine) {
      restartedFrom = this.engine.matchId;
      this.engine.stop();
      await this.finishIfNeeded();
    }
    const result = await this.start(configInput || this.config);
    return { ...result, restarted_from: restartedFrom };
  }

  /** 获取当前比赛。 */
  current() {
    if (!this.engine) return null;
    return this.currentPayload();
  }

  /** 完成报告生成。 */
  async finishIfNeeded() {
    if (!this.engine || this.engine.reportPaths) return this.currentPayload();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.lastStepAt = 0;
    const artifacts = await saveMatchArtifacts(this.engine, this.orchestrator, this.extraSecrets);
    this.broadcast("report", { ...this.currentPayload(), report_ready: true });
    return { ...this.currentPayload(), report_ready: true, report_paths: redactSensitive(artifacts.paths, this.extraSecrets) };
  }

  /** 合并配置时保留已保存密钥。 */
  withSavedKeys(input = {}) {
    const merged = mergeConfig(input);
    for (const side of ["homeCoach", "awayCoach"]) {
      const incoming = input?.[side] || {};
      const savedKey = this.config?.[side]?.api_key || "";
      const nextKey = incoming.api_key || incoming.api_key_once || "";
      if (nextKey) merged[side].api_key = nextKey;
      else if (savedKey) merged[side].api_key = savedKey;
    }
    return merged;
  }

  /** 收集需要额外替换的密钥文本。 */
  collectSecrets(config = this.config) {
    return [...new Set([
      ...this.extraSecrets,
      config?.homeCoach?.api_key,
      config?.homeCoach?.api_key_once,
      config?.awayCoach?.api_key,
      config?.awayCoach?.api_key_once
    ].filter(Boolean))];
  }

  /** 构造当前脱敏 payload。 */
  currentPayload() {
    if (!this.engine) return null;
    this.ensureRunLoop();
    return redactSensitive({ ...this.engine.snapshot(), coach_dashboard: this.orchestrator?.dashboard?.() || null }, this.extraSecrets);
  }

  /** 广播状态。 */
  broadcast(type, payload) {
    if (!this.engine) return;
    this.broadcaster(this.engine.matchId, { type, match_id: this.engine.matchId, sent_at: new Date().toISOString(), payload: redactSensitive(payload, this.extraSecrets) });
  }

  ensureEngine() {
    if (!this.engine) {
      const error = new Error("当前没有比赛");
      error.status = 404;
      error.code = "match_not_found";
      throw error;
    }
  }

  /** 启动或恢复比赛推进循环。 */
  startRunLoop() {
    if (this.interval) clearInterval(this.interval);
    this.lastStepAt = Date.now();
    this.interval = setInterval(() => this.step(), 1000 / 30);
  }

  /** 修复异常丢失的推进循环，避免比赛卡在 in_play。 */
  ensureRunLoop() {
    if (!this.engine || this.engine.paused || this.engine.state === "pre_match" || this.engine.state === "full_time") return;
    if (!this.interval || Date.now() - this.lastStepAt > 2000) {
      this.startRunLoop();
      this.engine.matchLog.safety_log.push({ tick: this.engine.tick, type: "run_loop_restarted", message: "检测到比赛推进循环停滞，已自动恢复。" });
    }
  }

  /** 双方赛前战术确定后再真正开球。 */
  async kickoffAfterPreMatch() {
    const engine = this.engine;
    const orchestrator = this.orchestrator;
    await orchestrator?.waitForPreMatchDecisions?.();
    if (!engine || !orchestrator || this.engine !== engine || this.orchestrator !== orchestrator || engine.state !== "pre_match") return;
    engine.start();
    this.startRunLoop();
    this.broadcast("snapshot", this.currentPayload());
  }
}
