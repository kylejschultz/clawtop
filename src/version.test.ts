import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { APP_VERSION } from "./version.js";

test("runtime version comes from package metadata", () => {
  const require = createRequire(import.meta.url);
  const packageMetadata = require("../package.json") as { version: string };
  assert.equal(APP_VERSION, packageMetadata.version);
});
