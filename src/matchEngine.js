import { buildCommentary } from "./commentary.js";
import { installMovementMethods } from "./engine/movement.js";
import { applyFormation, createMirrorTeams, getOnFieldPlayers } from "./teamFactory.js";
import { TICKS_PER_SECOND, clamp, createId, distance, formatGameTime, normalizeMatchMinutes, nowIso } from "./utils.js";

export const ENGINE_VERSION = "1.0.0";
export const RULES_VERSION = "standard_11v11_v1";

const PASS_INTERVAL_TICKS = TICKS_PER_SECOND * 4;
const SHOT_INTERVAL_TICKS = TICKS_PER_SECOND * 165;
const DUEL_INTERVAL_TICKS = TICKS_PER_SECOND * 15;
const BALL_OUT_INTERVAL_TICKS = TICKS_PER_SECOND * 60;
const PENALTY_CHECK_INTERVAL_TICKS = TICKS_PER_SECOND * 300;
const PENALTY_INCIDENT_PROBABILITY = 0.1;

/** 本机权威比赛引擎。 */
export class MatchEngine {
  constructor(config, rng) {
    this.config = config;
    this.rng = rng;
    this.matchId = createId("match");
    this.matchMinutes = normalizeMatchMinutes(config?.match?.matchMinutes);
    this.fullTimeSeconds = this.matchMinutes * 60;
    this.halfSeconds = Math.floor(this.fullTimeSeconds / 2);
    this.teams = createMirrorTeams(config, rng);
    this.tick = 0;
    this.gameTime = 0;
    this.period = "first_half";
    this.state = "pre_match";
    this.previousState = "pre_match";
    this.stateTicks = 0;
    this.paused = false;
    this.possessionTeam = "home";
    this.ball = { x: 50, y: 50, vx: 0, vy: 0, holderTeam: "home", holderId: 9 };
    this.lastPassSnapshot = null;
    this.lastShotTick = -Infinity;
    this.lastEventTicks = new Set();
    this.passReception = null;
    this.matchLog = this.createEmptyLog();
    this.pendingEvents = { home: [], away: [] };
    this.carryTracker = { teamId: this.possessionTeam, playerId: this.ball.holderId, startX: this.ball.x, startTick: 0, lastCommentaryTime: -Infinity };
    this.shootout = null;
    this.onEvent = null;
    this.onActionEvent = null;
    this.reportPaths = null;
    this.startedAt = nowIso();
  }

  /** 启动比赛。 */
  start() {
    this.state = "kickoff";
    this.logEvent("match_started", null, null, "比赛开始，双方镜像阵容就位。", { restart_state: "kickoff" });
    this.recordTick(true);
    return this.snapshot();
  }

  /** 推进一个权威 tick。 */
  advanceTick() {
    if (this.paused || this.state === "full_time") return this.snapshot();
    this.tick += 1;
    this.stateTicks += 1;
    if (this.isClockRunning()) this.gameTime += 1 / TICKS_PER_SECOND;
    this.handleTimedStates();
    if (this.state === "in_play") this.simulateOpenPlay();
    this.updateDynamicTargets();
    this.updatePlayers();
    this.maybeLogCarryProgression();
    this.recordTick(false);
    this.handlePeriodBoundaries();
    return this.snapshot();
  }

  /** 暂停比赛。 */
  pause() {
    this.paused = true;
    this.logEvent("match_paused", null, null, "比赛暂停。", {});
  }

  /** 恢复比赛。 */
  resume() {
    this.paused = false;
    this.logEvent("match_resumed", null, null, "比赛恢复。", {});
  }

  /** 停止比赛。 */
  stop(reason = "用户停止比赛") {
    if (this.state !== "full_time") {
      this.previousState = this.state;
      this.state = "full_time";
      this.logEvent("match_stopped", null, null, reason, {});
      this.recordTick(true);
    }
  }

  /** 应用模型战术。 */
  applyTactics(teamId, tacticalState, decisionLog = null) {
    const team = this.teams[teamId];
    team.tactics = { ...team.tactics, ...tacticalState, appliedTick: this.tick };
    if (tacticalState.formation && tacticalState.formation !== team.formation) {
      team.formation = tacticalState.formation;
      applyFormation(team.players, team.formation, teamId === "away", { resetPositions: false });
    }
    this.adjustTargetsByTactics(teamId);
    this.logEvent("tactic_applied", teamId, null, `${team.name} 应用战术：${tacticalState.intent}`, { decision_id: decisionLog?.decision_id });
  }

  /** 执行换人。 */
  attemptSubstitution(teamId, outPlayerId, inPlayerId, context = this.state) {
    const team = this.teams[teamId];
    const outPlayer = team.players.find((player) => player.id === outPlayerId);
    const inPlayer = team.players.find((player) => player.id === inPlayerId);
    const limit = this.period.startsWith("extra") ? 6 : 5;
    const returningPlayer = team.substitutions.usedPlayers.some((substitution) => substitution.out === inPlayerId);
    if (!outPlayer || !inPlayer || !outPlayer.onField || inPlayer.onField || outPlayer.sentOff || returningPlayer) return { ok: false, reason: "球员状态不允许换人" };
    if ((outPlayer.position === "GK") !== (inPlayer.position === "GK")) return { ok: false, reason: "门将与非门将不能直接互换" };
    if (team.substitutions.used >= limit) return { ok: false, reason: "换人名额已用完" };
    if (context !== "half_time" && context !== "extra_time_break" && team.substitutions.lastWindowTick !== this.tick) {
      if (team.substitutions.windowsUsed >= (this.period.startsWith("extra") ? 4 : 3)) return { ok: false, reason: "换人窗口已用完" };
      team.substitutions.windowsUsed += 1;
      team.substitutions.lastWindowTick = this.tick;
    }
    outPlayer.onField = false;
    inPlayer.onField = true;
    inPlayer.formationSlot = outPlayer.formationSlot;
    inPlayer.x = outPlayer.x;
    inPlayer.y = outPlayer.y;
    team.substitutions.used += 1;
    team.substitutions.usedPlayers.push({ out: outPlayerId, in: inPlayerId, tick: this.tick });
    applyFormation(team.players, team.formation, teamId === "away", { resetPositions: false });
    this.logEvent("substitution", teamId, inPlayerId, `${team.name}：${outPlayer.name} 下，${inPlayer.name} 上。`, { related_player_ids: [outPlayerId, inPlayerId] });
    this.logActionEvent("substitution", teamId, inPlayerId, `${team.name}：${outPlayer.name} 下，${inPlayer.name} 上。`, { target: this.playerRef(teamId, outPlayerId), related_player_ids: [outPlayerId, inPlayerId] });
    return { ok: true };
  }

  /** 返回指定进攻方对应的倒数第二名防守球员线。 */
  secondLastDefenderLine(teamId) {
    const opponent = this.teams[teamId === "home" ? "away" : "home"];
    const defenders = getOnFieldPlayers(opponent).map((player) => player.x).sort((a, b) => teamId === "home" ? b - a : a - b);
    return defenders[1] ?? (teamId === "home" ? 100 : 0);
  }

  /** 判断接球目标在当前球位下是否处于越位位置。 */
  isOffsideTarget(teamId, receiver, ballX = this.ball.x, secondLastLine = this.secondLastDefenderLine(teamId)) {
    const aheadOfBall = teamId === "home" ? receiver.x > ballX : receiver.x < ballX;
    const beyondLine = teamId === "home" ? receiver.x > secondLastLine : receiver.x < secondLastLine;
    const inOpponentHalf = teamId === "home" ? receiver.x > 50 : receiver.x < 50;
    return Boolean(aheadOfBall && beyondLine && inOpponentHalf);
  }

  /** 把无球接应目标按职责错层压回越位线内。 */
  onsideSupportTargetX(teamId, targetX, ballX, secondLastLine, margin = 3.2) {
    if (teamId === "home") return Math.min(targetX, Math.max(ballX, secondLastLine, 50) - margin);
    return Math.max(targetX, Math.min(ballX, secondLastLine, 50) + margin);
  }

  /** 记录传球瞬间并判定潜在越位位置。 */
  evaluateOffsideAtPass(teamId, passerId, receiverId) {
    const team = this.teams[teamId];
    const receiver = team.players.find((player) => player.id === receiverId);
    const secondLastLine = this.secondLastDefenderLine(teamId);
    const offsidePosition = this.isOffsideTarget(teamId, receiver, this.ball.x, secondLastLine);
    this.lastPassSnapshot = { tick: this.tick, teamId, passerId, receiverId, ballX: this.ball.x, receiverX: receiver.x, secondLastLine, offsidePosition };
    return this.lastPassSnapshot;
  }

  /** 在接球参与进攻时确认越位。 */
  confirmOffsideIfInvolved() {
    if (!this.lastPassSnapshot?.offsidePosition) return { offside: false };
    const teamId = this.lastPassSnapshot.teamId;
    this.teams[teamId].stats.offsides += 1;
    this.logEvent("offside", teamId, this.lastPassSnapshot.receiverId, "越位：按传球瞬间位置判定。", { restart_state: "free_kick" });
    this.changeState("free_kick");
    return { offside: true, snapshot: this.lastPassSnapshot };
  }

  /** 给球员出示黄牌或红牌。 */
  cardPlayer(teamId, playerId, card) {
    const team = this.teams[teamId];
    const player = team.players.find((item) => item.id === playerId);
    if (!player) return;
    if (card === "yellow") {
      player.yellowCards += 1;
      team.stats.yellowCards += 1;
      this.logEvent("yellow_card", teamId, playerId, `${player.name} 得到黄牌。`, {});
      this.logActionEvent("yellow_card", teamId, playerId, `${player.name} 得到黄牌。`);
      if (player.yellowCards >= 2) this.cardPlayer(teamId, playerId, "red");
      return;
    }
    player.sentOff = true;
    player.onField = false;
    team.stats.redCards += 1;
    this.rebalanceAfterRed(teamId);
    this.logEvent("red_card", teamId, playerId, `${player.name} 被红牌罚下，阵型自动重平衡。`, {});
    this.logActionEvent("red_card", teamId, playerId, `${player.name} 被红牌罚下。`);
  }

  /** 触发 VAR 复核。 */
  triggerVarCheck(reason = "关键判罚复核") {
    this.previousState = this.state;
    this.changeState("var_check");
    this.logEvent("var_check", null, null, reason, { review_type: "key_decision" });
  }

  /** 完成 VAR 复核。 */
  completeVarCheck(result = "维持原判") {
    const nextState = this.previousState === "in_play" ? "free_kick" : this.previousState;
    this.logEvent("var_result", null, null, `VAR 结果：${result}`, { final_decision: result, restart_state: nextState });
    this.changeState(nextState || "in_play");
  }

  /** 模拟点球大战。 */
  simulatePenaltyShootout() {
    this.changeState("penalty_shootout");
    const shootout = { home: 0, away: 0, kicks: [] };
    let round = 0;
    while (round < 5 || shootout.home === shootout.away) {
      round += 1;
      for (const side of ["home", "away"]) {
        const scorer = this.rng.next() < 0.72;
        if (scorer) shootout[side] += 1;
        shootout.kicks.push({ round, side, scored: scorer });
      }
      const remaining = 5 - round;
      if (round >= 5 || Math.abs(shootout.home - shootout.away) > remaining) {
        if (shootout.home !== shootout.away) break;
      }
      if (round > 12) break;
    }
    this.shootout = shootout;
    this.logEvent("shootout_finished", null, null, `点球大战结束：${shootout.home}-${shootout.away}`, { shootout });
    this.changeState("full_time");
    return shootout;
  }

  /** 生成前端快照。 */
  snapshot() {
    const clock = this.clockSnapshot();
    return {
      match_id: this.matchId,
      tick: this.tick,
      game_time: this.gameTime,
      display_time: clock.display_time,
      state: this.state,
      paused: this.paused,
      period: this.period,
      clock,
      score: { home: this.teams.home.score, away: this.teams.away.score },
      shootout_score: this.shootout ? { home: this.shootout.home, away: this.shootout.away } : null,
      possession_team: this.possessionTeam,
      ball: { ...this.ball },
      pass_reception: this.passReception ? { ...this.passReception } : null,
      teams: {
        home: this.teamSnapshot(this.teams.home),
        away: this.teamSnapshot(this.teams.away)
      },
      recent_events: this.matchLog.match_event_log.slice(-8),
      recent_action_events: this.matchLog.action_event_log.slice(-12),
      stats: this.combinedStats(),
      report_ready: Boolean(this.reportPaths)
    };
  }

  clockSnapshot() {
    const extraHalfSeconds = 15 * 60;
    const extraTotalSeconds = extraHalfSeconds * 2;
    const usesExtraClock = this.period?.startsWith("extra") || this.state === "extra_time_break" || this.state === "penalty_shootout";
    const matchTotalSeconds = this.fullTimeSeconds + (usesExtraClock ? extraTotalSeconds : 0);
    const period = this.clockPeriodWindow(extraHalfSeconds);
    const elapsedSeconds = clamp(this.gameTime, 0, matchTotalSeconds);
    const periodElapsedSeconds = clamp(this.gameTime - period.start, 0, period.total);
    return {
      period: this.period,
      period_label: this.periodLabel(),
      elapsed_seconds: elapsedSeconds,
      display_time: formatGameTime(elapsedSeconds),
      period_elapsed_seconds: periodElapsedSeconds,
      period_display_time: formatGameTime(periodElapsedSeconds),
      period_total_seconds: period.total,
      period_total_display_time: formatGameTime(period.total),
      match_total_seconds: matchTotalSeconds,
      match_total_display_time: formatGameTime(matchTotalSeconds),
      regulation_total_seconds: this.fullTimeSeconds,
      regulation_total_display_time: formatGameTime(this.fullTimeSeconds)
    };
  }

  clockPeriodWindow(extraHalfSeconds = 15 * 60) {
    const secondHalfSeconds = this.fullTimeSeconds - this.halfSeconds;
    if (this.state === "penalty_shootout") return { start: this.fullTimeSeconds + extraHalfSeconds * 2, total: 0 };
    if (this.state === "extra_time_break" && this.period === "full_time") return { start: this.fullTimeSeconds, total: extraHalfSeconds };
    if (this.state === "extra_time_break" && this.period === "extra_between") return { start: this.fullTimeSeconds + extraHalfSeconds, total: extraHalfSeconds };
    if (this.state === "full_time" && this.gameTime <= this.fullTimeSeconds) return { start: this.halfSeconds, total: secondHalfSeconds };
    if (this.period === "first_half") return { start: 0, total: this.halfSeconds };
    if (this.period === "second_half" || this.state === "half_time") return { start: this.halfSeconds, total: secondHalfSeconds };
    if (this.period === "extra_first") return { start: this.fullTimeSeconds, total: extraHalfSeconds };
    if (this.period === "extra_between" || this.period === "extra_second") return { start: this.fullTimeSeconds + extraHalfSeconds, total: extraHalfSeconds };
    return { start: 0, total: this.fullTimeSeconds };
  }

  periodLabel() {
    if (this.state === "penalty_shootout") return "\u70b9\u7403\u5927\u6218";
    if (this.state === "full_time") return "\u5168\u573a";
    if (this.state === "half_time") return "\u4e2d\u573a";
    if (this.state === "extra_time_break" && this.period === "full_time") return "\u52a0\u65f6\u524d\u4f11\u606f";
    if (this.state === "extra_time_break") return "\u52a0\u65f6\u4e2d\u573a";
    return {
      first_half: "\u4e0a\u534a\u573a",
      second_half: "\u4e0b\u534a\u573a",
      extra_first: "\u52a0\u65f6\u4e0a\u534a\u573a",
      extra_between: "\u52a0\u65f6\u4e2d\u573a",
      extra_second: "\u52a0\u65f6\u4e0b\u534a\u573a",
      full_time: "\u5168\u573a"
    }[this.period] || this.period;
  }

  /** 创建空日志。 */
  createEmptyLog() {
    return {
      match_meta: { match_id: this.matchId, created_at: nowIso(), engine_version: ENGINE_VERSION, rules_version: RULES_VERSION, tactical_schema_version: "coach_decision_v1", random_seed: this.rng.seed, mirror_template_version: "mirror_23_v1", runtime_version: "local_node_v1" },
      engine_tick_log: [],
      match_event_log: [],
      action_event_log: [],
      model_decision_log: [],
      safety_log: []
    };
  }

  /** 记录比赛事件。 */
  logEvent(eventType, teamId, playerId, description, extra = {}) {
    const event = { event_id: `event_${this.matchLog.match_event_log.length + 1}`, tick: this.tick, game_time: this.gameTime, event_type: eventType, team_id: teamId, player_id: playerId, location: { x: this.ball.x, y: this.ball.y }, related_player_ids: extra.related_player_ids || [], referee_decision: extra.final_decision || null, xG: extra.xG || 0, restart_state: extra.restart_state || null, description, ...extra };
    this.matchLog.match_event_log.push(event);
    this.lastEventTicks.add(this.tick);
    this.pendingEvents.home.push(event);
    this.pendingEvents.away.push(event);
    this.recordTick(true);
    this.onEvent?.(event);
    return event;
  }

  /** 记录动作事件并生成播报。 */
  logActionEvent(actionType, teamId, playerId, description = "", extra = {}) {
    const { actor = this.playerRef(teamId, playerId), target = null, ...rest } = extra;
    const event = {
      action_event_id: `action_event_${this.matchLog.action_event_log.length + 1}`,
      tick: this.tick,
      game_time: this.gameTime,
      action_type: actionType,
      team_id: teamId,
      player_id: playerId,
      actor,
      target,
      location: { x: this.ball.x, y: this.ball.y },
      description,
      ...rest
    };
    event.commentary = event.commentary || buildCommentary(event);
    event.description = event.description || event.commentary;
    this.matchLog.action_event_log.push(event);
    this.onActionEvent?.(event);
    return event;
  }

  /** 生成动作事件中的球员引用。 */
  playerRef(teamId, playerId) {
    const team = this.teams[teamId];
    const player = team?.players.find((item) => item.id === playerId);
    if (!team && !player) return null;
    return { team_id: teamId, team_name: team?.name || teamId, player_id: player?.id ?? playerId ?? null, shirt: player?.shirt ?? null, name: player?.name ?? null, position: player?.position ?? null };
  }

  /** 记录状态快照。 */
  recordTick(force) {
    const last = this.matchLog.engine_tick_log.at(-1);
    if (!force && last && this.tick - last.tick < 5) return;
    this.matchLog.engine_tick_log.push({ tick: this.tick, game_time: this.gameTime, match_state: this.state, ball_state: { ...this.ball }, player_state_snapshot_ref: `snapshot_${this.tick}`, team_tactical_state: { home: this.teams.home.tactics, away: this.teams.away.tactics }, possession_team: this.possessionTeam, current_phase: this.period, referee_state: { last_event_tick: this.tick }, stamina_summary: this.staminaSummary(), score: { home: this.teams.home.score, away: this.teams.away.score } });
  }

  /** 判断比赛时钟是否运行。 */
  isClockRunning() {
    return ["kickoff", "in_play", "throw_in", "goal_kick", "corner_kick", "free_kick", "penalty_kick"].includes(this.state);
  }

  handleTimedStates() {
    if (this.state === "kickoff" && this.stateTicks >= TICKS_PER_SECOND * 2) this.changeState("in_play");
    if (["throw_in", "goal_kick", "corner_kick", "free_kick", "penalty_kick", "goal_scored"].includes(this.state) && this.stateTicks >= TICKS_PER_SECOND * 3) this.changeState(this.state === "goal_scored" ? "kickoff" : "in_play");
    if (this.state === "var_check" && this.stateTicks >= TICKS_PER_SECOND * 2) this.completeVarCheck("维持原判");
    if (this.state === "half_time" && this.stateTicks >= TICKS_PER_SECOND * 2) {
      this.period = "second_half";
      this.changeState("kickoff");
    }
    if (this.state === "extra_time_break" && this.stateTicks >= TICKS_PER_SECOND * 2) {
      this.period = this.period === "full_time" ? "extra_first" : "extra_second";
      this.changeState("kickoff");
    }
  }

  handlePeriodBoundaries() {
    if (this.period === "first_half" && this.gameTime >= this.halfSeconds && this.state === "in_play") {
      this.changeState("half_time");
      this.logEvent("period_end", null, null, "上半场结束。", {});
    }
    if (this.period === "second_half" && this.gameTime >= this.fullTimeSeconds && this.state === "in_play") {
      if (this.config.match?.knockout && this.teams.home.score === this.teams.away.score) {
        this.period = "full_time";
        this.changeState("extra_time_break");
        this.logEvent("extra_time_required", null, null, "淘汰赛平局，进入加时赛。", {});
      } else {
        this.changeState("full_time");
        this.logEvent("full_time", null, null, "全场比赛结束。", {});
      }
    }
    if (this.period === "extra_first" && this.gameTime >= this.fullTimeSeconds + 900 && this.state === "in_play") {
      this.period = "extra_between";
      this.changeState("extra_time_break");
      this.logEvent("period_end", null, null, "加时赛上半场结束。", {});
    }
    if (this.period === "extra_second" && this.gameTime >= this.fullTimeSeconds + 1800 && this.state === "in_play") {
      if (this.teams.home.score === this.teams.away.score) this.simulatePenaltyShootout();
      else this.changeState("full_time");
    }
  }

  simulateOpenPlay() {
    if (this.passReception) return;
    const immediateShot = this.hasImmediateShootingChance();
    if ((this.tick % SHOT_INTERVAL_TICKS === 0 || immediateShot) && this.simulateShot()) return;
    if (this.tick % PASS_INTERVAL_TICKS === 0) this.simulatePass();
    if (this.state !== "in_play") return;
    if (this.tick % DUEL_INTERVAL_TICKS === 0) this.simulateDuel();
    if (this.state !== "in_play") return;
    if (this.tick % BALL_OUT_INTERVAL_TICKS === 0) this.simulateBallOut();
    if (this.state !== "in_play") return;
    if (this.tick % PENALTY_CHECK_INTERVAL_TICKS === 0 && this.rng.next() < PENALTY_INCIDENT_PROBABILITY) this.simulatePenaltyIncident();
  }

  simulateBallOut(forcedRestart = null) {
    const restartRoll = this.rng.next();
    const restart = forcedRestart || (restartRoll < 0.58 ? "throw_in" : restartRoll < 0.86 ? "goal_kick" : "corner_kick");
    const opponentId = this.possessionTeam === "home" ? "away" : "home";
    const restartTeam = restart === "goal_kick" || restart === "throw_in" ? opponentId : this.possessionTeam;
    const restartX = restart === "throw_in" ? clamp(this.ball.x, 5, 95) : restart === "corner_kick" ? (restartTeam === "home" ? 93 : 7) : restartTeam === "home" ? 7 : 93;
    const restartY = restart === "throw_in" || restart === "corner_kick" ? (this.rng.next() < 0.5 ? 4 : 96) : 50;
    const restartPlayers = getOnFieldPlayers(this.teams[restartTeam]).filter((player) => (restart === "goal_kick" ? player.position === "GK" : player.position !== "GK"));
    const restartHolder = (restartPlayers.length ? restartPlayers : getOnFieldPlayers(this.teams[restartTeam])).reduce((nearest, player) => {
      if (!nearest) return player;
      return distance(player, { x: restartX, y: restartY }) < distance(nearest, { x: restartX, y: restartY }) ? player : nearest;
    }, null);
    this.possessionTeam = restartTeam;
    this.ball.holderTeam = restartTeam;
    this.ball.holderId = restartHolder?.id || 1;
    this.setBallTarget(restartX, restartY);
    const label = { throw_in: "界外球", corner_kick: "角球", goal_kick: "球门球" }[restart];
    this.logEvent(restart, restartTeam, this.ball.holderId, `${this.teams[restartTeam].name} 获得${label}。`, { restart_state: restart });
    this.logActionEvent(restart, restartTeam, this.ball.holderId, `${this.teams[restartTeam].name} 获得${label}。`);
    this.resetCarryTracker();
    this.changeState(restart);
    return restart;
  }

  simulatePenaltyIncident() {
    const defenderId = this.possessionTeam === "home" ? "away" : "home";
    const defender = getOnFieldPlayers(this.teams[defenderId]).find((player) => player.position !== "GK");
    this.teams[defenderId].stats.fouls += 1;
    this.setBallTarget(this.possessionTeam === "home" ? 88 : 12, 50);
    this.logEvent("penalty_awarded", this.possessionTeam, this.ball.holderId, `${this.teams[this.possessionTeam].name} 获得点球。`, { related_player_ids: defender ? [defender.id] : [], restart_state: "penalty_kick" });
    this.logActionEvent("penalty_awarded", this.possessionTeam, this.ball.holderId, `${this.teams[this.possessionTeam].name} 获得点球。`, { target: defender ? this.playerRef(defenderId, defender.id) : null, related_player_ids: defender ? [defender.id] : [] });
    if (defender && this.rng.next() < 0.14) this.cardPlayer(defenderId, defender.id, "yellow");
    this.changeState("penalty_kick");
    return true;
  }

  simulatePass() {
    if (this.passReception) return;
    const team = this.teams[this.possessionTeam];
    const players = getOnFieldPlayers(team);
    const passer = players.find((player) => player.id === this.ball.holderId) || this.nearestOnFieldPlayer(this.possessionTeam, this.ball);
    if (!this.isBallWithPlayer(passer, 5)) return;
    const preferredReceivers = players.filter((player) => player.id !== passer?.id && (passer?.position === "GK" || player.position !== "GK"));
    const receivers = preferredReceivers.length ? preferredReceivers : players.filter((player) => player.id !== passer?.id);
    if (!passer || !receivers.length) return;
    const direction = this.possessionTeam === "home" ? 1 : -1;
    const secondLastLine = this.secondLastDefenderLine(this.possessionTeam);
    const isOffsideTarget = (receiver) => this.isOffsideTarget(this.possessionTeam, receiver, this.ball.x, secondLastLine);
    const receiverCandidates = receivers.some((receiver) => !isOffsideTarget(receiver)) ? receivers.filter((receiver) => !isOffsideTarget(receiver)) : receivers;
    const roleBonus = { ST: 9, AM: 7, RW: 7, LW: 7, CM: 4, DM: 2, RB: 1, LB: 1, CB: 0, GK: -20 };
    const rankedReceivers = receiverCandidates
      .map((receiver) => {
        const receiverDepth = this.possessionTeam === "home" ? receiver.x : 100 - receiver.x;
        const passerDepth = this.possessionTeam === "home" ? passer.x : 100 - passer.x;
        const forwardGain = (receiver.x - passer.x) * direction;
        const offsideRisk = isOffsideTarget(receiver) ? -28 : 0;
        const buildupBonus = passer.position === "GK" ? 10 - Math.abs(receiverDepth - 28) * 0.35 + (["CB", "RB", "LB", "DM"].includes(receiver.position) ? 4 : 0) : 0;
        const lineBreakBonus = receiverDepth > passerDepth ? 5 : -3;
        return { receiver, score: forwardGain * 1.4 + receiverDepth * 0.16 - distance(passer, receiver) * 0.08 + (roleBonus[receiver.position] ?? 0) + lineBreakBonus + buildupBonus + offsideRisk };
      })
      .sort((left, right) => right.score - left.score);
    const receiverPool = rankedReceivers.slice(0, Math.min(3, rankedReceivers.length));
    const receiver = receiverPool[Math.floor(this.rng.next() * receiverPool.length)]?.receiver;
    if (!receiver) return;
    const trajectory = this.passTrajectory(passer, receiver);
    this.evaluateOffsideAtPass(this.possessionTeam, passer.id, receiver.id);
    const passSuccess = this.passProbability(passer, receiver, team.tactics);
    team.stats.passes += 1;
    if (this.rng.next() < passSuccess) {
      team.stats.completedPasses += 1;
      this.passReception = {
        teamId: this.possessionTeam,
        passerId: passer.id,
        receiverId: receiver.id,
        mode: trajectory.reception_mode,
        targetX: trajectory.end.x,
        targetY: trajectory.end.y,
        passStartX: trajectory.start.x,
        passStartY: trajectory.start.y,
        receiverStartX: receiver.x,
        receiverStartY: receiver.y,
        startedTick: this.tick
      };
      this.setBallTarget(trajectory.end.x, trajectory.end.y);
      this.ball.pendingHolderTeam = this.possessionTeam;
      this.ball.pendingHolderId = receiver.id;
      this.ball.receptionMode = trajectory.reception_mode;
      this.ball.flightHeight = trajectory.height;
      this.ball.flightKind = trajectory.kind;
      this.ball.flightStartX = trajectory.start.x;
      this.ball.flightStartY = trajectory.start.y;
      this.ball.flightEndX = trajectory.end.x;
      this.ball.flightEndY = trajectory.end.y;
      this.ball.inFlight = true;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.logActionEvent("pass_completed", this.possessionTeam, passer.id, "", { target: this.playerRef(this.possessionTeam, receiver.id), trajectory });
    } else {
      const passerTeamId = this.possessionTeam;
      const opponentId = this.possessionTeam === "home" ? "away" : "home";
      const interceptor = this.nearestOnFieldPlayer(opponentId, this.ball);
      const interceptionTrajectory = interceptor ? { ...trajectory, end: this.pointRef(interceptor), outcome: "intercepted" } : { ...trajectory, outcome: "intercepted" };
      this.passReception = null;
      this.possessionTeam = opponentId;
      this.ball.holderTeam = opponentId;
      this.ball.holderId = interceptor?.id || this.ball.holderId;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.logActionEvent("pass_intercepted", passerTeamId, passer.id, "", { target: interceptor ? this.playerRef(opponentId, interceptor.id) : null, trajectory: interceptionTrajectory });
      this.resetCarryTracker();
    }
  }

  simulateDuel() {
    const team = this.teams[this.possessionTeam];
    const opponentId = this.possessionTeam === "home" ? "away" : "home";
    const holder = team.players.find((player) => player.id === this.ball.holderId) || getOnFieldPlayers(team)[0];
    const defender = holder ? this.nearestOnFieldPlayer(opponentId, holder) : null;
    if (!defender || !holder || !this.isBallWithPlayer(holder, 6)) return;
    const foulProbability = clamp(0.04 + defender.hidden.foul_tendency * 0.08 + (defender.stamina < 45 ? 0.07 : 0) - ((defender.attributes.tackle - 50) / 50) * 0.06, 0.01, 0.65);
    if (this.rng.next() < foulProbability) {
      this.teams[opponentId].stats.fouls += 1;
      this.logEvent("foul", opponentId, defender.id, `${defender.name} 犯规。`, { restart_state: "free_kick" });
      this.logActionEvent("foul", opponentId, defender.id, `${defender.name} 犯规。`, { target: this.playerRef(this.possessionTeam, holder.id) });
      if (this.rng.next() < 0.12) this.cardPlayer(opponentId, defender.id, "yellow");
      this.changeState("free_kick");
    } else if (this.rng.next() < 0.45) {
      const holderTeamId = this.possessionTeam;
      this.teams[opponentId].stats.tackles += 1;
      this.possessionTeam = opponentId;
      this.ball.holderTeam = opponentId;
      this.ball.holderId = defender.id;
      this.logActionEvent("tackle_won", opponentId, defender.id, "", { target: this.playerRef(holderTeamId, holder.id) });
      this.resetCarryTracker();
    }
  }

  /** 估算当前持球人的射门机会。 */
  estimateShootingChance() {
    const team = this.teams[this.possessionTeam];
    const shooter = team.players.find((player) => player.id === this.ball.holderId) || getOnFieldPlayers(team)[0];
    if (!this.isBallWithPlayer(shooter, 4)) return null;
    const goalX = this.possessionTeam === "home" ? 100 : 0;
    const attackingDepth = this.possessionTeam === "home" ? shooter.x : 100 - shooter.x;
    if (attackingDepth < 70) return null;
    const shotDistance = Math.abs(goalX - shooter.x);
    const centrality = 1 - Math.min(Math.abs(shooter.y - 50) / 45, 1);
    const distanceQuality = 1 - Math.min(shotDistance / 45, 1);
    const opponentId = this.possessionTeam === "home" ? "away" : "home";
    const nearestDefender = this.nearestOnFieldPlayer(opponentId, shooter);
    const pressure = nearestDefender ? clamp((5.5 - distance(nearestDefender, shooter)) / 5.5, 0, 1) : 0;
    const xG = clamp(0.01 + distanceQuality * 0.115 + centrality * 0.026 + ((shooter.attributes.shooting - 50) / 50) * 0.018 - pressure * 0.018 - (shooter.stamina < 45 ? 0.035 : 0), 0.01, 0.2);
    const threshold = team.tactics.behavior?.shotThreshold ?? 0.07;
    return { team, shooter, xG, threshold, shotDistance, centrality, pressure };
  }

  /** 判断是否应在下一次传球前立即完成射门。 */
  hasImmediateShootingChance() {
    const chance = this.estimateShootingChance();
    if (!chance) return false;
    const shotCooldown = this.tick - this.lastShotTick;
    const closeRange = chance.shotDistance <= 12;
    const centralBoxChance = chance.shotDistance <= 16.5 && chance.centrality >= 0.75;
    const passWindow = this.tick % PASS_INTERVAL_TICKS === 0;
    const passWindowChance = passWindow && centralBoxChance && chance.shotDistance <= 16 && shotCooldown >= TICKS_PER_SECOND * 360;
    const cooldownTicks = closeRange ? TICKS_PER_SECOND * 120 : centralBoxChance ? TICKS_PER_SECOND * 240 : TICKS_PER_SECOND * 320;
    const cooledDown = shotCooldown >= cooldownTicks;
    const qualityFloor = passWindowChance ? Math.max(0.11, chance.threshold + 0.015) : centralBoxChance ? Math.max(0.115, chance.threshold + 0.035) : closeRange ? Math.max(0.085, chance.threshold) : Math.max(0.13, chance.threshold + 0.03);
    const pressureLimit = centralBoxChance ? 0.98 : 0.9;
    return Boolean(cooledDown && (closeRange || centralBoxChance || passWindowChance) && chance.pressure < pressureLimit && chance.xG >= qualityFloor);
  }

  simulateShot() {
    const chance = this.estimateShootingChance();
    if (!chance || chance.xG < chance.threshold) return false;
    const { team, shooter, xG } = chance;
    this.lastShotTick = this.tick;
    team.stats.shots += 1;
    team.stats.xG += xG;
    const scored = this.rng.next() < xG;
    const onTarget = scored || this.rng.next() < clamp(xG + 0.25, 0.08, 0.75);
    if (onTarget) team.stats.shotsOnTarget += 1;
    if (scored) {
      team.score += 1;
      shooter.form = clamp(shooter.form + 2, -10, 10);
      const trajectory = this.shotTrajectory(shooter, onTarget, true);
      this.logEvent("goal", this.possessionTeam, shooter.id, `${shooter.name} 破门得分。`, { xG, restart_state: "kickoff" });
      this.logActionEvent("goal", this.possessionTeam, shooter.id, `${shooter.name} 破门得分。`, { xG, trajectory });
      if (this.rng.next() < 0.2) this.triggerVarCheck("进球有效性复核。");
      else this.changeState("goal_scored");
    } else {
      const trajectory = this.shotTrajectory(shooter, onTarget, false);
      this.logEvent("shot", this.possessionTeam, shooter.id, `${shooter.name} 完成射门。`, { xG });
      this.logActionEvent("shot", this.possessionTeam, shooter.id, `${shooter.name} 完成射门。`, { xG, trajectory });
      this.simulateBallOut(onTarget && this.rng.next() < 0.25 ? "corner_kick" : "goal_kick");
    }
    return true;
  }

  /** 返回传球的可视化球路，不影响比赛判定。 */
  passTrajectory(passer, receiver) {
    const passDistance = distance(passer, receiver);
    const lateralGap = Math.abs(passer.y - receiver.y);
    const direction = this.possessionTeam === "home" ? 1 : -1;
    const forwardGain = (receiver.x - passer.x) * direction;
    const passerDepth = this.possessionTeam === "home" ? passer.x : 100 - passer.x;
    const isCross = passerDepth >= 72 && lateralGap >= 20;
    const isLofted = isCross || passDistance >= 34 || (forwardGain >= 18 && lateralGap >= 14);
    const kind = isCross ? "cross" : isLofted ? "lofted_pass" : forwardGain >= 10 ? "through_pass" : "ground_pass";
    const height = isCross ? 0.86 : isLofted ? 0.68 : kind === "through_pass" ? 0.22 : 0.08;
    const reception = this.passReceptionPoint(passer, receiver, kind, forwardGain, lateralGap);
    return {
      kind,
      label: isLofted ? "高球" : "低平球",
      height,
      start: this.pointRef(passer),
      end: reception.point,
      receiver_position_at_pass: this.pointRef(receiver),
      reception_mode: reception.mode,
      outcome: "completed"
    };
  }

  /** 根据传球类型决定传到脚下还是打到接球人前方空间。 */
  passReceptionPoint(passer, receiver, kind, forwardGain, lateralGap) {
    const direction = this.possessionTeam === "home" ? 1 : -1;
    const receiverDepth = this.possessionTeam === "home" ? receiver.x : 100 - receiver.x;
    const intoSpace = ["through_pass", "cross", "lofted_pass"].includes(kind) && (forwardGain > 8 || lateralGap > 18 || receiverDepth > 66);
    if (!intoSpace) {
      const gap = Math.max(distance(passer, receiver), 1);
      const checkDistance = clamp(gap * 0.13, 1.2, receiver.position === "GK" ? 2.2 : 3.8);
      const point = {
        x: clamp(receiver.x + ((passer.x - receiver.x) / gap) * checkDistance, 5, 95),
        y: clamp(receiver.y + ((passer.y - receiver.y) / gap) * checkDistance, 5, 95)
      };
      return { mode: "to_feet", point };
    }
    const leadByKind = { through_pass: 7.5, cross: 5.8, lofted_pass: 4.8 };
    const lead = leadByKind[kind] ?? 4.5;
    const lanePull = kind === "cross" ? (50 - receiver.y) * 0.28 : (receiver.y - passer.y) * 0.12;
    const point = {
      x: clamp(receiver.x + direction * lead, 5, 95),
      y: clamp(receiver.y + lanePull, 5, 95)
    };
    const secondLastLine = this.secondLastDefenderLine(this.possessionTeam);
    point.x = this.onsideSupportTargetX(this.possessionTeam, point.x, this.ball.x, secondLastLine, 2.2);
    return { mode: "into_space", point };
  }

  /** 返回射门的可视化球路，不影响比赛判定。 */
  shotTrajectory(shooter, onTarget, scored) {
    const goalX = this.possessionTeam === "home" ? 100 : 0;
    const targetY = scored ? 50 : clamp(shooter.y + (shooter.y < 50 ? -8 : 8), 29, 71);
    return {
      kind: scored ? "goal_shot" : "shot",
      label: onTarget ? "射正" : "射偏",
      height: onTarget ? 0.5 : 0.72,
      start: this.pointRef(shooter),
      end: { x: goalX, y: targetY },
      outcome: scored ? "goal" : onTarget ? "saved_or_blocked" : "missed"
    };
  }

  /** 复制实体坐标，供前端动画使用。 */
  pointRef(point) {
    return { x: point?.x ?? this.ball.x, y: point?.y ?? this.ball.y };
  }

  passProbability(passer, receiver, tactics) {
    const passDistance = distance(passer, receiver);
    const distancePenalty = passDistance < 18 ? 0.05 : passDistance < 36 ? 0.14 : 0.28;
    const riskModifier = tactics.passingRisk === "high" ? -0.04 : tactics.passingRisk === "low" ? 0.04 : 0;
    return clamp(0.72 + ((passer.attributes.passing - 50) / 50) * 0.16 + ((passer.attributes.vision - 50) / 50) * 0.08 + ((receiver.attributes.positioning - 50) / 50) * 0.06 - distancePenalty + riskModifier, 0.05, 0.98);
  }

  /** 返回距离指定点最近的场上球员。 */
  nearestOnFieldPlayer(teamId, point) {
    return getOnFieldPlayers(this.teams[teamId]).reduce((nearest, player) => {
      if (!nearest) return player;
      return distance(player, point) < distance(nearest, point) ? player : nearest;
    }, null);
  }

  /** 设置足球需要平滑移动到的目标点。 */
  setBallTarget(x, y) {
    this.ball.targetX = x;
    this.ball.targetY = y;
    this.ball.vx = 0;
    this.ball.vy = 0;
  }

  /** 清除足球目标点，恢复跟随持球人。 */
  clearBallTarget() {
    delete this.ball.targetX;
    delete this.ball.targetY;
    delete this.ball.pendingHolderTeam;
    delete this.ball.pendingHolderId;
    delete this.ball.receptionMode;
    delete this.ball.flightHeight;
    delete this.ball.flightKind;
    delete this.ball.flightStartX;
    delete this.ball.flightStartY;
    delete this.ball.flightEndX;
    delete this.ball.flightEndY;
    delete this.ball.inFlight;
    this.passReception = null;
  }

  /** 完成跑向落点接球阶段。 */
  completePassReceptionIfReady() {
    if (!this.passReception) return;
    const receiver = this.teams[this.passReception.teamId]?.players.find((player) => player.id === this.passReception.receiverId);
    if (!receiver) return;
    const target = { x: this.passReception.targetX, y: this.passReception.targetY };
    if (distance(this.ball, target) <= 0.7 && distance(receiver, target) <= 4.2) {
      this.possessionTeam = this.passReception.teamId;
      this.ball.holderTeam = this.passReception.teamId;
      this.ball.holderId = this.passReception.receiverId;
      this.ball.x = receiver.x;
      this.ball.y = receiver.y;
      this.clearBallTarget();
      this.resetCarryTracker();
      this.confirmOffsideIfInvolved();
    }
  }

  passReceptionProgress(reception = this.passReception) {
    if (!reception) return 0;
    const start = { x: reception.passStartX ?? this.ball.flightStartX ?? this.ball.x, y: reception.passStartY ?? this.ball.flightStartY ?? this.ball.y };
    const end = { x: reception.targetX, y: reception.targetY };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return 1;
    return clamp(((this.ball.x - start.x) * dx + (this.ball.y - start.y) * dy) / lengthSquared, 0, 1);
  }

  receptionRunnerTarget(receiver) {
    const reception = this.passReception;
    const finalPoint = { x: reception.targetX, y: reception.targetY };
    const start = { x: reception.receiverStartX ?? receiver.x, y: reception.receiverStartY ?? receiver.y };
    const progress = this.passReceptionProgress(reception);
    if (reception.mode === "into_space") {
      const runPhase = clamp(progress + 0.24, 0.2, 1);
      return {
        x: start.x + (finalPoint.x - start.x) * runPhase,
        y: start.y + (finalPoint.y - start.y) * runPhase
      };
    }
    const settlePhase = clamp(progress * 1.35 + 0.18, 0.18, 1);
    return {
      x: start.x + (finalPoint.x - start.x) * settlePhase,
      y: start.y + (finalPoint.y - start.y) * settlePhase
    };
  }

  /** 判断足球是否已经到达当前动作球员附近。 */
  isBallWithPlayer(player, tolerance = 4) {
    return Boolean(player && distance(this.ball, player) <= tolerance);
  }

  /** 重置持球推进统计起点。 */
  resetCarryTracker() {
    const holder = this.teams[this.possessionTeam]?.players.find((player) => player.id === this.ball.holderId);
    this.carryTracker = { teamId: this.possessionTeam, playerId: this.ball.holderId, startX: holder?.x ?? this.ball.x, startTick: this.tick, lastCommentaryTime: this.carryTracker?.lastCommentaryTime ?? -Infinity };
  }

  /** 按推进距离和冷却时间生成持球推进播报。 */
  maybeLogCarryProgression() {
    if (this.state !== "in_play") return;
    if (this.passReception) return;
    const holder = this.teams[this.possessionTeam]?.players.find((player) => player.id === this.ball.holderId);
    if (!this.isBallWithPlayer(holder, 7)) return;
    const changedHolder = this.carryTracker?.teamId !== this.possessionTeam || this.carryTracker?.playerId !== this.ball.holderId;
    if (changedHolder || !Number.isFinite(this.carryTracker?.startX)) {
      this.resetCarryTracker();
      return;
    }
    const direction = this.possessionTeam === "home" ? 1 : -1;
    const gain = (holder.x - this.carryTracker.startX) * direction;
    if (gain < 0) {
      this.carryTracker.startX = holder.x;
      return;
    }
    if (gain >= 8 && this.gameTime - this.carryTracker.lastCommentaryTime >= 10) {
      this.logActionEvent("carry_progressive", this.possessionTeam, holder.id, "", { carry_distance: gain });
      this.carryTracker = { teamId: this.possessionTeam, playerId: holder.id, startX: holder.x, startTick: this.tick, lastCommentaryTime: this.gameTime };
    }
  }

  adjustTargetsByTactics(teamId) {
    const team = this.teams[teamId];
    const direction = teamId === "home" ? 1 : -1;
    const pressShift = team.tactics.pressingHeight === "high" ? 8 : team.tactics.pressingHeight === "low" ? -6 : 0;
    const widthShift = team.tactics.attackingWidth === "wide" ? 6 : team.tactics.attackingWidth === "narrow" ? -4 : 0;
    for (const player of getOnFieldPlayers(team)) {
      const baseX = player.baseTargetX ?? player.targetX;
      const baseY = player.baseTargetY ?? player.targetY;
      player.targetX = player.position === "GK" ? baseX : clamp(baseX + pressShift * direction, 4, 96);
      player.targetY = baseY < 50 ? clamp(baseY - widthShift, 4, 96) : baseY > 50 ? clamp(baseY + widthShift, 4, 96) : baseY;
    }
  }

  rebalanceAfterRed(teamId) {
    const team = this.teams[teamId];
    const count = getOnFieldPlayers(team).length;
    team.formation = count <= 10 ? "4-4-1" : team.formation;
    applyFormation(team.players, team.formation, teamId === "away", { resetPositions: false });
  }

  changeState(nextState) {
    this.previousState = this.state;
    this.state = nextState;
    this.stateTicks = 0;
    if (nextState === "in_play") this.clearBallTarget();
  }

  staminaSummary() {
    const summary = {};
    for (const side of ["home", "away"]) {
      const players = getOnFieldPlayers(this.teams[side]);
      summary[side] = Math.round(players.reduce((sum, player) => sum + player.stamina, 0) / Math.max(players.length, 1));
    }
    return summary;
  }

  teamSnapshot(team) {
    return { id: team.id, name: team.name, formation: team.formation, tactics: team.tactics, stats: team.stats, players: getOnFieldPlayers(team).map((player) => ({ id: player.id, shirt: player.shirt, name: player.name, x: player.x, y: player.y, targetX: player.targetX, targetY: player.targetY, stamina: player.stamina, form: player.form, yellowCards: player.yellowCards, sentOff: player.sentOff, position: player.position })) };
  }

  combinedStats() {
    return { home: this.teams.home.stats, away: this.teams.away.stats };
  }
}

installMovementMethods(MatchEngine);
