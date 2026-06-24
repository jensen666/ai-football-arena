import crypto from "node:crypto";
import { redactSensitive } from "./utils.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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
    this.send(socket, { type: "snapshot", match_id: matchId, sent_at: new Date().toISOString(), payload: snapshot });
    socket.on("data", (buffer) => this.handleFrame(socket, buffer));
    socket.on("close", () => this.removeClient(matchId, socket));
    socket.on("error", () => this.removeClient(matchId, socket));
  }

  /** 广播给指定比赛。 */
  broadcast(matchId, message) {
    const clients = this.clients.get(matchId);
    if (!clients) return;
    for (const socket of clients) this.send(socket, redactSensitive(message));
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

  /** 发送文本帧。 */
  send(socket, data) {
    if (socket.destroyed) return;
    const payload = Buffer.from(JSON.stringify(data));
    const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]) : null;
    if (!header) return;
    socket.write(Buffer.concat([header, payload]));
  }

  /** 处理关闭和 ping 帧。 */
  handleFrame(socket, buffer) {
    const opcode = buffer[0] & 0x0f;
    if (opcode === 0x8) socket.end();
    if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]));
  }
}
