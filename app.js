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
  // Filled in once deployed. Until then their panels say they are coming, and the admin tab never shows.
  console: "0x5ed189a962217090245D23517eCE03811cB71791", // SunflowerConsole: admins, studio approvals, reward bookkeeping
  staking: "0xb05C26c55134f249f4cB228c5Ec70189446561aD", // SunflowerStaking: the 100-day staking
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
  application: null, // my studio application waiting for approval: {name, at}
  isAdmin: false,
  rewardBps: 0,
  rewards: [], // the admin tab's rows, with their paid flags
};

// ---------------------------------------------------------------- formatting

function usd(value) {
  const n = Number(BigInt(value || 0) / 10n ** 14n) / 10_000;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Rounded to the cent rather than cut: the token's transfer dust leaves 1000 staked as
// 999.999999999999999998, which cut to two places reads as a lost hundredth.
const tokens = (value) => Chain.formatUnits(BigInt(value || 0) + 5n * 10n ** 15n, 18, 2);
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
    await loadConsole().catch(() => {});
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
    [/no application/i, "没有待审核的申请。"],
    [/not a studio/i, "这个地址不是工作室。"],
    [/not admin/i, "这个钱包不是管理员。"],
    [/already paid/i, "其中有已经标记过发放的记录，请刷新后重试。"],
    [/not paid/i, "其中有还没标记发放的记录，请刷新后重试。"],
    [/staking closed/i, "理财暂停中，暂时不能质押。"],
    [/bonus pool too small/i, "奖励池余额不足，暂时不能质押。"],
    [/amount too small/i, "数量低于最少质押额。"],
    [/nothing to claim/i, "现在没有可领取的。"],
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
  // When each member bound. Only purchases after it count, for the member and for any team.
  const bound = new Map(Object.entries(report?.bound ?? {}).map(([a, t]) => [lower(a), Number(t)]));
  return { rows, parent, children, asOf, bound };
}

/** A member's own performance: net buying since they bound. Nothing before binding counts. */
const perf = (row) => BigInt(row?.teamPerformanceUsd ?? 0);
/** Everyone's performance in the team at and below `address`, as the indexer added it up. */
function teamTotal(address) {
  const row = state.index.rows.get(lower(address));
  if (row?.teamUsd !== undefined) return BigInt(row.teamUsd);
  return [address, ...downline(address)].reduce((sum, a) => sum + perf(state.index.rows.get(lower(a))), 0n);
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

/**
 * How a single purchase stands, as of the report: whether it counts at all (only after binding),
 * how much of it still counts, and where it is against the 48-hour rule.
 */
function holding(buy) {
  const amt = BigInt(buy.amt);
  const counted = BigInt(buy.counted ?? 0);
  const left = BigInt(buy.teamLeft ?? 0);
  const usdOf = (tokens) => (amt > 0n ? (BigInt(buy.usd) * tokens) / amt : 0n);
  const hours = (state.index.asOf - buy.t) / 3600;
  let label;
  let tone;
  if (!buy.team) [label, tone] = ["绑定前", "pre"];
  else if (counted === 0n) [label, tone] = ["补回卖出", "pre"];
  else if (left === 0n) [label, tone] = ["已卖出", "out"];
  else if (hours >= HOLD_HOURS) [label, tone] = [left === counted ? `满${HOLD_HOURS}h` : `满${HOLD_HOURS}h·部分卖出`, "ok"];
  else [label, tone] = [`还差 ${Math.ceil(HOLD_HOURS - hours)}h`, "wait"];
  const leftUsd = usdOf(left);
  return { hours, counted, left, countedUsd: usdOf(counted), leftUsd, eligibleUsd: tone === "ok" ? leftUsd : 0n, label, tone };
}

/** Everything the console contract says about the page's visitor: approved studios, their own
 *  waiting application, and whether they are an admin. */
async function loadConsole() {
  state.studios = new Map();
  state.application = null;
  state.isAdmin = false;
  if (!CONFIG.console) return;
  const [accounts, names] = await read(CONFIG.console, "studios", [0n, 1000n], ["address[]", "string[]"]);
  accounts.forEach((a, i) => state.studios.set(lower(a), names[i]));
  if (!state.account) return;
  const [[name, at], [admin]] = await Promise.all([
    read(CONFIG.console, "applicationOf", [state.account], ["string", "uint256"]),
    read(CONFIG.console, "isAdmin", [state.account], ["bool"]),
  ]);
  state.application = name ? { name, at: Number(at) } : null;
  state.isAdmin = admin;
}

async function statusOf(account) {
  if (!CONFIG.registry || !account) return null;
  const [registered, upline, level, directs] = await read(CONFIG.registry, "statusOf", [account], ["bool", "address", "uint32", "uint32"]);
  return { registered, upline, level: Number(level), directs: Number(directs) };
}

// ---------------------------------------------------------------- tabs

const TABS = ["me", "trade", "stake", "team", "board", "admin"];

function showTab(name) {
  // The admin tab exists only for admins. Hiding it is a courtesy, not the protection: every admin
  // action is checked by the console contract, and what the tab shows is public on chain anyway.
  let tab = TABS.includes(name) ? name : "me";
  if (tab === "admin" && !state.isAdmin) tab = "me";
  $("adminTab").hidden = !state.isAdmin;
  for (const button of document.querySelectorAll("[data-tab]")) {
    const on = button.dataset.tab === tab;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", on);
  }
  for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== tab;
  if (tab === "team") renderTeam();
  if (tab === "trade") refreshSwap();
  if (tab === "stake") renderStake();
  if (tab === "admin") renderAdmin();
}

const currentTab = () => document.querySelector("[data-tab].on")?.dataset.tab ?? "me";

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
  $("personalUsd").textContent = usd(perf(row));
  $("teamUsd").textContent = state.account ? usd(teamTotal(state.account)) : usd(0);
  $("heldTokens").textContent = tokens(row?.heldTokens);
  $("stakedTokens").textContent = tokens(row?.staked);
  const boundAt = state.index.bound.get(lower(state.account));
  const reset = state.report?.countFrom;
  $("perfHint").textContent = !state.account
    ? reset
      ? `全部业绩已于 ${timeOf(reset)} 清零重新统计；只算绑定之后的买入`
      : "只算绑定之后的买入，按买入当时的美元价锁定"
    : boundAt !== undefined
      ? boundAt === reset
        ? `全部业绩已于 ${timeOf(reset)} 清零，从那时起重新统计`
        : `从 ${timeOf(boundAt)} 绑定起算，按买入当时的美元价锁定`
      : state.status?.registered
        ? "刚绑定，数据更新后开始计算"
        : "还没绑定：绑定之后的买入才计入业绩";
  $("lockedTokens").textContent = tokens(row?.locked);

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
  const ready = Boolean(CONFIG.console);
  $("studioPending").hidden = ready;
  $("studioBody").hidden = !ready;
  if (!ready) return;

  const me = lower(state.account);
  const isStudio = Boolean(me) && state.studios.has(me);
  const waiting = state.application;
  $("studioNeedsBind").hidden = !state.account || Boolean(state.status?.registered);
  $("studioApply").hidden = isStudio || Boolean(waiting);
  $("studioManage").hidden = !isStudio;
  $("studioRenameBox").hidden = Boolean(waiting);
  $("studioWaiting").hidden = !waiting;
  $("studioAddress").value = state.account || "请先连接钱包";
  if (isStudio) $("studioCurrent").textContent = state.studios.get(me);
  if (waiting) {
    $("studioWaitingKind").textContent = isStudio ? "改名申请" : "工作室申请";
    $("studioWaitingName").textContent = waiting.name;
    $("studioWaitingAt").textContent = timeOf(waiting.at);
  }
}

/** Same rules as the contract, checked first so a mistake costs nothing. */
function checkStudioName(name, self) {
  if (!name) return "请填写社区名称。";
  if (new TextEncoder().encode(name).length > 48) return "名字太长了：最多 16 个汉字或 48 个英文字母。";
  for (const [address, taken] of state.studios) if (taken === name && address !== self) return "这个名字已经被别的工作室用了，换一个。";
  return null;
}

async function consoleAction(data, label, done) {
  try {
    await send({ to: CONFIG.console, data }, label);
    note(done, "ok");
    await loadConsole();
    await renderAll();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function applyStudio() {
  if (!(await requireWallet())) return;
  if (!state.status?.registered) return note("请先绑定推荐人，再申请成为工作室。", "warn");
  const name = $("studioName").value.trim();
  const problem = checkStudioName(name, lower(state.account));
  if (problem) return note(problem, "warn");
  await consoleAction(
    Chain.encodeCall("applyForStudio", name),
    "申请成为工作室",
    "申请已提交，等管理员审核。通过后，你网体下的所有地址都会显示这个名字。"
  );
}

async function renameStudio() {
  const name = $("studioRename").value.trim();
  const problem = checkStudioName(name, lower(state.account));
  if (problem) return note(problem, "warn");
  await consoleAction(Chain.encodeCall("applyForStudio", name), "申请改名", "改名申请已提交，等管理员审核；审核前仍显示原名。");
}

async function withdrawStudioApplication() {
  await consoleAction(Chain.encodeCall("withdrawApplication"), "撤回申请", "申请已撤回。");
}

async function resignStudio() {
  if (!confirm("确定取消工作室吗？你网体下的地址将改为显示上一级工作室（如果有）。")) return;
  await consoleAction(Chain.encodeCall("resign"), "取消工作室", "已取消工作室。");
}

// ---------------------------------------------------------------- 理财

// The same constants as SunflowerStaking: 10% at once, then 1% a day for 100 days.
const BONUS_BPS = 1_000n;
const RELEASE_DAYS = 100n;

async function renderStake() {
  const ready = Boolean(CONFIG.staking);
  $("stakePending").hidden = ready;
  $("stakeBody").hidden = !ready;
  if (!ready) return;
  try {
    const one = async (name, ...args) => (await read(CONFIG.staking, name, args, ["uint256"]))[0];
    const [pool, [open], minStake, totalStaked, totalBonus] = await Promise.all([
      one("poolBalance"),
      read(CONFIG.staking, "open", [], ["bool"]),
      one("minStake"),
      one("totalStaked"),
      one("totalBonusPaid"),
    ]);
    state.stake = { pool, open, minStake, balance: 0n };
    $("stakePool").textContent = tokens(pool);
    $("stakeTotal").textContent = tokens(totalStaked);
    $("stakeBonusPaid").textContent = tokens(totalBonus);

    const list = $("stakeList");
    list.innerHTML = "";
    let locked = 0n;
    let claimable = 0n;
    if (state.account) {
      const [principal, claimed, start, released] = await read(
        CONFIG.staking, "positionsOf", [state.account], ["uint256[]", "uint256[]", "uint256[]", "uint256[]"]
      );
      state.stake.balance = await readUint(CONFIG.token, "balanceOf", state.account);
      // Days counted exactly as the contract counts them -- whole days of chain time since the
      // stake -- so the bar and "可领" can never disagree. Working back from released/principal
      // does not do: the transfer dust makes 3% of a stake come out as 2.999… days.
      const chainNow = parseInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp, 16);
      for (let i = principal.length - 1; i >= 0; i--) {
        locked += principal[i] - claimed[i];
        claimable += released[i] - claimed[i];
        const days = Math.min(100, Math.max(0, Math.floor((chainNow - Number(start[i])) / 86400)));
        const line = document.createElement("div");
        line.className = "position";
        line.innerHTML =
          `<div class="p-head"><span>${timeOf(Number(start[i]))} 质押</span><b>${tokens(principal[i])}</b></div>` +
          `<div class="bar"><i style="width:${days}%"></i></div>` +
          `<div class="p-foot"><span>已释放 ${days}/100 天</span><span>已领 ${tokens(claimed[i])} · 可领 <b>${tokens(released[i] - claimed[i])}</b></span></div>`;
        list.appendChild(line);
      }
    }
    $("stakeEmpty").hidden = list.childElementCount > 0;
    $("stakeLocked").textContent = tokens(locked);
    $("stakeClaimable").textContent = tokens(claimable);
    $("stakeClaim").disabled = claimable === 0n;
    $("stakeBalance").textContent = state.account ? tokens(state.stake.balance) : "—";
  } catch (error) {
    note("读取理财数据失败：" + readableError(error), "warn");
  }
  updateStakePreview();
}

function updateStakePreview() {
  const s = state.stake;
  const amount = Chain.parseUnits($("stakeAmount").value || "") ?? 0n;
  const bonus = (amount * BONUS_BPS) / 10_000n;
  $("stakeBonus").textContent = tokens(bonus);
  $("stakeDaily").textContent = tokens(amount / RELEASE_DAYS);
  let label = "质押";
  let disabled = false;
  if (!state.account) label = "连接钱包";
  else if (!s) [label, disabled] = ["读取中…", true];
  else if (!s.open) [label, disabled] = ["暂停质押", true];
  else if (amount === 0n) [label, disabled] = ["输入数量", true];
  else if (amount < s.minStake) [label, disabled] = [`最少 ${tokens(s.minStake)} 枚`, true];
  else if (amount > s.balance) [label, disabled] = ["余额不足", true];
  // Refused on chain too: a stake without its bonus is never accepted.
  else if (bonus > s.pool) [label, disabled] = ["奖励池不足，暂不能质押", true];
  $("stakeButton").textContent = label;
  $("stakeButton").disabled = disabled;
}

function setStakeMax() {
  if (!state.account || !state.stake) return;
  $("stakeAmount").value = Chain.formatUnits(state.stake.balance, 18, 18).replace(/,/g, "");
  updateStakePreview();
}

async function executeStake() {
  if (!(await requireWallet())) return;
  const amount = Chain.parseUnits($("stakeAmount").value || "");
  if (!amount) return note("请输入数量。", "warn");
  $("stakeButton").disabled = true;
  try {
    await ensureAllowance(CONFIG.token, amount, "向日葵", CONFIG.staking);
    await send({ to: CONFIG.staking, data: Chain.encodeCall("stake", amount) }, "质押");
    note("质押成功：10% 奖励已到账，本金从明天起每天释放 1%。", "ok");
    $("stakeAmount").value = "";
  } catch (error) {
    note(readableError(error), "warn");
  } finally {
    await renderStake();
  }
}

async function claimStake() {
  if (!(await requireWallet())) return;
  try {
    await send({ to: CONFIG.staking, data: Chain.encodeCall("claim") }, "领取释放");
    note("已领取。", "ok");
  } catch (error) {
    note(readableError(error), "warn");
  } finally {
    await renderStake();
  }
}

// ---------------------------------------------------------------- 管理

const rewardKey = (r) => r.tx + ":" + r.buyer;

/**
 * Every referral reward the 48-hour rule creates: one per purchase by a member with a referrer,
 * made after the member's counting started. What was sold within 48 hours earns nothing, and a
 * purchase sold entirely within them is not listed. The root is the project itself and is skipped.
 */
function rewardRows() {
  const rows = [];
  const root = lower(CONFIG.root);
  for (const [buyer, referrer] of state.index.parent) {
    if (referrer === root) continue;
    for (const b of state.index.rows.get(buyer)?.buys ?? []) {
      if (!b.team) continue;
      const counted = BigInt(b.counted);
      const early = BigInt(b.early ?? 0);
      const kept = counted > early ? counted - early : 0n;
      if (kept === 0n) continue;
      const keptUsd = (BigInt(b.usd) * kept) / BigInt(b.amt);
      const hours = (state.index.asOf - b.t) / 3600;
      rows.push({
        referrer, buyer, tx: b.tx, t: b.t, usd: BigInt(b.usd), keptUsd, hours,
        reward: (keptUsd * BigInt(state.rewardBps)) / 10_000n,
        matured: hours >= HOLD_HOURS,
        paid: false,
      });
    }
  }
  return rows.sort((a, b) => b.t - a.t);
}

async function loadRewardFlags(rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    const [flags] = await read(CONFIG.console, "paidMany", [slice.map((r) => r.tx), slice.map((r) => r.buyer)], ["bool[]"]);
    slice.forEach((r, k) => (r.paid = flags[k]));
  }
}

async function renderAdmin() {
  if (!state.isAdmin || !CONFIG.console) return;
  try {
    const [[admins], [owner], [bps], [accounts, names, at]] = await Promise.all([
      read(CONFIG.console, "admins", [], ["address[]"]),
      read(CONFIG.console, "owner", [], ["address"]),
      read(CONFIG.console, "rewardBps", [], ["uint256"]),
      read(CONFIG.console, "applications", [0n, 500n], ["address[]", "string[]", "uint256[]"]),
    ]);
    state.rewardBps = Number(bps);
    $("rewardRateNow").textContent = `${state.rewardBps / 100}%`;
    if (document.activeElement !== $("rewardRate")) $("rewardRate").value = String(state.rewardBps / 100);

    const everyone = [owner, ...admins.filter((a) => lower(a) !== lower(owner))].filter((a) => lower(a) !== lower(CONFIG.zero));
    $("adminList").innerHTML = everyone
      .map(
        (a) =>
          `<li><a class="mono" href="${CONFIG.explorer}/address/${a}" target="_blank" rel="noopener">${a}</a>` +
          (lower(a) === lower(owner) ? '<span class="tag soft">owner</span>' : "") +
          (lower(a) === lower(state.account) ? '<span class="tag">我</span>' : "") +
          `</li>`
      )
      .join("");

    const apps = $("appList");
    apps.innerHTML = "";
    accounts.forEach((a, i) => {
      const current = state.studios.get(lower(a));
      const row = document.createElement("div");
      row.className = "app-row";
      row.innerHTML =
        `<div class="app-name"><b>${esc(names[i])}</b>${current ? `<span class="muted small">改名，原名「${esc(current)}」</span>` : ""}</div>` +
        `<div class="muted small"><a class="mono" href="${CONFIG.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a> · ${timeOf(Number(at[i]))} 申请</div>` +
        `<div class="row2"><button class="btn primary small" data-approve="${a}">批准</button><button class="btn ghost small danger" data-reject="${a}">拒绝</button></div>`;
      apps.appendChild(row);
    });
    $("appEmpty").hidden = accounts.length > 0;

    const studios = $("studioAdminList");
    studios.innerHTML = "";
    for (const [a, name] of state.studios) {
      const row = document.createElement("div");
      row.className = "app-row";
      row.innerHTML =
        `<div class="app-name"><b>${esc(name)}</b><span class="muted small">网体 ${downline(a).length} 人</span></div>` +
        `<div class="muted small"><a class="mono" href="${CONFIG.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a></div>` +
        `<div><button class="btn ghost small danger" data-remove="${a}">移除</button></div>`;
      studios.appendChild(row);
    }
    $("studioAdminEmpty").hidden = state.studios.size > 0;

    state.rewards = rewardRows();
    await loadRewardFlags(state.rewards);
    state.selected = new Set();
    renderRewards();
  } catch (error) {
    note("读取后台数据失败：" + readableError(error), "warn");
  }
}

function rewardFilter() {
  const filter = document.querySelector("[data-rfilter].on")?.dataset.rfilter ?? "due";
  return { due: (r) => r.matured && !r.paid, waiting: (r) => !r.matured, paid: (r) => r.paid, all: () => true }[filter];
}

function renderRewards() {
  const total = (rows) => rows.reduce((sum, r) => sum + r.reward, 0n);
  const due = state.rewards.filter((r) => r.matured && !r.paid);
  const paid = state.rewards.filter((r) => r.paid);
  const waiting = state.rewards.filter((r) => !r.matured);
  $("rewardSummary").innerHTML =
    `待发放 <b>${due.length}</b> 笔 <b>${usd(total(due))}</b> · 已发放 ${paid.length} 笔 ${usd(total(paid))} · 未满48h ${waiting.length} 笔`;

  const box = $("rewardList");
  box.innerHTML = "";
  const rows = state.rewards.filter(rewardFilter());
  for (const r of rows) {
    const key = rewardKey(r);
    const status = r.paid ? ["已发放", "ok"] : r.matured ? ["待发放", "wait"] : [`还差 ${Math.ceil(HOLD_HOURS - r.hours)}h`, "pre"];
    const line = document.createElement("label");
    line.className = "reward";
    line.innerHTML =
      `<input type="checkbox" data-key="${key}"${state.selected.has(key) ? " checked" : ""}${r.matured ? "" : " disabled"}>` +
      `<div class="r-main">` +
      `<div class="r-who"><span class="muted">推荐人</span> <a class="mono" href="${CONFIG.explorer}/address/${r.referrer}" target="_blank" rel="noopener">${short(r.referrer)}</a>${studioTag(r.referrer)}` +
      ` <span class="muted">← 直推</span> <a class="mono" href="${CONFIG.explorer}/address/${r.buyer}" target="_blank" rel="noopener">${short(r.buyer)}</a></div>` +
      `<div class="r-what"><a href="${CONFIG.explorer}/tx/${r.tx}" target="_blank" rel="noopener">${timeOf(r.t)}</a> 买入 ${usd(r.usd)}` +
      (r.keptUsd < r.usd ? ` · 48h内卖出部分不计，计 ${usd(r.keptUsd)}` : "") +
      ` · 已持有 ${Math.floor(r.hours)}h</div>` +
      `</div>` +
      `<div class="r-side"><b>${usd(r.reward)}</b><span class="b-state ${status[1]}">${status[0]}</span></div>`;
    box.appendChild(line);
  }
  $("rewardEmpty").hidden = rows.length > 0;
  updateRewardSelection();
}

function updateRewardSelection() {
  const picked = state.rewards.filter((r) => state.selected.has(rewardKey(r)));
  const payable = picked.filter((r) => r.matured && !r.paid);
  const undo = picked.filter((r) => r.paid);
  $("markPaid").disabled = payable.length === 0;
  $("markPaid").textContent = payable.length ? `标记已发放（${payable.length} 笔 ${usd(payable.reduce((s, r) => s + r.reward, 0n))}）` : "标记已发放";
  $("unmarkPaid").hidden = undo.length === 0;
  $("unmarkPaid").textContent = `撤销已发放（${undo.length} 笔）`;
}

async function markRewards(paid) {
  const picked = state.rewards.filter((r) => state.selected.has(rewardKey(r)) && (paid ? r.matured && !r.paid : r.paid));
  if (!picked.length) return;
  if (paid && state.rewardBps === 0 && !confirm("奖励比例还是 0%，记录的发放金额会是 $0。确定继续吗？")) return;
  const data = paid
    ? Chain.encodeCall("markPaid", picked.map((r) => r.tx), picked.map((r) => r.buyer), picked.map((r) => r.reward))
    : Chain.encodeCall("unmarkPaid", picked.map((r) => r.tx), picked.map((r) => r.buyer));
  try {
    await send({ to: CONFIG.console, data }, paid ? `标记 ${picked.length} 笔已发放` : `撤销 ${picked.length} 笔`);
    note(paid ? "已记录为已发放。" : "已撤销。", "ok");
    await renderAdmin();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function saveRewardRate() {
  const percent = Number($("rewardRate").value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return note("奖励比例要在 0 到 100 之间。", "warn");
  const bps = Math.round(percent * 100);
  try {
    await send({ to: CONFIG.console, data: Chain.encodeCall("setRewardBps", BigInt(bps)) }, `设置奖励比例为 ${bps / 100}%`);
    note(`奖励比例已设为 ${bps / 100}%。`, "ok");
    await renderAdmin();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function adminClick(event) {
  const target = event.target.closest("[data-approve],[data-reject],[data-remove],[data-rfilter]");
  if (!target) return;
  if (target.dataset.rfilter) {
    for (const b of document.querySelectorAll("[data-rfilter]")) b.classList.toggle("on", b === target);
    state.selected = new Set();
    return renderRewards();
  }
  const [name, address, label] = target.dataset.approve
    ? ["approveStudio", target.dataset.approve, "批准工作室"]
    : target.dataset.reject
      ? ["rejectStudio", target.dataset.reject, "拒绝申请"]
      : ["removeStudio", target.dataset.remove, "移除工作室"];
  if (name === "removeStudio" && !confirm("确定移除这个工作室吗？它网体下的地址将改为显示上一级工作室（如果有）。")) return;
  try {
    await send({ to: CONFIG.console, data: Chain.encodeCall(name, address) }, label);
    note(`${label}：完成。`, "ok");
    await loadConsole();
    await renderAdmin();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

function exportRewards() {
  const rows = state.rewards.filter(rewardFilter());
  const plain = (wei, places) => Chain.formatUnits(BigInt(wei), 18, places).replace(/,/g, "");
  const lines = [["推荐人", "推荐人所属工作室", "被推荐人", "买入时间(北京)", "买入金额(USD)", "48h后仍持有部分(USD)", "已持有小时", "奖励比例", "奖励金额(USD)", "状态", "交易哈希"]];
  for (const r of rows) {
    lines.push([
      r.referrer, studioAbove(r.referrer)?.name ?? "", r.buyer, timeOf(r.t), plain(r.usd, 2), plain(r.keptUsd, 2),
      Math.floor(r.hours), `${state.rewardBps / 100}%`, plain(r.reward, 2),
      r.paid ? "已发放" : r.matured ? "待发放" : "未满48h", r.tx,
    ]);
  }
  const csv = "﻿" + lines.map((cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `48小时奖励-${dayOf(state.index.asOf)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function viewWholeNetwork() {
  $("lookupInput").value = CONFIG.root;
  history.replaceState(null, "", "#team");
  showTab("team");
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

/** Approves exactly what this action needs, if `spender` may not already move it. */
async function ensureAllowance(tokenAddress, amount, label, spender = CONFIG.router) {
  const allowed = await readUint(tokenAddress, "allowance", state.account, spender);
  if (allowed >= amount) return;
  await send({ to: tokenAddress, data: Chain.encodeCall("approve", spender, amount) }, `授权${label}`);
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
  $("networkTree").innerHTML = "";
  if (!state.view) {
    $("teamEmpty").hidden = false;
    $("teamEmpty").textContent = "连接钱包，或在上面输入一个地址查看。";
    for (const id of ["statDirects", "statTeam", "statTeamUsd", "statEligible"]) $(id).textContent = "—";
    $("dailyTotal").textContent = "";
    $("directEmpty").hidden = false;
    $("networkEmpty").hidden = false;
    return;
  }
  const inTree = state.index.bound.has(state.view) || state.index.parent.has(state.view) || state.index.children.has(state.view);
  $("teamEmpty").hidden = inTree;
  $("teamEmpty").textContent = inTree ? "" : "这个地址还没有绑定推荐人，不在网体里。";

  const team = [state.view, ...downline(state.view)];
  const directs = state.index.children.get(state.view) ?? [];
  const desc = (x, y) => (y > x ? 1 : y < x ? -1 : 0);

  // Directs, each with every purchase and where it stands: counted at all (after binding), still
  // held, and old enough for the 48-hour rule.
  let eligibleTotal = 0n;
  const entries = directs.map((address) => {
    const row = state.index.rows.get(address);
    const buys = (row?.buys ?? []).map((b) => ({ ...b, h: holding(b) }));
    const eligible = buys.reduce((sum, b) => sum + b.h.eligibleUsd, 0n);
    eligibleTotal += eligible;
    return { address, row, buys, eligible };
  });
  entries.sort((a, b) => desc(a.eligible, b.eligible) || desc(perf(a.row), perf(b.row)));

  $("statDirects").textContent = directs.length;
  $("statTeam").textContent = team.length - 1;
  $("statTeamUsd").textContent = usd(teamTotal(state.view));
  $("statEligible").textContent = usd(eligibleTotal);

  for (const entry of entries) list.appendChild(directCard(entry));
  $("directEmpty").hidden = entries.length > 0;

  // What each Beijing day added to the team. Only purchases after the buyer bound, and only the
  // part of each that was new: a purchase that made up for an earlier sale adds nothing.
  const days = new Map();
  for (const address of team) {
    for (const buy of state.index.rows.get(address)?.buys ?? []) {
      if (!buy.team) continue;
      const h = holding(buy);
      const key = dayOf(buy.t);
      if (!days.has(key)) days.set(key, { added: 0n, held: 0n, buyers: new Set(), buys: [] });
      const d = days.get(key);
      d.added += h.countedUsd;
      d.held += h.leftUsd;
      d.buyers.add(address);
      d.buys.push({ address, buy, h });
    }
  }
  // Each day opens onto who bought: the address, its studio, when, how much, and what still counts.
  let totalAdded = 0n;
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const key = dayOf(state.index.asOf - i * 86400);
    const d = days.get(key);
    totalAdded += d?.added ?? 0n;
    const day = document.createElement("details");
    day.className = "day" + (d ? "" : " quiet");
    day.innerHTML =
      `<summary><span class="day-date">${key.slice(5)}</span>` +
      `<span class="num">${d ? usd(d.added) : "—"}</span>` +
      `<span class="num">${d ? usd(d.held) : "—"}</span>` +
      `<span class="num">${d ? `${d.buys.length} 笔 · ${d.buyers.size} 人` : "—"}</span></summary>`;
    if (d) {
      const list = document.createElement("div");
      list.className = "day-buys";
      for (const { address, buy, h } of d.buys.sort((a, b) => b.buy.t - a.buy.t)) {
        const line = document.createElement("div");
        line.className = "day-buy";
        line.innerHTML =
          `<div class="d-top"><a href="${CONFIG.explorer}/address/${address}" target="_blank" rel="noopener">${short(address)}</a>${studioTag(address)}</div>` +
          `<div class="muted small"><a href="${CONFIG.explorer}/tx/${buy.tx}" target="_blank" rel="noopener">${timeOf(buy.t).slice(-5)}</a> 买入 ${usd(buy.usd)} · 计入 ${usd(h.countedUsd)}</div>`;
        list.appendChild(line);
      }
      day.appendChild(list);
    }
    daily.appendChild(day);
  }
  $("dailyTotal").textContent = `近 ${DAYS_SHOWN} 天新增合计 ${usd(totalAdded)} · 点开某一天看买入者`;

  renderNetwork();
}

// ---------------------------------------------------------------- 网体

const byTeamDesc = (addresses) =>
  addresses.slice().sort((a, b) => {
    const x = teamTotal(a);
    const y = teamTotal(b);
    return y > x ? 1 : y < x ? -1 : 0;
  });

/** The network below the viewed address. One level shows; each member opens onto their own. */
function renderNetwork() {
  const top = state.index.children.get(state.view) ?? [];
  $("networkEmpty").hidden = top.length > 0;
  for (const child of byTeamDesc(top)) $("networkTree").appendChild(networkNode(child, 1));
}

function networkNode(address, depth) {
  const kids = state.index.children.get(address) ?? [];
  const row = state.index.rows.get(address);
  const node = document.createElement("div");
  node.className = "node";
  const head = document.createElement("div");
  head.className = "node-head";
  // Indentation stops growing after a few levels, or a deep line would push off a phone screen.
  head.style.paddingLeft = `${Math.min(depth - 1, 6) * 12}px`;
  head.innerHTML =
    `<button class="toggle"${kids.length ? "" : " disabled"} aria-label="展开下级">${kids.length ? "▸" : "·"}</button>` +
    `<div class="node-main">` +
    `<div class="node-id"><span class="lvl">${depth}代</span><a href="#" data-view="${address}">${short(address)}</a>${studioTag(address)}</div>` +
    `<div class="node-stats">个人 <b>${usd(perf(row))}</b> · 团队 <b>${usd(teamTotal(address))}</b> · 下级 <b>${downline(address).length}</b> 人</div>` +
    `</div>`;
  node.appendChild(head);

  const childBox = document.createElement("div");
  childBox.className = "node-children";
  childBox.hidden = true;
  node.appendChild(childBox);

  const toggle = head.querySelector(".toggle");
  toggle.addEventListener("click", () => {
    if (!kids.length) return;
    if (!childBox.childElementCount) for (const kid of byTeamDesc(kids)) childBox.appendChild(networkNode(kid, depth + 1));
    childBox.hidden = !childBox.hidden;
    toggle.textContent = childBox.hidden ? "▸" : "▾";
  });
  // Tapping an address looks at the network from there, as if it had been typed into the search.
  head.querySelector("[data-view]").addEventListener("click", (event) => {
    event.preventDefault();
    $("lookupInput").value = address;
    renderTeam();
    $("teamPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  return node;
}

function studioTag(address) {
  const studio = studioAbove(address);
  return studio ? `<span class="tag">${esc(studio.name)}</span>` : "";
}

function directCard({ address, row, buys, eligible }) {
  const card = document.createElement("details");
  card.className = "direct";
  const held = BigInt(row?.heldTokens ?? 0);
  const boundAt = state.index.bound.get(address);
  card.innerHTML =
    `<summary>` +
    `<div class="d-top"><a href="${CONFIG.explorer}/address/${address}" target="_blank" rel="noopener">${short(address)}</a>${studioTag(address)}` +
    (boundAt !== undefined ? `<span class="d-bound">${timeOf(boundAt)} 绑定</span>` : "") +
    `</div>` +
    `<div class="d-stats">` +
    `<span>持仓 <b>${tokens(held)}</b></span>` +
    `<span>业绩 <b>${usd(perf(row))}</b></span>` +
    `<span class="${eligible > 0n ? "ok" : ""}">满${HOLD_HOURS}h <b>${usd(eligible)}</b></span>` +
    `</div></summary>`;
  const body = document.createElement("div");
  body.className = "buys";
  if (!buys.length) {
    body.innerHTML = `<div class="empty small">还没有买入记录${held > 0n ? "（持仓来自转入或空投，不算业绩）" : ""}</div>`;
  } else {
    for (const b of buys.slice().reverse()) {
      const line = document.createElement("div");
      line.className = "buy";
      line.innerHTML =
        `<div class="b-when"><a href="${CONFIG.explorer}/tx/${b.tx}" target="_blank" rel="noopener">${timeOf(b.t)}</a>${b.src === "mint" ? '<span class="tag soft">铸造</span>' : ""}</div>` +
        `<div class="b-money">${usd(b.usd)} <span class="muted">· ${bnb(b.bnb)} BNB</span></div>` +
        `<div class="b-qty">买入 ${tokens(b.amt)}${b.team ? ` · 计入 ${tokens(b.h.left)}` : ""}</div>` +
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
  const lines = [[
    "直推地址", "所属工作室", "绑定时间(北京)", "买入时间(北京)", "来源", "是否计入(绑定后)",
    "买入金额(USD)", "买入BNB", "买入数量", "计入数量", "仍计入数量", "已持有小时", "状态", "交易哈希",
  ]];
  const plain = (wei, places) => Chain.formatUnits(BigInt(wei), 18, places).replace(/,/g, "");
  for (const address of state.index.children.get(state.view) ?? []) {
    const studio = studioAbove(address)?.name ?? "";
    const boundAt = state.index.bound.get(address);
    for (const b of state.index.rows.get(address)?.buys ?? []) {
      const h = holding(b);
      lines.push([
        address, studio, boundAt !== undefined ? timeOf(boundAt) : "", timeOf(b.t), b.src === "mint" ? "铸造" : "买入",
        b.team ? "是" : "否", plain(b.usd, 2), plain(b.bnb, 6), plain(b.amt, 4), plain(h.counted, 4), plain(h.left, 4),
        h.hours.toFixed(1), h.label, b.tx,
      ]);
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
  // Only members with something counted: everyone else either never bound or has not bought since.
  const rows = (state.report?.rows ?? []).filter((r) => perf(r) > 0n || BigInt(r.teamUsd ?? 0) > 0n);
  const board = $("board");
  board.innerHTML = "";
  for (const [rank, r] of rows.slice(0, 50).entries()) {
    const tr = document.createElement("tr");
    if (lower(r.address) === lower(state.account)) tr.className = "mine";
    tr.innerHTML =
      `<td>${rank + 1}</td>` +
      `<td><a href="${CONFIG.explorer}/address/${r.address}" target="_blank" rel="noopener">${short(r.address)}</a>${studioTag(r.address)}</td>` +
      `<td class="num">${usd(perf(r))}</td>` +
      `<td class="num">${usd(BigInt(r.teamUsd ?? 0))}</td>` +
      `<td class="num">${tokens(r.heldTokens)}</td>`;
    board.appendChild(tr);
  }
  $("boardEmpty").hidden = rows.length > 0;
}

// ---------------------------------------------------------------- boot

async function renderAll() {
  await renderMe();
  renderBoard();
  // The admin tab appears or disappears with the wallet; re-show the current tab to settle that.
  showTab(currentTab());
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
  $("studioWithdraw").addEventListener("click", withdrawStudioApplication);
  $("lookupButton").addEventListener("click", renderTeam);
  $("lookupInput").addEventListener("keydown", (e) => e.key === "Enter" && renderTeam());
  $("exportCsv").addEventListener("click", exportCsv);

  $("stakeAmount").addEventListener("input", updateStakePreview);
  $("stakeMax").addEventListener("click", setStakeMax);
  $("stakeButton").addEventListener("click", executeStake);
  $("stakeClaim").addEventListener("click", claimStake);

  $("adminPanel").addEventListener("click", adminClick);
  $("rewardList").addEventListener("change", (event) => {
    const key = event.target.dataset?.key;
    if (!key) return;
    if (event.target.checked) state.selected.add(key);
    else state.selected.delete(key);
    updateRewardSelection();
  });
  $("rewardAll").addEventListener("click", () => {
    const visible = state.rewards.filter(rewardFilter()).filter((r) => r.matured);
    const all = visible.every((r) => state.selected.has(rewardKey(r)));
    for (const r of visible) all ? state.selected.delete(rewardKey(r)) : state.selected.add(rewardKey(r));
    renderRewards();
  });
  $("markPaid").addEventListener("click", () => markRewards(true));
  $("unmarkPaid").addEventListener("click", () => markRewards(false));
  $("saveRewardRate").addEventListener("click", saveRewardRate);
  $("exportRewards").addEventListener("click", exportRewards);
  $("viewWholeNetwork").addEventListener("click", viewWholeNetwork);

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

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", async (accounts) => {
      state.account = accounts[0] || null;
      await loadConsole().catch(() => {});
      renderAll();
    });
    window.ethereum.on?.("chainChanged", () => location.reload());
    const accounts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
    if (accounts[0]) state.account = accounts[0];
  }
  await loadConsole().catch(() => {});
  showTab(location.hash.slice(1));
  await renderAll();
}

document.addEventListener("DOMContentLoaded", boot);
