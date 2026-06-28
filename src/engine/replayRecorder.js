import { createId, TICKS_PER_SECOND } from "../utils.js";

const REPLAY_PRE_SECONDS = 10;
const REPLAY_POST_SECONDS = 3;
const REPLAY_POST_TICKS = REPLAY_POST_SECONDS * TICKS_PER_SECOND;
const REPLAY_RING_SIZE = REPLAY_PRE_SECONDS * TICKS_PER_SECOND;

/** 管理进球回放片段的录制、固化和查询。 */
export class ReplayRecorder {
  constructor() {
    this.ringBuffer = [];
    this.pendingReplays = [];
    this.completedReplays = [];
  }

  /** 清空所有回放数据。 */
  clear() {
    this.ringBuffer = [];
    this.pendingReplays = [];
    this.completedReplays = [];
  }

  /** 录制一帧到环形缓冲区。 */
  recordFrame(frameBuilder) {
    const frame = frameBuilder();
    this.ringBuffer.push(frame);
    if (this.ringBuffer.length > REPLAY_RING_SIZE) this.ringBuffer.shift();
  }

  /**
   * 进球时开启一个新的回放片段。
   * 前段画面取自当前环形缓冲区（最近 10 秒）。
   */
  startReplay(goalTick, teamId, playerId, playerName, scoreAfter, gameTime) {
    const replay = {
      replayId: createId("replay"),
      goalTick,
      teamId,
      playerId,
      playerName,
      scoreAfter,
      gameTime,
      frames: this.ringBuffer.slice(),
      postFrames: [],
      completed: false
    };
    this.pendingReplays.push(replay);
  }

  /**
   * 为所有 pending 回放片段追加后段帧。
   * 当已录制满 1 秒后，移入 completedReplays。
   */
  finalizePendingReplays(tick, frameBuilder) {
    const stillPending = [];
    for (const replay of this.pendingReplays) {
      const elapsed = tick - replay.goalTick;
      if (elapsed <= REPLAY_POST_TICKS) {
        replay.postFrames.push(frameBuilder());
        stillPending.push(replay);
      } else {
        replay.completed = true;
        this.completedReplays.push(replay);
      }
    }
    this.pendingReplays = stillPending;
  }

  /** 强制完成所有 pending 回放（用于比赛停止时）。 */
  forceFinalizeAll() {
    for (const replay of this.pendingReplays) {
      replay.completed = true;
      this.completedReplays.push(replay);
    }
    this.pendingReplays = [];
  }

  /** 返回用于 WebSocket 广播的回放列表元数据。 */
  getReplayList() {
    return this.completedReplays.map((replay) => ({
      replay_id: replay.replayId,
      goal_tick: replay.goalTick,
      game_time: replay.gameTime,
      team_id: replay.teamId,
      player_id: replay.playerId,
      player_name: replay.playerName,
      score_after: replay.scoreAfter
    }));
  }

  /** 按 replayId 返回完整回放片段。 */
  getReplay(replayId) {
    const replay = this.completedReplays.find((item) => item.replayId === replayId);
    if (!replay) return null;
    return {
      replay_id: replay.replayId,
      goal_tick: replay.goalTick,
      game_time: replay.gameTime,
      team_id: replay.teamId,
      player_id: replay.playerId,
      player_name: replay.playerName,
      score_after: replay.scoreAfter,
      frames: [...replay.frames, ...replay.postFrames]
    };
  }
}
