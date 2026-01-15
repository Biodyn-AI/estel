const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_OUTPUT_BYTES = 120 * 1024;

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

const parseTimestamp = (value) => {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
};

const readAliasMap = (queueDir, session) => {
  const key = (session || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  const aliasFile = path.join(queueDir, "chains", `aliases.${key}.tsv`);
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

const readTailFile = (filePath, maxBytes) => {
  if (!fs.existsSync(filePath)) return { text: "", truncated: false };
  const stat = fs.statSync(filePath);
  if (!stat.size) return { text: "", truncated: false };
  const readSize = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);
  const text = buffer.toString("utf8");
  return { text, truncated: stat.size > readSize };
};

const extractTokens = (text) => {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const inline = line.match(/tokens used[:\s]+([0-9][0-9,]*)/i);
    if (inline) {
      return Number(inline[1].replace(/,/g, "")) || 0;
    }
    if (line.toLowerCase().includes("tokens used")) {
      const next = lines[i + 1] || "";
      const match = next.match(/([0-9][0-9,]*)/);
      if (match) {
        return Number(match[1].replace(/,/g, "")) || 0;
      }
    }
  }
  return 0;
};

const runStatus = (queueDir, runId) => {
  if (fs.existsSync(path.join(queueDir, "working", `${runId}.json`))) return "working";
  if (fs.existsSync(path.join(queueDir, "inbox", `${runId}.json`))) return "queued";
  if (fs.existsSync(path.join(queueDir, "failed", `${runId}.md`))) return "failed";
  if (fs.existsSync(path.join(queueDir, "outbox", `${runId}.md`))) return "done";
  return "done";
};

const runFinishedAt = (queueDir, runId, status) => {
  if (status === "failed") {
    const file = path.join(queueDir, "failed", `${runId}.md`);
    if (fs.existsSync(file)) return fs.statSync(file).mtimeMs;
  }
  if (status === "done") {
    const file = path.join(queueDir, "outbox", `${runId}.md`);
    if (fs.existsSync(file)) return fs.statSync(file).mtimeMs;
  }
  return null;
};

const loadRunOutput = (queueDir, runId, maxOutputBytes) => {
  const runDir = path.join(queueDir, "runs", runId);
  const outputPath = path.join(runDir, "output.txt");
  const outboxPath = path.join(queueDir, "outbox", `${runId}.md`);
  const target = fs.existsSync(outputPath) ? outputPath : outboxPath;
  return readTailFile(target, maxOutputBytes);
};

const collectStats = (options = {}) => {
  const workspace = options.workspace || process.env.WORKSPACE || "/workspace";
  const queueDir = options.queueDir || process.env.QUEUE_DIR || path.join(workspace, "queue");
  const session = options.session || process.env.UI_SESSION || "webui";
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  const runsDir = path.join(queueDir, "runs");
  const aliasMap = readAliasMap(queueDir, session);
  const now = Date.now();

  const chainMap = new Map();
  const runStatusCounts = { queued: 0, working: 0, done: 0, failed: 0 };
  let tokensTotal = 0;
  let tokensRuns = 0;
  let durationTotalMs = 0;
  let durationRuns = 0;
  let durationMinMs = null;
  let durationMaxMs = null;

  safeReadDir(runsDir).forEach((runId) => {
    const taskPath = path.join(runsDir, runId, "task.json");
    const task = readJson(taskPath);
    if (!task) return;
    const status = runStatus(queueDir, runId);
    runStatusCounts[status] = (runStatusCounts[status] || 0) + 1;

    const manualChain = task.manual_chain || task.manualChain || "";
    const isAuto = task.chain || task.mode === "autonomous";
    const chainRef = task.chain || task.id || runId;
    const manualRef = manualChain || task.id || runId;
    const chainKey = isAuto ? chainRef : `manual:${manualRef}`;
    const chainId = isAuto ? chainRef : manualRef;
    const title = task.goal || task.prompt || task.task || "untitled chain";
    const mode = isAuto ? "auto" : "manual";
    const createdAt = parseTimestamp(task.created);
    const finishedAt = runFinishedAt(queueDir, runId, status);
    const durationMs = createdAt ? (finishedAt || now) - createdAt : null;

    if (durationMs !== null && durationMs >= 0) {
      durationTotalMs += durationMs;
      durationRuns += 1;
      durationMinMs = durationMinMs === null ? durationMs : Math.min(durationMinMs, durationMs);
      durationMaxMs = durationMaxMs === null ? durationMs : Math.max(durationMaxMs, durationMs);
    }

    const output = loadRunOutput(queueDir, runId, maxOutputBytes);
    const tokens = extractTokens(output.text);
    if (tokens > 0) {
      tokensTotal += tokens;
      tokensRuns += 1;
    }

    const chain = chainMap.get(chainKey) || {
      id: chainKey,
      chainId,
      title,
      mode,
      statusSet: new Set(),
      updatedAt: 0,
      runCount: 0,
      activeRuns: 0,
      queuedRuns: 0,
      workingRuns: 0,
      doneRuns: 0,
      failedRuns: 0,
      tokensTotal: 0,
      tokensRuns: 0,
      durationTotalMs: 0,
      durationRuns: 0,
    };

    chain.title = chain.title || title;
    chain.statusSet.add(status);
    chain.runCount += 1;
    if (status === "queued") chain.queuedRuns += 1;
    if (status === "working") chain.workingRuns += 1;
    if (status === "done") chain.doneRuns += 1;
    if (status === "failed") chain.failedRuns += 1;
    if (status === "queued" || status === "working") chain.activeRuns += 1;
    if (tokens > 0) {
      chain.tokensTotal += tokens;
      chain.tokensRuns += 1;
    }
    if (durationMs !== null && durationMs >= 0) {
      chain.durationTotalMs += durationMs;
      chain.durationRuns += 1;
    }

    const stat = fs.existsSync(taskPath) ? fs.statSync(taskPath) : null;
    const updatedAt = Math.max(createdAt || 0, finishedAt || 0, stat ? stat.mtimeMs : 0);
    chain.updatedAt = Math.max(chain.updatedAt, updatedAt);
    chainMap.set(chainKey, chain);
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
      title: entry.title,
      mode: entry.mode,
      status,
      updatedAt: entry.updatedAt,
      runCount: entry.runCount,
      activeRuns: entry.activeRuns,
      queuedRuns: entry.queuedRuns,
      workingRuns: entry.workingRuns,
      doneRuns: entry.doneRuns,
      failedRuns: entry.failedRuns,
      tokensTotal: entry.tokensTotal,
      tokensAvg: entry.tokensRuns ? Math.round(entry.tokensTotal / entry.tokensRuns) : 0,
      durationTotalMs: entry.durationTotalMs,
      durationAvgMs: entry.durationRuns
        ? Math.round(entry.durationTotalMs / entry.durationRuns)
        : 0,
    };
  });

  chains.sort((a, b) => b.updatedAt - a.updatedAt);

  const chainCount = chains.length;
  const activeChains = chains.filter(
    (chain) => chain.status === "working" || chain.status === "queued"
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      chainCount,
      activeChains,
      runCount: runStatusCounts.queued + runStatusCounts.working + runStatusCounts.done + runStatusCounts.failed,
      activeRuns: runStatusCounts.queued + runStatusCounts.working,
      queuedRuns: runStatusCounts.queued,
      workingRuns: runStatusCounts.working,
      doneRuns: runStatusCounts.done,
      failedRuns: runStatusCounts.failed,
      tokensTotal,
      tokensAvg: tokensRuns ? Math.round(tokensTotal / tokensRuns) : 0,
      tokensRuns,
      durationTotalMs,
      durationAvgMs: durationRuns ? Math.round(durationTotalMs / durationRuns) : 0,
      durationRuns,
      durationMinMs,
      durationMaxMs,
    },
    chains,
  };
};

const formatDuration = (ms) => {
  if (!ms && ms !== 0) return "--";
  const sec = Math.round(ms / 1000);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const formatNumber = (value) => {
  if (value === null || value === undefined) return "--";
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return value.toLocaleString();
};

const renderText = (stats, activeOnly) => {
  const totals = stats.totals || {};
  const chains = activeOnly
    ? stats.chains.filter((chain) => chain.status === "working" || chain.status === "queued")
    : stats.chains;
  const lines = [];
  lines.push(`AutoAgents statistics (${stats.generatedAt})`);
  lines.push(
    `Chains: ${formatNumber(totals.chainCount)} (active ${formatNumber(totals.activeChains)})`
  );
  lines.push(
    `Runs: ${formatNumber(totals.runCount)} (queued ${formatNumber(totals.queuedRuns)}, working ${formatNumber(
      totals.workingRuns
    )}, done ${formatNumber(totals.doneRuns)}, failed ${formatNumber(totals.failedRuns)})`
  );
  lines.push(
    `Tokens: ${formatNumber(totals.tokensTotal)} total (avg ${formatNumber(
      totals.tokensAvg
    )} over ${formatNumber(totals.tokensRuns)} runs)`
  );
  lines.push(
    `Duration: total ${formatDuration(totals.durationTotalMs)} (avg ${formatDuration(
      totals.durationAvgMs
    )} over ${formatNumber(totals.durationRuns)} runs)`
  );
  lines.push("");
  lines.push(activeOnly ? "Active chains:" : "Chains:");
  if (!chains.length) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  chains.forEach((chain) => {
    lines.push(
      `- ${chain.displayId} ${chain.title} | ${chain.mode} | ${chain.status} | runs ${formatNumber(
        chain.runCount
      )} (active ${formatNumber(chain.activeRuns)}) | tokens ${formatNumber(
        chain.tokensTotal
      )} | avg ${formatDuration(chain.durationAvgMs)}`
    );
  });
  return lines.join("\n");
};

const main = () => {
  const args = process.argv.slice(2);
  let format = "text";
  let session = process.env.UI_SESSION || "webui";
  let activeOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      format = "json";
    } else if (arg === "--session") {
      session = args[i + 1] || session;
      i += 1;
    } else if (arg === "--active-only") {
      activeOnly = true;
    }
  }
  const stats = collectStats({ session });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(stats, activeOnly)}\n`);
  }
};

if (require.main === module) {
  main();
}

module.exports = { collectStats };
