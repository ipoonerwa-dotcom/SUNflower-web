// The web page hardcodes four-byte selectors so it can run with no libraries at all. A wrong one
// does not throw: it calls a function that does not exist, and the page quietly shows nothing. So
// they are checked here instead of trusted. Three of the five were wrong when first written.
//
//   node tools/check-selectors.js
const fs = require("fs");
const path = require("path");
const { id } = require("ethers");

const SIGNATURES = {
  statusOf: "statusOf(address)",
  bind: "bind(address)",
  memberCount: "memberCount()",
  root: "root()",
  balanceOf: "balanceOf(address)",
};

const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
let bad = 0;

for (const [name, signature] of Object.entries(SIGNATURES)) {
  const found = new RegExp(`\\b${name}:\\s*"(0x[0-9a-fA-F]{8})"`).exec(source);
  const expected = id(signature).slice(0, 10);
  if (!found) {
    console.error(`  missing  ${name}`);
    bad++;
  } else if (found[1].toLowerCase() !== expected) {
    console.error(`  WRONG    ${name.padEnd(13)} ${signature.padEnd(21)} has ${found[1]}  want ${expected}`);
    bad++;
  } else {
    console.log(`  ok       ${name.padEnd(13)} ${signature.padEnd(21)} ${expected}`);
  }
}

if (bad) {
  console.error(`\n${bad} selector(s) wrong -- the page would call nothing.`);
  process.exit(1);
}
console.log("\nall selectors match their signatures");
