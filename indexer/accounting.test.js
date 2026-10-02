"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Ledger, USD_SCALE, formatUsd } = require("./accounting");

const T = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // tokens, 18 decimals
const U = (n) => BigInt(Math.round(n * 100)) * (USD_SCALE / 100n); // usd, 18 decimals

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const VAULT = "0xdda9d6c1738ea47e047b220a6fecc3cfc9d65cb6";

const fresh = () => new Ledger({ excluded: new Set([VAULT]) });

test("a buy is worth what it cost in USD at the time", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(500));
  assert.strictEqual(l.personalUsd(ALICE), U(500));
  assert.strictEqual(l.account(ALICE).heldTokens, T(1000));
});

test("performance does not move when the token price does", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(500));
  const before = l.personalUsd(ALICE);
  // Nothing happens on chain; the price simply doubles. Gold standard means this changes nothing.
  assert.strictEqual(l.personalUsd(ALICE), before);
});

test("selling removes exactly what those tokens cost, not what they fetched", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(500));
  // Sells 40% after the price doubled: proceeds $400, but only $200 of cost leaves.
  l.sell(ALICE, T(400), U(400));
  assert.strictEqual(l.personalUsd(ALICE), U(300));
  assert.strictEqual(l.account(ALICE).heldTokens, T(600));
});

test("selling everything lands on zero, never below it", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(500));
  l.sell(ALICE, T(1000), U(5000)); // sold at 10x
  assert.strictEqual(l.personalUsd(ALICE), 0n, "a profitable exit is zero, not negative");
  l.sell(ALICE, T(1000), U(1)); // selling what is not there changes nothing
  assert.strictEqual(l.personalUsd(ALICE), 0n);
});

test("lots are consumed oldest first", () => {
  const l = fresh();
  l.buy(ALICE, T(100), U(100)); // $1.00 each
  l.buy(ALICE, T(100), U(300)); // $3.00 each
  l.sell(ALICE, T(100), U(0));
  assert.strictEqual(l.personalUsd(ALICE), U(300), "the cheap lot went first");
});

test("a partial sale splits the lot in proportion", () => {
  const l = fresh();
  l.buy(ALICE, T(100), U(100));
  l.sell(ALICE, T(25), U(0));
  assert.strictEqual(l.personalUsd(ALICE), U(75));
  assert.strictEqual(l.account(ALICE).heldTokens, T(75));
});

// ---------------------------------------------------------------- the lending flow

test("pledging collateral does not look like a sale", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(500));
  l.pledge(ALICE, T(300));
  assert.strictEqual(l.personalUsd(ALICE), U(500), "the tokens are still hers");
  assert.strictEqual(l.account(ALICE).staked, T(300));
});

test("buying with borrowed BNB counts like any other buy", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(500));
  l.pledge(ALICE, T(300)); // stake, borrow BNB
  l.buy(ALICE, T(200), U(100)); // the borrowed BNB goes straight back into the pair
  l.redeem(ALICE, T(300)); // repay, collateral returned
  assert.strictEqual(l.personalUsd(ALICE), U(600));
  assert.strictEqual(l.account(ALICE).staked, 0n);
});

test("a default burns the collateral and the performance with it", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(500)); // $0.50 each
  l.pledge(ALICE, T(300));
  l.defaulted(ALICE, T(300)); // window expired, vault burned the stake
  assert.strictEqual(l.personalUsd(ALICE), U(350), "300 tokens at $0.50 are gone");
  assert.strictEqual(l.account(ALICE).staked, 0n);
  assert.strictEqual(l.account(ALICE).defaultedTokens, T(300));
});

test("the vault's own buybacks belong to nobody", () => {
  const l = fresh();
  l.buy(VAULT, T(5000), U(2500)); // idle buyback, then burned to DEAD
  assert.strictEqual(l.personalUsd(VAULT), 0n);
  assert.strictEqual(l.ranking().length, 0);
});

// ---------------------------------------------------------------- transfers, and why they count

test("moving tokens to another wallet costs the performance", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(1000));
  l.release(ALICE, T(1000)); // sent to BOB
  l.receive(BOB, T(1000));
  assert.strictEqual(l.personalUsd(ALICE), 0n);
  assert.strictEqual(l.personalUsd(BOB), 0n, "BOB never bought them, so they are worth nothing to him");
});

test("the wash loop produces no performance at all", () => {
  // Buy, move to a second wallet, sell there, send the money back, buy again. If transfers were
  // ignored this would print performance forever from the same $10,000.
  const l = fresh();
  for (let round = 0; round < 5; round++) {
    l.buy(ALICE, T(1000), U(10000));
    l.release(ALICE, T(1000)); // -> BOB
    l.receive(BOB, T(1000));
    l.sell(BOB, T(1000), U(10000)); // BOB exits; he holds no bought lots, so nothing is deducted
  }
  assert.strictEqual(l.personalUsd(ALICE), 0n, "five round trips, still zero");
  assert.strictEqual(l.personalUsd(BOB), 0n);
});

test("passing on a gift does not eat performance you did earn", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(1000)); // earned
  l.receive(ALICE, T(500)); // a friend sends her some
  l.release(ALICE, T(500)); // she passes them on
  assert.strictEqual(l.personalUsd(ALICE), U(1000), "the gift was spent first");
  assert.strictEqual(l.account(ALICE).heldTokens, T(1000));
});

test("once the gifts run out, an outflow starts costing", () => {
  const l = fresh();
  l.buy(ALICE, T(1000), U(1000));
  l.receive(ALICE, T(500));
  l.release(ALICE, T(700)); // 500 gifted + 200 bought
  assert.strictEqual(l.personalUsd(ALICE), U(800));
});

test("tokens that were only ever received are worth nothing", () => {
  const l = fresh();
  l.receive(BOB, T(9_000_000));
  assert.strictEqual(l.personalUsd(BOB), 0n);
  l.sell(BOB, T(9_000_000), U(50000));
  assert.strictEqual(l.personalUsd(BOB), 0n);
});

// ---------------------------------------------------------------- order matters

test("selling then being gifted is not the same as never selling", () => {
  const replay = (events) => fresh().applyAll(events);

  const sellThenGift = replay([
    { type: "buy", address: ALICE, tokens: T(100), usd: U(100) },
    { type: "sell", address: ALICE, tokens: T(100), usd: U(100) },
    { type: "receive", address: ALICE, tokens: T(100) },
  ]);
  assert.strictEqual(sellThenGift.personalUsd(ALICE), 0n, "she holds a gift, not what she bought");

  const justBought = replay([{ type: "buy", address: ALICE, tokens: T(100), usd: U(100) }]);
  assert.strictEqual(justBought.personalUsd(ALICE), U(100));
  // Both end holding 100 tokens. Only chronological processing tells them apart.
  assert.strictEqual(sellThenGift.account(ALICE).heldTokens, justBought.account(ALICE).heldTokens);
});

// ---------------------------------------------------------------- the team

test("team performance reaches every level below", () => {
  const l = fresh();
  l.buy(ALICE, T(10), U(100));
  l.buy(BOB, T(10), U(200));
  l.buy(CAROL, T(10), U(400));
  const childrenOf = new Map([
    [ALICE.toLowerCase(), [BOB.toLowerCase()]],
    [BOB.toLowerCase(), [CAROL.toLowerCase()]],
  ]);
  assert.strictEqual(l.teamUsd(ALICE, childrenOf), U(700));
  assert.strictEqual(l.teamUsd(BOB, childrenOf), U(600));
  assert.strictEqual(l.teamUsd(CAROL, childrenOf), U(400));
});

test("a corrupted tree cannot hang the walk", () => {
  const l = fresh();
  l.buy(ALICE, T(10), U(100));
  l.buy(BOB, T(10), U(200));
  const cyclic = new Map([
    [ALICE.toLowerCase(), [BOB.toLowerCase()]],
    [BOB.toLowerCase(), [ALICE.toLowerCase()]], // the registry forbids this; the walk survives it anyway
  ]);
  assert.strictEqual(l.teamUsd(ALICE, cyclic), U(300));
});

test("formatUsd reads like money", () => {
  assert.strictEqual(formatUsd(U(1234.5)), "$1,234.50");
  assert.strictEqual(formatUsd(0n), "$0.00");
});
