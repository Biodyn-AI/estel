const treeBody = document.getElementById("treeBody");
const codePane = document.getElementById("codePane");
const codePath = document.getElementById("codePath");
const codeBadge = document.getElementById("codeBadge");
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
let activeFilePath = "";
const treeCache = new Map();
const openFolders = new Set([""]);
let poller = null;

const fetchJson = async (url, options = {}) => {
  const res = await fetch(url, options);
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || "Request failed");
  }
  return res.json();
};

const postJson = async (url, payload) => {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
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

const renderCode = (content, filePath, truncated) => {
  if (!codePane || !codePath || !codeBadge) return;
  codePath.textContent = filePath ? `/workspace/${filePath}` : "Select a file";
  codeBadge.textContent = truncated ? "truncated" : "preview";

  codePane.innerHTML = "";
  if (!content) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.textContent = "File is empty.";
    codePane.appendChild(empty);
    return;
  }

  if (truncated) {
    const notice = document.createElement("div");
    notice.className = "code-empty";
    notice.textContent = "Showing first 200KB of file.";
    codePane.appendChild(notice);
  }

  const lines = content.split(/\r?\n/);
  const wrapper = document.createElement("div");
  wrapper.className = "code-lines";
  lines.forEach((line, idx) => {
    const lineEl = document.createElement("div");
    lineEl.className = "line";
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = String(idx + 1);
    const text = document.createElement("span");
    text.className = "code-text";
    text.textContent = line;
    lineEl.appendChild(ln);
    lineEl.appendChild(text);
    wrapper.appendChild(lineEl);
  });
  codePane.appendChild(wrapper);
};

const renderTree = () => {
  if (!treeBody) return;
  treeBody.innerHTML = "";

  const rootLabel = document.createElement("div");
  rootLabel.className = "tree-root";
  rootLabel.textContent = "/workspace";
  treeBody.appendChild(rootLabel);

  const container = document.createElement("div");
  container.className = "tree-children";
  treeBody.appendChild(container);
  const entries = treeCache.get("") || [];
  entries.forEach((entry) => appendTreeNode(entry, container));
};

const appendTreeNode = (entry, container) => {
  const node = document.createElement("div");
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tree-item ${entry.type}`;
  button.dataset.path = entry.path;
  button.dataset.type = entry.type;
  if (entry.type === "file" && entry.path === activeFilePath) {
    button.classList.add("active");
  }

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.textContent = entry.type === "folder" ? "▸" : "•";
  button.appendChild(icon);

  const label = document.createElement("span");
  label.textContent = entry.name;
  button.appendChild(label);
  node.appendChild(button);

  if (entry.type === "folder") {
    const isOpen = openFolders.has(entry.path);
    if (isOpen) {
      icon.textContent = "▾";
      const childContainer = document.createElement("div");
      childContainer.className = "tree-children";
      const children = treeCache.get(entry.path) || entry.entries || [];
      if (children.length) {
        children.forEach((child) => appendTreeNode(child, childContainer));
      } else {
        const empty = document.createElement("div");
        empty.className = "tree-item file";
        empty.textContent = "empty";
        childContainer.appendChild(empty);
      }
      node.appendChild(childContainer);
    }
  }

  button.addEventListener("click", async () => {
    if (entry.type === "folder") {
      if (openFolders.has(entry.path)) {
        openFolders.delete(entry.path);
        renderTree();
        return;
      }
      openFolders.add(entry.path);
      if (!treeCache.has(entry.path)) {
        try {
          const data = await fetchJson(
            `/api/tree?path=${encodeURIComponent(entry.path)}&depth=2`
          );
          treeCache.set(entry.path, data.entries || []);
        } catch (err) {
          console.error(err);
        }
      }
      renderTree();
      return;
    }

    activeFilePath = entry.path;
    try {
      const data = await fetchJson(`/api/file?path=${encodeURIComponent(entry.path)}`);
      renderCode(data.content, data.path, data.truncated);
      renderTree();
    } catch (err) {
      console.error(err);
    }
  });

  container.appendChild(node);
};

const loadTreeRoot = async () => {
  try {
    const data = await fetchJson("/api/tree?depth=2");
    treeCache.set("", data.entries || []);
    renderTree();
  } catch (err) {
    console.error(err);
  }
};

const refreshState = async () => {
  try {
    const data = await fetchJson("/api/state");
    renderChains(data.chains || [], data.activeChain || null);
    renderRepl(data.repl || []);
  } catch (err) {
    console.error(err);
  }
};

const startStream = () => {
  if (!window.EventSource) {
    return;
  }
  const stream = new EventSource("/api/stream");
  stream.addEventListener("state", (event) => {
    try {
      const data = JSON.parse(event.data);
      renderChains(data.chains || [], data.activeChain || null);
      renderRepl(data.repl || []);
    } catch (err) {
      console.error(err);
    }
  });
  stream.onerror = () => {
    stream.close();
    if (!poller) {
      poller = setInterval(refreshState, 2000);
    }
  };
};

const sendReplInput = async (input) => {
  if (!input) return;
  const trimmed = input.trim();
  if (!trimmed) return;

  if (trimmed.startsWith("/auto")) {
    const prompt = trimmed.replace(/^\/auto\s*/, "");
    if (prompt) {
      await postJson("/api/chains", { mode: "auto", prompt });
      return;
    }
  }

  if (trimmed === "/stop-current") {
    await postJson("/api/stop-current");
    return;
  }

  if (trimmed === "/stop") {
    await postJson("/api/stop-all");
    return;
  }

  await postJson("/api/repl", { input: trimmed });
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
      await sendReplInput(input);
      if (replInput) replInput.value = "";
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
loadTreeRoot();
refreshState();
startStream();
if (!window.EventSource) {
  poller = setInterval(refreshState, 2000);
}
