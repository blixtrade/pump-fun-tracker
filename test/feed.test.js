import test from "node:test";
import assert from "node:assert/strict";
import { makeFilter, parseLaunch, parseMigration } from "../lib/feed.js";

const raw = { signature: "sig", mint: "MintpumP", traderPublicKey: "Dev", txType: "create", initialBuy: 1788384, solAmount: 0.05, marketCapSol: 28.05, name: " GTA 6 GATOR ", symbol: "GATOR", uri: "https://ipfs.io/x" };

test("a create message becomes a launch", () => {
  const l = parseLaunch(raw);
  assert.equal(l.type, "launch");
  assert.equal(l.name, "GTA 6 GATOR");
  assert.equal(l.devBuySol, 0.05);
  assert.equal(l.dev, "Dev");
});

test("non-launch messages are ignored", () => {
  assert.equal(parseLaunch({ message: "Successfully subscribed" }), null);
  assert.equal(parseLaunch({ ...raw, txType: "buy" }), null);
  assert.equal(parseLaunch(null), null);
});

test("a migrate message becomes a migration", () => {
  assert.equal(parseMigration({ txType: "migrate", mint: "M", pool: "pump-amm" }).type, "migration");
  assert.equal(parseMigration(raw), null);
});

test("filters combine", () => {
  const l = parseLaunch(raw);
  assert.equal(makeFilter()(l), true);
  assert.equal(makeFilter({ minDevBuy: 1 })(l), false);
  assert.equal(makeFilter({ maxDevBuy: 0.01 })(l), false);
  assert.equal(makeFilter({ name: "gator" })(l), true);
  assert.equal(makeFilter({ name: "cat$" })(l), false);
  assert.equal(makeFilter({ name: "gta", exclude: "gator" })(l), false);
});
