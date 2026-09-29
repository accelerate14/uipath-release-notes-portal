// Release Radar v1.2 - agent output validation and month-level merge.
//
// The agent contract (unchanged from v1.1, proven by a real agent run):
//   { "changes_by_product": { "<product>": { summary, changes: [ { name, summary,
//       analysis, impact, breaking_change } ], overall_analysis } } }
// v1.1 displayed whatever came back, including an Orchestrator "Pending" job record.
// v1.2 validates every chunk result and never shows a job record as an analysis.

import { productKey } from "./markdown.js";

export class AgentOutputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "AgentOutputError";
    this.details = details;
  }
}

const JOB_RECORD_KEYS = ["state", "key", "creationTime", "organizationUnitId"];

function findChangesByProduct(value, depth = 0) {
  if (value == null || depth > 3) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[[{]/.test(trimmed)) return undefined;
    try {
      return findChangesByProduct(JSON.parse(trimmed), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object") return undefined;
  if (value.changes_by_product && typeof value.changes_by_product === "object") return value.changes_by_product;
  if (typeof value.changes_by_product === "string") {
    try {
      const parsed = JSON.parse(value.changes_by_product);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed.changes_by_product || parsed;
    } catch {
      return undefined;
    }
  }
  for (const key of ["output", "Output", "outputArguments", "OutputArguments", "result", "Result"]) {
    if (key in value) {
      const found = findChangesByProduct(value[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

const asText = (value) => (typeof value === "string" ? value.trim() : value == null ? "" : String(value));

/**
 * Validate and normalise one agent response.
 * @returns {{products: Record<string, object>, warnings: string[]}}
 */
export function normalizeAgentOutput(raw) {
  if (raw && typeof raw === "object" && JOB_RECORD_KEYS.every((key) => key in raw) && !findChangesByProduct(raw)) {
    throw new AgentOutputError(
      `Received an Orchestrator job record (state "${raw.state}") instead of agent output`,
      { state: raw.state },
    );
  }
  const map = findChangesByProduct(raw);
  if (!map || Array.isArray(map)) {
    throw new AgentOutputError("Agent output has no 'changes_by_product' object", {
      preview: JSON.stringify(raw)?.slice(0, 300),
    });
  }

  const warnings = [];
  const products = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") {
      warnings.push(`Product "${name}" has no object value; skipped`);
      continue;
    }
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    if (!Array.isArray(entry.changes)) warnings.push(`Product "${name}" has no 'changes' array`);
    products[name] = {
      summary: asText(entry.summary),
      overall_analysis: asText(entry.overall_analysis),
      changes: changes
        .filter((change) => change && typeof change === "object")
        .map((change) => {
          if (typeof change.breaking_change !== "boolean") {
            warnings.push(`Change "${asText(change.name)}" in "${name}" has non-boolean breaking_change`);
          }
          return {
            name: asText(change.name),
            summary: asText(change.summary),
            analysis: asText(change.analysis),
            impact: asText(change.impact),
            breaking_change: change.breaking_change === true || change.breaking_change === "true",
          };
        }),
    };
  }
  if (!Object.keys(products).length) throw new AgentOutputError("Agent output contains no products");
  return { products, warnings };
}

const joinText = (a, b) => [a, b].filter(Boolean).join(" ");

/**
 * Merge per-chunk results into the month document consumed by the portal.
 * @param {object} doc parsed document (from parseReleaseNotes)
 * @param {object[]} chunkRecords [{ id, sectionId, sha256, products, status, result?, error? }]
 */
export function mergeMonth(doc, chunkRecords) {
  const sections = doc.sections.map((section) => {
    const records = chunkRecords.filter((record) => record.sectionId === section.id);
    const analysed = new Map(); // productKey -> merged analysis
    const extra = [];

    for (const record of records) {
      if (record.status !== "ok" || !record.result) continue;
      for (const [name, value] of Object.entries(record.result.products)) {
        const key = productKey(name);
        const existing = analysed.get(key);
        if (!existing) {
          analysed.set(key, { name, ...value, changes: [...value.changes], fromChunk: record.id });
        } else {
          existing.summary = joinText(existing.summary, value.summary);
          existing.overall_analysis = joinText(existing.overall_analysis, value.overall_analysis);
          existing.changes.push(...value.changes);
        }
      }
    }

    // A product can appear more than once in a section (Dedicated lists it per release date).
    // The agent returns one key per product name, so its analysis covers every occurrence:
    // it is attached to the first occurrence and the later ones point to it.
    const claimed = new Map(); // productKey -> first product entry that holds the analysis
    const carrierStatus = (carriers) =>
      carriers.length && carriers.every((record) => record.status === "ok")
        ? "ok"
        : carriers.some((record) => record.status === "failed")
          ? "failed"
          : "pending";

    const products = section.products.map((product) => {
      const key = productKey(product.name);
      const carriers = records.filter((record) => record.products.some((p) => productKey(p.name) === key));
      const chunk = carriers[0];
      const first = claimed.get(key);
      if (first) {
        if (product.releaseDate && !first.releaseDates.includes(product.releaseDate)) {
          first.releaseDates.push(product.releaseDate);
        }
        return {
          name: product.name,
          releaseDate: product.releaseDate || null,
          source: product.text,
          sourceMentionsBreaking: /breaking change/i.test(product.text),
          analysisStatus: carrierStatus(carriers),
          analysis: null,
          sharedAnalysis: true,
        };
      }
      // Exact name match first; then tolerate the agent shortening/extending a name, but only
      // for names returned by the same chunk that carried this product.
      let matchKey = analysed.has(key) ? key : null;
      if (!matchKey && chunk) {
        matchKey =
          [...analysed.entries()].find(
            ([k, v]) => v.fromChunk === chunk.id && k.length > 3 && (k.includes(key) || key.includes(k)),
          )?.[0] || null;
      }
      const found = matchKey ? analysed.get(matchKey) : null;
      if (matchKey) analysed.delete(matchKey);
      const analysis = found ? (({ fromChunk, ...rest }) => rest)(found) : null;
      const entry = {
        name: product.name,
        releaseDate: product.releaseDate || null,
        releaseDates: product.releaseDate ? [product.releaseDate] : [],
        source: product.text,
        sourceMentionsBreaking: /breaking change/i.test(product.text),
        analysisStatus: analysis
          ? carriers.every((record) => record.status === "ok")
            ? "ok"
            : "partial"
          : carriers.some((record) => record.status === "failed")
            ? "failed"
            : "pending",
        analysis,
      };
      if (analysis) claimed.set(key, entry);
      return entry;
    });

    // Products the agent returned under a name we did not send (e.g. renamed). Kept, flagged.
    for (const [, { fromChunk, ...analysis }] of analysed) {
      if (!analysis.changes.length) continue; // nothing to show; keeps counts equal to what users see
      extra.push({
        name: analysis.name,
        releaseDate: null,
        source: "",
        sourceMentionsBreaking: false,
        analysisStatus: "ok",
        unmatched: true,
        analysis,
      });
    }

    return {
      id: section.id,
      environment: section.environment,
      timeframe: section.timeframe,
      publishingDate: section.publishingDate,
      range: section.range,
      note: section.note,
      products: [...products, ...extra],
      catalog: section.catalog,
    };
  });

  const total = chunkRecords.length;
  const ok = chunkRecords.filter((r) => r.status === "ok").length;
  const failed = chunkRecords.filter((r) => r.status === "failed").length;
  const status = total === 0 ? "no-highlights" : ok === total ? "complete" : ok === 0 && failed ? "failed" : ok === 0 ? "pending" : "partial";

  const allProducts = sections.flatMap((s) => s.products);
  const changes = allProducts.flatMap((p) => p.analysis?.changes || []);
  return {
    status,
    sections,
    counts: {
      sections: sections.length,
      products: allProducts.length,
      analysedProducts: allProducts.filter((p) => p.analysisStatus === "ok").length,
      changes: changes.length,
      breakingChanges: changes.filter((c) => c.breaking_change).length,
      chunks: { total, ok, failed, pending: total - ok - failed },
    },
  };
}
