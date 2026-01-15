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
    };

    entry.statusSet.add(task.status || "queued");
    entry.updatedAt = Math.max(entry.updatedAt, task.updatedAt || 0);
    if (!entry.title && title) entry.title = title;
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

  if (req.method === "GET" && pathname === "/api/state") {
    const tasks = loadTasks();
    const chains = buildChains(tasks);
    const activeChain = loadActiveChainId(chains);
    const repl = loadReplLines();
    return sendJson(res, 200, { chains, activeChain, repl });
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
      return sendJson(res, 200, { id: alias, mode: "auto" });
    }
    const id = await runAgentctl([
      "submit",
      "--session",
      UI_SESSION,
      payload.prompt,
    ]);
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
    return sendJson(res, 200, { id });
  }

  if (req.method === "POST" && pathname === "/api/stop-current") {
    await runAgentctl(["chain-stop-current"]);
    return sendJson(res, 200, { status: "ok" });
  }

  const chainStopMatch = pathname.match(/^\/api\/chains\/([^/]+)\/stop$/);
  if (req.method === "POST" && chainStopMatch) {
    const id = chainStopMatch[1];
    await runAgentctl(["chain-stop", id]);
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
