const chainList = document.getElementById("chainList");
const activeChain = document.getElementById("activeChain");
const chainCount = document.getElementById("chainCount");
const modeButtons = Array.from(document.querySelectorAll(".mode-button"));
const createButton = document.getElementById("createChain");
const chainPrompt = document.getElementById("chainPrompt");
const replBody = document.getElementById("replBody");
const replInput = document.getElementById("replInput");
const replSend = document.getElementById("replSend");
const stopCurrent = document.getElementById("stopCurrent");
const followAll = document.getElementById("followAll");

let currentMode = "manual";
let selectedChainId = null;

const postJson = async (url, payload) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || "Request failed");
  }
  return res.json().catch(() => ({}));
};

const setMode = (mode) => {
  currentMode = mode;
  modeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
};

const renderChains = (chains, activeId) => {
  if (!chainList) return;
  chainList.innerHTML = "";

  const runningCount = chains.filter((chain) => chain.status === "working").length;
  if (chainCount) {
    chainCount.textContent = `${runningCount} running`;
  }

  if (!chains.length) {
    const empty = document.createElement("div");
    empty.className = "chain-item";
    empty.textContent = "No chains yet. Create one to get started.";
    chainList.appendChild(empty);
    if (activeChain) activeChain.textContent = "--";
    return;
  }

  let activeDisplay = "--";
  chains.forEach((chain) => {
    const item = document.createElement("button");
    item.className = "chain-item";
    item.dataset.chainId = chain.id;
    item.dataset.displayId = chain.displayId || "--";

    const statusClass = {
      working: "live",
      queued: "pending",
      done: "done",
      failed: "failed",
    }[chain.status || "queued"];

    item.innerHTML = `
      <div class="chain-top">
        <span class="chain-id">${chain.displayId || "--"}</span>
        <span class="status ${statusClass}">${chain.status}</span>
      </div>
      <div class="chain-title">${chain.title || "untitled chain"}</div>
      <div class="chain-meta">
        <span class="chip">${chain.mode}</span>
        <span class="chip">${chain.scope || "workspace"}</span>
      </div>
    `;

    const shouldActivate =
      (selectedChainId && selectedChainId === chain.id) ||
      (!selectedChainId && activeId && activeId === chain.id);
    if (shouldActivate) {
      item.classList.add("active");
      activeDisplay = chain.displayId || "--";
      selectedChainId = chain.id;
    }

    chainList.appendChild(item);
  });

  if (!selectedChainId && chains[0]) {
    selectedChainId = chains[0].id;
    activeDisplay = chains[0].displayId || "--";
    chainList.firstChild.classList.add("active");
  }

  if (activeChain) {
    activeChain.textContent = activeDisplay;
  }
};

const renderRepl = (lines) => {
  if (!replBody) return;
  replBody.innerHTML = "";
  if (!lines.length) {
    const empty = document.createElement("div");
    empty.className = "repl-line assistant";
    empty.textContent = "No REPL activity yet.";
    replBody.appendChild(empty);
    return;
  }
  lines.forEach((line) => {
    const entry = document.createElement("div");
    entry.className = `repl-line ${line.role || "assistant"}`;
    entry.textContent = line.text;
    replBody.appendChild(entry);
  });
  replBody.scrollTop = replBody.scrollHeight;
};

const refreshState = async () => {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) return;
    const data = await res.json();
    renderChains(data.chains || [], data.activeChain || null);
    renderRepl(data.repl || []);
  } catch (err) {
    console.error(err);
  }
};

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setMode(button.dataset.mode || "manual");
  });
});

if (chainList) {
  chainList.addEventListener("click", (event) => {
    const item = event.target.closest(".chain-item");
    if (!item || !item.dataset.chainId) return;
    selectedChainId = item.dataset.chainId;
    chainList.querySelectorAll(".chain-item").forEach((btn) => {
      btn.classList.toggle("active", btn === item);
    });
    if (activeChain) {
      activeChain.textContent = item.dataset.displayId || "--";
    }
  });
}

if (createButton) {
  createButton.addEventListener("click", async () => {
    const prompt = chainPrompt ? chainPrompt.value.trim() : "";
    if (!prompt) return;
    try {
      await postJson("/api/chains", { mode: currentMode, prompt });
      if (chainPrompt) chainPrompt.value = "";
      await refreshState();
    } catch (err) {
      console.error(err);
    }
  });
}

if (replSend) {
  replSend.addEventListener("click", async () => {
    const input = replInput ? replInput.value.trim() : "";
    if (!input) return;
    try {
      await postJson("/api/repl", { input });
      if (replInput) replInput.value = "";
      await refreshState();
    } catch (err) {
      console.error(err);
    }
  });
}

if (replInput) {
  replInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      replSend?.click();
    }
  });
}

if (stopCurrent) {
  stopCurrent.addEventListener("click", async () => {
    try {
      await postJson("/api/stop-current");
      await refreshState();
    } catch (err) {
      console.error(err);
    }
  });
}

if (followAll) {
  followAll.addEventListener("click", () => {
    followAll.textContent = "following...";
    setTimeout(() => {
      followAll.textContent = "follow all";
    }, 1200);
  });
}

setMode(currentMode);
refreshState();
setInterval(refreshState, 2000);
