/*
 * Chain helpers shared by the page and the Node tests.
 *
 * The page loads no libraries, so calls are encoded and decoded here by hand, and PancakeSwap's
 * constant-product maths is reproduced for quoting. Everything in this file is pure -- no DOM, no
 * network -- which is what lets indexer/chain.test.js check it against ethers and against the live
 * router before any of it touches somebody's money.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Chain = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // name: [signature, selector]. A wrong selector does not throw -- it calls a function that does
  // not exist and the page quietly shows nothing -- so tools/check-selectors.js recomputes every one.
  const FN = {
    // ReferralRegistry
    statusOf: ["statusOf(address)", "0x97a5d5b5"],
    bind: ["bind(address)", "0x81bac14f"],
    memberCount: ["memberCount()", "0x11aee380"],
    root: ["root()", "0xebf0c717"],
    uplineOf: ["uplineOf(address,uint256)", "0xfc824a55"],
    // SunflowerConsole: admins, studio approvals, reward bookkeeping
    applyForStudio: ["applyForStudio(string)", "0xdd17ab63"],
    withdrawApplication: ["withdrawApplication()", "0x1fcf55ff"],
    resign: ["resign()", "0x69652fcf"],
    approveStudio: ["approve(address)", "0xdaea85c5"],
    rejectStudio: ["reject(address)", "0xab0da5a9"],
    registerFor: ["registerFor(address,string)", "0x498163fd"],
    removeStudio: ["remove(address)", "0x29092d0e"],
    nameOf: ["nameOf(address)", "0xf5c57382"],
    studios: ["studios(uint256,uint256)", "0x5e991974"],
    studioCount: ["studioCount()", "0x1f0a3773"],
    applicationOf: ["applicationOf(address)", "0x450187b8"],
    applications: ["applications(uint256,uint256)", "0x7a870b63"],
    isAdmin: ["isAdmin(address)", "0x24d7806c"],
    admins: ["admins()", "0xa5de3619"],
    owner: ["owner()", "0x8da5cb5b"],
    rewardBps: ["rewardBps()", "0x82328ffc"],
    setRewardBps: ["setRewardBps(uint256)", "0x0a542fa7"],
    markPaid: ["markPaid(bytes32[],address[],uint256[])", "0x31659a9a"],
    unmarkPaid: ["unmarkPaid(bytes32[],address[])", "0xb23144e8"],
    paidMany: ["paidMany(bytes32[],address[])", "0x5d61bd70"],
    correctReferrer: ["correctReferrer(address,address)", "0xddbfe38c"], // owner only, passed to the registry
    // SunflowerStaking
    stake: ["stake(uint256)", "0xa694fc3a"],
    claim: ["claim()", "0x4e71d92d"],
    claimable: ["claimable(address)", "0x402914f5"],
    positionsOf: ["positionsOf(address)", "0xf867d46b"],
    poolBalance: ["poolBalance()", "0x96365d44"],
    totalLocked: ["totalLocked()", "0x56891412"],
    open: ["open()", "0xfcfff16f"],
    minStake: ["minStake()", "0x375b3c0a"],
    totalStaked: ["totalStaked()", "0x817b1cd2"],
    totalBonusPaid: ["totalBonusPaid()", "0x8325263c"],
    // SunflowerStaking, owner only
    withdrawPool: ["withdrawPool(address,uint256)", "0x7c4304ff"],
    withdrawBnb: ["withdrawBnb(address)", "0xca109946"],
    setOpen: ["setOpen(bool)", "0x6fdca5e0"],
    // ERC20: the token and USDT
    balanceOf: ["balanceOf(address)", "0x70a08231"],
    allowance: ["allowance(address,address)", "0xdd62ed3e"],
    approve: ["approve(address,uint256)", "0x095ea7b3"],
    // SUNFLOWER itself
    buyTaxBps: ["buyTaxBps()", "0xc473413a"],
    sellTaxBps: ["sellTaxBps()", "0xcffd129c"],
    liquidationThreshold: ["liquidationThreshold()", "0x4031234c"],
    dividendTokenReserved: ["dividendTokenReserved()", "0x40f446ad"],
    // PancakeSwap V2
    getReserves: ["getReserves()", "0x0902f1ac"],
    getAmountsOut: ["getAmountsOut(uint256,address[])", "0xd06ca61f"],
    swapExactETHForTokensSupportingFeeOnTransferTokens: [
      "swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)",
      "0xb6f9de95",
    ],
    swapExactTokensForETHSupportingFeeOnTransferTokens: [
      "swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
      "0x791ac947",
    ],
    swapExactTokensForTokensSupportingFeeOnTransferTokens: [
      "swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
      "0x5c11d795",
    ],
  };

  // ------------------------------------------------------------------ ABI encoding

  const utf8 = { encode: (s) => new TextEncoder().encode(s), decode: (b) => new TextDecoder().decode(b) };
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const word = (value) => {
    const v = BigInt(value);
    if (v < 0n) throw new Error("negative values are not supported");
    const h = v.toString(16);
    if (h.length > 64) throw new Error("value does not fit in 32 bytes");
    return h.padStart(64, "0");
  };
  const addressWord = (a) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("not an address: " + a);
    return a.slice(2).toLowerCase().padStart(64, "0");
  };
  const padRight = (h) => h + "0".repeat((64 - (h.length % 64)) % 64);

  const isDynamic = (type) => type === "string" || type === "bytes" || type.endsWith("[]");

  function encodeStatic(type, value) {
    if (type === "address") return addressWord(value);
    if (type === "bool") return word(value ? 1 : 0);
    if (type === "bytes32") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("not 32 bytes: " + value);
      return value.slice(2).toLowerCase();
    }
    if (/^uint\d*$/.test(type)) return word(value);
    throw new Error("unsupported static type " + type);
  }

  function encodeDynamic(type, value) {
    if (type === "string") {
      const bytes = utf8.encode(value);
      return word(bytes.length) + padRight(hex(bytes));
    }
    if (type.endsWith("[]")) {
      const inner = type.slice(0, -2);
      if (isDynamic(inner)) throw new Error("arrays of dynamic types are not encoded here");
      return word(value.length) + value.map((v) => encodeStatic(inner, v)).join("");
    }
    throw new Error("unsupported dynamic type " + type);
  }

  /** Head-and-tail encoding of a flat argument list. */
  function encodeArgs(types, values) {
    if (types.length !== values.length) throw new Error(`expected ${types.length} arguments, got ${values.length}`);
    const heads = [];
    const tails = [];
    let tailBytes = 32 * types.length;
    types.forEach((type, i) => {
      if (isDynamic(type)) {
        const tail = encodeDynamic(type, values[i]);
        heads.push(word(tailBytes));
        tails.push(tail);
        tailBytes += tail.length / 2;
      } else {
        heads.push(encodeStatic(type, values[i]));
      }
    });
    return heads.join("") + tails.join("");
  }

  const typesOf = (signature) => {
    const inside = signature.slice(signature.indexOf("(") + 1, -1);
    return inside ? inside.split(",") : [];
  };

  /** Calldata for `name` with `args`, typed from its signature. */
  function encodeCall(name, ...args) {
    const entry = FN[name];
    if (!entry) throw new Error("unknown function " + name);
    const [signature, selector] = entry;
    return selector + encodeArgs(typesOf(signature), args);
  }

  // ------------------------------------------------------------------ ABI decoding

  function decode(types, data) {
    const h = data.startsWith("0x") ? data.slice(2) : data;
    const at = (byteOffset) => h.slice(byteOffset * 2, byteOffset * 2 + 64);
    const uintAt = (byteOffset) => BigInt("0x" + (at(byteOffset) || "0"));

    const readStatic = (type, offset) => {
      const w = at(offset);
      if (w.length !== 64) throw new Error("return data too short");
      if (type === "address") return "0x" + w.slice(24);
      if (type === "bool") return BigInt("0x" + w) !== 0n;
      if (/^uint\d*$/.test(type)) return BigInt("0x" + w);
      throw new Error("unsupported static type " + type);
    };

    const readString = (offset) => {
      const length = Number(uintAt(offset));
      const start = (offset + 32) * 2;
      const raw = h.slice(start, start + length * 2);
      const bytes = new Uint8Array(raw.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
      return utf8.decode(bytes);
    };

    const readDynamic = (type, offset) => {
      if (type === "string") return readString(offset);
      if (type.endsWith("[]")) {
        const inner = type.slice(0, -2);
        const length = Number(uintAt(offset));
        const base = offset + 32;
        const out = [];
        for (let i = 0; i < length; i++) {
          // Elements of a dynamic type are themselves offsets, counted from the start of the elements.
          out.push(isDynamic(inner) ? readDynamic(inner, base + Number(uintAt(base + 32 * i))) : readStatic(inner, base + 32 * i));
        }
        return out;
      }
      throw new Error("unsupported dynamic type " + type);
    };

    return types.map((type, i) => (isDynamic(type) ? readDynamic(type, Number(uintAt(32 * i))) : readStatic(type, 32 * i)));
  }

  // ------------------------------------------------------------------ PancakeSwap V2 maths

  // Pancake V2 charges 0.25%: the router computes amountIn * 9975 / 10000.
  function amountOut(amountIn, reserveIn, reserveOut) {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
    const inWithFee = amountIn * 9975n;
    return (inWithFee * reserveOut) / (reserveIn * 10000n + inWithFee);
  }

  /**
   * Tokens -> BNB on the SUNFLOWER pair, for what a seller actually gets.
   *
   * Two things a plain getAmountsOut misses. The 3% sell tax leaves the seller's tokens before the
   * pool sees them, so only the remainder is swapped. And a sale can trigger the token's own tax
   * liquidation first -- it sells its accumulated tax into the same pool just before the seller's
   * tokens arrive, a price drop of several percent that a tight slippage would revert on. When that
   * is due, the quote assumes the worst case the contract allows: the whole inventory, capped at
   * half the round-trip tax of the token reserve, sold first. The real sale is smaller (part is
   * burned, part goes back as liquidity), so the seller can only do better than quoted.
   */
  function quoteSell({ tokensIn, reserveToken, reserveBnb, buyTaxBps, sellTaxBps, taxInventory = 0n, threshold = 0n }) {
    let rT = reserveToken;
    let rB = reserveBnb;
    let preSale = 0n;
    if (threshold > 0n && taxInventory >= threshold) {
      const cap = (rT * BigInt(buyTaxBps + sellTaxBps)) / 20000n;
      preSale = taxInventory < cap ? taxInventory : cap;
      const out = amountOut(preSale, rT, rB);
      rT += preSale;
      rB -= out;
    }
    const intoPool = (tokensIn * BigInt(10000 - sellTaxBps)) / 10000n;
    return { bnbOut: amountOut(intoPool, rT, rB), intoPool, preSale };
  }

  /** What actually arrives from a buy, given the router's pre-tax quote. */
  const afterBuyTax = (quotedTokens, buyTaxBps) => (quotedTokens * BigInt(10000 - buyTaxBps)) / 10000n;

  /** The floor passed to the router: the expectation less the tolerated slippage. */
  const withSlippage = (expected, slippageBps) => (expected * BigInt(10000 - slippageBps)) / 10000n;

  // ------------------------------------------------------------------ trading

  /** The router path for a trade. The SUNFLOWER pool is paired with WBNB, so USDT goes through it. */
  function swapPath(cfg, side, asset) {
    const head = asset === "USDT" ? [cfg.usdt, cfg.wbnb] : [cfg.wbnb];
    return side === "buy" ? [...head, cfg.token] : [cfg.token, ...head.slice().reverse()];
  }

  /**
   * Quotes a trade: what should arrive, and the floor to send. `call(to, name, args, types)` reads
   * the chain; the page passes its RPC and the fork test passes anvil, so both run this same code.
   */
  async function quoteTrade(call, cfg, { side, asset, amountIn, slippageBps, taxes }) {
    if (!amountIn || amountIn <= 0n) return null;
    const one = async (to, name, ...args) => (await call(to, name, args, ["uint256"]))[0];

    if (side === "buy") {
      // A buy cannot trigger the tax liquidation (only a sale into the pair does), so the router is exact.
      const [amounts] = await call(cfg.router, "getAmountsOut", [amountIn, swapPath(cfg, "buy", asset)], ["uint256[]"]);
      const expected = afterBuyTax(amounts[amounts.length - 1], taxes.buy);
      return { expected, min: withSlippage(expected, slippageBps), preSale: 0n };
    }

    const [reserves, inventory, reserved, threshold] = await Promise.all([
      call(cfg.pair, "getReserves", [], ["uint112", "uint112", "uint32"]),
      one(cfg.token, "balanceOf", cfg.token),
      one(cfg.token, "dividendTokenReserved").catch(() => 0n),
      one(cfg.token, "liquidationThreshold").catch(() => 0n),
    ]);
    // WBNB sorts below the token, so it is token0 on this pair.
    const wbnbFirst = cfg.wbnb.toLowerCase() < cfg.token.toLowerCase();
    const sell = quoteSell({
      tokensIn: amountIn,
      reserveBnb: wbnbFirst ? reserves[0] : reserves[1],
      reserveToken: wbnbFirst ? reserves[1] : reserves[0],
      buyTaxBps: taxes.buy,
      sellTaxBps: taxes.sell,
      taxInventory: inventory > reserved ? inventory - reserved : 0n,
      threshold,
    });
    let expected = sell.bnbOut;
    if (asset === "USDT" && expected > 0n) {
      const [amounts] = await call(cfg.router, "getAmountsOut", [expected, [cfg.wbnb, cfg.usdt]], ["uint256[]"]);
      expected = amounts[amounts.length - 1];
    }
    return { expected, min: withSlippage(expected, slippageBps), preSale: sell.preSale };
  }

  /** The router call that carries out a quoted trade. */
  function swapCall(cfg, { side, asset, amountIn, min, to, deadline }) {
    const path = swapPath(cfg, side, asset);
    if (side === "buy" && asset === "BNB") {
      return { to: cfg.router, value: amountIn, data: encodeCall("swapExactETHForTokensSupportingFeeOnTransferTokens", min, path, to, deadline) };
    }
    if (side === "sell" && asset === "BNB") {
      return { to: cfg.router, value: 0n, data: encodeCall("swapExactTokensForETHSupportingFeeOnTransferTokens", amountIn, min, path, to, deadline) };
    }
    return { to: cfg.router, value: 0n, data: encodeCall("swapExactTokensForTokensSupportingFeeOnTransferTokens", amountIn, min, path, to, deadline) };
  }

  // ------------------------------------------------------------------ units

  /** "1.5" -> 1500000000000000000n, exact, no floating point. */
  function parseUnits(text, decimals = 18) {
    const t = String(text).trim();
    if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
    const [whole, fraction = ""] = t.split(".");
    if (fraction.length > decimals) return null;
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  }

  /** 1500000000000000000n -> "1.5", trimmed to `places`. */
  function formatUnits(value, decimals = 18, places = 4) {
    const v = BigInt(value);
    const negative = v < 0n;
    const abs = negative ? -v : v;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    let fraction = (abs % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
    const text = whole.toLocaleString("en-US") + (fraction ? "." + fraction : "");
    return (negative ? "-" : "") + text;
  }

  return {
    FN, encodeCall, encodeArgs, decode,
    amountOut, quoteSell, afterBuyTax, withSlippage,
    swapPath, quoteTrade, swapCall,
    parseUnits, formatUnits,
  };
});
