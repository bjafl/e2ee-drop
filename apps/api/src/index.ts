// apps/api/src/index.ts
import { buildServer } from "./server";
import { env } from "./env";

const server = buildServer();

server
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
