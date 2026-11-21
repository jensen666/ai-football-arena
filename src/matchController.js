import { MatchEngine } from "./matchEngine.js";
import { CoachOrchestrator, createCoachRequestBody, extractCoachDecision, extractModelIds, resolveApiKey, resolveChatEndpoint, resolveModelsEndpoint } from "./coachOrchestrator.js";
import { saveMatchArtifacts } from "./reporting.js";
import { loadConfig, mergeConfig, saveConfig, sanitizeConfig } from "./storage.js";
import { createRng, redactSensitive } from "./utils.js";

// coach 看板广播限流：两次广播至少间隔 250ms（≤4Hz），避免模型状态刷屏。
const COACH_BROADCAST_MIN_INTERVAL_MS = 250;
// Windows 默认定时器精度会把 33.3ms 的 setInterval 拉长到 46.8ms（实测只有 21.5 tick/s），
// 因此推进循环改为"10ms 轮询 + 按墙钟补齐 tick"，保证比赛时钟与真实时间一致。
const TICK_MS = 1000 / 30;
const RUN_LOOP_POLL_MS = 10;
const MAX_CATCH_UP_TICKS = 6;

/** 管理当前本地比赛会话。 */
export class MatchController {
  constructor(broadcaster = () => {}) {
    this.broadcaster = broadcaster;
    this.engine = null;
    this.orchestrator = null;
    this.interval = null;
    this.lastStepAt = 0;
    this.nextStepAt = 0;
    this.config = null;
    this.extraSecrets = [];
    this.lastCoachSignature = "";
    this.lastCoachBroadcastAt = 0;
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

  /** 测试模型连接，密钥留空时复用已保存密钥。 */
  async testModel({ side = "home", coach = {} }) {
    const effective = this.effectiveCoach(side, coach);
    const apiKey = effective.api_key || effective.api_key_once || "";
    if (apiKey) this.extraSecrets = [...new Set([...this.extraSecrets, apiKey])];
    if (!effective.endpoint) return { status: "success", message: "本地规则教练可用。" };
    if (!apiKey && !effective.api_key_ref) return { status: "missing_key", message: "缺少 API Key 或环境变量引用。" };
    const resolvedKey = resolveApiKey(effective);
    if (!resolvedKey) return { status: "missing_key", message: "无法解析 API Key。" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
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
      const response = await fetch(resolveChatEndpoint(effective), {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolvedKey}` },
        body: JSON.stringify(createCoachRequestBody(effective, input))
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

  /** 获取上游可用模型列表，密钥留空时复用已保存密钥。 */
  async listModels({ side = "home", coach = {} }) {
    const effective = this.effectiveCoach(side, coach);
    if (effective.api_key) this.extraSecrets = [...new Set([...this.extraSecrets, effective.api_key])];
    if (!effective.endpoint) return { status: "missing_endpoint", message: "请先填写 Endpoint；本地规则教练无需获取模型列表。" };
    const resolvedKey = resolveApiKey(effective);
    if (!resolvedKey) return { status: "missing_key", message: "缺少 API Key 或环境变量引用。" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(resolveModelsEndpoint(effective), {
        method: "GET",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${resolvedKey}` }
      });
      if (!response.ok) return { status: "error", message: `模型接口返回 ${response.status}` };
      const models = extractModelIds(await response.json()).sort((a, b) => a.localeCompare(b));
      if (!models.length) return { status: "error", message: "模型接口未返回可用模型列表。" };
      return { status: "success", message: `获取到 ${models.length} 个模型。`, models };
    } catch (error) {
      return { status: "error", message: error.name === "AbortError" ? "获取模型列表超时。" : `获取模型列表失败：${error.message}` };
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

  /** 推进运行中比赛：每 3 tick 广播 10Hz 动帧，每 30 tick 或状态切换时广播全量快照。 */
  step() {
    if (!this.engine) return;
    try {
      this.lastStepAt = Date.now();
      const beforeTick = this.engine.tick;
      const beforeState = this.engine.state;
      const snapshot = this.engine.advanceTick();
      this.orchestrator?.tick();
      // 暂停/完场时 advanceTick 不推进 tick，用 tickAdvanced 防止同一帧被反复广播。
      const tickAdvanced = snapshot.tick !== beforeTick;
      if (tickAdvanced && snapshot.tick % 3 === 0) this.broadcast("motion", this.motionPayload());
      if (this.engine.state !== beforeState || (tickAdvanced && snapshot.tick % 30 === 0)) this.broadcast("snapshot", this.currentPayload());
      if (this.engine.state === "full_time") this.finishIfNeeded().catch((error) => this.recordRuntimeError("finish_error", error));
    } catch (error) {
      this.recordRuntimeError("tick_error", error);
    }
  }

  /** 构造动帧 payload：优先使用引擎 motionFrame，引擎尚未就绪时降级为快照精简。 */
  motionPayload() {
    try {
      if (typeof this.engine?.motionFrame === "function") return this.engine.motionFrame();
    } catch (error) {
      this.recordRuntimeError("motion_frame_error", error);
    }
    return this.fallbackMotionFrame();
  }

  /** 引擎没有 motionFrame 时的降级实现：只从全量快照挑选动帧字段，保持与正式协议同构。 */
  fallbackMotionFrame() {
    const snapshot = this.engine.snapshot();
    const clock = snapshot.clock || {};
    const players = [];
    for (const side of ["home", "away"]) {
      for (const player of snapshot.teams?.[side]?.players || []) {
        players.push({ team_id: side, id: player.id, x: player.x, y: player.y, vx: player.vx ?? 0, vy: player.vy ?? 0 });
      }
    }
    const ball = snapshot.ball || {};
    return {
      match_id: snapshot.match_id,
      tick: snapshot.tick,
      state: snapshot.state,
      paused: snapshot.paused,
      game_time: snapshot.game_time,
      display_time: snapshot.display_time,
      period_label: clock.period_label ?? null,
      period_display_time: clock.period_display_time ?? null,
      period_total_display_time: clock.period_total_display_time ?? null,
      score: snapshot.score,
      ball: { x: ball.x, y: ball.y, holderTeam: ball.holderTeam ?? null, holderId: ball.holderId ?? null, inFlight: ball.inFlight ?? null, flightKind: ball.flightKind ?? null },
      players
    };
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

  /** 按 replayId 获取已完成的回放片段。 */
  getReplay(replayId) {
    if (!this.engine) return null;
    return this.engine.getReplay(replayId);
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

  /** 合并配置时以当前配置为基底做增量更新，并保留已保存密钥；显式改用 env: 引用时清除旧密钥，避免旧密钥优先生效。 */
  withSavedKeys(input = {}) {
    const base = this.config || {};
    const merged = mergeConfig({
      homeCoach: { ...(base.homeCoach || {}), ...(input.homeCoach || {}) },
      awayCoach: { ...(base.awayCoach || {}), ...(input.awayCoach || {}) },
      match: { ...(base.match || {}), ...(input.match || {}) }
    });
    for (const side of ["homeCoach", "awayCoach"]) {
      const incoming = input?.[side] || {};
      const savedKey = this.config?.[side]?.api_key || "";
      const nextKey = incoming.api_key || incoming.api_key_once || "";
      if (nextKey) merged[side].api_key = nextKey;
      else if (incoming.api_key_ref) merged[side].api_key = "";
      else if (savedKey) merged[side].api_key = savedKey;
    }
    return merged;
  }

  /** 合并提交的配置与已保存配置：密钥留空时复用已保存密钥，显式 env: 引用优先于旧密钥。 */
  effectiveCoach(side, coach = {}) {
    const saved = this.config?.[side === "away" ? "awayCoach" : "homeCoach"] || {};
    const effective = { ...saved, ...coach };
    effective.api_key_ref = coach.api_key_ref || saved.api_key_ref || "";
    effective.api_key = coach.api_key || coach.api_key_once || (coach.api_key_ref ? "" : saved.api_key || "");
    return effective;
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

  /** 构造当前全量 payload；脱敏统一放在 broadcast / HTTP 响应层，避免重复深拷贝。 */
  currentPayload() {
    if (!this.engine) return null;
    this.ensureRunLoop();
    return { ...this.engine.snapshot(), coach_dashboard: this.orchestrator?.dashboard?.() || null };
  }

  /** 构造已脱敏的全量 payload，用于 WS 握手首帧等绕过 broadcast 的单发场景。 */
  currentSafePayload() {
    const payload = this.current();
    return payload ? redactSensitive(payload, this.extraSecrets) : null;
  }

  /** 广播状态：这里是 WS 链路唯一一次脱敏点，wsHub 不再重复脱敏。 */
  broadcast(type, payload) {
    if (!this.engine) return;
    try {
      if (type === "coach" && !this.shouldBroadcastCoach(payload)) return;
      // motion 帧只含坐标、比分与时钟等公开字段，不含密钥/本机路径，跳过深拷贝脱敏以降低 10Hz 热路径开销。
      const safePayload = type === "motion" ? payload : redactSensitive(payload, this.extraSecrets);
      this.broadcaster(this.engine.matchId, { type, match_id: this.engine.matchId, sent_at: new Date().toISOString(), payload: safePayload });
    } catch (error) {
      this.recordRuntimeError("broadcast_error", error);
    }
  }

  /** coach 看板去重与限流：相同签名跳过，且两次广播至少间隔 250ms（≤4Hz）。 */
  shouldBroadcastCoach(payload) {
    const signature = JSON.stringify(payload);
    const now = Date.now();
    if (signature === this.lastCoachSignature || now - this.lastCoachBroadcastAt < COACH_BROADCAST_MIN_INTERVAL_MS) return false;
    this.lastCoachSignature = signature;
    this.lastCoachBroadcastAt = now;
    return true;
  }

  /** 记录运行期异常：写 console.error 与 safety_log，保证 30Hz 推进循环不中断。 */
  recordRuntimeError(type, error) {
    console.error(`[matchController] ${type}，比赛继续运行：`, error);
    try {
      this.engine?.matchLog?.safety_log?.push({ tick: this.engine.tick, type, message: error?.message || String(error) });
    } catch (logError) {
      console.error("[matchController] 写入 safety_log 失败", logError);
    }
  }

  ensureEngine() {
    if (!this.engine) {
      const error = new Error("当前没有比赛");
      error.status = 404;
      error.code = "match_not_found";
      throw error;
    }
  }

  /** 启动或恢复比赛推进循环：按墙钟补齐 tick，避免系统定时器精度不足导致比赛慢于真实时间。 */
  startRunLoop() {
    if (this.interval) clearInterval(this.interval);
    const now = Date.now();
    this.lastStepAt = now;
    this.nextStepAt = now + TICK_MS;
    this.interval = setInterval(() => this.runPendingSteps(), RUN_LOOP_POLL_MS);
  }

  /** 轮询推进：到点就推进一个 tick，定时器滞后时一次补多个（上限 6 个，避免长时间卡顿后快进）。 */
  runPendingSteps() {
    if (!this.engine) return;
    const now = Date.now();
    if (!this.nextStepAt) this.nextStepAt = now;
    if (this.engine.paused || this.engine.state === "full_time") {
      this.nextStepAt = now + TICK_MS;
      this.lastStepAt = now;
      return;
    }
    let steps = 0;
    while (now >= this.nextStepAt && steps < MAX_CATCH_UP_TICKS) {
      this.nextStepAt += TICK_MS;
      this.step();
      steps += 1;
    }
    // 休眠/断点等长时间停滞后放弃积压的 tick，只从当前时间继续。
    if (now - this.nextStepAt > 1000) this.nextStepAt = now + TICK_MS;
    if (steps > 0) this.lastStepAt = now;
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
