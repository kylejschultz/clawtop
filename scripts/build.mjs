import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const [app, style, index] = await Promise.all([
  readFile("dist/public/app.js"),
  readFile("dist/public/style.css"),
  readFile("dist/public/index.html", "utf8")
]);
const revision = (content) => createHash("sha256").update(content).digest("hex").slice(0, 12);
const versionAsset = (html, attribute, path, content) => {
  const pattern = new RegExp(`${attribute}="${path.replaceAll(".", "\\.")}(?:\\?[^\"]*)?"`, "g");
  if ([...html.matchAll(pattern)].length !== 1) throw new Error(`expected exactly one ${path} reference`);
  return html.replace(pattern, `${attribute}="${path}?v=${revision(content)}"`);
};
const versioned = versionAsset(versionAsset(index, "href", "/style.css", style), "src", "/app.js", app);
await writeFile("dist/public/index.html", versioned);
