/**
 * 客户端动帧缓冲与时间轴插值（纯数据模块）。
 *
 * 设计要点：
 * - 帧时间轴使用客户端接收时间 receivedAt（毫秒）与服务器 tick 的比值估计每 tick 毫秒数；
 * - sampleAt 以 nowMs - delayMs 作为"当前应显示的时刻"，反推显示 tick，在相邻两帧间线性插值；
 * - 越界时 clamp 到最近帧；只有落后最新帧不超过 80ms 才用两帧差速外推，且外推最多 80ms；
 * - 不引用 DOM / window / performance 等浏览器全局，可直接被 Node 测试 import；
 * - 所有导出函数都不修改传入的 state / frame，返回新对象或浅拷贝。
 */

export const DEFAULT_TICK_MS = 33.33;
export const MAX_FRAMES = 30;
export const MAX_EXTRAPOLATE_MS = 80;
const MAX_TICK_SAMPLES = 16;
const MIN_TICK_MS = 15;
const MAX_TICK_MS = 80;
const DEFAULT_DELAY_MS = 120;

/** 创建动帧流状态：frames 按 tick 升序保存，tickMs 为每个 tick 的毫秒估计。 */
export function createStreamState() {
  return { frames: [], tickMs: DEFAULT_TICK_MS };
}

/** 写入一帧：按 tick 去重/排序，只保留最近 MAX_FRAMES 帧，并同步刷新 tickMs 估计。 */
export function pushFrame(state, frame, receivedAtMs) {
  if (!state || !Array.isArray(state.frames)) return null;
  const normalized = normalizeFrame(frame, receivedAtMs);
  if (!normalized) return null;
  const frames = state.frames;
  const existingIndex = frames.findIndex((item) => item.tick === normalized.tick);
  if (existingIndex >= 0) {
    // 同一 tick 只保留最后一次到达的数据（快照与动帧可能撞 tick），避免帧数膨胀。
    frames[existingIndex] = normalized;
  } else {
    frames.push(normalized);
    frames.sort((left, right) => left.tick - right.tick);
  }
  if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES);
  state.tickMs = estimateTickMs(state);
  return normalized;
}

/** 用最近若干对相邻帧的 (receivedAt 差 / tick 差) 中位数估计 tickMs，样本不足返回 33.33。 */
export function estimateTickMs(state) {
  const frames = state?.frames || [];
  if (frames.length < 2) return DEFAULT_TICK_MS;
  const samples = [];
  const start = Math.max(1, frames.length - MAX_TICK_SAMPLES);
  for (let index = start; index < frames.length; index += 1) {
    const deltaMs = frames[index].receivedAt - frames[index - 1].receivedAt;
    const deltaTick = frames[index].tick - frames[index - 1].tick;
    // 只采信正向、非零样本；乱序或同 tick 样本直接丢弃。
    if (deltaMs > 0 && deltaTick > 0) samples.push(deltaMs / deltaTick);
  }
  if (!samples.length) return DEFAULT_TICK_MS;
  samples.sort((left, right) => left - right);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
  return clamp(median, MIN_TICK_MS, MAX_TICK_MS);
}

/** 返回最新一帧的独立副本（reduced-motion 直接绘制最新帧、不做插值）。 */
export function latestFrame(state) {
  const frames = state?.frames || [];
  const newest = frames[frames.length - 1];
  if (!newest) return null;
  return cloneFrame(newest);
}

/** 按 nowMs - delayMs 的时间轴采样：相邻两帧线性插值，越界 clamp，最多外推 80ms。 */
export function sampleAt(state, nowMs, delayMs = DEFAULT_DELAY_MS) {
  const frames = state?.frames || [];
  if (!frames.length) return null;
  const tickMs = Number.isFinite(state.tickMs) ? state.tickMs : DEFAULT_TICK_MS;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
  const delay = Number.isFinite(Number(delayMs)) ? Number(delayMs) : DEFAULT_DELAY_MS;
  const newest = frames[frames.length - 1];
  // 目标显示时刻 now - delay 对应的 tick：比最新帧更早时为负偏移，更晚时为正偏移。
  const targetTime = now - delay;
  const displayTick = newest.tick + (targetTime - newest.receivedAt) / tickMs;

  if (displayTick <= frames[0].tick) return sampleFrames(null, frames[0], 0, frames[0].tick, 0);
  if (displayTick >= newest.tick) {
    const previous = frames.length > 1 ? frames[frames.length - 2] : null;
    const extraTicks = Math.min(displayTick - newest.tick, MAX_EXTRAPOLATE_MS / tickMs);
    return sampleFrames(previous, newest, 0, newest.tick + extraTicks, extraTicks);
  }
  let index = frames.length - 2;
  while (index > 0 && frames[index].tick > displayTick) index -= 1;
  const from = frames[index];
  const to = frames[index + 1];
  const span = to.tick - from.tick;
  const ratio = span > 0 ? clamp((displayTick - from.tick) / span, 0, 1) : 1;
  return sampleFrames(from, to, ratio, displayTick, 0);
}

/** 提取一帧中需要覆盖到 latest 的标量字段（不含 teams/ball 等大对象）。 */
export function frameScalars(frame) {
  if (!frame) return null;
  const scalars = { tick: frame.tick };
  if (frame.state != null) scalars.state = frame.state;
  if (frame.paused != null) scalars.paused = frame.paused;
  if (frame.score) scalars.score = { ...frame.score };
  if (frame.clock) scalars.clock = { ...frame.clock };
  if (frame.gameTime != null) scalars.game_time = frame.gameTime;
  if (frame.displayTime != null) scalars.display_time = frame.displayTime;
  if (frame.period != null) scalars.period = frame.period;
  return scalars;
}

/**
 * 为渲染层准备可复用的绘制缓存：模板（最新快照）变化时重建球员/球队/球副本，
 * 之后每个动帧只覆盖坐标与速度，避免每帧深拷贝 22 名球员；模板不变时原样返回缓存。
 */
export function createDrawStateCache(template, previous = null) {
  if (previous?.template === template) return previous;
  const players = new Map();
  const teams = {};
  for (const side of ["home", "away"]) {
    const copies = template.teams[side].players.map((player) => {
      const copy = { ...player };
      players.set(`${side}:${player.id}`, copy);
      return copy;
    });
    teams[side] = { ...template.teams[side], players: copies };
  }
  const ball = template.ball ? { ...template.ball } : null;
  return { template, players, teams, ball, state: { ...template, teams, ball } };
}

/**
 * 把采样帧覆盖到绘制缓存：球员/球坐标与引擎速度、比分/时钟等标量取动帧最新值；
 * 足球先保留快照里的球路细节（flightStartX 等）再覆盖，避免 10Hz 动帧缺字段时丢飞行信息。
 * 直接更新并返回同一个缓存对象（调用方按帧复用，不产生额外深拷贝）。
 */
export function applyFrameToDrawState(cache, frame) {
  if (!cache || !frame) return cache;
  const template = cache.template;
  cache.state.state = frame.state ?? template.state;
  cache.state.paused = frame.paused ?? template.paused;
  cache.state.score = frame.score || template.score;
  cache.state.clock = frame.clock || template.clock;
  for (const player of frame.players) {
    const target = cache.players.get(`${player.team_id}:${player.id}`);
    if (!target) continue;
    target.x = player.x;
    target.y = player.y;
    // 渲染层速度兜底直接读 player.vx/vy（引擎每 tick 位移）：用动帧即时覆盖，
    // 避免画布降帧或球员停下时回退到 1Hz 快照里的滞后速度。
    if (Number.isFinite(player.vx) && Number.isFinite(player.vy)) {
      target.vx = player.vx;
      target.vy = player.vy;
    }
  }
  if (frame.ball) {
    cache.ball = cache.ball || {};
    Object.assign(cache.ball, template.ball || {}, frame.ball);
    cache.state.ball = cache.ball;
  }
  return cache;
}

/** 从 10Hz "motion" 消息构造内部帧（players 只保留插值需要的坐标/速度字段）。 */
export function frameFromMotion(payload) {
  if (!payload) return null;
  return {
    tick: payload.tick,
    players: (payload.players || []).map((player) => ({
      team_id: player.team_id === "away" ? "away" : "home",
      id: player.id ?? null,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy
    })),
    ball: payload.ball ? { ...payload.ball } : null,
    state: payload.state ?? null,
    paused: typeof payload.paused === "boolean" ? payload.paused : null,
    score: payload.score ? { home: payload.score.home ?? 0, away: payload.score.away ?? 0 } : null,
    clock: motionClock(payload),
    gameTime: payload.game_time ?? null,
    displayTime: payload.display_time ?? null,
    period: payload.period ?? null
  };
}

/** 从全量快照构造内部帧：场上球员按主客队列出，作为插值时间轴的锚点。 */
export function frameFromSnapshot(payload) {
  if (!payload?.teams?.home || !payload?.teams?.away) return null;
  const players = [];
  for (const side of ["home", "away"]) {
    for (const player of payload.teams[side].players || []) {
      players.push({ team_id: side, id: player.id ?? null, x: player.x, y: player.y, vx: player.vx, vy: player.vy });
    }
  }
  return {
    tick: payload.tick,
    players,
    ball: payload.ball ? { ...payload.ball } : null,
    state: payload.state ?? null,
    paused: typeof payload.paused === "boolean" ? payload.paused : null,
    score: payload.score ? { home: payload.score.home ?? 0, away: payload.score.away ?? 0 } : null,
    clock: copyClock(payload.clock) || motionClock(payload),
    gameTime: payload.game_time ?? null,
    displayTime: payload.display_time ?? payload.clock?.display_time ?? null,
    period: payload.period ?? null
  };
}

/** 在相邻两个回放帧之间线性插值球员与球坐标，返回新的回放帧（不修改入参）。 */
export function interpolateReplayFrames(from, to, alpha = 0.5) {
  if (!from) return to || null;
  if (!to) return from;
  const ratio = clamp(Number.isFinite(Number(alpha)) ? Number(alpha) : 0, 0, 1);
  const teams = {};
  for (const side of ["home", "away"]) {
    const fromTeam = from.teams?.[side] || {};
    const toTeam = to.teams?.[side] || {};
    const players = interpolateReplayPlayers(fromTeam.players || [], toTeam.players || [], ratio);
    teams[side] = { ...toTeam, players };
  }
  return {
    ...to,
    tick: lerp(Number(from.tick) || 0, Number(to.tick) || 0, ratio),
    teams,
    ball: interpolateReplayBall(from.ball, to.ball, ratio)
  };
}

/** 把帧标准化为内部结构并深拷贝坐标/标量，避免后续修改影响调用方对象。 */
function normalizeFrame(frame, receivedAtMs) {
  const tick = Number(frame?.tick);
  if (!Number.isFinite(tick)) return null;
  const receivedAt = Number(receivedAtMs);
  return {
    tick,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : 0,
    players: Array.isArray(frame.players) ? frame.players.filter((player) => player && Number.isFinite(Number(player.x)) && Number.isFinite(Number(player.y))).map((player) => ({
      team_id: player.team_id === "away" ? "away" : "home",
      id: player.id ?? null,
      x: Number(player.x),
      y: Number(player.y),
      vx: Number.isFinite(Number(player.vx)) ? Number(player.vx) : 0,
      vy: Number.isFinite(Number(player.vy)) ? Number(player.vy) : 0
    })) : [],
    ball: normalizeBall(frame.ball),
    state: frame.state ?? null,
    paused: typeof frame.paused === "boolean" ? frame.paused : null,
    score: frame.score ? { home: Number(frame.score.home) || 0, away: Number(frame.score.away) || 0 } : null,
    clock: copyClock(frame.clock),
    gameTime: Number.isFinite(Number(frame.gameTime)) ? Number(frame.gameTime) : null,
    displayTime: frame.displayTime ?? null,
    period: frame.period ?? null
  };
}

/** 拷贝最新帧的独立副本。 */
function cloneFrame(frame) {
  return {
    ...frame,
    players: frame.players.map((player) => ({ ...player })),
    ball: frame.ball ? { ...frame.ball } : null,
    score: frame.score ? { ...frame.score } : null,
    clock: copyClock(frame.clock)
  };
}

/** 用前后两帧合成采样结果：ratio 为插值比例，extraTicks 为允许的差速外推 tick 数。 */
function sampleFrames(previous, current, ratio, tick, extraTicks) {
  return {
    tick,
    players: samplePlayers(previous, current, ratio, extraTicks),
    ball: sampleBall(previous?.ball, current.ball, ratio, extraTicks, previous, current),
    state: current.state,
    paused: current.paused,
    score: current.score ? { ...current.score } : previous?.score ? { ...previous.score } : null,
    clock: copyClock(current.clock) || copyClock(previous?.clock),
    gameTime: current.gameTime ?? previous?.gameTime ?? null,
    displayTime: current.displayTime ?? previous?.displayTime ?? null,
    period: current.period ?? previous?.period ?? null
  };
}

/** 球员按 team_id+id 匹配插值；某一帧缺失的球员保留另一帧坐标。 */
function samplePlayers(previous, current, ratio, extraTicks) {
  const previousByKey = new Map((previous?.players || []).map((player) => [playerKey(player), player]));
  const sampled = current.players.map((player) => interpolatePlayer(previousByKey.get(playerKey(player)), player, ratio, extraTicks, previous, current));
  const currentKeys = new Set(current.players.map((player) => playerKey(player)));
  for (const player of previous?.players || []) {
    if (!currentKeys.has(playerKey(player))) sampled.push({ ...player });
  }
  return sampled;
}

/** 单名球员插值；外推时优先用两帧位置差速，其次用帧内 vx/vy（按每 tick 位移处理）。 */
function interpolatePlayer(previous, current, ratio, extraTicks, previousFrame, currentFrame) {
  const player = { team_id: current.team_id, id: current.id, x: current.x, y: current.y, vx: current.vx, vy: current.vy };
  if (!previous) {
    if (extraTicks > 0) {
      player.x += toPerTickVelocity(current.x, undefined, current.vx) * extraTicks;
      player.y += toPerTickVelocity(current.y, undefined, current.vy) * extraTicks;
    }
    return player;
  }
  if (extraTicks > 0) {
    const tickSpan = (currentFrame?.tick ?? 0) - (previousFrame?.tick ?? 0);
    player.x += toPerTickVelocity(current.x, previous.x, current.vx, tickSpan) * extraTicks;
    player.y += toPerTickVelocity(current.y, previous.y, current.vy, tickSpan) * extraTicks;
    return player;
  }
  player.x = lerp(previous.x, current.x, ratio);
  player.y = lerp(previous.y, current.y, ratio);
  return player;
}

/** 足球插值：坐标按前后帧插值/外推，其余飞行字段取较新的当前帧。 */
function sampleBall(previousBall, currentBall, ratio, extraTicks, previousFrame, currentFrame) {
  if (!currentBall) return previousBall ? { ...previousBall } : null;
  const ball = { ...currentBall };
  if (!previousBall) {
    if (extraTicks > 0) {
      ball.x += toPerTickVelocity(currentBall.x, undefined, currentBall.vx) * extraTicks;
      ball.y += toPerTickVelocity(currentBall.y, undefined, currentBall.vy) * extraTicks;
    }
    return ball;
  }
  if (extraTicks > 0) {
    const tickSpan = (currentFrame?.tick ?? 0) - (previousFrame?.tick ?? 0);
    ball.x += toPerTickVelocity(currentBall.x, previousBall.x, currentBall.vx, tickSpan) * extraTicks;
    ball.y += toPerTickVelocity(currentBall.y, previousBall.y, currentBall.vy, tickSpan) * extraTicks;
    return ball;
  }
  ball.x = lerp(previousBall.x, currentBall.x, ratio);
  ball.y = lerp(previousBall.y, currentBall.y, ratio);
  return ball;
}

/** 回放球员按 id 匹配插值；缺失的一方保留另一侧坐标。 */
function interpolateReplayPlayers(fromPlayers, toPlayers, ratio) {
  const fromById = new Map(fromPlayers.map((player) => [player.id, player]));
  const sampled = toPlayers.map((player) => {
    const previous = fromById.get(player.id);
    if (!previous) return { ...player };
    return { ...player, x: lerp(previous.x, player.x, ratio), y: lerp(previous.y, player.y, ratio) };
  });
  const toIds = new Set(toPlayers.map((player) => player.id));
  for (const player of fromPlayers) if (!toIds.has(player.id)) sampled.push({ ...player });
  return sampled;
}

/** 回放足球插值：坐标插值，其余字段取较新的目标帧。 */
function interpolateReplayBall(fromBall, toBall, ratio) {
  if (!toBall) return fromBall ? { ...fromBall } : null;
  if (!fromBall) return { ...toBall };
  return { ...toBall, x: lerp(fromBall.x, toBall.x, ratio), y: lerp(fromBall.y, toBall.y, ratio) };
}

/** 把动帧消息里的扁平时钟字段整理成与快照 clock 兼容的结构。 */
function motionClock(payload) {
  if (payload.clock) return copyClock(payload.clock);
  const clock = {};
  if (payload.period_label != null) clock.period_label = payload.period_label;
  if (payload.period_display_time != null) clock.period_display_time = payload.period_display_time;
  if (payload.period_total_display_time != null) clock.period_total_display_time = payload.period_total_display_time;
  if (payload.display_time != null) clock.display_time = payload.display_time;
  if (payload.game_time != null) clock.elapsed_seconds = payload.game_time;
  return Object.keys(clock).length ? clock : null;
}

/** 复制 clock 对象（无内容时返回 null）。 */
function copyClock(clock) {
  return clock && typeof clock === "object" ? { ...clock } : null;
}

/** 标准化足球对象：坐标转数值，其余字段原样浅拷贝。 */
function normalizeBall(ball) {
  if (!ball || !Number.isFinite(Number(ball.x)) || !Number.isFinite(Number(ball.y))) return null;
  return { ...ball, x: Number(ball.x), y: Number(ball.y) };
}

/** 计算每 tick 位移：优先用前后两帧位置差速，样本不足时退回帧内 vx/vy。 */
function toPerTickVelocity(current, previous, frameVelocity, tickSpan = 0) {
  if (previous != null && tickSpan > 0) return (current - previous) / tickSpan;
  return Number.isFinite(Number(frameVelocity)) ? Number(frameVelocity) : 0;
}

function playerKey(player) {
  return `${player.team_id}:${player.id}`;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
