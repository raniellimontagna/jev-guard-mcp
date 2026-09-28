import { createServer, type Server } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { resolvePublicAddresses, validateStartUrl, type Lookup } from "../security/url-policy.js";

interface EgressProxyOptions {
  lookup?: Lookup;
  dial?: (ip: string, port: number, family: 4 | 6) => Socket;
}

function allowedOrigin(raw: string): string {
  const url = validateStartUrl(raw);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Proxy origin must be exact");
  return url.origin;
}

function connectTarget(authority: string | undefined): URL | undefined {
  if (!authority || authority.includes("/") || authority.includes("@")) return undefined;
  try {
    const url = new URL(`https://${authority}`);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
}

function reject(socket: Duplex, status: 403 | 502): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class EgressProxy {
  readonly port: number;
  readonly url: string;
  readonly #sockets: Set<Duplex>;
  #closing?: Promise<void>;

  private constructor(private readonly server: Server, port: number, sockets: Set<Duplex>) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.#sockets = sockets;
  }

  static async start(origins: readonly string[], options: EgressProxyOptions = {}): Promise<EgressProxy> {
    const allowed = new Set(origins.map(allowedOrigin));
    if (allowed.size === 0) throw new Error("At least one proxy origin is required");
    const server = createServer((_request, response) => {
      response.writeHead(403, { connection: "close", "content-length": "0" });
      response.end();
    });
    const sockets = new Set<Duplex>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("connect", (request, client, head) => {
      void (async () => {
        const target = connectTarget(request.url);
        if (!target || !allowed.has(target.origin)) {
          reject(client, 403);
          return;
        }
        let addresses: Awaited<ReturnType<typeof resolvePublicAddresses>>;
        try {
          addresses = await resolvePublicAddresses(target.hostname, options.lookup);
        } catch {
          reject(client, 403);
          return;
        }
        if (client.destroyed || addresses.length === 0) return;
        const selected = addresses[0]!;
        const remote = options.dial
          ? options.dial(selected.address, Number(target.port || 443), selected.family)
          : connectTcp({ host: selected.address, family: selected.family, port: Number(target.port || 443) });
        sockets.add(remote);
        remote.once("close", () => sockets.delete(remote));
        remote.on("error", () => {
          reject(client, 502);
          remote.destroy();
        });
        remote.once("connect", () => {
          if (client.destroyed) { remote.destroy(); return; }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) remote.write(head);
          client.pipe(remote);
          remote.pipe(client);
        });
        client.once("close", () => remote.destroy());
      })().catch(() => reject(client, 502));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Proxy failed to bind");
      return new EgressProxy(server, address.port, sockets);
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closing ??= new Promise<void>((resolve) => {
      for (const socket of this.#sockets) socket.destroy();
      this.server.close(() => resolve());
    });
    await this.#closing;
  }
}
