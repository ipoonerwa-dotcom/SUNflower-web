"use strict";
/**
 * Feeds hand-built logs, shaped exactly as the chain emits them, through the same replay the real
 * report uses. This is where the classification is proved: which transfers are purchases, which
 * are collateral, and which are somebody quietly moving tokens to a second wallet.
 */
const test = require("node:test");
const assert = require("node:assert");
const { replay, PriceTimeline, TOPIC, CONFIG } = require("./index");
const { USD_SCALE, formatUsd } = require("./accounting");

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const PAIR = CONFIG.pair;
const VAULT = CONFIG.lendingVault;
const DEAD = CONFIG.dead;
const TOKEN = CONFIG.token;

const pad = (address) => "0x" + address.slice(2).toLowerCase().padStart(64, "0");
const word = (value) => value.toString(16).padStart(64, "0");
const T = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const BNB = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

// BNB at a flat $600 so the expected USD figures stay easy to read.
const prices = new PriceTimeline([{ block: 0, usd18: 600n * USD_SCALE }]);

let nextBlock = 100;
let nextTx = 1;
function tx(logs) {
  const block = nextBlock++;
  const hash = "0x" + String(nextTx++).padStart(64, "0");
  return logs.map((log, i) => ({
    ...log,
    blockNumber: String(block),
    transactionIndex: "0",
    transactionHash: hash,
    logIndex: String(i),
  }));
}

const transfer = (from, to, amount) => ({
  kind: "transfer",
  address: CONFIG.token,
  topics: [TOPIC.transfer, pad(from), pad(to)],
  data: "0x" + word(amount),
});
// WBNB sorts below the token, so it is token0: BNB in on a buy, BNB out on a sell.
const swapBuy = (to, bnbIn, tokensOut) => ({
  kind: "swap",
  address: PAIR,
  topics: [TOPIC.swap, pad(PAIR), pad(to)],
  data: "0x" + word(bnbIn) + word(0n) + word(0n) + word(tokensOut),
});
const swapSell = (to, tokensIn, bnbOut) => ({
  kind: "swap",
  address: PAIR,
  topics: [TOPIC.swap, pad(PAIR), pad(to)],
  data: "0x" + word(0n) + word(tokensIn) + word(bnbOut) + word(0n),
});
const borrowStarted = (user, stake) => ({
  kind: "borrowStarted",
  address: VAULT,
  topics: [TOPIC.borrowStarted, pad(user)],
  data: "0x" + word(stake) + word(0n) + word(0n) + word(0n),
});
const repaid = (user, returned) => ({
  kind: "repaid",
  address: VAULT,
  topics: [TOPIC.repaid, pad(user)],
  data: "0x" + word(0n) + word(returned),
});
const defaulted = (user, burned) => ({
  kind: "defaulted",
  address: VAULT,
  topics: [TOPIC.defaulted, pad(user), pad(DEAD)],
  data: "0x" + word(burned) + word(0n),
});
const minted = (user, paidBnb, tokensOut) => ({
  kind: "minted",
  address: TOKEN,
  topics: [TOPIC.minted, pad(user)],
  data: "0x" + word(paidBnb) + word(tokensOut),
});

/** Same grouping the report does, but for logs already carrying their `kind`. */
function run(transactions) {
  const grouped = transactions.map((logs) => ({
    hash: logs[0].transactionHash,
    block: Number(logs[0].blockNumber),
    index: 0,
    logs: logs.map((log) => ({ kind: log.kind, log })),
  }));
  return replay(grouped, prices);
}

test("a plain buy becomes a lot worth the BNB spent", () => {
  const ledger = run([tx([swapBuy(ALICE, BNB(1), T(1000)), transfer(PAIR, ALICE, T(1000))])]);
  assert.strictEqual(ledger.personalUsd(ALICE), 600n * USD_SCALE, "1 BNB at $600");
  assert.strictEqual(ledger.account(ALICE).heldTokens, T(1000));
});

test("a buy tax does not inflate the lot: only what actually arrived is counted", () => {
  // The pool releases 1000, the token immediately takes 50 as tax to the vault.
  const ledger = run([
    tx([
      swapBuy(ALICE, BNB(1), T(1000)),
      transfer(PAIR, ALICE, T(1000)),
      transfer(ALICE, VAULT, T(50)),
    ]),
  ]);
  assert.strictEqual(ledger.account(ALICE).heldTokens, T(950), "net of the tax");
  assert.strictEqual(ledger.personalUsd(ALICE), 600n * USD_SCALE, "she still paid a whole BNB");
});

test("a sell deducts the cost of the tokens sold", () => {
  const ledger = run([
    tx([swapBuy(ALICE, BNB(2), T(1000)), transfer(PAIR, ALICE, T(1000))]), // $1200
    tx([transfer(ALICE, PAIR, T(400)), swapSell(ALICE, T(400), BNB(1))]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 720n * USD_SCALE, "40% of $1200 left");
});

test("pledging collateral is not a sale", () => {
  const ledger = run([
    tx([swapBuy(ALICE, BNB(1), T(1000)), transfer(PAIR, ALICE, T(1000))]),
    tx([transfer(ALICE, VAULT, T(300)), borrowStarted(ALICE, T(300))]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 600n * USD_SCALE, "still hers while staked");
  assert.strictEqual(ledger.account(ALICE).staked, T(300));
});

test("the whole borrow round trip nets out, and the borrowed buy counts", () => {
  const ledger = run([
    tx([swapBuy(ALICE, BNB(1), T(1000)), transfer(PAIR, ALICE, T(1000))]), // $600
    tx([transfer(ALICE, VAULT, T(300)), borrowStarted(ALICE, T(300))]), // stake, borrow BNB
    tx([swapBuy(ALICE, BNB(0.3), T(280)), transfer(PAIR, ALICE, T(280))]), // spends the borrowed BNB
    tx([transfer(VAULT, ALICE, T(300)), repaid(ALICE, T(300))]), // repay, collateral back
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 780n * USD_SCALE, "$600 + $180");
  assert.strictEqual(ledger.account(ALICE).staked, 0n);
  assert.strictEqual(ledger.account(ALICE).heldTokens, T(1280));
});

test("a default burns the stake and the performance behind it", () => {
  const ledger = run([
    tx([swapBuy(ALICE, BNB(1), T(1000)), transfer(PAIR, ALICE, T(1000))]), // $0.60 a token
    tx([transfer(ALICE, VAULT, T(300)), borrowStarted(ALICE, T(300))]),
    tx([transfer(VAULT, DEAD, T(300)), defaulted(ALICE, T(300))]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 420n * USD_SCALE, "300 tokens of cost destroyed");
  assert.strictEqual(ledger.account(ALICE).staked, 0n);
});

test("moving tokens to a second wallet hands the performance to nobody", () => {
  const ledger = run([
    tx([swapBuy(ALICE, BNB(5), T(1000)), transfer(PAIR, ALICE, T(1000))]), // $3000
    tx([transfer(ALICE, BOB, T(1000))]),
    tx([transfer(BOB, PAIR, T(1000)), swapSell(BOB, T(1000), BNB(5))]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 0n);
  assert.strictEqual(ledger.personalUsd(BOB), 0n, "he never bought them");
});

test("the vault's idle buyback is not somebody's performance", () => {
  const ledger = run([
    tx([swapBuy(VAULT, BNB(2), T(400)), transfer(PAIR, VAULT, T(400)), transfer(VAULT, DEAD, T(400))]),
  ]);
  assert.strictEqual(ledger.personalUsd(VAULT), 0n);
  assert.strictEqual(ledger.ranking().length, 0, "nothing to report");
});

test("two buyers in one transaction split the BNB by what each received", () => {
  const ledger = run([
    tx([
      swapBuy(ALICE, BNB(3), T(900)),
      transfer(PAIR, ALICE, T(600)),
      transfer(PAIR, BOB, T(300)),
    ]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 1200n * USD_SCALE, "two thirds of $1800");
  assert.strictEqual(ledger.personalUsd(BOB), 600n * USD_SCALE);
});

test("the report reads in dollars", () => {
  const ledger = run([tx([swapBuy(ALICE, BNB(1.5), T(1000)), transfer(PAIR, ALICE, T(1000))])]);
  assert.strictEqual(formatUsd(ledger.personalUsd(ALICE)), "$900.00");
});

// The fair mint is how half of this supply was issued, and the batch that settles it carries no
// msg.value: the minter's BNB goes straight into the pool as liquidity. Read as transfers alone it
// looks like a free airdrop paired with somebody buying.
test("a mint is a purchase at the price its own event reports", () => {
  const ledger = run([
    tx([
      minted(ALICE, BNB(0.01515), T(2500)),
      transfer(TOKEN, ALICE, T(2500)), // the minter's allocation
      transfer(TOKEN, PAIR, T(2500)), // the matching half, paired with the BNB below
      swapBuy(PAIR, BNB(0.015), 0n), // addLiquidity's WBNB leg, which is nobody's trade
    ]),
  ]);
  assert.strictEqual(formatUsd(ledger.personalUsd(ALICE)), "$9.09", "0.01515 BNB at $600");
  assert.strictEqual(ledger.account(ALICE).heldTokens, T(2500));
  assert.strictEqual(ledger.account(ALICE).giftBalance, 0n, "bought, not gifted");
});

test("BNB added as liquidity is not credited to whoever happens to receive tokens", () => {
  const ledger = run([
    tx([
      swapBuy(PAIR, BNB(10), 0n), // 10 BNB into the pool
      transfer(TOKEN, PAIR, T(5000)), // tokens in with it: liquidity, not a sale
      transfer(BOB, ALICE, T(100)), // and in the same transaction Bob pays Alice
    ]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 0n, "$6,000 of liquidity is not her purchase");
  assert.strictEqual(ledger.account(ALICE).heldTokens, T(100), "a gift, with no cost behind it");
});

test("removing liquidity is not a sale of somebody's position", () => {
  const ledger = run([
    tx([swapBuy(ALICE, BNB(2), T(1000)), transfer(PAIR, ALICE, T(1000))]), // $1,200
    tx([
      swapSell(ALICE, 0n, BNB(5)), // BNB leaving the pool
      transfer(PAIR, BOB, T(2000)), // and the tokens leaving with it
    ]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 1200n * USD_SCALE, "untouched");
  assert.strictEqual(ledger.account(BOB).heldTokens, T(2000));
  assert.strictEqual(ledger.personalUsd(BOB), 0n, "he withdrew liquidity, he did not buy");
});

test("the token's own tax account is not a member", () => {
  const ledger = run([
    tx([
      swapBuy(ALICE, BNB(1), T(1000)),
      transfer(PAIR, ALICE, T(1000)),
      transfer(ALICE, TOKEN, T(30)), // 3% tax parks in the token contract
    ]),
    tx([transfer(TOKEN, PAIR, T(30)), swapSell(TOKEN, T(30), BNB(0.03))]), // which later sells it
  ]);
  assert.strictEqual(ledger.personalUsd(TOKEN), 0n);
  assert.ok(!ledger.ranking().some((row) => row.address === TOKEN.toLowerCase()), "not in the ranking");
  assert.strictEqual(ledger.account(ALICE).heldTokens, T(970), "net of the tax");
  assert.strictEqual(ledger.personalUsd(ALICE), 600n * USD_SCALE, "she still paid a whole BNB");
});

// This one was a live misreading: the pledge shared a transaction with the vault's idle buyback, so
// every transfer-shape discriminator put it on the wrong side and booked the collateral as a sale.
test("collateral pledged alongside the vault's buyback is still collateral", () => {
  const ledger = run([
    tx([swapBuy(ALICE, BNB(1), T(1000)), transfer(PAIR, ALICE, T(1000))]),
    tx([
      transfer(ALICE, VAULT, T(300)),
      borrowStarted(ALICE, T(300)),
      swapBuy(VAULT, BNB(0.5), T(200)), // the vault buying back, same transaction
      transfer(PAIR, VAULT, T(200)),
      transfer(VAULT, DEAD, T(200)),
    ]),
  ]);
  assert.strictEqual(ledger.personalUsd(ALICE), 600n * USD_SCALE, "not a sale");
  assert.strictEqual(ledger.account(ALICE).staked, T(300));
  assert.strictEqual(ledger.account(ALICE).heldTokens, T(1000));
});
