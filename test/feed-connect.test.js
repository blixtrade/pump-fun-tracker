// Tests for connect(): the subscribe calls, message handling, migrations
// gating, and the reconnect backoff. A fake WebSocket class records send()
// calls and lets each test fire onopen/onmessage/onclose, so nothing here
// touches the live PumpPortal feed.

import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "../lib/feed.js";

const MINT = "9hjBLBrc7WZW2H8UQvBAvG5WiTZotXUv2Bdcn4f4pump";

const launchMsg = { txType: "create", mint: MINT, name: "Coin", symbol: "C", solAmount: 1 };
const migrationMsg = { txType: "migrate", mint: MINT, pool: "pump-amm" };

/** A fake WebSocket that records what was sent and exposes the handlers. */
class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  // Helpers for the test to drive the connection.
  fireOpen() {
    this.onopen();
  }
  fireMessage(data) {
    this.onmessage({ data });
  }
  fireClose() {
    this.onclose();
  }
}

function fresh() {
  FakeWebSocket.instances = [];
  return FakeWebSocket;
}

test("on open it subscribes to new tokens, and to migrations only when asked", () => {
  const Impl = fresh();

  const events = [];
  connect({ onEvent: (e) => events.push(e), WebSocketImpl: Impl });
  const ws = Impl.instances[0];
  ws.fireOpen();

  assert.deepEqual(ws.sent, [JSON.stringify({ method: "subscribeNewToken" })]);

  // With migrations: both subscribe calls, in order.
  const Impl2 = fresh();
  connect({ migrations: true, onEvent: () => {}, WebSocketImpl: Impl2 });
  const ws2 = Impl2.instances[0];
  ws2.fireOpen();
  assert.deepEqual(ws2.sent, [
    JSON.stringify({ method: "subscribeNewToken" }),
    JSON.stringify({ method: "subscribeMigration" }),
  ]);
});

test("onStatus reports connected", () => {
  const Impl = fresh();
  const statuses = [];
  connect({ onEvent: () => {}, onStatus: (s) => statuses.push(s), WebSocketImpl: Impl });
  Impl.instances[0].fireOpen();
  assert.deepEqual(statuses, ["connected"]);
});

test("it uses the url it is given", () => {
  const Impl = fresh();
  connect({ onEvent: () => {}, WebSocketImpl: Impl, url: "wss://example.test/feed" });
  assert.equal(Impl.instances[0].url, "wss://example.test/feed");
});

test("a launch message is parsed and delivered", () => {
  const Impl = fresh();
  const events = [];
  connect({ onEvent: (e) => events.push(e), WebSocketImpl: Impl });
  const ws = Impl.instances[0];
  ws.fireOpen();
  ws.fireMessage(JSON.stringify(launchMsg));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "launch");
  assert.equal(events[0].mint, MINT);
});

test("non-JSON messages are dropped", () => {
  const Impl = fresh();
  const events = [];
  connect({ onEvent: (e) => events.push(e), WebSocketImpl: Impl });
  const ws = Impl.instances[0];
  ws.fireOpen();
  ws.fireMessage("not json {");
  assert.equal(events.length, 0);
});

test("migrations are ignored unless asked for", () => {
  const Impl = fresh();
  const events = [];
  connect({ onEvent: (e) => events.push(e), WebSocketImpl: Impl });
  const ws = Impl.instances[0];
  ws.fireOpen();
  ws.fireMessage(JSON.stringify(migrationMsg));
  assert.equal(events.length, 0, "a migration must not be delivered without migrations: true");

  const Impl2 = fresh();
  const events2 = [];
  connect({ migrations: true, onEvent: (e) => events2.push(e), WebSocketImpl: Impl2 });
  const ws2 = Impl2.instances[0];
  ws2.fireOpen();
  ws2.fireMessage(JSON.stringify(migrationMsg));
  assert.equal(events2.length, 1);
  assert.equal(events2[0].type, "migration");
});

test("after a close it retries with growing backoff, and resets after an open", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Impl = fresh();
  const statuses = [];
  connect({ onEvent: () => {}, onStatus: (s) => statuses.push(s), WebSocketImpl: Impl });

  // First connection closes: it should reconnect after 1s (2^0).
  Impl.instances[0].fireClose();
  assert.match(statuses.at(-1), /retrying in 1s/);
  assert.equal(Impl.instances.length, 1, "no new socket before the timer fires");
  t.mock.timers.tick(1000);
  assert.equal(Impl.instances.length, 2, "reconnected after 1s");

  // Second closes: backoff doubles to 2s (2^1).
  Impl.instances[1].fireClose();
  assert.match(statuses.at(-1), /retrying in 2s/);
  t.mock.timers.tick(1000);
  assert.equal(Impl.instances.length, 2, "not yet, the wait is 2s");
  t.mock.timers.tick(1000);
  assert.equal(Impl.instances.length, 3, "reconnected after 2s");

  // Third closes: 4s (2^2).
  Impl.instances[2].fireClose();
  assert.match(statuses.at(-1), /retrying in 4s/);

  // A successful open resets the backoff to 1s.
  t.mock.timers.tick(4000);
  assert.equal(Impl.instances.length, 4);
  Impl.instances[3].fireOpen();
  Impl.instances[3].fireClose();
  assert.match(statuses.at(-1), /retrying in 1s/, "backoff reset after a successful open");
});

test("the backoff is capped at 30s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Impl = fresh();
  const statuses = [];
  connect({ onEvent: () => {}, onStatus: (s) => statuses.push(s), WebSocketImpl: Impl });

  // Close six times in a row (2^5 = 32s, capped to 30s). Each close schedules a
  // reconnect, so tick past the wait before closing the next socket.
  let waits = [1000, 2000, 4000, 8000, 16000, 30000];
  for (let i = 0; i < waits.length; i++) {
    Impl.instances[i].fireClose();
    assert.match(statuses.at(-1), new RegExp(`retrying in ${waits[i] / 1000}s`));
    t.mock.timers.tick(waits[i]);
  }
  assert.match(statuses.at(-1), /retrying in 30s/, "the wait is capped at 30s");
});

test("the returned stop function stops retries and closes the socket", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Impl = fresh();
  const statuses = [];
  const stop = connect({ onEvent: () => {}, onStatus: (s) => statuses.push(s), WebSocketImpl: Impl });

  const ws = Impl.instances[0];
  stop();
  assert.equal(ws.closed, true, "the socket is closed");

  // A close after stopping must not schedule a retry.
  ws.fireClose();
  assert.equal(statuses.length, 0, "no reconnect status after stop");
  t.mock.timers.tick(60000);
  assert.equal(Impl.instances.length, 1, "no new socket after stop");
});