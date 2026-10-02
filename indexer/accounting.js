"use strict";
/**
 * Performance accounting for SUNFLOWER, in USD fixed at the moment of purchase.
 *
 * One rule decides everything:
 *
 *     performance = the USD cost of the tokens an address bought and still holds
 *
 * "Still holds" counts what sits in the wallet plus what is pledged as collateral in the lending
 * vault, because pledging is a plain ERC20 transfer that would otherwise look like a sale.
 *
 * Writing it as one rule instead of a rule per event type is deliberate. Every case falls out:
 *
 *   sell            balance falls                       -> deducted
 *   transfer out    balance falls                       -> deducted  (this is what stops farming)
 *   pledge          balance falls, collateral rises     -> unchanged
 *   redeem          collateral falls, balance rises     -> unchanged
 *   default         collateral burns and never returns  -> deducted
 *   airdrop in      balance rises with no purchase      -> unchanged
 *   borrowed buy    an ordinary swap on the pair        -> added
 *
 * Why transfers must be deducted: if they were not, an address could buy for $10,000, move the
 * tokens to a second wallet, sell there, send the BNB back and buy again -- the same money
 * producing unlimited performance, for the price of the trading tax alone.
 *
 * Tokens that arrive without being bought carry no cost, and an outflow spends those first. That
 * keeps someone who was sent tokens and passed them on from losing performance they did earn,
 * without reopening the loop above: the loop needs bought tokens to leave, and they still do.
 *
 * This module is pure. It takes an ordered event stream and returns numbers, so the rules can be
 * tested without a network. All token amounts are BigInt in base units; USD is BigInt scaled by
 * USD_SCALE (1e18).
 */

const USD_SCALE = 10n ** 18n;

/** A parcel of bought tokens and what it cost, in USD at the time of the buy. */
class Lot {
  constructor(amount, usd) {
    this.amount = amount;
    this.usd = usd;
  }
}

class Account {
  constructor() {
    /** Bought tokens still held, oldest first. */
    this.lots = [];
    /** Tokens received without buying them. No cost, spent before bought ones. */
    this.giftBalance = 0n;
    /** Running totals, for display rather than for the rule. */
    this.boughtUsd = 0n;
    this.soldUsd = 0n;
    this.boughtTokens = 0n;
    this.soldTokens = 0n;
    this.staked = 0n;
    this.defaultedTokens = 0n;
  }

  /** The number this whole module exists to produce. */
  get performanceUsd() {
    let total = 0n;
    for (const lot of this.lots) total += lot.usd;
    return total;
  }

  get heldTokens() {
    let total = this.giftBalance;
    for (const lot of this.lots) total += lot.amount;
    return total;
  }
}

class Ledger {
  /**
   * @param {object} options
   * @param {Set<string>} options.excluded Addresses whose trades are protocol behaviour, not a
   *        member's: the lending vault's idle buybacks, the pair, the burn address.
   */
  constructor({ excluded = new Set() } = {}) {
    this.accounts = new Map();
    this.excluded = new Set([...excluded].map((a) => a.toLowerCase()));
  }

  account(address) {
    const key = address.toLowerCase();
    if (!this.accounts.has(key)) this.accounts.set(key, new Account());
    return this.accounts.get(key);
  }

  isExcluded(address) {
    return this.excluded.has(String(address).toLowerCase());
  }

  /** Tokens bought on the pair. `usd` is the BNB spent valued at that block. */
  buy(address, tokens, usd) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    const a = this.account(address);
    a.lots.push(new Lot(tokens, usd));
    a.boughtTokens += tokens;
    a.boughtUsd += usd;
  }

  /** Tokens arriving any other way: a gift, an airdrop, a transfer between wallets. */
  receive(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    this.account(address).giftBalance += tokens;
  }

  /**
   * Tokens leaving for good: sold, sent to someone else, or burned.
   * Gifted tokens go first, then bought ones oldest first.
   * @returns {bigint} the USD performance this removed.
   */
  release(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return 0n;
    const a = this.account(address);
    let remaining = tokens;

    const fromGifts = remaining < a.giftBalance ? remaining : a.giftBalance;
    a.giftBalance -= fromGifts;
    remaining -= fromGifts;

    let removedUsd = 0n;
    while (remaining > 0n && a.lots.length > 0) {
      const lot = a.lots[0];
      if (lot.amount <= remaining) {
        removedUsd += lot.usd;
        remaining -= lot.amount;
        a.lots.shift();
      } else {
        // Split the lot proportionally; the cost follows the tokens.
        const share = (lot.usd * remaining) / lot.amount;
        lot.usd -= share;
        lot.amount -= remaining;
        removedUsd += share;
        remaining = 0n;
      }
    }
    // Anything still unmatched was never ours to account for; ignore it rather than go negative.
    return removedUsd;
  }

  /** Sold on the pair. Deducts, and records the proceeds for display. */
  sell(address, tokens, usd) {
    const removed = this.release(address, tokens);
    if (!this.isExcluded(address) && tokens > 0n) {
      const a = this.account(address);
      a.soldTokens += tokens;
      a.soldUsd += usd;
    }
    return removed;
  }

  /** Collateral moving into the lending vault. Still theirs, so the ledger does not move. */
  pledge(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    this.account(address).staked += tokens;
  }

  /** Collateral coming back out. */
  redeem(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    const a = this.account(address);
    a.staked -= tokens > a.staked ? a.staked : tokens;
  }

  /** The 600-second window expired and the vault burned the collateral. It is really gone. */
  defaulted(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return 0n;
    const a = this.account(address);
    a.staked -= tokens > a.staked ? a.staked : tokens;
    a.defaultedTokens += tokens;
    return this.release(address, tokens);
  }

  /**
   * Apply one ordered event. Callers feed these in (blockNumber, logIndex) order.
   * @param {{type: string, address: string, tokens: bigint, usd?: bigint}} event
   */
  apply(event) {
    const usd = event.usd ?? 0n;
    switch (event.type) {
      case "buy":
        return this.buy(event.address, event.tokens, usd);
      case "sell":
        return this.sell(event.address, event.tokens, usd);
      case "receive":
        return this.receive(event.address, event.tokens);
      case "transferOut":
        return this.release(event.address, event.tokens);
      case "pledge":
        return this.pledge(event.address, event.tokens);
      case "redeem":
        return this.redeem(event.address, event.tokens);
      case "default":
        return this.defaulted(event.address, event.tokens);
      default:
        throw new Error("unknown event type: " + event.type);
    }
  }

  applyAll(events) {
    for (const event of events) this.apply(event);
    return this;
  }

  /** Personal performance, ignoring the team. */
  personalUsd(address) {
    const key = String(address).toLowerCase();
    return this.accounts.has(key) ? this.accounts.get(key).performanceUsd : 0n;
  }

  /**
   * Personal plus everyone below, to unlimited depth.
   * @param {Map<string,string[]>} childrenOf lowercase address -> direct members
   */
  teamUsd(address, childrenOf) {
    let total = 0n;
    const stack = [String(address).toLowerCase()];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (seen.has(node)) continue; // the registry forbids cycles, but never trust the input
      seen.add(node);
      total += this.personalUsd(node);
      for (const child of childrenOf.get(node) ?? []) stack.push(child);
    }
    return total;
  }

  /** Every account with something to show, largest first. */
  ranking() {
    return [...this.accounts.entries()]
      .map(([address, a]) => ({
        address,
        performanceUsd: a.performanceUsd,
        heldTokens: a.heldTokens,
        staked: a.staked,
        boughtUsd: a.boughtUsd,
        soldUsd: a.soldUsd,
      }))
      .filter((row) => row.performanceUsd > 0n || row.heldTokens > 0n)
      .sort((x, y) => (y.performanceUsd > x.performanceUsd ? 1 : y.performanceUsd < x.performanceUsd ? -1 : 0));
  }
}

const formatUsd = (value) => {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = v / USD_SCALE;
  const cents = ((v % USD_SCALE) * 100n) / USD_SCALE;
  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};

module.exports = { Ledger, Account, Lot, USD_SCALE, formatUsd };
