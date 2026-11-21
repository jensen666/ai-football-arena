/**
 * 球员姿态系统（纯计算，不依赖 DOM，可被渲染器与 Node 测试直接复用）。
 * 职责：
 * 1) 用同一球员上一帧的屏幕坐标（或引擎 vx/vy）估算速度与 heading；
 * 2) 按实际行进距离累积步频相位，速度越小相位越不前进（idle 冻结）；
 * 3) 保留传球/射门/接球/抢断/犯规/庆祝动作姿态，作为跑动姿态的叠加层；
 * 4) 输出 facing/tilt/dirX/dirY 等朝向表现参数，供渲染器做镜像与小幅旋转。
 * 坐标约定：输入点是 pitchRenderer 投影后的 CSS 像素坐标；内部速度统一换算成
 * “设计基准像素/帧”（基准画布宽 1100px、60fps），因此与画布实际尺寸、帧率解耦。
 */

/** 无轨迹动作事件（黄牌、换人等）的默认姿态时长（毫秒）。 */
export const ACTION_EFFECT_MS = 900;
/** 进球特效与庆祝动作时长（毫秒）。 */
export const GOAL_EFFECT_MS = 2500;
/** 轨迹缺少 flightSpeed 时使用的默认球速（场地单位/秒）。 */
export const DEFAULT_FLIGHT_SPEED = 25;
/** 射门类轨迹缺省飞行速度（场地单位/tick），与引擎 applyBallFlight 的射门速度一致。 */
const DEFAULT_SHOT_FLIGHT_SPEED = 2.2;
/** 特效时长允许区间（毫秒）。 */
const EFFECT_MS_MIN = 350;
const EFFECT_MS_MAX = 2600;
/** 引擎 tick 周期：player.vx/vy 与 trajectory.flightSpeed 都是“每 tick”量（30Hz）。 */
const ENGINE_TICK_MS = 1000 / 30;
/** 60fps 单帧时长，用于把速度统一换算成“每帧”口径。 */
const FRAME_MS = 1000 / 60;
/** 步频相位累积系数（弧度/基准像素）：每跑 1 基准像素前进 0.165 弧度。 */
const STRIDE_RAD_PER_PX = 0.165;
/** 单帧最大相位增量，避免球员瞬移或低帧率时腿部转速失真。 */
const STRIDE_MAX_STEP_RAD = 0.9;
/** 满幅步幅对应的基准像素/帧速度。 */
const FULL_STRIDE_SPEED = 4.2;
/** 跑动状态的进入/退出死区（基准像素/帧），抑制目标点呼吸波动导致的跑停抖动。 */
const RUN_ENTER_SPEED = 0.55;
const RUN_EXIT_SPEED = 0.22;
/** 朝向插值系数（60fps 每帧的基础值），动作期间转向更快。 */
const HEADING_BLEND = 0.2;
const ACTION_HEADING_BLEND = 0.35;
/** 用引擎 vx/vy 估算屏幕速度时的近似投影系数（基准 1100x696 画布，像素/场地单位）。 */
const VELOCITY_PX_PER_X_UNIT = 8.45;
const VELOCITY_PX_PER_Y_UNIT = 5.08;
/** 初始朝向与镜像方向：主队朝 +x，客队朝 -x。 */
const INITIAL_HEADING = { home: 0, away: Math.PI };
const INITIAL_FACING = { home: 1, away: -1 };
/** 长时间未出场的球员记录清理（毫秒），避免长时间比赛的 Map 无限增长。 */
const RECORD_TTL_MS = 5000;
const RECORD_PRUNE_INTERVAL_MS = 2000;
/** 身体小幅倾斜的最大角度（弧度）。 */
const TILT_LIMIT = 0.18;

/** 动作姿态参数表：保留原有小人仔动作语义，作为跑动姿态的叠加层。 */
const PLAYER_ACTION_SYSTEM = {
  idle: { lean: 0, stretch: 0, leg: 0.08, arm: 0.08, kick: 0, crouch: 0 },
  run: { lean: 0.18, stretch: 0.22, leg: 0.48, arm: 0.38, kick: 0, crouch: 0.02 },
  pass: { lean: 0.28, stretch: 0.42, leg: 0.16, arm: 0.26, kick: 0.86, crouch: 0.02 },
  receive: { lean: -0.08, stretch: 0.2, leg: 0.2, arm: 0.34, kick: 0.18, crouch: 0.04 },
  shot: { lean: 0.34, stretch: 0.5, leg: 0.14, arm: 0.44, kick: 1.12, crouch: 0.02 },
  tackle: { lean: 0.42, stretch: 0.5, leg: 0.12, arm: 0.28, kick: 1.18, crouch: 0.18 },
  foul: { lean: 0.2, stretch: 0.22, leg: 0.12, arm: 0.66, kick: 0.54, crouch: 0.12 },
  celebrate: { lean: -0.14, stretch: 0.26, leg: 0.18, arm: 0.92, kick: 0.22, crouch: 0 }
};

/**
 * 估算动作事件的特效时长：优先用轨迹距离与引擎飞行速度换算。
 * 引擎的 trajectory.flightSpeed 是“场地单位/tick”，缺省按默认球速估算。
 * 没有轨迹的姿态类事件（黄牌、换人等）使用 ACTION_EFFECT_MS；进球固定 GOAL_EFFECT_MS。
 */
export function estimateEffectDurationMs(event = {}) {
  if (event.action_type === "goal") return GOAL_EFFECT_MS;
  const trajectory = event.trajectory;
  const start = trajectory?.start;
  const end = trajectory?.end;
  if (!start || !end) return ACTION_EFFECT_MS;
  const distance = Math.hypot(Number(end.x || 0) - Number(start.x || 0), Number(end.y || 0) - Number(start.y || 0));
  if (!Number.isFinite(distance) || distance <= 0) return ACTION_EFFECT_MS;
  const kind = trajectory.kind;
  const rawFlightSpeed = Number(trajectory.flightSpeed);
  // 引擎已写入 flightSpeed 时按“单位/tick”换算；射门类轨迹缺省用引擎射门速度兜底
  let perTickSpeed = null;
  if (Number.isFinite(rawFlightSpeed) && rawFlightSpeed > 0) perTickSpeed = rawFlightSpeed;
  else if (["shot", "goal_shot"].includes(kind)) perTickSpeed = DEFAULT_SHOT_FLIGHT_SPEED;
  const durationMs = perTickSpeed
    ? (distance / perTickSpeed) * ENGINE_TICK_MS
    : (distance / DEFAULT_FLIGHT_SPEED) * 1000;
  return clampNumber(durationMs, EFFECT_MS_MIN, EFFECT_MS_MAX);
}

/**
 * 创建姿态追踪器；实时画面与回放画面各持有一个实例，天然隔离朝向/步频/入网计时。
 * update 入参：{ player, side, point, view, state, time, effects, skipEffects }，
 * point 为投影后的 CSS 像素坐标，view 需提供 { width, height, scale }，
 * skipEffects=true 时完全忽略传入的实时特效（回放隔离）。
 */
export function createPoseTracker() {
  const records = new Map();
  const goalNetTimes = new Map();
  const pruneState = { lastEffects: null, lastRecordPruneAt: 0 };
  return {
    /** 更新并返回单个球员本帧姿态。 */
    update(input = {}) {
      const effects = input.effects || [];
      // 特效列表每帧会被渲染器重建，引用变化时顺手清理已结束的入网计时
      if (pruneState.lastEffects !== effects) {
        pruneState.lastEffects = effects;
        pruneGoalNetTimes(goalNetTimes, effects);
      }
      const time = Number(input.time) || 0;
      if (time - pruneState.lastRecordPruneAt > RECORD_PRUNE_INTERVAL_MS) {
        pruneState.lastRecordPruneAt = time;
        pruneRecords(records, time);
      }
      return computePose(records, goalNetTimes, input);
    },
    /** 清空全部追踪状态（重开比赛、切换比赛时调用）。 */
    reset() {
      records.clear();
      goalNetTimes.clear();
      pruneState.lastEffects = null;
      pruneState.lastRecordPruneAt = 0;
    }
  };
}

/** 角度平滑插值，处理 ±π 环绕。 */
function smoothAngle(from, to, factor) {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta * factor;
}

/** 数值裁剪。 */
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** 用引擎 vx/vy（每 tick 位移）估算基准像素/帧速度与朝向；数据无效时返回 null。 */
function velocityHint(player) {
  const vx = Number(player?.vx);
  const vy = Number(player?.vy);
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
  const pixelX = vx * VELOCITY_PX_PER_X_UNIT;
  const pixelY = vy * VELOCITY_PX_PER_Y_UNIT;
  const speed = (Math.hypot(pixelX, pixelY) * FRAME_MS) / ENGINE_TICK_MS;
  if (!Number.isFinite(speed) || speed < 0.02) return null;
  return { speed, heading: Math.atan2(pixelY, pixelX) };
}

/** 初始化单个球员的姿态记录（保存上一帧位置、朝向、步频相位与跑动状态）。 */
function createPoseRecord(side, point) {
  return {
    x: Number.isFinite(point?.x) ? point.x : 0,
    y: Number.isFinite(point?.y) ? point.y : 0,
    time: 0,
    heading: INITIAL_HEADING[side] ?? 0,
    facing: INITIAL_FACING[side] ?? 1,
    phase: 0,
    moving: false
  };
}

/** 清理长时间未出现的球员记录（换人、红牌离场后不再累积）。 */
function pruneRecords(records, time) {
  for (const [key, record] of records) {
    if (time - record.time > RECORD_TTL_MS) records.delete(key);
  }
}

/** 清理已经消失的入网计时，避免进球特效结束后 Map 持续增长。 */
function pruneGoalNetTimes(goalNetTimes, effects) {
  if (!goalNetTimes.size) return;
  const activeIds = new Set((effects || []).map((effect) => effect.id));
  for (const id of goalNetTimes.keys()) {
    if (!activeIds.has(id)) goalNetTimes.delete(id);
  }
}

/** 把动作事件映射到小人仔动作键。 */
function playerActionKey(action) {
  if (action.role === "target" && ["pass_completed", "pass_intercepted"].includes(action.type)) return "receive";
  if (["pass_completed", "pass_intercepted"].includes(action.type)) return "pass";
  if (["shot"].includes(action.type)) return "shot";
  if (["goal"].includes(action.type)) return ["actor", "teammate"].includes(action.role) ? "celebrate" : "receive";
  if (["tackle_won"].includes(action.type)) return action.role === "actor" ? "tackle" : "receive";
  if (["foul"].includes(action.type)) return "foul";
  return "idle";
}

/** 判断足球是否已经越过指定球门线并进入球网（庆祝动作的启动条件）。 */
function isBallInNet(effect, state) {
  if (!state?.ball) return false;
  const endX = effect.trajectory?.end?.x;
  if (!Number.isFinite(endX)) return false;
  const ballX = state.ball.x;
  if (endX > 100) return ballX >= 99.5;
  if (endX < 0) return ballX <= 0.5;
  return false;
}

/** 计算球路方向角度。 */
function effectAngle(effect) {
  const start = effect.trajectory?.start;
  const end = effect.trajectory?.end;
  if (start && end) return Math.atan2(end.y - start.y, end.x - start.x);
  return effect.actor?.team_id === "away" ? Math.PI : 0;
}

/** 查找球员当前生效的动作事件；没有任何匹配时返回 null。 */
function activePlayerAction(player, side, state, time, effects, goalNetTimes) {
  let selected = null;
  for (const effect of effects) {
    const duration = Number.isFinite(effect.durationMs) && effect.durationMs > 0 ? effect.durationMs : ACTION_EFFECT_MS;
    const rawAge = (time - effect.startedAt) / duration;
    if (rawAge < 0 || rawAge > 1) continue;
    const actorMatch = effect.actor?.team_id === side && effect.actor?.player_id === player.id;
    const targetMatch = effect.target?.team_id === side && effect.target?.player_id === player.id;
    const teammateCelebrate = effect.type === "goal" && effect.actor?.team_id === side;
    if (!actorMatch && !targetMatch && !teammateCelebrate) continue;
    let role = "target";
    if (actorMatch) role = "actor";
    else if (teammateCelebrate) role = "teammate";
    selected = { ...effect, age: rawAge, role };
  }
  if (!selected) return null;
  // 进球庆祝必须等球真正入网后才开始，避免球刚踢出球员就跳跃
  if (selected.type === "goal" && ["actor", "teammate"].includes(selected.role)) {
    if (!isBallInNet(selected, state)) return null;
    if (!goalNetTimes.has(selected.id)) goalNetTimes.set(selected.id, time);
    const netTime = goalNetTimes.get(selected.id);
    selected.age = (time - netTime) / GOAL_EFFECT_MS;
    if (selected.age < 0 || selected.age > 1) return null;
  }
  return { ...selected, angle: effectAngle(selected) };
}

/** 把动作事件姿态叠加到速度驱动的跑动姿态上：动作期间动作权重高于跑动。 */
function applyActionOverlay(runPose, action, time, player) {
  const pose = { ...runPose };
  if (!action) return pose;
  const actionKey = playerActionKey(action);
  const spec = PLAYER_ACTION_SYSTEM[actionKey] || PLAYER_ACTION_SYSTEM.idle;
  const pulse = Math.sin(Math.PI * clampNumber(action.age, 0, 1));
  const receiving = action.role === "target";
  pose.leg = Math.max(pose.leg, spec.leg * pulse);
  pose.armSwing *= 1 - pulse * 0.7;
  pose.arm = spec.arm * pulse;
  pose.kick = (receiving ? 0.22 : spec.kick) * pulse;
  pose.lean = pose.lean * (1 - pulse) + spec.lean * pulse;
  pose.stretch = Math.max(pose.stretch, spec.stretch * pulse);
  pose.crouch = Math.max(pose.crouch, spec.crouch * pulse);
  pose.run *= 1 - pulse * 0.5;
  // 庆祝动作的弹跳：按球员 id 错开相位，避免全队同步跳动
  if (actionKey === "celebrate") pose.jump = Math.abs(Math.sin(time * 0.015 + player.id * 0.8)) * 12;
  return pose;
}

/** 计算单个球员本帧姿态：位移 → 速度 → 步频/朝向 → 动作叠加。 */
function computePose(records, goalNetTimes, { player, side, point, view, state = null, time = 0, effects = [], skipEffects = false }) {
  if (!player) return null;
  const key = `${side}-${player.id}`;
  let record = records.get(key);
  if (!record) {
    record = createPoseRecord(side, point);
    records.set(key, record);
  }
  const pointX = Number.isFinite(point?.x) ? point.x : record.x;
  const pointY = Number.isFinite(point?.y) ? point.y : record.y;
  const viewScale = Math.max(0.25, Number(view?.scale) || 1);
  const dtMs = record.time > 0 ? clampNumber(time - record.time, 4, 120) : FRAME_MS;
  const hasPrevious = record.time > 0;

  // 1) 屏幕位移换算到设计基准像素（1100px 宽），再折算成 60fps 每帧速度
  const baseDx = hasPrevious ? (pointX - record.x) / viewScale : 0;
  const baseDy = hasPrevious ? (pointY - record.y) / viewScale : 0;
  const travelPx = Math.hypot(baseDx, baseDy);
  const screenSpeed = hasPrevious ? (travelPx * FRAME_MS) / dtMs : 0;
  // 2) 引擎 vx/vy 作为兜底：首帧、掉帧或渲染层降帧到接近静止时仍能给出速度
  const hint = velocityHint(player);
  const speed = screenSpeed > 0.12 ? screenSpeed : hint?.speed || 0;

  // 3) 跑动状态使用滞后死区，避免目标点小幅呼吸导致跑/停反复切换
  const moving = speed > RUN_ENTER_SPEED || (record.moving && speed > RUN_EXIT_SPEED);
  const amplitude = clampNumber((speed - RUN_EXIT_SPEED) / (FULL_STRIDE_SPEED - RUN_EXIT_SPEED), 0, 1);

  // 4) 步频相位按实际行进距离累积：跑得越快腿摆越快，静止时相位冻结
  if (moving && travelPx > 0.02) {
    record.phase = (record.phase + Math.min(travelPx * STRIDE_RAD_PER_PX, STRIDE_MAX_STEP_RAD)) % (Math.PI * 2);
  }

  // 5) 动作事件：回放传 skipEffects=true，完全隔离实时特效
  const action = skipEffects ? null : activePlayerAction(player, side, state, time, effects, goalNetTimes);

  // 6) 朝向：跑动看向位移方向，静止保持上一朝向，动作期间转向动作方向
  let headingTarget = record.heading;
  if (moving && travelPx > 0.05) headingTarget = Math.atan2(baseDy, baseDx);
  else if (hint && speed > RUN_EXIT_SPEED) headingTarget = hint.heading;
  if (action) headingTarget = action.role === "target" ? action.angle + Math.PI : action.angle;
  const turnBlend = action && !moving ? ACTION_HEADING_BLEND : HEADING_BLEND;
  if (moving || action) record.heading = smoothAngle(record.heading, headingTarget, 1 - Math.pow(1 - turnBlend, dtMs / FRAME_MS));

  // 7) 左右镜像：只在横向移动明显时翻转，避免上下跑动时左右乱闪
  if (moving && travelPx > 0.05) {
    const horizontalWeight = Math.abs(baseDx) / travelPx;
    if (horizontalWeight > 0.32) record.facing = baseDx >= 0 ? 1 : -1;
  } else if ((moving || action) && Math.abs(Math.cos(record.heading)) > 0.32) {
    // 速度来自 vx/vy 兜底（无屏幕位移）或动作朝向时，按朝向决定镜像方向
    record.facing = Math.cos(record.heading) >= 0 ? 1 : -1;
  }

  // 8) 倾斜：先在屏幕空间算倾角（±0.18 弧度），再换算到镜像后的局部坐标系
  const screenTilt = clampNumber(0.11 * amplitude * Math.cos(record.heading) + 0.02 * amplitude * Math.sin(record.phase), -TILT_LIMIT, TILT_LIMIT);
  const tilt = screenTilt * record.facing;

  // 9) 速度驱动的跑动基础姿态：腿/臂反相摆动，幅度随速度插值
  const runPose = {
    leg: Math.sin(record.phase) * 0.52 * amplitude,
    armSwing: -Math.sin(record.phase) * 0.42 * amplitude,
    arm: 0,
    kick: 0,
    lean: 0.18 * amplitude,
    stretch: 0.06 + 0.16 * amplitude,
    crouch: 0.02 * amplitude,
    run: 0.55 * amplitude,
    jump: 0
  };

  // 10) 动作叠加层
  const pose = applyActionOverlay(runPose, action, time, player);

  // 11) 写回记录并输出本帧姿态
  record.x = pointX;
  record.y = pointY;
  record.time = time;
  record.moving = moving;
  return {
    ...pose,
    actionKey: action ? playerActionKey(action) : moving ? "run" : "idle",
    role: action?.role ?? null,
    type: action?.type ?? null,
    heading: record.heading,
    facing: record.facing,
    tilt,
    // 镜像后的局部坐标系朝向单位向量：绘制踢球方向时使用
    dirX: Math.cos(record.heading) * record.facing,
    dirY: Math.sin(record.heading)
  };
}
