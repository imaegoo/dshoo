// Unit tests for the plugin's pure helpers, run against the built output so the
// package that ships is what gets tested.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";

import { WebSocketServer } from "ws";

import { Bridge, rewriteIndex } from "../src/plugin/lib/bridge.js";
import { normalizeServer, tunnelUrl } from "../src/plugin/lib/config.js";
import { hudScript } from "../src/plugin/lib/hud.js";
import {
  decodeFrame,
  FrameReqEnd,
  FrameReqHead,
  FrameResBody,
  FrameResEnd,
  FrameResHead,
} from "../src/plugin/lib/protocol.js";
import { retryDelayMs, TunnelClient } from "../src/plugin/lib/tunnel.js";
import { pluginVersion } from "../src/plugin/lib/version.js";

test("normalizeServer keeps an explicit origin", () => {
  assert.equal(normalizeServer("https://fleet.example.com"), "https://fleet.example.com");
  assert.equal(normalizeServer("http://10.0.0.2:9830"), "http://10.0.0.2:9830");
});

test("normalizeServer defaults a bare host to https", () => {
  assert.equal(normalizeServer("fleet.example.com"), "https://fleet.example.com");
  assert.equal(normalizeServer(" fleet.example.com/ "), "https://fleet.example.com");
});

test("normalizeServer drops a trailing slash and keeps a mount path", () => {
  assert.equal(normalizeServer("https://example.com/"), "https://example.com");
  assert.equal(normalizeServer("https://example.com/dshoo/"), "https://example.com/dshoo");
});

test("normalizeServer maps ws schemes onto http", () => {
  assert.equal(normalizeServer("ws://127.0.0.1:9830"), "http://127.0.0.1:9830");
  assert.equal(normalizeServer("wss://example.com"), "https://example.com");
});

test("normalizeServer rejects unusable input", () => {
  assert.equal(normalizeServer(""), "");
  assert.equal(normalizeServer("ftp://example.com"), "");
  assert.equal(normalizeServer("://nope"), "");
});

test("tunnelUrl appends the tunnel path", () => {
  assert.equal(tunnelUrl("https://example.com"), "wss://example.com/tunnel");
  assert.equal(tunnelUrl("http://127.0.0.1:9830"), "ws://127.0.0.1:9830/tunnel");
  assert.equal(tunnelUrl("https://example.com/dshoo"), "wss://example.com/dshoo/tunnel");
});

test("retry is quick when a healthy connection was cut", () => {
  // A proxy that caps WebSocket lifetime cuts a healthy socket; the retry
  // should be fast so the outage stays around a second.
  assert.equal(retryDelayMs(true, 0), 1_000);
  assert.equal(retryDelayMs(true, 2), 1_000);
});

test("retry stays at ten seconds otherwise", () => {
  // A connection that never came up.
  assert.equal(retryDelayMs(false, 0), 10_000);
  // Quick retries exhausted: the connection keeps dropping straight away.
  assert.equal(retryDelayMs(true, 3), 10_000);
});

test("reports the version from the package manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../src/plugin/package.json", import.meta.url), "utf8"));
  assert.equal(pluginVersion, manifest.version);
});

test("the remote document declares the language the harness will use", () => {
  // The harness ships lang="en" and corrects it only after boot; Chrome offers
  // to translate the app before that happens.
  const html = "<!doctype html><html lang=\"en\"><body></body></html>";
  assert.ok(rewriteIndex(html, "/i/abc", "zh-CN,zh;q=0.9,en;q=0.8").includes("<html lang=\"zh-CN\">"));
  assert.ok(rewriteIndex(html, "/i/abc", "en-US,en;q=0.9").includes("<html lang=\"en\">"));
  // No header: leave the document as the harness wrote it.
  assert.ok(rewriteIndex(html, "/i/abc").includes("<html lang=\"en\">"));
  // A document without a lang attribute gets one.
  assert.ok(rewriteIndex("<html><body></body></html>", "/i/abc", "zh-TW").includes("<html lang=\"zh-CN\">"));
});

test("the remote page gets the HUD, the local page does not", () => {
  const html = "<html><body><div id=\"root\"></div></body></html>";
  const remote = rewriteIndex(html, "/i/abc");
  assert.ok(remote.includes("<script src=\"/i/abc/__dshoo/hud.js\" defer></script>"));
  assert.ok(remote.indexOf("__dshoo/hud.js") < remote.indexOf("</body>"));
  // Opening the harness directly never goes through this rewrite.
  assert.equal(rewriteIndex(html, ""), html);
});

test("the HUD script stands on its own", () => {
  const script = hudScript();
  assert.ok(script.includes("dshoo-hud"));
  assert.ok(!script.includes("</script"));
  // It is inlined into the page, so a syntax error would break the harness UI.
  assert.doesNotThrow(() => new Function(script));
});

test("the HUD endpoints are answered without the harness", () => {
  const frames = [];
  const bridge = new Bridge({
    harness: {
      port() { throw new Error("the harness must not be touched"); },
      sessionCookie() { throw new Error("the harness must not be touched"); },
    },
    prefix: () => "/i/abc",
    send: (frame) => {
      frames.push(decodeFrame(frame));
      return true;
    },
    log: () => {},
  });
  const request = (id, path) => {
    bridge.onFrame({ type: FrameReqHead, id, payload: Buffer.from(JSON.stringify({ method: "GET", path, headers: {} })) });
    bridge.onFrame({ type: FrameReqEnd, id, payload: Buffer.alloc(0) });
  };

  request(1, "/__dshoo/ping?t=1");
  request(2, "/__dshoo/hud.js");

  const types = (id) => frames.filter((frame) => frame.id === id).map((frame) => frame.type);
  assert.deepEqual(types(1), [FrameResHead, FrameResEnd]);
  const ping = JSON.parse(frames.find((frame) => frame.id === 1).payload.toString("utf8"));
  assert.equal(ping.status, 204);

  assert.deepEqual(types(2), [FrameResHead, FrameResBody, FrameResEnd]);
  const body = frames.find((frame) => frame.id === 2 && frame.type === FrameResBody).payload.toString("utf8");
  assert.ok(body.includes("dshoo-hud"));
});

test("the proxied index is served with the browser's language", async () => {
  // The server forwards browser headers with Go's canonical casing, so the
  // plugin has to look the header up case-insensitively.
  const origin = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html lang=\"en\"><body>hi</body></html>");
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const { port } = origin.address();
  const frames = [];
  const bridge = new Bridge({
    harness: {
      port: () => port,
      sessionCookie: async () => "dsh=1",
      authority: () => "127.0.0.1:1",
      origin: () => "http://127.0.0.1:1",
    },
    prefix: () => "/i/abc",
    send: (frame) => {
      frames.push(decodeFrame(frame));
      return true;
    },
    log: () => {},
  });

  bridge.onFrame({
    type: FrameReqHead,
    id: 5,
    payload: Buffer.from(JSON.stringify({
      method: "GET",
      path: "/",
      headers: { "Accept-Language": ["zh-CN,zh;q=0.9,en;q=0.8"] },
    })),
  });
  bridge.onFrame({ type: FrameReqEnd, id: 5, payload: Buffer.alloc(0) });

  try {
    const deadline = Date.now() + 3000;
    while (!frames.some((frame) => frame.id === 5 && frame.type === FrameResEnd) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const body = frames
      .filter((frame) => frame.id === 5 && frame.type === FrameResBody)
      .map((frame) => frame.payload)
      .join("");
    assert.ok(body.includes("<html lang=\"zh-CN\">"), body.slice(0, 120));
    assert.ok(body.includes("/__dshoo/hud.js"));
  } finally {
    origin.close();
  }
});

test("a tunnel whose pongs stop arriving drops the socket and reconnects", async () => {
  // A half-open socket looks healthy to the OS: writes succeed into the void
  // and no close event ever arrives. The keepalive must notice.
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const { port } = server.address();
  let connections = 0;
  const states = [];
  server.on("connection", (socket) => {
    connections += 1;
    socket.send(JSON.stringify({
      type: "hello-ack",
      instanceId: "test",
      prefix: "/i/test",
      serverTime: Date.now(),
    }));
    // Stop reading, so pings pile up unanswered while the socket stays open.
    socket.pause();
  });

  const client = new TunnelClient(`ws://127.0.0.1:${port}/tunnel`, "user", "pass", {
    hello: () => ({
      key: "test-key",
      name: "test",
      hostname: "test",
      os: "win32",
      arch: "x64",
      dshVersion: "0",
      pid: process.pid,
      guiPort: 0,
      pluginVersion: "0",
    }),
    onFrame: () => {},
    onState: (state) => {
      states.push(state);
    },
  }, () => {}, { heartbeatInterval: 2_500, heartbeatTimeout: 150 });

  try {
    client.start();
    const deadline = Date.now() + 10_000;
    while (connections < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (states[states.length - 1] !== "connected" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(connections >= 2, `expected a reconnect, saw ${connections} connection(s)`);
    assert.deepEqual(states.slice(0, 3), ["connecting", "connected", "reconnecting"]);
  } finally {
    client.stop();
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
});

test("stopping while a socket is still dialling does not throw", async () => {
  // Aborting a handshake makes `ws` emit an error; an unhandled error event
  // would take down the harness host that runs the plugin.
  const server = net.createServer(() => {
    // Accept the TCP connection and never answer the upgrade request.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const client = new TunnelClient(`ws://127.0.0.1:${port}/tunnel`, "user", "pass", {
    hello: () => ({
      key: "test-key",
      name: "test",
      hostname: "test",
      os: "win32",
      arch: "x64",
      dshVersion: "0",
      pid: process.pid,
      guiPort: 0,
      pluginVersion: "0",
    }),
    onFrame: () => {},
    onState: () => {},
  }, () => {});

  client.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  client.stop();
  // Give the aborted handshake time to surface its error.
  await new Promise((resolve) => setTimeout(resolve, 300));
  server.close();
});
