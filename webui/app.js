const treeBody = document.getElementById("treeBody");
const codePane = document.getElementById("codePane");
const codePath = document.getElementById("codePath");
const codeBadge = document.getElementById("codeBadge");
const editToggle = document.getElementById("editToggle");
const saveFile = document.getElementById("saveFile");
const newFile = document.getElementById("newFile");
const newFolder = document.getElementById("newFolder");
const renamePath = document.getElementById("renamePath");
const deletePath = document.getElementById("deletePath");
const refreshTree = document.getElementById("refreshTree");
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
let selectedPath = "";
let selectedType = "";
let currentFile = null;
let editMode = false;
let isDirty = false;
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

const putJson = async (url, payload) => {
  return fetchJson(url, {
    method: "PUT",
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

const updateEditorControls = () => {
  if (!codeBadge || !editToggle || !saveFile) return;
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

  if (!currentFile) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.textContent = "Pick a file from the tree to view it here.";
    codePane.appendChild(empty);
    codePath.textContent = "Select a file";
    updateEditorControls();
    return;
  }

  codePath.textContent = `/workspace/${currentFile.path}`;

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
loadTreeRoot();
refreshState();
startStream();
if (!window.EventSource) {
  poller = setInterval(refreshState, 2000);
}
