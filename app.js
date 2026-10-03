/* SUNFLOWER team DApp: binding and studios on chain, performance from the indexer's report.json,
   and trading straight through PancakeSwap. Calls are encoded by chain.js, which is tested
   against ethers; this file only wires them to the page. */

const CONFIG = {
  chainIdHex: "0x38", // BNB Smart Chain
  chainName: "BNB Smart Chain",
  rpc: "https://bsc-dataseed.bnbchain.org",
  explorer: "https://bscscan.com",
  token: "0xFD06eeAdc43EE0687D5611D698FB2ee39f9baAaA",
  pair: "0x72861674beea6a8046e485327adaC898EE2E611D",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  lendingVault: "0xDDA9d6C1738Ea47E047b220A6feCc3cfC9D65cB6",
  registry: "0xFD58e05fFc519B3fd7E28FeD770845C19D696FAB",
  // Filled in once StudioRegistry is deployed. Until then the studio panel explains itself.
  studio: "0x40ba7F1c0555F505bD143b1Be396bCe39797bBf2",
  // The top of the tree, and the only address that is in it from birth. Whoever arrives without an
  // invite link joins here, so nobody is ever stuck with nobody to bind to.
  root: "0xa666EAE830201c62fe3E0c07Bd956e5D516CD419",
};

const HOLD_HOURS = 48;
const GAS_RESERVE = 2n * 10n ** 15n; // 0.002 BNB kept back when "max" is pressed on BNB
const DAYS_SHOWN = 14;

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const lower = (a) => String(a || "").toLowerCase();
// Studio names are typed by members and read back from chain: never let one reach innerHTML raw.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  account: null,
  report: null,
  index: null, // rows by address, children by referrer, built once from the report
  status: null,
  studios: new Map(), // lowercase address -> name
  myUplines: [],
  view: null, // the address the team tab is looking at
  swap: { side: "buy", asset: "BNB", slippageBps: 100, quote: null, seq: 0 },
  taxes: null,
};

// ---------------------------------------------------------------- formatting

function usd(value) {
  const n = Number(BigInt(value || 0) / 10n ** 14n) / 10_000;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const tokens = (value) => Chain.formatUnits(BigInt(value || 0), 18, 2);
const bnb = (value) => Chain.formatUnits(BigInt(value || 0), 18, 4);

const BJ_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const BJ_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const timeOf = (seconds) => BJ_TIME.format(new Date(seconds * 1000));
const dayOf = (seconds) => BJ_DAY.format(new Date(seconds * 1000));

// ---------------------------------------------------------------- chain access

async function rpc(method, params) {
  const response = await fetch(CONFIG.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** Calls a view and decodes its return values. */
async function read(to, name, args, types) {
  const raw = await rpc("eth_call", [{ to, data: Chain.encodeCall(name, ...args) }, "latest"]);
  return Chain.decode(types, raw);
}
const readUint = async (to, name, ...args) => (await read(to, name, args, ["uint256"]))[0];

async function waitForReceipt(hash) {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const receipt = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt) return receipt;
  }
  return null;
}

/** Sends a transaction from the connected wallet and waits for it. Throws on rejection or revert. */
async function send({ to, data, value = 0n }, label) {
  note(`请在钱包里确认：${label}`, "info");
  const params = { from: state.account, to, data };
  if (value > 0n) params.value = "0x" + value.toString(16);
  const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [params] });
  note(`${label}：已提交，等待上链…  ${short(hash)}`, "info");
  const receipt = await waitForReceipt(hash);
  if (!receipt) throw new Error("等待超时，请到区块浏览器查看 " + hash);
  if (receipt.status !== "0x1") throw new Error(`${label}失败了，链上没有生效。`);
  return receipt;
}

// ---------------------------------------------------------------- wallet

async function connect() {
  if (!window.ethereum) {
    note("没有检测到钱包。请在 MetaMask、TokenPocket 或 OKX 钱包的浏览器里打开本页。", "warn");
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.account = accounts[0];
    await ensureChain();
    await renderAll();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function ensureChain() {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current === CONFIG.chainIdHex) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CONFIG.chainIdHex }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CONFIG.chainIdHex,
        chainName: CONFIG.chainName,
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: [CONFIG.rpc],
        blockExplorerUrls: [CONFIG.explorer],
      }],
    });
  }
}

/** Ensures a wallet is connected, connecting for the member if needed. */
async function requireWallet() {
  if (!state.account) await connect();
  return Boolean(state.account);
}

function readableError(error) {
  const message = String(error?.data?.message || error?.error?.message || error?.message || error);
  const rules = [
    [/user rejected|User denied|rejected the request/i, "你在钱包里取消了这次操作。"],
    [/already bound/i, "这个地址已经绑定过了，本人不能再改。如果绑错了，请联系官方更正。"],
    [/self referral/i, "不能绑定自己。"],
    [/referrer not in tree/i, "推荐人还没有加入，请他先完成绑定。"],
    [/not in referral tree/i, "请先绑定推荐人，再申请成为工作室。"],
    [/already a studio/i, "这个地址已经是工作室了。"],
    [/name taken/i, "这个名字已经被别的工作室用了，换一个。"],
    [/name too long/i, "名字太长了：最多 16 个汉字或 48 个英文字母。"],
    [/empty name/i, "请填写社区名称。"],
    [/same name/i, "新名字和现在的一样。"],
    [/INSUFFICIENT_OUTPUT_AMOUNT/i, "价格变动超过了滑点，交易没有成交。可以调高滑点或稍后再试。"],
    [/TRANSFER_FROM_FAILED|transfer amount exceeds/i, "余额或授权不足。"],
    [/EXPIRED/i, "交易等待太久已过期，请重新提交。"],
    [/insufficient funds/i, "BNB 余额不足以支付手续费。"],
  ];
  for (const [pattern, text] of rules) if (pattern.test(message)) return text;
  return message.slice(0, 160);
}

function note(text, tone = "info") {
  const box = $("note");
  box.textContent = text;
  box.className = "note " + tone;
  box.hidden = !text;
}

// ---------------------------------------------------------------- data

async function loadReport() {
  try {
    const response = await fetch("report.json", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Lookups the panels need, built once: rows by address, and the tree both ways. */
function buildIndex(report) {
  const rows = new Map();
  for (const row of report?.rows ?? []) rows.set(lower(row.address), row);

  // The report's tree covers members who bound but never traded, whom the rows alone would miss.
  const parent = new Map();
  for (const [child, up] of Object.entries(report?.tree ?? {})) parent.set(lower(child), lower(up));
  for (const row of report?.rows ?? []) if (row.referrer && !parent.has(lower(row.address))) parent.set(lower(row.address), lower(row.referrer));

  const children = new Map();
  for (const [child, up] of parent) {
    if (!children.has(up)) children.set(up, []);
    children.get(up).push(child);
  }
  const asOf = report?.generatedAt ? Math.floor(Date.parse(report.generatedAt) / 1000) : Math.floor(Date.now() / 1000);
  return { rows, parent, children, asOf };
}

/** Everybody below `address`, at every depth. */
function downline(address) {
  const out = [];
  const stack = [...(state.index.children.get(lower(address)) ?? [])];
  const seen = new Set();
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    stack.push(...(state.index.children.get(next) ?? []));
  }
  return out;
}

/** The nearest studio at or above `address`, walking the report's tree. */
function studioAbove(address) {
  let cursor = lower(address);
  for (let i = 0; i < 512 && cursor; i++) {
    if (state.studios.has(cursor)) return { address: cursor, name: state.studios.get(cursor) };
    cursor = state.index.parent.get(cursor);
  }
  return null;
}

/** How a single purchase stands against the 48-hour rule, as of the report. */
function holding(buy) {
  const amt = BigInt(buy.amt);
  const left = BigInt(buy.left);
  const hours = (state.index.asOf - buy.t) / 3600;
  const leftUsd = amt > 0n ? (BigInt(buy.usd) * left) / amt : 0n;
  let label;
  let tone;
  if (left === 0n) [label, tone] = ["已卖出", "out"];
  else if (hours >= HOLD_HOURS) [label, tone] = [left === amt ? `满${HOLD_HOURS}h` : `满${HOLD_HOURS}h·部分卖出`, "ok"];
  else [label, tone] = [`还差 ${Math.ceil(HOLD_HOURS - hours)}h`, "wait"];
  return { hours, left, leftUsd, eligibleUsd: tone === "ok" ? leftUsd : 0n, label, tone };
}

async function loadStudios() {
  state.studios = new Map();
  if (!CONFIG.studio) return;
  const [accounts, names] = await read(CONFIG.studio, "studios", [0n, 1000n], ["address[]", "string[]"]);
  accounts.forEach((a, i) => state.studios.set(lower(a), names[i]));
}

async function statusOf(account) {
  if (!CONFIG.registry || !account) return null;
  const [registered, upline, level, directs] = await read(CONFIG.registry, "statusOf", [account], ["bool", "address", "uint32", "uint32"]);
  return { registered, upline, level: Number(level), directs: Number(directs) };
}

// ---------------------------------------------------------------- tabs

const TABS = ["me", "trade", "team", "board"];

function showTab(name) {
  const tab = TABS.includes(name) ? name : "me";
  for (const button of document.querySelectorAll("[data-tab]")) {
    const on = button.dataset.tab === tab;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", on);
  }
  for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== tab;
  if (tab === "team") renderTeam();
  if (tab === "trade") refreshSwap();
}

// ---------------------------------------------------------------- 我的

async function renderMe() {
  $("connect").textContent = state.account ? short(state.account) : "连接钱包";
  $("connect").classList.toggle("connected", Boolean(state.account));

  const report = state.report;
  $("reportAge").textContent = report ? "数据更新于 " + new Date(report.generatedAt).toLocaleString("zh-CN") : "业绩数据尚未生成";

  state.status = state.account ? await statusOf(state.account).catch(() => null) : null;
  state.myUplines = [];
  if (state.account && CONFIG.registry && state.status?.registered) {
    state.myUplines = (await read(CONFIG.registry, "uplineOf", [state.account, 512n], ["address[]"]).catch(() => [[]]))[0];
  }
  if (state.account) {
    const balance = await readUint(CONFIG.token, "balanceOf", state.account).catch(() => 0n);
    $("myBalance").textContent = tokens(balance);
  }

  const row = state.index.rows.get(lower(state.account));
  $("personalUsd").textContent = usd(row?.performanceUsd);
  $("teamUsd").textContent = usd(row?.teamUsd);
  $("heldTokens").textContent = tokens(row?.heldTokens);
  $("stakedTokens").textContent = tokens(row?.staked);

  // My community: the nearest studio at or above me, using the live upline so a fresh binding shows.
  const chain = state.account ? [state.account, ...state.myUplines] : [];
  const mine = chain.map(lower).find((a) => state.studios.has(a));
  $("myStudioLine").hidden = !mine;
  if (mine) $("myStudioName").textContent = state.studios.get(mine);

  // Binding
  const s = state.status;
  $("bindPanel").hidden = Boolean(s?.registered);
  $("boundPanel").hidden = !s?.registered;
  if (s?.registered) {
    $("myUpline").textContent = short(s.upline);
    $("myUpline").href = `${CONFIG.explorer}/address/${s.upline}`;
    $("myLevel").textContent = s.level;
    $("myDirects").textContent = s.directs;
  }

  renderStudioPanel();
}

async function bind() {
  const referrer = $("referrerInput").value.trim();
  if (!isAddress(referrer)) return note("推荐人地址格式不对，应该是 0x 开头的 42 位地址。", "warn");
  // Somebody who arrives by invite link sees the button before the connect prompt. Connect for
  // them rather than sending a transaction with no sender, which wallets reject unreadably.
  if (!state.account) {
    if (!(await requireWallet())) return;
    if ((await statusOf(state.account).catch(() => null))?.registered) return note("这个钱包已经绑定过了。", "info");
  }
  if (lower(referrer) === lower(state.account)) return note("不能绑定自己。", "warn");

  // Ask the chain before asking the wallet: a revert gives a raw error and, in some wallets, a fee.
  note("正在检查…", "info");
  const upline = await statusOf(referrer).catch(() => null);
  if (!upline) return note("读取链上状态失败，请检查网络后重试。", "warn");
  if (!upline.registered) return note("这个推荐人还没有加入，请他先完成自己的绑定，你才能绑在他下面。", "warn");

  try {
    await send({ to: CONFIG.registry, data: Chain.encodeCall("bind", referrer) }, "绑定推荐人");
    note("绑定成功。", "ok");
    await renderMe();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function copyLink() {
  if (!state.account) return;
  const link = `${location.origin}${location.pathname}?ref=${state.account}`;
  try {
    await navigator.clipboard.writeText(link);
    note("邀请链接已复制。", "ok");
  } catch {
    note(link, "info");
  }
}

// ---------------------------------------------------------------- 工作室

function renderStudioPanel() {
  const ready = Boolean(CONFIG.studio);
  $("studioPending").hidden = ready;
  $("studioBody").hidden = !ready;
  if (!ready) return;

  const me = lower(state.account);
  const isStudio = me && state.studios.has(me);
  $("studioApply").hidden = isStudio;
  $("studioManage").hidden = !isStudio;
  $("studioAddress").value = state.account || "请先连接钱包";
  if (isStudio) $("studioCurrent").textContent = state.studios.get(me);

  const registered = Boolean(state.status?.registered);
  $("studioNeedsBind").hidden = !state.account || registered;
}

/** Same rules as the contract, checked first so a mistake costs nothing. */
function checkStudioName(name, self) {
  if (!name) return "请填写社区名称。";
  if (new TextEncoder().encode(name).length > 48) return "名字太长了：最多 16 个汉字或 48 个英文字母。";
  for (const [address, taken] of state.studios) if (taken === name && address !== self) return "这个名字已经被别的工作室用了，换一个。";
  return null;
}

async function applyStudio() {
  if (!(await requireWallet())) return;
  const name = $("studioName").value.trim();
  const problem = checkStudioName(name, lower(state.account));
  if (problem) return note(problem, "warn");
  if (!state.status?.registered) return note("请先绑定推荐人，再申请成为工作室。", "warn");
  try {
    await send({ to: CONFIG.studio, data: Chain.encodeCall("register", name) }, "申请成为工作室");
    note(`申请成功：你的地址现在是工作室「${name}」，你网体下的所有地址都会显示这个名字。`, "ok");
    await loadStudios();
    await renderAll();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function renameStudio() {
  const name = $("studioRename").value.trim();
  const problem = checkStudioName(name, lower(state.account));
  if (problem) return note(problem, "warn");
  try {
    await send({ to: CONFIG.studio, data: Chain.encodeCall("rename", name) }, "修改社区名称");
    note("已改名。", "ok");
    await loadStudios();
    await renderAll();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function resignStudio() {
  if (!confirm("确定取消工作室吗？你网体下的地址将改为显示上一级工作室（如果有）。")) return;
  try {
    await send({ to: CONFIG.studio, data: Chain.encodeCall("resign") }, "取消工作室");
    note("已取消工作室。", "ok");
    await loadStudios();
    await renderAll();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

// ---------------------------------------------------------------- 交易

async function loadTaxes() {
  if (state.taxes) return state.taxes;
  const [buy, sell] = await Promise.all([readUint(CONFIG.token, "buyTaxBps"), readUint(CONFIG.token, "sellTaxBps")]);
  state.taxes = { buy: Number(buy), sell: Number(sell) };
  return state.taxes;
}

async function balanceOf(asset, who) {
  if (!who) return 0n;
  if (asset === "BNB") return BigInt(await rpc("eth_getBalance", [who, "latest"]));
  return readUint(asset === "USDT" ? CONFIG.usdt : CONFIG.token, "balanceOf", who);
}

/** Quotes the trade in the form, or null if there is nothing to quote. Same code the fork test runs. */
async function quote(side, asset, amountIn, slippageBps) {
  const taxes = await loadTaxes();
  return Chain.quoteTrade(read, CONFIG, { side, asset, amountIn, slippageBps, taxes });
}

function swapAmount() {
  return Chain.parseUnits($("swapAmount").value || "") ?? null;
}

async function refreshSwap() {
  const s = state.swap;
  const seq = ++s.seq;
  const payAsset = s.side === "buy" ? s.asset : "SUN";
  const getAsset = s.side === "buy" ? "SUN" : s.asset;
  const unit = (a) => (a === "SUN" ? "向日葵" : a);

  $("payUnit").textContent = unit(payAsset);
  $("getUnit").textContent = unit(getAsset);
  $("swapAssetLabel").textContent = s.side === "buy" ? "用什么买" : "卖成什么";
  for (const b of document.querySelectorAll("[data-side]")) b.classList.toggle("on", b.dataset.side === s.side);
  for (const b of document.querySelectorAll("[data-asset]")) b.classList.toggle("on", b.dataset.asset === s.asset);
  for (const b of document.querySelectorAll("[data-slip]")) b.classList.toggle("on", Number(b.dataset.slip) === s.slippageBps);

  const taxes = await loadTaxes().catch(() => null);
  if (taxes) $("swapTax").textContent = `${(s.side === "buy" ? taxes.buy : taxes.sell) / 100}%`;

  const [payBalance, getBalance] = await Promise.all([
    balanceOf(payAsset, state.account).catch(() => 0n),
    balanceOf(getAsset, state.account).catch(() => 0n),
  ]);
  if (seq !== s.seq) return; // a newer refresh has started; let it win
  $("payBalance").textContent = state.account ? (payAsset === "SUN" ? tokens(payBalance) : bnb(payBalance)) : "—";
  $("getBalance").textContent = state.account ? (getAsset === "SUN" ? tokens(getBalance) : bnb(getBalance)) : "—";
  s.payBalance = payBalance;

  const amount = swapAmount();
  s.quote = null;
  $("swapWarn").hidden = true;
  $("swapOut").textContent = "0";
  $("swapMin").textContent = "—";

  let label = s.side === "buy" ? "买入" : "卖出";
  let disabled = false;
  if (!state.account) label = "连接钱包";
  else if (!amount) [label, disabled] = ["输入数量", true];
  else if (amount > payBalance) [label, disabled] = [`${unit(payAsset)} 余额不足`, true];

  if (amount) {
    try {
      const q = await quote(s.side, s.asset, amount, s.slippageBps);
      if (seq !== s.seq) return;
      s.quote = q;
      const fmt = getAsset === "SUN" ? tokens : bnb;
      $("swapOut").textContent = fmt(q.expected);
      $("swapMin").textContent = `${fmt(q.min)} ${unit(getAsset)}`;
      if (q.preSale > 0n) {
        $("swapWarn").hidden = false;
        $("swapWarn").textContent =
          `这笔卖出可能先触发代币的税池换币（约 ${tokens(q.preSale)} 枚先卖进池子），价格会先下跌。` +
          "报价已按最坏情况计算，实际到账只会更多。";
      }
      if (q.expected === 0n) [label, disabled] = ["数量太小", true];
    } catch {
      [label, disabled] = ["报价失败，请重试", true];
    }
  }
  $("swapButton").textContent = label;
  $("swapButton").disabled = disabled;
}

let quoteTimer;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshSwap, 350);
}

async function setMax() {
  if (!state.account) return;
  const s = state.swap;
  const asset = s.side === "buy" ? s.asset : "SUN";
  let balance = await balanceOf(asset, state.account).catch(() => 0n);
  if (asset === "BNB") balance = balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n;
  $("swapAmount").value = Chain.formatUnits(balance, 18, 18).replace(/,/g, "");
  refreshSwap();
}

/** Approves exactly what this trade needs, if the router may not already move it. */
async function ensureAllowance(tokenAddress, amount, label) {
  const allowed = await readUint(tokenAddress, "allowance", state.account, CONFIG.router);
  if (allowed >= amount) return;
  await send({ to: tokenAddress, data: Chain.encodeCall("approve", CONFIG.router, amount) }, `授权${label}`);
}

async function executeSwap() {
  if (!(await requireWallet())) return;
  const s = state.swap;
  const amount = swapAmount();
  if (!amount) return note("请输入数量。", "warn");
  const button = $("swapButton");
  button.disabled = true;
  try {
    if (s.side === "sell") await ensureAllowance(CONFIG.token, amount, "向日葵");
    if (s.side === "buy" && s.asset === "USDT") await ensureAllowance(CONFIG.usdt, amount, " USDT");

    // Quote again right before sending: the floor must come from the price now, not when typed.
    const q = await quote(s.side, s.asset, amount, s.slippageBps);
    if (!q || q.min === 0n) throw new Error("报价失败，请重试。");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const tx = Chain.swapCall(CONFIG, { side: s.side, asset: s.asset, amountIn: amount, min: q.min, to: state.account, deadline });
    await send(tx, s.side === "buy" ? "买入" : "卖出");
    note(s.side === "buy" ? "买入成功。业绩会在下次数据更新时计入。" : "卖出成功。", "ok");
    $("swapAmount").value = "";
  } catch (error) {
    note(readableError(error), "warn");
  } finally {
    await refreshSwap();
  }
}

// ---------------------------------------------------------------- 团队

function renderTeam() {
  const target = isAddress($("lookupInput").value.trim()) ? $("lookupInput").value.trim() : state.account;
  state.view = target ? lower(target) : null;
  const report = state.report;
  $("teamAge").textContent = report ? "数据截至 " + new Date(report.generatedAt).toLocaleString("zh-CN") : "";

  const list = $("directList");
  const daily = $("dailyBody");
  list.innerHTML = "";
  daily.innerHTML = "";
  if (!state.view) {
    $("teamEmpty").hidden = false;
    $("teamEmpty").textContent = "连接钱包，或在上面输入一个地址查看。";
    for (const id of ["statDirects", "statTeam", "statTeamUsd", "statEligible"]) $(id).textContent = "—";
    return;
  }
  $("teamEmpty").hidden = true;

  const team = [state.view, ...downline(state.view)];
  const directs = state.index.children.get(state.view) ?? [];
  const viewRow = state.index.rows.get(state.view);

  // Directs, each with every purchase and where it stands against the 48-hour rule.
  let eligibleTotal = 0n;
  const entries = directs.map((address) => {
    const row = state.index.rows.get(address);
    const buys = (row?.buys ?? []).map((b) => ({ ...b, h: holding(b) }));
    const eligible = buys.reduce((sum, b) => sum + b.h.eligibleUsd, 0n);
    eligibleTotal += eligible;
    return { address, row, buys, eligible };
  });
  entries.sort((a, b) => (b.eligible > a.eligible ? 1 : b.eligible < a.eligible ? -1 : BigInt(b.row?.boughtUsd ?? 0) > BigInt(a.row?.boughtUsd ?? 0) ? 1 : -1));

  $("statDirects").textContent = directs.length;
  $("statTeam").textContent = team.length - 1;
  $("statTeamUsd").textContent = usd(viewRow?.teamUsd ?? team.reduce((s, a) => s + BigInt(state.index.rows.get(a)?.performanceUsd ?? 0), 0n));
  $("statEligible").textContent = usd(eligibleTotal);

  for (const entry of entries) list.appendChild(directCard(entry));
  $("directEmpty").hidden = entries.length > 0;

  // Daily new purchases across the whole team, Beijing days.
  const days = new Map();
  for (const address of team) {
    for (const buy of state.index.rows.get(address)?.buys ?? []) {
      const key = dayOf(buy.t);
      if (!days.has(key)) days.set(key, { usd: 0n, bnb: 0n, count: 0, buyers: new Set(), heldUsd: 0n });
      const d = days.get(key);
      d.usd += BigInt(buy.usd);
      d.bnb += BigInt(buy.bnb);
      d.count++;
      d.buyers.add(address);
      d.heldUsd += holding(buy).leftUsd;
    }
  }
  let totalUsd = 0n;
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const key = dayOf(state.index.asOf - i * 86400);
    const d = days.get(key);
    totalUsd += d?.usd ?? 0n;
    const tr = document.createElement("tr");
    if (!d) tr.className = "quiet";
    tr.innerHTML =
      `<td>${key.slice(5)}</td>` +
      `<td class="num">${d ? usd(d.usd) : "—"}</td>` +
      `<td class="num">${d ? usd(d.heldUsd) : "—"}</td>` +
      `<td class="num">${d ? `${d.count} 笔 · ${d.buyers.size} 人` : "—"}</td>`;
    daily.appendChild(tr);
  }
  $("dailyTotal").textContent = `近 ${DAYS_SHOWN} 天合计 ${usd(totalUsd)}`;
}

function studioTag(address) {
  const studio = studioAbove(address);
  return studio ? `<span class="tag">${esc(studio.name)}</span>` : "";
}

function directCard({ address, row, buys, eligible }) {
  const card = document.createElement("details");
  card.className = "direct";
  const held = BigInt(row?.heldTokens ?? 0);
  card.innerHTML =
    `<summary>` +
    `<div class="d-top"><a href="${CONFIG.explorer}/address/${address}" target="_blank" rel="noopener">${short(address)}</a>${studioTag(address)}</div>` +
    `<div class="d-stats">` +
    `<span>持仓 <b>${tokens(held)}</b></span>` +
    `<span>业绩 <b>${usd(row?.performanceUsd)}</b></span>` +
    `<span class="${eligible > 0n ? "ok" : ""}">满${HOLD_HOURS}h <b>${usd(eligible)}</b></span>` +
    `</div></summary>`;
  const body = document.createElement("div");
  body.className = "buys";
  if (!buys.length) {
    body.innerHTML = `<div class="empty small">没有买入记录${held > 0n ? "（持仓来自转入或空投）" : ""}</div>`;
  } else {
    for (const b of buys.slice().reverse()) {
      const line = document.createElement("div");
      line.className = "buy";
      line.innerHTML =
        `<div class="b-when"><a href="${CONFIG.explorer}/tx/${b.tx}" target="_blank" rel="noopener">${timeOf(b.t)}</a>${b.src === "mint" ? '<span class="tag soft">铸造</span>' : ""}</div>` +
        `<div class="b-money">${usd(b.usd)} <span class="muted">· ${bnb(b.bnb)} BNB</span></div>` +
        `<div class="b-qty">买入 ${tokens(b.amt)} · 剩 ${tokens(b.left)}</div>` +
        `<div class="b-state ${b.h.tone}">${b.h.label}</div>`;
      body.appendChild(line);
    }
  }
  card.appendChild(body);
  return card;
}

/** The directs and their purchases as a spreadsheet, for whoever works out the rewards. */
function exportCsv() {
  if (!state.view) return note("先连接钱包或输入要查看的地址。", "warn");
  const lines = [["直推地址", "所属工作室", "买入时间(北京)", "来源", "买入金额(USD)", "买入BNB", "买入数量", "剩余数量", "已持有小时", "48小时状态", "交易哈希"]];
  const plain = (wei, places) => Chain.formatUnits(BigInt(wei), 18, places).replace(/,/g, "");
  for (const address of state.index.children.get(state.view) ?? []) {
    const studio = studioAbove(address)?.name ?? "";
    for (const b of state.index.rows.get(address)?.buys ?? []) {
      const h = holding(b);
      lines.push([address, studio, timeOf(b.t), b.src === "mint" ? "铸造" : "买入", plain(b.usd, 2), plain(b.bnb, 6), plain(b.amt, 4), plain(b.left, 4), h.hours.toFixed(1), h.label, b.tx]);
    }
  }
  const csv = "﻿" + lines.map((cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `直推明细-${short(state.view).replace("…", "_")}-${dayOf(state.index.asOf)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------------------------------------------------------------- 排行

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  for (const [rank, r] of (state.report?.rows ?? []).slice(0, 50).entries()) {
    const tr = document.createElement("tr");
    if (lower(r.address) === lower(state.account)) tr.className = "mine";
    tr.innerHTML =
      `<td>${rank + 1}</td>` +
      `<td><a href="${CONFIG.explorer}/address/${r.address}" target="_blank" rel="noopener">${short(r.address)}</a>${studioTag(r.address)}</td>` +
      `<td class="num">${usd(r.performanceUsd)}</td>` +
      `<td class="num">${usd(r.teamUsd)}</td>` +
      `<td class="num">${tokens(r.heldTokens)}</td>`;
    board.appendChild(tr);
  }
  $("boardEmpty").hidden = Boolean(state.report?.rows?.length);
}

// ---------------------------------------------------------------- boot

async function renderAll() {
  await renderMe();
  renderBoard();
  if (!$("teamPanel").hidden) renderTeam();
  if (!$("tradePanel").hidden) refreshSwap();
}

async function boot() {
  // With an invite link the referrer is fixed; without one it falls back to the root, which anyone
  // can bind to from day one. The field stays editable then, so somebody who knows their referrer
  // can still type them in instead of joining under the project.
  const ref = new URLSearchParams(location.search).get("ref");
  if (isAddress(ref)) {
    $("referrerInput").value = ref;
    $("referrerInput").readOnly = true;
    $("refFromLink").hidden = false;
  } else {
    $("referrerInput").value = CONFIG.root;
    $("refDefault").hidden = false;
  }
  $("tokenLink").href = `${CONFIG.explorer}/token/${CONFIG.token}`;
  $("vaultLink").href = `${CONFIG.explorer}/address/${CONFIG.lendingVault}`;

  $("connect").addEventListener("click", connect);
  $("bindButton").addEventListener("click", bind);
  $("copyLink").addEventListener("click", copyLink);
  $("studioSubmit").addEventListener("click", applyStudio);
  $("studioRenameButton").addEventListener("click", renameStudio);
  $("studioResign").addEventListener("click", resignStudio);
  $("lookupButton").addEventListener("click", renderTeam);
  $("lookupInput").addEventListener("keydown", (e) => e.key === "Enter" && renderTeam());
  $("exportCsv").addEventListener("click", exportCsv);

  for (const b of document.querySelectorAll("[data-tab]")) {
    b.addEventListener("click", () => {
      history.replaceState(null, "", "#" + b.dataset.tab);
      showTab(b.dataset.tab);
    });
  }
  for (const b of document.querySelectorAll("[data-side]")) {
    b.addEventListener("click", () => {
      state.swap.side = b.dataset.side;
      $("swapAmount").value = "";
      refreshSwap();
    });
  }
  for (const b of document.querySelectorAll("[data-asset]")) {
    b.addEventListener("click", () => {
      state.swap.asset = b.dataset.asset;
      refreshSwap();
    });
  }
  for (const b of document.querySelectorAll("[data-slip]")) {
    b.addEventListener("click", () => {
      state.swap.slippageBps = Number(b.dataset.slip);
      refreshSwap();
    });
  }
  $("swapAmount").addEventListener("input", scheduleQuote);
  $("maxButton").addEventListener("click", setMax);
  $("swapButton").addEventListener("click", executeSwap);

  state.report = await loadReport();
  state.index = buildIndex(state.report);
  await loadStudios().catch(() => {});

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", (accounts) => {
      state.account = accounts[0] || null;
      renderAll();
    });
    window.ethereum.on?.("chainChanged", () => location.reload());
    const accounts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
    if (accounts[0]) state.account = accounts[0];
  }
  showTab(location.hash.slice(1));
  await renderAll();
}

document.addEventListener("DOMContentLoaded", boot);
