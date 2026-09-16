import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicDir = new URL("./public/", import.meta.url);
const revision = (content: Buffer): string => createHash("sha256").update(content).digest("hex").slice(0, 12);

test("build versions static asset URLs from their content", async () => {
  const [index, app, style] = await Promise.all([
    readFile(new URL("index.html", publicDir), "utf8"),
    readFile(new URL("app.js", publicDir)),
    readFile(new URL("style.css", publicDir))
  ]);
  assert.deepEqual(index.match(/src="\/app\.js(?:\?[^\"]*)?"/g), [`src="/app.js?v=${revision(app)}"`]);
  assert.deepEqual(index.match(/href="\/style\.css(?:\?[^\"]*)?"/g), [`href="/style.css?v=${revision(style)}"`]);
});
