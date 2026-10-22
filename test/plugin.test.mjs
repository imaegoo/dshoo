// Unit tests for the plugin's pure helpers, run against the built output so the
// package that ships is what gets tested.
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeServer, tunnelUrl } from "../src/plugin/lib/config.js";

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
