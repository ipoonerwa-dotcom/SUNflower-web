/* SUNFLOWER team DApp — binding on chain, performance from the indexer's report.json. */

const CONFIG = {
  chainIdHex: "0x38", // BNB Smart Chain
  chainName: "BNB Smart Chain",
  rpc: "https://bsc-dataseed.bnbchain.org",
  explorer: "https://bscscan.com",
  token: "0xfd06eeAdC43ee0687D5611d698Fb2Ee39f9BAAAa",
  lendingVault: "0xdda9d6c1738EA47e047b220a6FecC3cfC9d65cB6",
  // Filled in after ReferralRegistry is deployed. Until then the binding panel explains itself.
  registry: "0xFD58e05fFc519B3fd7E28FeD770845C19D696FAB",
  // The top of the tree, and the only address that is in it from birth. Whoever arrives without an
  // invite link joins here, so nobody is ever stuck with nobody to bind to. Must match the ROOT the
  // registry was deployed with -- the contract rejects anything that is not already in the tree.
  root: "0xa666EAE830201c62fe3E0c07Bd956e5D516CD419",
};

// The page loads no libraries, so calls are encoded by hand. Every selector below is the first
// four bytes of keccak256 of the signature beside it; `npm run selectors` recomputes and checks
// them, because a wrong selector here would not error -- it would quietly call nothing.
const SELECTOR = {
  statusOf: "0x97a5d5b5", // statusOf(address)
  bind: "0x81bac14f", // bind(address)
  memberCount: "0x11aee380", // memberCount()
  root: "0xebf0c717", // root()
  balanceOf: "0x70a08231", // balanceOf(address)
};

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const pad = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");

const state = { account: null, report: null, status: null };

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

const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

function usd(value) {
  const n = Number(BigInt(value || 0) / 10n ** 14n) / 10_000;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tokens(value) {
  const n = Number(BigInt(value || 0) / 10n ** 14n) / 10_000;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
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
    render();
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function ensureChain() {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current === CONFIG.chainIdHex) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CONFIG.chainIdHex }],
    });
  } catch (error) {
    if (error.code === 4902) {
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
    } else {
      throw error;
    }
  }
}

function readableError(error) {
  const message = String(error?.data?.message || error?.message || error);
  if (/user rejected|User denied/i.test(message)) return "你在钱包里取消了这次操作。";
  if (/already bound/i.test(message)) return "这个地址已经绑定过了，本人不能再改。如果绑错了，请联系官方更正。";
  if (/self referral/i.test(message)) return "不能绑定自己。";
  if (/referrer not in tree/i.test(message)) return "推荐人还没有加入，请他先完成绑定。";
  if (/insufficient funds/i.test(message)) return "BNB 余额不足以支付手续费。";
  return message.slice(0, 160);
}

function note(text, tone = "info") {
  const box = $("note");
  box.textContent = text;
  box.className = "note " + tone;
  box.hidden = !text;
}

// ---------------------------------------------------------------- chain reads

async function statusOf(account) {
  if (!CONFIG.registry || !account) return null;
  const raw = await ethCall(CONFIG.registry, SELECTOR.statusOf + pad(account));
  const at = (i) => "0x" + raw.slice(2).slice(i * 64, (i + 1) * 64);
  return {
    registered: BigInt(at(0)) === 1n,
    upline: "0x" + at(1).slice(-40),
    level: Number(BigInt(at(2))),
    directs: Number(BigInt(at(3))),
  };
}

const loadStatus = () => statusOf(state.account);

async function loadBalance() {
  if (!state.account) return 0n;
  const raw = await ethCall(CONFIG.token, SELECTOR.balanceOf + pad(state.account));
  return BigInt(raw);
}

async function loadReport() {
  try {
    const response = await fetch("report.json", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- actions

async function bind() {
  const referrer = $("referrerInput").value.trim();
  if (!isAddress(referrer)) return note("推荐人地址格式不对，应该是 0x 开头的 42 位地址。", "warn");
  if (!CONFIG.registry) return note("绑定合约还没有部署。", "warn");
  // Somebody who arrives by invite link sees the button before the connect prompt. Connect for
  // them rather than sending a transaction with no sender, which wallets reject unreadably.
  if (!state.account) {
    await connect();
    if (!state.account) return;
    const mine = await loadStatus().catch(() => null);
    if (mine?.registered) return note("这个钱包已经绑定过了。", "info");
  }
  if (referrer.toLowerCase() === state.account?.toLowerCase()) return note("不能绑定自己。", "warn");

  // Ask the chain before asking the wallet. The contract enforces all of this anyway, but finding
  // out by watching a transaction revert gives the member a raw error and, in some wallets, a fee.
  note("正在检查…", "info");
  const upline = await statusOf(referrer).catch(() => null);
  if (!upline) return note("读取链上状态失败，请检查网络后重试。", "warn");
  if (!upline.registered) {
    return note("这个推荐人还没有加入，请他先完成自己的绑定，你才能绑在他下面。", "warn");
  }

  note("请在钱包里确认这笔交易。绑定后本人不能再改，请确认推荐人地址无误。", "info");
  try {
    const hash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: state.account, to: CONFIG.registry, data: SELECTOR.bind + pad(referrer) }],
    });
    note("已提交，等待上链…  " + short(hash), "info");
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (!receipt) continue;
      if (receipt.status === "0x1") {
        note("绑定成功。", "ok");
        await render();
      } else {
        note("交易失败了，绑定没有生效。", "warn");
      }
      return;
    }
    note("等待超时，请到区块浏览器查看这笔交易。", "warn");
  } catch (error) {
    note(readableError(error), "warn");
  }
}

async function copyLink() {
  if (!state.account) return;
  const link = `${location.origin}${location.pathname}?ref=${state.account}`;
  try {
    await navigator.clipboard.writeText(link);
    note("推荐链接已复制。", "ok");
  } catch {
    note(link, "info");
  }
}

// ---------------------------------------------------------------- render

async function render() {
  $("connect").textContent = state.account ? short(state.account) : "连接钱包";
  $("connect").classList.toggle("connected", Boolean(state.account));

  if (!state.report) state.report = await loadReport();
  const report = state.report;

  $("reportAge").textContent = report
    ? "数据更新于 " + new Date(report.generatedAt).toLocaleString("zh-CN")
    : "业绩数据尚未生成";

  if (state.account) {
    state.status = await loadStatus().catch(() => null);
    const balance = await loadBalance().catch(() => 0n);
    $("myBalance").textContent = tokens(balance);
  }

  // binding panel
  const s = state.status;
  $("bindPanel").hidden = Boolean(s?.registered);
  $("boundPanel").hidden = !s?.registered;
  if (s?.registered) {
    $("myUpline").textContent = short(s.upline);
    $("myUpline").href = `${CONFIG.explorer}/address/${s.upline}`;
    $("myLevel").textContent = s.level;
    $("myDirects").textContent = s.directs;
  }
  if (!CONFIG.registry) {
    $("bindPanel").hidden = false;
    $("bindForm").hidden = true;
    $("bindPending").hidden = false;
  }

  // performance
  const row = report?.rows?.find((r) => r.address.toLowerCase() === state.account?.toLowerCase());
  $("personalUsd").textContent = usd(row?.performanceUsd);
  $("teamUsd").textContent = usd(row?.teamUsd);
  $("heldTokens").textContent = tokens(row?.heldTokens);
  $("stakedTokens").textContent = tokens(row?.staked);

  // leaderboard
  const board = $("board");
  board.innerHTML = "";
  for (const [rank, r] of (report?.rows ?? []).slice(0, 50).entries()) {
    const mine = r.address.toLowerCase() === state.account?.toLowerCase();
    const tr = document.createElement("tr");
    if (mine) tr.className = "mine";
    tr.innerHTML =
      `<td>${rank + 1}</td>` +
      `<td><a href="${CONFIG.explorer}/address/${r.address}" target="_blank" rel="noopener">${short(r.address)}</a></td>` +
      `<td class="num">${usd(r.performanceUsd)}</td>` +
      `<td class="num">${usd(r.teamUsd)}</td>` +
      `<td class="num">${tokens(r.heldTokens)}</td>`;
    board.appendChild(tr);
  }
  $("boardEmpty").hidden = Boolean(report?.rows?.length);
}

// ---------------------------------------------------------------- boot

function boot() {
  // With an invite link the referrer is fixed; without one it falls back to the root, which anyone
  // can bind to from day one. The field stays editable in that case, so somebody who knows their
  // referrer's address can still type it instead of joining under the project.
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

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", (accounts) => {
      state.account = accounts[0] || null;
      render();
    });
    window.ethereum.on?.("chainChanged", () => location.reload());
    window.ethereum.request({ method: "eth_accounts" }).then((accounts) => {
      if (accounts[0]) state.account = accounts[0];
      render();
    });
  } else {
    render();
  }
}

document.addEventListener("DOMContentLoaded", boot);
