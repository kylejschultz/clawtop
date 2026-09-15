import type { ServerResponse } from "node:http";

export class SseBroadcaster<T> {
  private readonly clients = new Set<Client>();
  constructor(private readonly maximum: number) {}

  get size(): number { return this.clients.size; }

  add(response: ServerResponse, initial: T): boolean {
    if (this.clients.size >= this.maximum) return false;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const client: Client = { response, blocked: false };
    const drain = () => this.flush(client);
    const close = () => {
      if (!this.clients.delete(client)) return;
      clearInterval(client.ping);
      response.removeListener("drain", drain);
      response.removeListener("error", close);
      response.removeListener("close", close);
    };
    client.cleanup = close;
    client.ping = setInterval(() => this.write(client, ": ping\n\n"), 15000);
    response.on("drain", drain);
    response.once("error", close);
    response.once("close", close);
    this.clients.add(client);
    this.write(client, frame(initial));
    return true;
  }

  publish(state: T): void {
    const latest = frame(state);
    for (const client of this.clients) this.write(client, latest);
  }

  private write(client: Client, value: string): void {
    if (client.blocked) {
      if (!value.startsWith(":")) client.pending = value;
      return;
    }
    try { client.blocked = !client.response.write(value); }
    catch { client.cleanup?.(); }
  }

  private flush(client: Client): void {
    client.blocked = false;
    const pending = client.pending;
    client.pending = undefined;
    if (pending) this.write(client, pending);
  }
}

type Client = {
  response: ServerResponse;
  blocked: boolean;
  pending?: string;
  ping?: NodeJS.Timeout;
  cleanup?: () => void;
};

function frame<T>(state: T): string { return `event: state\ndata: ${JSON.stringify(state)}\n\n`; }
