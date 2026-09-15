import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { SseBroadcaster } from "./sse.js";

class FakeResponse extends EventEmitter {
  status?: number;
  headers?: Record<string, string>;
  writes: string[] = [];
  results: boolean[] = [];
  writeHead(status: number, headers: Record<string, string>): this { this.status = status; this.headers = headers; return this; }
  write(value: string): boolean { this.writes.push(value); return this.results.shift() ?? true; }
}

const response = () => new FakeResponse() as FakeResponse & ServerResponse;

test("coalesces blocked SSE clients to the latest state and cleans up", () => {
  const broadcaster = new SseBroadcaster<{ revision: number }>(2);
  const client = response();
  client.results.push(false, true);
  assert.equal(broadcaster.add(client, { revision: 1 }), true);
  broadcaster.publish({ revision: 2 });
  broadcaster.publish({ revision: 3 });
  assert.equal(client.writes.length, 1);
  client.emit("drain");
  assert.equal(client.writes.length, 2);
  assert.equal(client.writes[1]?.includes('"revision":3'), true);
  assert.equal(client.writes.some((value) => value.includes('"revision":2')), false);
  client.emit("close");
  assert.equal(broadcaster.size, 0);
  broadcaster.publish({ revision: 4 });
  assert.equal(client.writes.length, 2);
});

test("rejects SSE clients beyond the configured cap", () => {
  const broadcaster = new SseBroadcaster<{ ok: boolean }>(1);
  const first = response();
  const second = response();
  assert.equal(broadcaster.add(first, { ok: true }), true);
  assert.equal(broadcaster.add(second, { ok: true }), false);
  assert.equal(second.status, undefined);
  first.emit("close");
});
