import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Preloaded with --import so the CLI runs offline: a global WebSocket that streams launches.
const fakeWebSocket = `globalThis.WebSocket = class {
  constructor() {
    setTimeout(() => {
      this.onopen?.();
      this.timer = setInterval(() => this.onmessage?.({ data: JSON.stringify({ txType: "create", mint: "9hjBLBrc7WZW2H8UQvBAvG5WiTZotXUv2Bdcn4f4pump", name: "Fake", symbol: "FAKE", solAmount: 1, marketCapSol: 30 }) }), 5);
    }, 0);
  }
  send() {}
  close() { clearInterval(this.timer); }
};`;

test("closing the output pipe early (| head) exits quietly instead of crashing with EPIPE", async () => {
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(fakeWebSocket)}`, join(root, "bin", "pump-fun-tracker.js"), "--json"], {
    env: { ...process.env, NO_COLOR: "1", BLIX_NO_FOOTER: "1" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.once("data", (d) => {
    assert.match(String(d), /"type":"launch"/);
    child.stdout.destroy(); // what `head -1` does after its first line
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const [code, signal] = await new Promise((r) => child.on("close", (c, s) => r([c, s])));
  clearTimeout(timer);
  assert.equal(signal, null, "the CLI had to be killed");
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE/);
});
