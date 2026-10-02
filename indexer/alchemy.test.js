"use strict";
/**
 * The two pieces of the data layer that decide whether the numbers can be trusted at all: how a
 * capped eth_getLogs is turned into something usable, and the check that refuses to let an event be
 * read out of the wrong word.
 */
const test = require("node:test");
const assert = require("node:assert");
const { id } = require("ethers");
const { logsAtBlocks, checkAgainstTransfers } = require("./alchemy");

const VAULT = "0xdda9d6c1738ea47e047b220a6fecc3cfc9d65cb6";
const TOPIC_BORROW = id("BorrowStarted(address,uint256,uint256,uint256,uint256)");
const TOPIC_MINTED = id("Minted(address,uint256,uint256)");

/** Records the filters a call would send, and answers with nothing. */
function recorder() {
  const asked = [];
  return {
    asked,
    rpc: async (_method, [filter]) => {
      asked.push([parseInt(filter.fromBlock, 16), parseInt(filter.toBlock, 16)]);
      return [];
    },
    pool: async (items, worker) => Promise.all(items.map(worker)),
  };
}

test("blocks are read in windows of at most ten, duplicates collapsed", async () => {
  const stub = recorder();
  await logsAtBlocks(stub, VAULT, [[TOPIC_BORROW]], [109, 100, 100, 104, 110, 300], "collateral");
  assert.deepStrictEqual(stub.asked, [[100, 109], [110, 110], [300, 300]]);
  for (const [from, to] of stub.asked) {
    assert.ok(to - from <= 9, `window ${from}-${to} would exceed the cap`);
  }
});

test("no blocks means no calls at all", async () => {
  const stub = recorder();
  assert.deepStrictEqual(await logsAtBlocks(stub, VAULT, [[TOPIC_BORROW]], [], "collateral"), []);
  assert.strictEqual(stub.asked.length, 0);
});

const CONFIG = {
  token: "0xfd06eeadc43ee0687d5611d698fb2ee39f9baaaa",
  pair: "0x72861674beea6a8046e485327adac898ee2e611d",
  lendingVault: VAULT,
  platformVault: "0xcb8c07c87a698329060e122edf383b581274c7fe",
  dead: "0x000000000000000000000000000000000000dead",
  zero: "0x0000000000000000000000000000000000000000",
};
const ALICE = "0x1111111111111111111111111111111111111111";
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const pad = (address) => "0x" + address.slice(2).padStart(64, "0");
const exact = (t) => BigInt(t.rawContract.value);
const xfer = (hash, from, to, amount) => ({
  hash,
  from,
  to,
  rawContract: { value: "0x" + word(amount) },
});
const borrow = (hash, user, stake) => ({
  kind: "borrowStarted",
  blockNumber: "900",
  transactionHash: hash,
  topics: [TOPIC_BORROW, pad(user)],
  data: "0x" + word(stake) + word(0) + word(0) + word(0),
});
const mintEvent = (hash, user, paid, out) => ({
  kind: "minted",
  blockNumber: "900",
  transactionHash: hash,
  topics: [TOPIC_MINTED, pad(user)],
  data: "0x" + word(paid) + word(out),
});

test("events backed by matching transfers pass", () => {
  checkAgainstTransfers({
    tokenTransfers: [
      xfer("0xa", ALICE, VAULT, 300n),
      xfer("0xb", CONFIG.token, ALICE, 2500n),
    ],
    exact,
    vaultMoves: [borrow("0xa", ALICE, 300n)],
    minted: [mintEvent("0xb", ALICE, 15n, 2500n)],
    config: CONFIG,
  });
});

test("an amount read from the wrong word stops the run", () => {
  assert.throws(
    () =>
      checkAgainstTransfers({
        tokenTransfers: [xfer("0xa", ALICE, VAULT, 300n)],
        exact,
        vaultMoves: [borrow("0xa", ALICE, 999n)], // as if stakeAmount were not word 0
        minted: [],
        config: CONFIG,
      }),
    /no transfer of 999/
  );
});

test("a mint event with no matching payout stops the run", () => {
  assert.throws(
    () =>
      checkAgainstTransfers({
        tokenTransfers: [xfer("0xb", CONFIG.token, CONFIG.pair, 2500n)], // liquidity, not a payout
        exact,
        vaultMoves: [],
        minted: [mintEvent("0xb", ALICE, 15n, 2500n)],
        config: CONFIG,
      }),
    /no transfer of 2500 from the token/
  );
});

// A batch settles dozens of identical mints, so "some transfer matches" cannot tell 28 from 29.
test("a miscounted batch of identical mints stops the run", () => {
  const transfers = [0, 1, 2].map(() => xfer("0xb", CONFIG.token, ALICE, 2500n));
  assert.throws(
    () =>
      checkAgainstTransfers({
        tokenTransfers: transfers,
        exact,
        vaultMoves: [],
        minted: [mintEvent("0xb", ALICE, 15n, 2500n), mintEvent("0xb", ALICE, 15n, 2500n)],
        config: CONFIG,
      }),
    /mint totals: 2 events for 3 transfers/
  );
});
