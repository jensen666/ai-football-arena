import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// 单条广播上限 1MB：避免慢客户端与超大 payload 造成内存堆积。
const MAX_BROADCAST_BYTES = 1024 * 1024;

/** 管理浏览器 WebSocket 连接。 */
export class WebSocketHub {
  constructor() {
    this.clients = new Map();
  }

  /** 处理 HTTP upgrade。 */
  handleUpgrade(request, socket, head, getSnapshot) {
    const key = request.headers["sec-websocket-key"];
    if (!key || !request.url?.startsWith("/ws/match/")) {
      socket.destroy();
      return;
    }
    const matchId = decodeURIComponent(request.url.split("/").pop());
    const snapshot = getSnapshot?.(matchId);
    if (!snapshot) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.addClient(matchId, socket);
    // 初始快照仍走单发通道：握手后立即给出完整画面，后续状态靠广播增量补齐。
    this.send(socket, { type: "snapshot", match_id: matchId, sent_at: new Date().toISOString(), payload: snapshot });
    socket.on("data", (buffer) => this.handleFrame(socket, buffer));
    socket.on("close", () => this.removeClient(matchId, socket));
    socket.on("error", () => this.removeClient(matchId, socket));
  }

  /** 广播给指定比赛：整条消息只序列化一次，所有客户端复用同一帧 Buffer。 */
  broadcast(matchId, message) {
    const clients = this.clients.get(matchId);
    if (!clients?.size) return;
    const frame = this.encodeFrame(message);
    if (!frame) return;
    for (const socket of clients) this.writeFrame(socket, frame);
  }

  /** 将消息编码成完整文本帧；序列化失败或超过 1MB 时记录错误并跳过本次广播。 */
  encodeFrame(message) {
    let payload;
    try {
      payload = Buffer.from(JSON.stringify(message));
    } catch (error) {
      console.error("[wsHub] 广播消息序列化失败，已跳过本次广播", error);
      return null;
    }
    if (payload.length > MAX_BROADCAST_BYTES) {
      console.error(`[wsHub] 广播消息 ${payload.length} 字节超过 1MB 上限，已跳过本次广播`);
      return null;
    }
    return Buffer.concat([encodeFrameHeader(payload.length), payload]);
  }

  /** 添加客户端。 */
  addClient(matchId, socket) {
    if (!this.clients.has(matchId)) this.clients.set(matchId, new Set());
    this.clients.get(matchId).add(socket);
  }

  /** 移除客户端。 */
  removeClient(matchId, socket) {
    const clients = this.clients.get(matchId);
    if (!clients) return;
    clients.delete(socket);
    if (!clients.size) this.clients.delete(matchId);
  }

  /** 发送单条消息（用于握手后的初始快照）。 */
  send(socket, data) {
    if (socket.destroyed) return;
    try {
      const payload = Buffer.from(JSON.stringify(data));
      socket.write(Buffer.concat([encodeFrameHeader(payload.length), payload]));
    } catch (error) {
      console.error("[wsHub] 发送 WebSocket 消息失败", error);
    }
  }

  /** 写入已编码帧：单个连接写失败只记录日志，不影响其余客户端。 */
  writeFrame(socket, frame) {
    if (socket.destroyed) return;
    try {
      socket.write(frame);
    } catch (error) {
      console.error("[wsHub] 写入 WebSocket 帧失败", error);
    }
  }

  /** 处理关闭和 ping 帧。 */
  handleFrame(socket, buffer) {
    const opcode = buffer[0] & 0x0f;
    if (opcode === 0x8) socket.end();
    if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]));
  }
}

/** 生成 WebSocket 文本帧头：<126 用 7 位长度，<65536 用 126+2 字节，更大用 127+8 字节（BigInt）。 */
function encodeFrameHeader(length) {
  if (length < 126) return Buffer.from([0x81, length]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}
