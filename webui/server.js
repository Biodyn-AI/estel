const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const QUEUE_DIR = process.env.QUEUE_DIR || path.join(WORKSPACE, "queue");
const LOG_FILE = process.env.LOG_FILE || path.join(WORKSPACE, "logs", "agentd.log");
const UI_SESSION = process.env.UI_SESSION || "webui";
const STATIC_DIR = path.join(WORKSPACE, "webui");
const PORT = Number(process.env.UI_PORT || process.env.PORT || 5177);
const TREE_SKIP = new Set([".git", "node_modules"]);
const MAX_FILE_BYTES = 200 * 1024;
const clients = new Set();

const STATUS_DIRS = {
  queued: "inbox",
  working: "working",
  done: "outbox",
  failed: "failed",
};

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { ...headers });
  res.end(data);
};

const sendJson = (res, status, payload) => {
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json" });
};

const readBody = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });

const safeReadDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const readStatusLine = (id) => {
  const file = path.join(QUEUE_DIR, "runs", id, "status.txt");
  if (!fs.existsSync(file)) return "";
  const content = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  return content[content.length - 1] || "";
};

const loadMeta = () => {
  const stopFile = path.join(QUEUE_DIR, "STOP");
  const status = fs.existsSync(stopFile) ? "paused" : "running";
  return {
    container: status,
    session: UI_SESSION,
  };
};

const resolveWorkspacePath = (requestedPath) => {
  const cleaned = requestedPath ? requestedPath.trim() : "";
  const resolved = cleaned
    ? path.resolve(cleaned.startsWith("/") ? cleaned : path.join(WORKSPACE, cleaned))
    : path.resolve(WORKSPACE);
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error("path outside workspace");
  }
  const relative = path.relative(WORKSPACE, resolved) || "";
  return { resolved, relative };
};

const readTree = (dirPath, depth) => {
  if (depth < 0) return [];
  const entries = safeReadDir(dirPath)
    .filter((name) => !TREE_SKIP.has(name))
    .filter((name) => !name.startsWith("._"))
    .map((name) => {
      const fullPath = path.join(dirPath, name);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return null;
      }
      const type = stat.isDirectory() ? "folder" : "file";
      const relative = path.relative(WORKSPACE, fullPath);
      return { name, type, path: relative, fullPath };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map((entry) => {
    if (entry.type === "folder" && depth > 0) {
      return {
        name: entry.name,
        type: entry.type,
        path: entry.path,
        entries: readTree(entry.fullPath, depth - 1),
      };
    }
    return {
      name: entry.name,
      type: entry.type,
      path: entry.path,
    };
  });
};

const getStatePayload = () => {
  const tasks = loadTasks();
  const chains = buildChains(tasks);
  const activeChain = loadActiveChainId(chains);
  const repl = loadReplLines();
  const meta = loadMeta();
  return { chains, activeChain, repl, meta };
};

const broadcast = (event, payload) => {
  const data = `event: ${event}\n` + `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((res) => {
    res.write(data);
  });
};

let lastStateSignature = "";
const broadcastStateIfChanged = () => {
  const payload = getStatePayload();
  const signature = JSON.stringify(payload);
  if (signature !== lastStateSignature) {
    lastStateSignature = signature;
    broadcast("state", payload);
  }
};

const readAliasMap = (session) => {
  const key = session.replace(/[^A-Za-z0-9._-]/g, "_");
  const aliasFile = path.join(QUEUE_DIR, "chains", `aliases.${key}.tsv`);
  const chainToAlias = new Map();
  if (!fs.existsSync(aliasFile)) return chainToAlias;
  const lines = fs.readFileSync(aliasFile, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    if (!line.trim()) return;
    const [alias, chainId] = line.split(/\t+/);
    if (alias && chainId) {
      chainToAlias.set(chainId.trim(), alias.trim());
    }
  });
  return chainToAlias;
};

const parseTimestamp = (value) => {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
};

const taskFromRun = (id, status, fallbackMtime) => {
  const taskPath = path.join(QUEUE_DIR, "runs", id, "task.json");
  const data = readJson(taskPath) || { id };
  const stat = fs.existsSync(taskPath)
    ? fs.statSync(taskPath)
    : { mtimeMs: fallbackMtime || 0 };
  return {
    ...data,
    status,
    updatedAt: parseTimestamp(data.created) || stat.mtimeMs,
  };
};

const loadTasks = () => {
  const tasks = [];
  Object.entries(STATUS_DIRS).forEach(([status, dir]) => {
    const targetDir = path.join(QUEUE_DIR, dir);
    safeReadDir(targetDir).forEach((file) => {
      if (status === "queued" || status === "working") {
        if (!file.endsWith(".json")) return;
        const data = readJson(path.join(targetDir, file));
        if (!data) return;
        if (status === "working") {
          data.statusLine = readStatusLine(data.id);
        }
        tasks.push({
          ...data,
          status,
          updatedAt:
            parseTimestamp(data.created) ||
            fs.statSync(path.join(targetDir, file)).mtimeMs,
        });
      } else if (file.endsWith(".md")) {
        const id = file.replace(/\.md$/, "");
        const filePath = path.join(targetDir, file);
        const mtime = fs.statSync(filePath).mtimeMs;
        tasks.push(taskFromRun(id, status, mtime));
      }
    });
  });
  return tasks;
};

const buildChains = (tasks) => {
  const aliasMap = readAliasMap(UI_SESSION);
  const chainMap = new Map();

  tasks.forEach((task) => {
    const isAuto = task.chain || task.mode === "autonomous";
    const mode = isAuto ? "auto" : "manual";
    const chainKey = task.chain || `manual:${task.id}`;
    const chainId = task.chain || task.id;
    const title =
      task.goal || task.prompt || task.task || "untitled chain";
    const entry = chainMap.get(chainKey) || {
      id: chainKey,
      chainId,
      displayId: "",
      mode,
      title,
      statusSet: new Set(),
      updatedAt: 0,
      scope: "workspace",
      statusLine: "",
    };

    entry.statusSet.add(task.status || "queued");
    entry.updatedAt = Math.max(entry.updatedAt, task.updatedAt || 0);
    if (!entry.title && title) entry.title = title;
    if (task.status === "working" && task.statusLine) {
      entry.statusLine = task.statusLine;
    }
    chainMap.set(chainKey, entry);
  });

  const chains = Array.from(chainMap.values()).map((entry) => {
    const statusPriority = ["working", "queued", "failed", "done"];
    const status =
      statusPriority.find((s) => entry.statusSet.has(s)) || "done";
    let displayId = entry.displayId;
    if (!displayId) {
      const alias = aliasMap.get(entry.chainId);
      if (alias) {
        displayId = alias.padStart(2, "0");
      } else if (entry.mode === "manual") {
        displayId = `M-${entry.chainId.slice(-4)}`;
      } else {
        displayId = entry.chainId.slice(-4);
      }
    }
    return {
      id: entry.id,
      chainId: entry.chainId,
      displayId,
      mode: entry.mode,
      title: entry.title,
      status,
      statusLine: entry.statusLine,
      scope: entry.scope,
      updatedAt: entry.updatedAt,
    };
  });

  chains.sort((a, b) => b.updatedAt - a.updatedAt);
  return chains;
};

const loadActiveChainId = (chains) => {
  const lastFile = path.join(QUEUE_DIR, "chains", "last_output");
  if (!fs.existsSync(lastFile)) return null;
  const raw = fs.readFileSync(lastFile, "utf8").trim();
  if (!raw) return null;
  const direct = chains.find((chain) => chain.chainId === raw);
  if (direct) return direct.id;
  const manual = chains.find((chain) => chain.id === `manual:${raw}`);
  return manual ? manual.id : null;
};

const parseSessionHistory = (content) => {
  const entries = [];
  const regex = /User:\n([\s\S]*?)\n\nAssistant:\n([\s\S]*?)(?:\n\n|$)/g;
  let match;
  while ((match = regex.exec(content))) {
    const user = match[1].trim();
    const assistant = match[2].trim();
    if (user) entries.push({ role: "user", text: user });
    if (assistant) entries.push({ role: "assistant", text: assistant });
  }
  return entries;
};

const tailLines = (filePath, maxLines = 120) => {
  if (!fs.existsSync(filePath)) return [];
  const stats = fs.statSync(filePath);
  const size = stats.size;
  const readSize = Math.min(size, 64 * 1024);
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, size - readSize);
  fs.closeSync(fd);
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).map((line) => ({ role: "assistant", text: line }));
};

const loadReplLines = () => {
  const sessionFile = path.join(QUEUE_DIR, "sessions", `${UI_SESSION}.md`);
  if (fs.existsSync(sessionFile)) {
    const content = fs.readFileSync(sessionFile, "utf8");
    const entries = parseSessionHistory(content);
    return entries.slice(-80);
  }
  return tailLines(LOG_FILE, 80);
};

const runAgentctl = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("agentctl", args, {
      env: { ...process.env, HOME: "/home/agent", USER: "agent" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout));
      } else {
        resolve(stdout.trim());
      }
    });
  });

const handleApi = async (req, res, pathname) => {
  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("\n");
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(getStatePayload())}\n\n`);
    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, getStatePayload());
  }

  if (req.method === "GET" && pathname === "/api/tree") {
    const query = url.parse(req.url, true).query;
    const depth = Math.min(Number(query.depth || 2), 5);
    const { resolved, relative } = resolveWorkspacePath(query.path || "");
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return sendJson(res, 404, { error: "directory not found" });
    }
    const entries = readTree(resolved, depth);
    return sendJson(res, 200, { path: relative, entries });
  }

  if (req.method === "GET" && pathname === "/api/file") {
    const query = url.parse(req.url, true).query;
    const { resolved, relative } = resolveWorkspacePath(query.path || "");
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return sendJson(res, 404, { error: "file not found" });
    }
    const stat = fs.statSync(resolved);
    let content = "";
    let truncated = false;
    if (stat.size > MAX_FILE_BYTES) {
      const fd = fs.openSync(resolved, "r");
      const buffer = Buffer.alloc(MAX_FILE_BYTES);
      fs.readSync(fd, buffer, 0, MAX_FILE_BYTES, 0);
      fs.closeSync(fd);
      content = buffer.toString("utf8");
      truncated = true;
    } else {
      content = fs.readFileSync(resolved, "utf8");
    }
    return sendJson(res, 200, { path: relative, content, truncated });
  }

  if (req.method === "POST" && pathname === "/api/chains") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid JSON payload" });
    }
    if (!payload.prompt) {
      return sendJson(res, 400, { error: "prompt required" });
    }
    if (payload.mode === "auto") {
      const alias = await runAgentctl([
        "start-autonomous",
        "--session",
        UI_SESSION,
        payload.prompt,
      ]);
      broadcastStateIfChanged();
      return sendJson(res, 200, { id: alias, mode: "auto" });
    }
    const id = await runAgentctl([
      "submit",
      "--session",
      UI_SESSION,
      payload.prompt,
    ]);
    broadcastStateIfChanged();
    return sendJson(res, 200, { id, mode: "manual" });
  }

  if (req.method === "POST" && pathname === "/api/repl") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid JSON payload" });
    }
    if (!payload.input) {
      return sendJson(res, 400, { error: "input required" });
    }
    const id = await runAgentctl([
      "submit",
      "--session",
      UI_SESSION,
      payload.input,
    ]);
    broadcastStateIfChanged();
    return sendJson(res, 200, { id });
  }

  if (req.method === "POST" && pathname === "/api/stop-current") {
    await runAgentctl(["chain-stop-current"]);
    broadcastStateIfChanged();
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "POST" && pathname === "/api/stop-all") {
    await runAgentctl(["chain-stop-all"]);
    broadcastStateIfChanged();
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "PUT" && pathname === "/api/file") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid JSON payload" });
    }
    if (!payload.path) {
      return sendJson(res, 400, { error: "path required" });
    }
    const { resolved, relative } = resolveWorkspacePath(payload.path);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return sendJson(res, 400, { error: "path is a directory" });
    }
    fs.writeFileSync(resolved, payload.content || "", "utf8");
    return sendJson(res, 200, { path: relative });
  }

  if (req.method === "POST" && pathname === "/api/fs/create-file") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid JSON payload" });
    }
    if (!payload.path) {
      return sendJson(res, 400, { error: "path required" });
    }
    const { resolved, relative } = resolveWorkspacePath(payload.path);
    if (fs.existsSync(resolved)) {
      return sendJson(res, 409, { error: "path already exists" });
    }
    const parent = path.dirname(resolved);
    if (!fs.existsSync(parent)) {
      return sendJson(res, 400, { error: "parent directory does not exist" });
    }
    fs.writeFileSync(resolved, payload.content || "", "utf8");
    return sendJson(res, 200, { path: relative });
  }

  if (req.method === "POST" && pathname === "/api/fs/create-folder") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid JSON payload" });
    }
    if (!payload.path) {
      return sendJson(res, 400, { error: "path required" });
    }
    const { resolved, relative } = resolveWorkspacePath(payload.path);
    if (fs.existsSync(resolved)) {
      return sendJson(res, 409, { error: "path already exists" });
    }
    fs.mkdirSync(resolved, { recursive: true });
    return sendJson(res, 200, { path: relative });
  }

  if (req.method === "POST" && pathname === "/api/fs/rename") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid JSON payload" });
    }
    if (!payload.from || !payload.to) {
      return sendJson(res, 400, { error: "from and to required" });
    }
    const from = resolveWorkspacePath(payload.from);
    const to = resolveWorkspacePath(payload.to);
    if (!fs.existsSync(from.resolved)) {
      return sendJson(res, 404, { error: "source not found" });
    }
    fs.renameSync(from.resolved, to.resolved);
    return sendJson(res, 200, { from: from.relative, to: to.relative });
  }

  if (req.method === "POST" && pathname === "/api/fs/delete") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid JSON payload" });
    }
    if (!payload.path) {
      return sendJson(res, 400, { error: "path required" });
    }
    const { resolved, relative } = resolveWorkspacePath(payload.path);
    if (resolved === WORKSPACE) {
      return sendJson(res, 400, { error: "refusing to delete workspace root" });
    }
    if (!fs.existsSync(resolved)) {
      return sendJson(res, 404, { error: "path not found" });
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    return sendJson(res, 200, { path: relative });
  }

  const chainStopMatch = pathname.match(/^\/api\/chains\/([^/]+)\/stop$/);
  if (req.method === "POST" && chainStopMatch) {
    const id = chainStopMatch[1];
    await runAgentctl(["chain-stop", id]);
    broadcastStateIfChanged();
    return sendJson(res, 200, { status: "ok" });
  }

  sendJson(res, 404, { error: "not found" });
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || "/";

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const filePath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(STATIC_DIR, safePath);
  if (!target.startsWith(STATIC_DIR)) {
    return send(res, 403, "Forbidden");
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    const ext = path.extname(target);
    send(res, 200, data, {
      "Content-Type": MIME_TYPES[ext] || "text/plain",
      "Cache-Control": "no-store",
    });
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Web UI running on http://localhost:${PORT}`);
});

setInterval(broadcastStateIfChanged, 1500);
setInterval(() => {
  clients.forEach((res) => {
    res.write(": ping\n\n");
  });
}, 15000);
