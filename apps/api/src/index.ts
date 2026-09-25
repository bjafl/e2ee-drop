// apps/api/src/index.ts
import { buildServer } from "./server";
import { env } from "./env";
import { ensureBucket } from "./lib/storage";

async function main() {
  await ensureBucket();
  const server = buildServer();
  await server.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
