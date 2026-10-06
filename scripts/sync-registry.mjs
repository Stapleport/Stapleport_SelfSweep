#!/usr/bin/env node
// Sync registry.json from the canonical hardhat deployments (single source of truth:
// Stapleport_hardhat/deployments/all.json), preserving this repo's own archive shape.
// Absorbed into push-registry (2026-10-05): `npm run sync-registry` (no args) is what
// HH/scripts/tool/push-registry.js invokes on the deploy tail (tier: dev — the archive
// currently covers the 31337 sandbox chain only).
//
// Key mapping (all.json -> registry.json), kept explicit on purpose:
//   contracts.<name>.abi          <- all[chainId][name].abi   (first archive chain that has it)
//   chains.<chainId>.meta         <- { name, rpc: network.url, explorer: network.explorer ?? null }
//   chains.<chainId>.<name>       <- all[chainId][name].address
//
// Shape-specific rules (the archive's specificity is the point — do not "collect-ify"):
//   - Chain set = exactly the chains already in registry.json. A registry chain is a
//     sweep-enabled chain (src/sweep.js resolveChain), so chains are NEVER auto-added;
//     new all.json chains are only reported as a notice.
//   - Contract keys per chain = exactly the keys already archived. Keys with no
//     counterpart in all.json keep their previous value and are listed as notices
//     for manual review (e.g. SwapFactory/SwapRouter/WETH9 on 31337).
//   - Hard failure (before any write) if an archived chain is missing from all.json
//     entirely — that means wrong source path or total drift, not a per-key gap.
//
// Usage:
//   node scripts/sync-registry.mjs                 # sync from canonical all.json (idempotent)
//   HARDHAT_ALL_JSON=/path/to/all.json node ...    # explicit source override (tests/rehearsal)
//   node scripts/sync-registry.mjs --from <path>   # explicit atomic overwrite from a snapshot

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TARGET = resolve(ROOT, "registry.json");

// 本仓在总库根两层深处：scripts 上跳三级 = 总库根（同 HelperWorker worker 侧口径）
function allJsonPath() {
  return (
    process.env.HARDHAT_ALL_JSON ??
    join(here, "..", "..", "..", "Stapleport_hardhat", "deployments", "all.json")
  );
}

function notice(msg) {
  console.error(`notice: ${msg}`);
}

function flatLeaves(value, prefix = "") {
  const out = new Map();
  if (Array.isArray(value) || typeof value !== "object" || value === null) {
    out.set(prefix, JSON.stringify(value));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [pk, pv] of flatLeaves(v, p)) out.set(pk, pv);
    } else {
      out.set(p, JSON.stringify(v));
    }
  }
  return out;
}

function diffSummary(current, next) {
  const a = flatLeaves(current);
  const b = flatLeaves(next);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  return { added, removed, changed };
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${label} (${path}): ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} (${path}) is not valid JSON: ${err.message}`);
  }
}

// ── default mode: canonical sync from all.json ───────────────────────────────
function syncFromAllJson() {
  const all = readJson(allJsonPath(), "deployments/all.json");
  const current = readJson(TARGET, "current registry.json");

  const allChains = Object.keys(all).filter((k) => /^\d+$/.test(k));
  if (!allChains.length) throw new Error("all.json has no numeric chainId buckets");

  const archiveChains = Object.keys(current.chains ?? {});
  if (!archiveChains.length) throw new Error("current registry.json has no chains — refusing to guess");

  // 链级硬校验：档案链必须都在 all.json 里（写盘前抛错，不半写）
  for (const chainId of archiveChains) {
    if (!all[chainId]) {
      throw new Error(
        `archived chain ${chainId} is missing from all.json ` +
        `(chains there: ${allChains.join(", ")}) — check HARDHAT_ALL_JSON / repo layout`,
      );
    }
  }

  // 新链只报不接：registry 链 = sweep 启用面，加链属业务决策（手工 + 两个覆盖变量亦可）
  const extraChains = allChains.filter((c) => !archiveChains.includes(c));
  if (extraChains.length) {
    notice(`all.json chains not in this archive (NOT added): ${extraChains.join(", ")}`);
  }

  const contracts = {};
  const chains = {};
  let mapped = 0;
  let preserved = 0;

  for (const [name, entry] of Object.entries(current.contracts ?? {})) {
    const src = archiveChains.map((c) => all[c]?.[name]).find(Boolean);
    if (src && Array.isArray(src.abi) && src.abi.length) {
      contracts[name] = { abi: src.abi };
      mapped++;
    } else {
      contracts[name] = entry;
      preserved++;
      notice(`contracts.${name}.abi preserved (no ABI source on chains ${archiveChains.join("/")})`);
    }
  }

  for (const chainId of archiveChains) {
    const entries = all[chainId];
    const oldChain = current.chains[chainId] ?? {};
    const nextChain = {};

    const net = Object.values(entries).find(
      (e) => e && typeof e === "object" && e.network?.url,
    )?.network;
    if (net) {
      nextChain.meta = { name: net.name, rpc: net.url, explorer: net.explorer ?? null };
    } else {
      nextChain.meta = oldChain.meta ?? { name: chainId, rpc: null, explorer: null };
      notice(`chain ${chainId}: no network metadata in all.json — meta preserved`);
    }

    let unmapped = [];
    for (const [key, oldAddr] of Object.entries(oldChain)) {
      if (key === "meta") continue;
      const src = entries[key];
      if (src && typeof src.address === "string" && src.address) {
        nextChain[key] = src.address;
        mapped++;
      } else {
        nextChain[key] = oldAddr;
        preserved++;
        unmapped.push(`${key}=${oldAddr}`);
      }
    }
    if (unmapped.length) {
      notice(`chain ${chainId}: ${unmapped.length} key(s) not in all.json, value(s) preserved: ${unmapped.join(", ")}`);
    }
    const skipped = Object.keys(entries).filter((k) => !(k in nextChain));
    if (skipped.length) {
      notice(`chain ${chainId}: ${skipped.length} all.json contract(s) not tracked by this archive (skipped): ${skipped.join(", ")}`);
    }
    chains[chainId] = nextChain;
  }

  const next = { contracts, chains };
  const { added, removed, changed } = diffSummary(current, next);
  console.log("Diff summary (current -> incoming):");
  console.log(`  added: ${added.length}${added.length ? `\n    + ${added.join("\n    + ")}` : ""}`);
  console.log(`  removed: ${removed.length}${removed.length ? `\n    - ${removed.join("\n    - ")}` : ""}`);
  console.log(`  changed: ${changed.length}${changed.length ? `\n    ~ ${changed.join("\n    ~ ")}` : ""}`);

  if (!added.length && !removed.length && !changed.length) {
    console.log(`registry.json already up to date: ${TARGET}`);
    console.log(`sync ok: chains=${archiveChains.join(",")} mapped=${mapped} preserved=${preserved} (no changes)`);
    return;
  }

  // 原子写：先 tmp 再 rename，任何前置抛错都不会留半写产物
  const tmp = `${TARGET}.tmp-sync`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, TARGET);
  console.log(`Atomic write complete: ${TARGET}`);
  console.log(`sync ok: chains=${archiveChains.join(",")} mapped=${mapped} preserved=${preserved}`);
}

// ── --from mode: explicit atomic overwrite from a snapshot ───────────────────
function overwriteFrom(fromPath) {
  const next = readJson(resolve(fromPath), "source");
  if (next === null || typeof next !== "object" || Array.isArray(next) || Object.keys(next).length === 0) {
    throw new Error("source JSON must be a non-empty object");
  }
  let current = {};
  try {
    current = JSON.parse(readFileSync(TARGET, "utf8"));
  } catch {
    // missing/unreadable target: treat as empty, everything counts as added
  }
  const { added, removed, changed } = diffSummary(current, next);
  console.log("Diff summary (current -> incoming):");
  console.log(`  added: ${added.length}${added.length ? `\n    + ${added.join("\n    + ")}` : ""}`);
  console.log(`  removed: ${removed.length}${removed.length ? `\n    - ${removed.join("\n    - ")}` : ""}`);
  console.log(`  changed: ${changed.length}${changed.length ? `\n    ~ ${changed.join("\n    ~ ")}` : ""}`);
  const tmp = `${TARGET}.tmp-sync`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, TARGET);
  console.log(`Atomic write complete: ${TARGET}`);
}

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
if (fromIdx !== -1) {
  const fromPath = args[fromIdx + 1];
  if (!fromPath) {
    console.error("Error: --from requires a path argument.");
    process.exit(1);
  }
  try {
    overwriteFrom(fromPath);
  } catch (err) {
    console.error(`Rejected: ${err.message}`);
    process.exit(1);
  }
} else {
  try {
    syncFromAllJson();
  } catch (err) {
    console.error(`sync failed (registry.json untouched): ${err.message}`);
    process.exit(1);
  }
}
