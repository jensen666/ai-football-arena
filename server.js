import { createServer } from "./src/httpServer.js";

const port = Number(process.env.PORT || 3000);
const host = "127.0.0.1";

createServer().listen(port, host, () => {
  console.log(`AI Football Arena 已启动：http://${host}:${port}`);
});
