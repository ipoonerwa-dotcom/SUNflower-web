"use strict";
/**
 * The tree is read from the registry's state, seeded with the addresses the ledger knows and then
 * closed over the uplines that come back. The closure is the part that can quietly lose an edge, so
 * it is tested against a fake chain that answers Multicall3 exactly as the real one does.
 */
const test = require("node:test");
const assert = require("node:assert");
const { Interface, AbiCoder, id } = require("ethers");
const { readTree } = require("./index");

const REGISTRY = "0x00000000000000000000000000000000000000aa";
const ROOT = "0x00000000000000000000000000000000000000f0";
const ZERO = "0x0000000000000000000000000000000000000000";
const REFERRER_OF = id("referrer(address)").slice(0, 10);

const multicall3 = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])",
]);
const abi = AbiCoder.defaultAbiCoder();
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");

/** Answers aggregate3 batches of referrer() calls from a plain map, and counts the round trips. */
function fakeChain(edges) {
  const chain = { calls: 0, asked: [] };
  chain.pool = async (items, worker) => Promise.all(items.map(worker));
  chain.rpc = async (method, [call]) => {
    assert.strictEqual(method, "eth_call");
    chain.calls++;
    const [calls] = multicall3.decodeFunctionData("aggregate3", call.data);
    const results = calls.map(({ target, callData }) => {
      assert.strictEqual(target.toLowerCase(), REGISTRY);
      assert.strictEqual(callData.slice(0, 10), REFERRER_OF);
      const who = "0x" + callData.slice(-40).toLowerCase();
      chain.asked.push(who);
      return [true, abi.encode(["address"], [edges[who] ?? ZERO])];
    });
    return multicall3.encodeFunctionResult("aggregate3", [results]);
  };
  return chain;
}

test("a member who bound but never traded still connects their downline to the root", async () => {
  const [quiet, trader] = [addr(1), addr(2)];
  // root <- quiet <- trader, and only the trader ever touched the token
  const chain = fakeChain({ [quiet]: ROOT, [trader]: quiet });

  const { referrerOf, childrenOf } = await readTree(chain, REGISTRY, [trader]);

  assert.strictEqual(referrerOf.get(trader), quiet);
  assert.strictEqual(referrerOf.get(quiet), ROOT, "found by following the trader upward");
  assert.deepStrictEqual(childrenOf.get(ROOT), [quiet]);
  assert.deepStrictEqual(childrenOf.get(quiet), [trader]);
});

test("addresses that never bound add nothing", async () => {
  const chain = fakeChain({});
  const { referrerOf, childrenOf } = await readTree(chain, REGISTRY, [addr(1), addr(2)]);
  assert.strictEqual(referrerOf.size, 0);
  assert.strictEqual(childrenOf.size, 0);
});

test("nobody is asked twice, however many paths lead to them", async () => {
  // Three traders under one upline: the upline is discovered three times but read once.
  const up = addr(9);
  const chain = fakeChain({ [addr(1)]: up, [addr(2)]: up, [addr(3)]: up, [up]: ROOT });
  await readTree(chain, REGISTRY, [addr(1), addr(2), addr(3), addr(1)]);

  const counts = {};
  for (const who of chain.asked) counts[who] = (counts[who] ?? 0) + 1;
  for (const [who, n] of Object.entries(counts)) assert.strictEqual(n, 1, `${who} read ${n} times`);
});

test("large seed sets are split across batches and still closed over", async () => {
  // 900 traders, each under their own quiet upline, every upline under the root.
  const edges = {};
  const traders = [];
  for (let i = 1; i <= 900; i++) {
    const trader = addr(10_000 + i);
    const quiet = addr(20_000 + i);
    edges[trader] = quiet;
    edges[quiet] = ROOT;
    traders.push(trader);
  }
  const chain = fakeChain(edges);
  const { referrerOf, childrenOf } = await readTree(chain, REGISTRY, traders);

  assert.strictEqual(referrerOf.size, 1800, "every trader and every upline");
  assert.strictEqual(childrenOf.get(ROOT).length, 900);
  // 900 seeds in batches of 400, then 900 uplines in batches of 400, then the root once.
  assert.strictEqual(chain.calls, 3 + 3 + 1);
});

test("with no registry configured, nothing is read", async () => {
  const chain = fakeChain({});
  const { referrerOf } = await readTree(chain, "", [addr(1)]);
  assert.strictEqual(referrerOf.size, 0);
  assert.strictEqual(chain.calls, 0);
});
