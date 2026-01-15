const treeBody = document.getElementById("treeBody");
const codePane = document.getElementById("codePane");
const codePath = document.getElementById("codePath");
const codeBadge = document.getElementById("codeBadge");
const editToggle = document.getElementById("editToggle");
const saveFile = document.getElementById("saveFile");
const viewToggle = document.getElementById("viewToggle");
const newFile = document.getElementById("newFile");
const newFolder = document.getElementById("newFolder");
const renamePath = document.getElementById("renamePath");
const deletePath = document.getElementById("deletePath");
const refreshTree = document.getElementById("refreshTree");
const chainList = document.getElementById("chainList");
const chainCount = document.getElementById("chainCount");
const modeButtons = Array.from(document.querySelectorAll(".mode-button"));
const createButton = document.getElementById("createChain");
const chainPrompt = document.getElementById("chainPrompt");
const replBody = document.getElementById("replBody");
const replStatus = document.getElementById("replStatus");
const replInput = document.getElementById("replInput");
const replSend = document.getElementById("replSend");
const stopCurrent = document.getElementById("stopCurrent");
const followAll = document.getElementById("followAll");
const metaContainer = document.getElementById("metaContainer");
const metaSession = document.getElementById("metaSession");
const workspace = document.getElementById("workspace");
const paneTree = document.getElementById("paneTree");
const paneEditor = document.getElementById("paneEditor");
const paneAgents = document.getElementById("paneAgents");
const paneRepl = document.getElementById("paneRepl");
const splitterTree = document.getElementById("splitterTree");
const splitterEditor = document.getElementById("splitterEditor");
const splitterHorizontal = document.getElementById("splitterHorizontal");
const appRoot = document.querySelector(".app");
const topbar = document.querySelector(".topbar");

let currentMode = "manual";
let selectedChainId = null;
let activeFilePath = "";
let selectedPath = "";
let selectedType = "";
let currentFile = null;
let editMode = false;
let isDirty = false;
let editorView = "file";
let latestChains = [];
let latestActiveChain = null;
let chainDetails = null;
let chainDetailsLoading = null;
const chainDetailsCache = new Map();
const treeCache = new Map();
const openFolders = new Set([""]);
let poller = null;
const dragState = {
  type: null,
  startX: 0,
  startY: 0,
  left: 0,
  middle: 0,
  right: 0,
  workspaceHeight: 0,
  replHeight: 0,
  availableHeight: 0,
};

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

const putJson = async (url, payload) => {
  return fetchJson(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const setWorkspaceColumns = (left, middle, right) => {
  if (!workspace) return;
  workspace.style.gridTemplateColumns = `${left}px 6px ${middle}px 6px ${right}px`;
};

const setWorkspaceRows = (workspaceHeight, replHeight) => {
  if (!appRoot) return;
  appRoot.style.gridTemplateRows = `auto ${workspaceHeight}px 6px ${replHeight}px`;
};

const setMode = (mode) => {
  currentMode = mode;
  modeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
};

const statusClassFor = (status) =>
  ({
    working: "live",
    queued: "pending",
    done: "done",
    failed: "failed",
  }[status || "queued"]);

const formatTimestamp = (value) => {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

const getPreferredChainId = () =>
  selectedChainId || latestActiveChain || (latestChains[0] && latestChains[0].id);

const getChainSummary = (chainId) =>
  latestChains.find((chain) => chain.id === chainId) || null;

const selectChainForDetails = (chainId) => {
  if (!chainId) return;
  selectedChainId = chainId;
  chainDetails = null;
  renderChains(latestChains, latestActiveChain);
  renderCode();
  refreshChainDetails();
};

const setEditorView = (view) => {
  editorView = view;
  if (viewToggle) {
    viewToggle.textContent = view === "file" ? "Chains" : "File";
  }
  if (view === "chain") {
    editMode = false;
    isDirty = false;
  }
  updateEditorControls();
  renderCode();
  if (view === "chain") {
    refreshChainDetails();
  }
};

const refreshChainDetails = async () => {
  if (editorView !== "chain") return;
  const chainId = getPreferredChainId();
  if (!chainId) {
    chainDetails = null;
    renderCode();
    return;
  }
  const cached = chainDetailsCache.get(chainId);
  if (cached && Date.now() - cached.fetchedAt < 1200) {
    chainDetails = cached.data;
    renderCode();
    return;
  }
  if (chainDetailsLoading === chainId) return;
  chainDetailsLoading = chainId;
  try {
    const data = await fetchJson(`/api/chains/${encodeURIComponent(chainId)}/details`);
    chainDetails = data;
    chainDetailsCache.set(chainId, { data, fetchedAt: Date.now() });
  } catch (err) {
    console.error(err);
  } finally {
    chainDetailsLoading = null;
    renderCode();
  }
};

const buildChainDetailContent = (chainId) => {
  const container = document.createElement("div");
  container.className = "chain-detail";
  if (!chainId) {
    const empty = document.createElement("div");
    empty.className = "chain-empty";
    empty.textContent = "No chain selected.";
    container.appendChild(empty);
    return { heading: "Chains", element: container };
  }

  const summary = getChainSummary(chainId);
  const title = summary?.title || chainDetails?.chain?.title || "Chain details";
  const displayId = summary?.displayId || chainDetails?.chain?.displayId || chainId;
  const heading = `${displayId} · ${title}`;

  if (!chainDetails || chainDetails.id !== chainId) {
    const loading = document.createElement("div");
    loading.className = "chain-empty";
    loading.textContent = "Loading chain details...";
    container.appendChild(loading);
    return { heading, element: container };
  }

  const detail = chainDetails;
  const summaryCard = document.createElement("div");
  summaryCard.className = "chain-summary";
  const summaryTitle = document.createElement("h3");
  summaryTitle.textContent = title;
  summaryCard.appendChild(summaryTitle);

  const metaLine = document.createElement("div");
  metaLine.className = "chain-meta-line";
  const idSpan = document.createElement("span");
  idSpan.textContent = `id: ${displayId}`;
  metaLine.appendChild(idSpan);
  const modeSpan = document.createElement("span");
  modeSpan.textContent = `mode: ${summary?.mode || detail.chain?.mode || "--"}`;
  metaLine.appendChild(modeSpan);
  const statusSpan = document.createElement("span");
  statusSpan.textContent = `status: ${summary?.status || detail.chain?.status || "--"}`;
  metaLine.appendChild(statusSpan);
  summaryCard.appendChild(metaLine);

  const statusLine = summary?.statusLine || detail.chain?.statusLine;
  if (statusLine) {
    const statusEl = document.createElement("div");
    statusEl.className = "chain-status";
    statusEl.textContent = statusLine;
    summaryCard.appendChild(statusEl);
  }

  container.appendChild(summaryCard);

  const runs = detail.runs || [];
  const runsWrap = document.createElement("div");
  runsWrap.className = "chain-runs";

  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "chain-empty";
    empty.textContent = "No runs yet for this chain.";
    runsWrap.appendChild(empty);
  } else {
    runs.forEach((run) => {
      const card = document.createElement("div");
      card.className = "chain-run";

      const header = document.createElement("div");
      header.className = "run-header";

      const runTitle = document.createElement("div");
      runTitle.className = "run-title";
      runTitle.textContent = run.id;

      const meta = document.createElement("div");
      meta.className = "run-meta";
      const status = document.createElement("span");
      status.className = `status ${statusClassFor(run.status)}`;
      status.textContent = run.status || "done";
      meta.appendChild(status);
      const time = formatTimestamp(run.created);
      if (time) {
        const timeEl = document.createElement("span");
        timeEl.textContent = time;
        meta.appendChild(timeEl);
      }

      header.appendChild(runTitle);
      header.appendChild(meta);
      card.appendChild(header);

      if (run.statusLine) {
        const line = document.createElement("div");
        line.className = "chain-status";
        line.textContent = run.statusLine;
        card.appendChild(line);
      }

      if (run.prompt) {
        const prompt = document.createElement("div");
        prompt.className = "run-prompt";
        prompt.textContent = run.prompt;
        card.appendChild(prompt);
      }

      if (run.output) {
        const label = document.createElement("div");
        label.className = "run-output-label";
        label.textContent = "Output";
        card.appendChild(label);
        const output = document.createElement("pre");
        output.className = "chain-output";
        output.textContent = run.output + (run.outputTruncated ? "\n…truncated" : "");
        card.appendChild(output);
      } else {
        const emptyOutput = document.createElement("div");
        emptyOutput.className = "run-output-label";
        emptyOutput.textContent = "No output yet.";
        card.appendChild(emptyOutput);
      }

      runsWrap.appendChild(card);
    });
  }

  container.appendChild(runsWrap);
  return { heading, element: container };
};

const renderChainDetails = () => {
  if (!codePane || !codePath) return;
  const chains = latestChains || [];
  const selectedId = chains.length ? getPreferredChainId() : null;

  const browser = document.createElement("div");
  browser.className = "chain-browser";

  const list = document.createElement("div");
  list.className = "chain-browser-list";

  if (!chains.length) {
    const empty = document.createElement("div");
    empty.className = "chain-empty";
    empty.textContent = "No chains yet. Create one to get started.";
    list.appendChild(empty);
  } else {
    chains.forEach((chain) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chain-item";
      if (chain.id === selectedId) {
        item.classList.add("active");
      }
      const statusClass = statusClassFor(chain.status);
      item.innerHTML = `
        <div class="chain-top">
          <span class="chain-id">${chain.displayId || "--"}</span>
          <span class="status ${statusClass}">${chain.status}</span>
        </div>
        <div class="chain-title">${chain.title || "untitled chain"}</div>
      `;
      item.addEventListener("click", () => {
        selectChainForDetails(chain.id);
      });
      list.appendChild(item);
    });
  }

  const detail = document.createElement("div");
  detail.className = "chain-browser-detail";
  if (!chains.length) {
    codePath.textContent = "Chains";
    const emptyDetail = document.createElement("div");
    emptyDetail.className = "chain-empty";
    emptyDetail.textContent = "No chain details to show yet.";
    detail.appendChild(emptyDetail);
  } else {
    const detailContent = buildChainDetailContent(selectedId);
    codePath.textContent = detailContent.heading;
    detail.appendChild(detailContent.element);
  }

  browser.appendChild(list);
  browser.appendChild(detail);
  codePane.appendChild(browser);
};

const renderChains = (chains, activeId) => {
  if (!chainList) return;
  chainList.innerHTML = "";
  latestChains = chains;
  latestActiveChain = activeId;

  const runningCount = chains.filter((chain) => chain.status === "working").length;
  if (chainCount) {
    chainCount.textContent = `${runningCount} running`;
  }

  if (!chains.length) {
    const empty = document.createElement("div");
    empty.className = "chain-item";
    empty.textContent = "No chains yet. Create one to get started.";
    chainList.appendChild(empty);
    return;
  }

  chains.forEach((chain) => {
    const item = document.createElement("button");
    item.className = "chain-item";
    item.dataset.chainId = chain.id;
    item.dataset.displayId = chain.displayId || "--";

    const statusClass = statusClassFor(chain.status);

    const scopeChip =
      chain.scope && chain.scope !== "workspace"
        ? `<span class="chip">${chain.scope}</span>`
        : "";

    item.innerHTML = `
      <div class="chain-top">
        <span class="chain-id">${chain.displayId || "--"}</span>
        <span class="status ${statusClass}">${chain.status}</span>
      </div>
      <div class="chain-title">${chain.title || "untitled chain"}</div>
      ${chain.statusLine ? `<div class="chain-status">${chain.statusLine}</div>` : ""}
      <div class="chain-meta">
        <span class="chip">${chain.mode}</span>
        ${scopeChip}
      </div>
    `;

    const shouldActivate =
      (selectedChainId && selectedChainId === chain.id) ||
      (!selectedChainId && activeId && activeId === chain.id);
    if (shouldActivate) {
      item.classList.add("active");
      selectedChainId = chain.id;
    }

    chainList.appendChild(item);
  });

  if (!selectedChainId && chains[0]) {
    selectedChainId = chains[0].id;
    chainList.firstChild.classList.add("active");
  }

  updateReplStatus(chains, activeId);
};

const updateReplStatus = (chains, activeId) => {
  if (!replStatus) return;
  let status = "";
  if (activeId) {
    const active = chains.find((chain) => chain.id === activeId);
    status = active?.statusLine || "";
  }
  if (!status) {
    const working = chains.find((chain) => chain.status === "working" && chain.statusLine);
    status = working?.statusLine || "";
  }
  replStatus.textContent = status ? `thinking: ${status}` : "thinking: idle";
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

const updateMeta = (meta) => {
  if (!meta) return;
  if (metaContainer) {
    metaContainer.textContent = `container: ${meta.container || "--"}`;
  }
  if (metaSession) {
    metaSession.textContent = `session: ${meta.session || "--"}`;
  }
};

const updateEditorControls = () => {
  if (!codeBadge || !editToggle || !saveFile) return;
  if (editorView === "chain") {
    codeBadge.textContent = "chain";
    editToggle.disabled = true;
    saveFile.disabled = true;
    editToggle.textContent = "Edit";
    return;
  }
  if (!currentFile) {
    codeBadge.textContent = "idle";
    editToggle.disabled = true;
    saveFile.disabled = true;
    editToggle.textContent = "Edit";
    return;
  }

  if (currentFile.truncated) {
    codeBadge.textContent = "truncated";
    editToggle.disabled = true;
    saveFile.disabled = true;
    editToggle.textContent = "Edit";
    return;
  }

  if (editMode) {
    codeBadge.textContent = isDirty ? "unsaved" : "editing";
    editToggle.textContent = "Preview";
    editToggle.disabled = false;
    saveFile.disabled = !isDirty;
  } else {
    codeBadge.textContent = "preview";
    editToggle.textContent = "Edit";
    editToggle.disabled = false;
    saveFile.disabled = true;
  }
};

const renderCode = () => {
  if (!codePane || !codePath) return;
  codePane.innerHTML = "";
  codePane.classList.toggle("chain-view", editorView === "chain");

  if (editorView === "chain") {
    renderChainDetails();
    return;
  }

  if (!currentFile) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.textContent = "Pick a file from the tree to view it here.";
    codePane.appendChild(empty);
    codePath.textContent = "Select a file";
    updateEditorControls();
    return;
  }

  codePath.textContent = currentFile.path || "Select a file";

  if (editMode) {
    const textarea = document.createElement("textarea");
    textarea.className = "code-textarea";
    textarea.value = currentFile.content || "";
    textarea.addEventListener("input", () => {
      isDirty = true;
      updateEditorControls();
    });
    codePane.appendChild(textarea);
    updateEditorControls();
    return;
  }

  if (!currentFile.content) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.textContent = "File is empty.";
    codePane.appendChild(empty);
    updateEditorControls();
    return;
  }

  if (currentFile.truncated) {
    const notice = document.createElement("div");
    notice.className = "code-empty";
    notice.textContent = "Showing first 200KB of file.";
    codePane.appendChild(notice);
  }

  const lines = currentFile.content.split(/\r?\n/);
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
  updateEditorControls();
};

const renderTree = () => {
  if (!treeBody) return;
  treeBody.innerHTML = "";

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
  if (entry.path === selectedPath) {
    button.classList.add("active");
  }

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.textContent = entry.type === "folder" ? ">" : "*";
  button.appendChild(icon);

  const label = document.createElement("span");
  label.textContent = entry.name;
  button.appendChild(label);
  node.appendChild(button);

  if (entry.type === "folder") {
    const isOpen = openFolders.has(entry.path);
    if (isOpen) {
      icon.textContent = "v";
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
    selectedPath = entry.path;
    selectedType = entry.type;
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
      currentFile = {
        path: data.path,
        content: data.content || "",
        truncated: data.truncated,
      };
      editMode = false;
      isDirty = false;
      renderCode();
      renderTree();
    } catch (err) {
      console.error(err);
    }
  });

  container.appendChild(node);
};

const refreshTreeState = async () => {
  try {
    treeCache.clear();
    const data = await fetchJson("/api/tree?depth=2");
    treeCache.set("", data.entries || []);
    const folders = Array.from(openFolders).filter((path) => path);
    for (const folder of folders) {
      try {
        const child = await fetchJson(
          `/api/tree?path=${encodeURIComponent(folder)}&depth=2`
        );
        treeCache.set(folder, child.entries || []);
      } catch (err) {
        console.error(err);
      }
    }
    renderTree();
  } catch (err) {
    console.error(err);
  }
};

const loadTreeRoot = async () => {
  await refreshTreeState();
};

const initSplitters = () => {
  if (!workspace || !paneTree || !paneEditor || !paneAgents) return;

  const updateFromCurrent = () => {
    const left = paneTree.getBoundingClientRect().width;
    const middle = paneEditor.getBoundingClientRect().width;
    const right = paneAgents.getBoundingClientRect().width;
    setWorkspaceColumns(left, middle, right);
  };

  updateFromCurrent();

  const startDrag = (type, event) => {
    dragState.type = type;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.left = paneTree.getBoundingClientRect().width;
    dragState.middle = paneEditor.getBoundingClientRect().width;
    dragState.right = paneAgents.getBoundingClientRect().width;
    if (paneRepl && workspace && appRoot && topbar) {
      dragState.workspaceHeight = workspace.getBoundingClientRect().height;
      dragState.replHeight = paneRepl.getBoundingClientRect().height;
      dragState.availableHeight =
        appRoot.clientHeight -
        topbar.getBoundingClientRect().height -
        splitterHorizontal.offsetHeight;
    }
    document.body.classList.add("resizing");
    if (type === "horizontal") {
      document.body.classList.add("resizing-horizontal");
    } else {
      document.body.classList.add("resizing-vertical");
    }
  };

  const stopDrag = () => {
    dragState.type = null;
    document.body.classList.remove("resizing");
    document.body.classList.remove("resizing-horizontal");
    document.body.classList.remove("resizing-vertical");
  };

  const onMove = (event) => {
    if (!dragState.type) return;
    if (dragState.type === "left") {
      const dx = event.clientX - dragState.startX;
      const minLeft = 180;
      const minMiddle = 260;
      const total = dragState.left + dragState.middle + dragState.right;
      const newLeft = clamp(dragState.left + dx, minLeft, total - dragState.right - minMiddle);
      const newMiddle = total - dragState.right - newLeft;
      setWorkspaceColumns(newLeft, newMiddle, dragState.right);
    } else if (dragState.type === "right") {
      const dx = event.clientX - dragState.startX;
      const minRight = 220;
      const minMiddle = 260;
      const total = dragState.left + dragState.middle + dragState.right;
      const newRight = clamp(
        dragState.right - dx,
        minRight,
        total - dragState.left - minMiddle
      );
      const newMiddle = total - dragState.left - newRight;
      setWorkspaceColumns(dragState.left, newMiddle, newRight);
    } else if (dragState.type === "horizontal") {
      const dy = event.clientY - dragState.startY;
      const minWorkspace = 240;
      const minRepl = 160;
      const available = dragState.availableHeight;
      if (available <= 0) return;
      const newWorkspace = clamp(
        dragState.workspaceHeight + dy,
        minWorkspace,
        available - minRepl
      );
      const newRepl = available - newWorkspace;
      setWorkspaceRows(newWorkspace, newRepl);
    }
  };

  splitterTree?.addEventListener("mousedown", (event) => {
    startDrag("left", event);
  });

  splitterEditor?.addEventListener("mousedown", (event) => {
    startDrag("right", event);
  });

  splitterHorizontal?.addEventListener("mousedown", (event) => {
    startDrag("horizontal", event);
  });

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stopDrag);
  window.addEventListener("mouseleave", stopDrag);
  window.addEventListener("resize", updateFromCurrent);
};

const handleState = (data) => {
  renderChains(data.chains || [], data.activeChain || null);
  renderRepl(data.repl || []);
  updateMeta(data.meta || {});
  if (editorView === "chain") {
    refreshChainDetails();
  }
};

const refreshState = async () => {
  try {
    const data = await fetchJson("/api/state");
    handleState(data);
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
      handleState(data);
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

const getParentPath = (path) => {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};

const resolveTargetFolder = () => {
  if (!selectedPath) return "";
  if (selectedType === "folder") return selectedPath;
  return getParentPath(selectedPath);
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
    if (editorView === "chain") {
      refreshChainDetails();
    }
  });
}

if (viewToggle) {
  viewToggle.addEventListener("click", () => {
    setEditorView(editorView === "file" ? "chain" : "file");
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

if (editToggle) {
  editToggle.addEventListener("click", () => {
    if (!currentFile || currentFile.truncated) return;
    editMode = !editMode;
    if (!editMode) {
      isDirty = false;
    }
    renderCode();
  });
}

if (saveFile) {
  saveFile.addEventListener("click", async () => {
    if (!currentFile || !editMode) return;
    const textarea = codePane?.querySelector("textarea");
    if (!textarea) return;
    try {
      await putJson("/api/file", {
        path: currentFile.path,
        content: textarea.value,
      });
      currentFile.content = textarea.value;
      editMode = false;
      isDirty = false;
      renderCode();
      await refreshTreeState();
    } catch (err) {
      console.error(err);
    }
  });
}

if (newFile) {
  newFile.addEventListener("click", async () => {
    const base = resolveTargetFolder();
    const name = window.prompt("New file name:");
    if (!name) return;
    const target = base ? `${base}/${name}` : name;
    try {
      await postJson("/api/fs/create-file", { path: target, content: "" });
      if (base) openFolders.add(base);
      selectedPath = target;
      selectedType = "file";
      activeFilePath = target;
      const data = await fetchJson(`/api/file?path=${encodeURIComponent(target)}`);
      currentFile = { path: data.path, content: data.content || "", truncated: data.truncated };
      editMode = true;
      isDirty = false;
      await refreshTreeState();
      renderCode();
    } catch (err) {
      console.error(err);
    }
  });
}

if (newFolder) {
  newFolder.addEventListener("click", async () => {
    const base = resolveTargetFolder();
    const name = window.prompt("New folder name:");
    if (!name) return;
    const target = base ? `${base}/${name}` : name;
    try {
      await postJson("/api/fs/create-folder", { path: target });
      selectedPath = target;
      selectedType = "folder";
      if (base) openFolders.add(base);
      openFolders.add(target);
      await refreshTreeState();
    } catch (err) {
      console.error(err);
    }
  });
}

if (renamePath) {
  renamePath.addEventListener("click", async () => {
    if (!selectedPath) return;
    const fromPath = selectedPath;
    const parent = getParentPath(selectedPath);
    const currentName = selectedPath.split("/").pop() || selectedPath;
    const nextName = window.prompt("Rename to:", currentName);
    if (!nextName || nextName === currentName) return;
    const target = parent ? `${parent}/${nextName}` : nextName;
    try {
      await postJson("/api/fs/rename", { from: fromPath, to: target });
      selectedPath = target;
      selectedType = selectedType || "file";
      if (activeFilePath === fromPath) {
        activeFilePath = target;
      }
      if (selectedType === "folder") {
        const updated = new Set();
        openFolders.forEach((folder) => {
          if (folder === fromPath) {
            updated.add(target);
          } else if (folder.startsWith(`${fromPath}/`)) {
            updated.add(folder.replace(fromPath, target));
          } else {
            updated.add(folder);
          }
        });
        openFolders.clear();
        updated.forEach((folder) => openFolders.add(folder));
      }
      await refreshTreeState();
      if (selectedType === "file") {
        const data = await fetchJson(`/api/file?path=${encodeURIComponent(target)}`);
        currentFile = { path: data.path, content: data.content || "", truncated: data.truncated };
        editMode = false;
        isDirty = false;
        renderCode();
      }
    } catch (err) {
      console.error(err);
    }
  });
}

if (deletePath) {
  deletePath.addEventListener("click", async () => {
    if (!selectedPath) return;
    const pathToDelete = selectedPath;
    const ok = window.confirm(`Delete ${selectedPath}?`);
    if (!ok) return;
    try {
      await postJson("/api/fs/delete", { path: pathToDelete });
      if (activeFilePath === pathToDelete) {
        activeFilePath = "";
        currentFile = null;
        editMode = false;
        isDirty = false;
        renderCode();
      }
      selectedPath = "";
      selectedType = "";
      if (pathToDelete) {
        openFolders.forEach((folder) => {
          if (folder === pathToDelete || folder.startsWith(`${pathToDelete}/`)) {
            openFolders.delete(folder);
          }
        });
      }
      await refreshTreeState();
    } catch (err) {
      console.error(err);
    }
  });
}

if (refreshTree) {
  refreshTree.addEventListener("click", async () => {
    await refreshTreeState();
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
setEditorView(editorView);
loadTreeRoot();
refreshState();
startStream();
if (!window.EventSource) {
  poller = setInterval(refreshState, 2000);
}
initSplitters();
