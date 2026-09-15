import { cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

await rm("dist", { recursive: true, force: true });
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/typescript/bin/tsc"], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tsc exited ${code}`)));
});
await mkdir("dist/public", { recursive: true });
await cp("public", "dist/public", { recursive: true });
await cp("dist/web/client.js", "dist/public/app.js");
await cp("dist/web/client.js.map", "dist/public/app.js.map");
