// Builds web/report.json from a made-up week of trading, so the page can be looked at and the
// whole chain -- ledger, report shape, rendering -- exercised before the API key exists.
//
//   node tools/demo-report.js
//
// The numbers are invented. The rules applied to them are the real ones.
const fs = require("fs");
const path = require("path");
const { Ledger, USD_SCALE } = require("../indexer/accounting");

const T = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const U = (n) => BigInt(Math.round(n * 100)) * (USD_SCALE / 100n);

const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const [ROOT, ANN, BEN, CHEN, DAI, EVE, FAN] = [1, 2, 3, 4, 5, 6, 7].map(A);

const ledger = new Ledger();

// Ann buys early and holds, then borrows against part of it and buys more with the BNB.
ledger.buy(ANN, T(4000), U(1800));
ledger.pledge(ANN, T(1200));
ledger.buy(ANN, T(900), U(430));
ledger.redeem(ANN, T(1200));

// Ben buys twice and takes some profit off the table. Only the cost of what he sold comes off.
ledger.buy(BEN, T(2500), U(1100));
ledger.buy(BEN, T(1500), U(780));
ledger.sell(BEN, T(1000), U(620));

// Chen borrowed and missed the window; the vault burned his collateral.
ledger.buy(CHEN, T(3000), U(1500));
ledger.pledge(CHEN, T(900));
ledger.defaulted(CHEN, T(900));

// Dai bought, then moved everything to a second wallet -- the classic way to try to keep the
// performance while exiting. It does not work.
ledger.buy(DAI, T(5000), U(2400));
ledger.release(DAI, T(5000));
ledger.receive(EVE, T(5000));
ledger.sell(EVE, T(5000), U(2500));

// Fan was airdropped tokens and never bought anything.
ledger.receive(FAN, T(8000));

const childrenOf = new Map([
  [ROOT, [ANN, BEN]],
  [ANN, [CHEN, DAI]],
  [BEN, [EVE, FAN]],
]);

const rows = ledger.ranking().map((row) => ({
  ...row,
  referrer:
    [...childrenOf].find(([, kids]) => kids.includes(row.address))?.[0] ?? null,
  teamUsd: ledger.teamUsd(row.address, childrenOf),
}));

const report = {
  generatedAt: new Date().toISOString(),
  demo: true,
  scannedTo: 0,
  token: "0xfd06eeadc43ee0687d5611d698fb2ee39f9baaaa",
  registry: null,
  members: rows.length,
  rows,
};

const out = path.join(__dirname, "..", "web", "report.json");
fs.writeFileSync(out, JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const usd = (v) => "$" + (Number(v / 10n ** 14n) / 10000).toLocaleString("en-US", { minimumFractionDigits: 2 });
console.log("demo report written to web/report.json\n");
console.log("address".padEnd(44) + "personal".padStart(12) + "team".padStart(12) + "   note");
const notes = {
  [ANN]: "held everything, borrowed and bought more",
  [BEN]: "sold a quarter; only that quarter's cost left",
  [CHEN]: "defaulted, collateral burned",
  [DAI]: "moved it all to a second wallet",
  [EVE]: "received and sold; never bought",
  [FAN]: "airdrop only",
};
for (const row of rows) {
  console.log(
    row.address.padEnd(44) +
      usd(row.performanceUsd).padStart(12) +
      usd(row.teamUsd).padStart(12) +
      "   " + (notes[row.address] ?? "")
  );
}
