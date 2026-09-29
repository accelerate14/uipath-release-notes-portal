// Release Radar v1.2 - view model for the portal.
// Turns a month document (sections = environment x timeframe) into what readers want:
// one tab per cloud, and inside it ONE entry per product for the whole month
// (Early/Mid/Late timeframes and Dedicated release dates are merged).
// Pure functions: unit-tested in pipeline/tests/view-model.test.js.

import { productKey } from "../../pipeline/lib/markdown.js";

const MONTH_ABBR = {
  January: "Jan", February: "Feb", March: "Mar", April: "Apr", May: "May", June: "Jun",
  July: "Jul", August: "Aug", September: "Sep", October: "Oct", November: "Nov", December: "Dec",
};

export function envShortName(environment) {
  if (/public sector/i.test(environment)) return "Public Sector";
  if (/dedicated/i.test(environment)) return "Dedicated";
  return "Automation Cloud";
}

/** Same product under different names (e.g. the three "Admin" spellings) gets one key. */
export function canonicalProduct(name) {
  const label = String(name || "").trim();
  if (/\badmin(istration)?\b/i.test(label)) return { key: "platform-administration", label: "Platform administration" };
  return { key: productKey(label), label };
}

/** "August 21, 2026" -> "Aug 21" (ordinal suffixes tolerated). */
export function shortDate(value) {
  const match = /^(\w+) (\d{1,2})(?:st|nd|rd|th)?,? \d{4}$/.exec(String(value || "").trim());
  return match && MONTH_ABBR[match[1]] ? `${MONTH_ABBR[match[1]]} ${match[2]}` : String(value || "");
}

/** "August 16, 2026 – August 31, 2026" -> "Aug 16 – 31". */
export function shortRange(range) {
  const parts = String(range || "").split(/\s+[–-]\s+/);
  if (parts.length !== 2) return shortDate(range);
  const [from, to] = parts.map(shortDate);
  const [fromMonth] = from.split(" ");
  const [toMonth, toDay] = to.split(" ");
  return fromMonth === toMonth ? `${from} – ${toDay}` : `${from} – ${to}`;
}

const MONTH_INDEX = Object.fromEntries(Object.keys(MONTH_ABBR).map((m, i) => [m, i]));

/** "August 21, 2026" / "August 4th, 2026" -> timestamp (NaN if not a date). */
export function dateValue(value) {
  const match = /^(\w+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(String(value || "").trim());
  if (!match || !(match[1] in MONTH_INDEX)) return Number.NaN;
  return Date.UTC(Number(match[3]), MONTH_INDEX[match[1]], Number(match[2]));
}

function whenLabel(section, product) {
  if (product.releaseDate) return `Released ${shortDate(product.releaseDate)}`;
  if (section.range && section.range !== "N/A") return shortRange(section.range);
  return section.publishingDate ? `Published ${shortDate(section.publishingDate)}` : "";
}

const stripMarkdown = (text) => String(text).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
const bullets = (text) =>
  String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[*-] /.test(line))
    .map((line) => line.replace(/^[*-] /, ""));

/** Chronological order; unparseable dates keep their place at the end. */
const byDate = (dates) => [...dates].sort((a, b) => (dateValue(a) || Infinity) - (dateValue(b) || Infinity));

function mergeStatus(statuses) {
  if (!statuses.length) return "pending";
  if (statuses.every((s) => s === "ok")) return "ok";
  if (statuses.some((s) => s === "ok" || s === "partial")) return "partial";
  if (statuses.some((s) => s === "failed")) return "failed";
  return "pending";
}

/**
 * @returns {{ envs: Array<{ name, short, products, catalogOnly, stats }> }}
 */
export function buildMonthView(month) {
  const envs = new Map();
  const getEnv = (name) => {
    if (!envs.has(name)) envs.set(name, { name, short: envShortName(name), products: new Map(), catalog: new Map(), dates: [] });
    return envs.get(name);
  };

  for (const section of month?.sections || []) {
    const env = getEnv(section.environment);
    if (section.publishingDate) env.dates.push(section.publishingDate);
    for (const product of section.products || []) {
      const changes = product.analysis?.changes || [];
      if (product.unmatched && !changes.length) continue;
      const { key, label } = canonicalProduct(product.name);
      if (!env.products.has(key)) {
        env.products.set(key, { key, name: label, updates: [], pendingItems: [], summaries: [], overall: [], sources: [], statuses: [], sourceMentionsBreaking: false });
      }
      const entry = env.products.get(key);
      const when = whenLabel(section, product);
      const analysis = product.analysis;
      if (analysis) {
        // One analysis can cover several release dates of the same product (Dedicated).
        const dates = product.releaseDates || [];
        const updateWhen = dates.length > 1 ? `Released ${dates.map(shortDate).join(", ")}` : when;
        if (analysis.summary) entry.summaries.push(analysis.summary);
        if (analysis.overall_analysis && !/^not stated/i.test(analysis.overall_analysis)) entry.overall.push(analysis.overall_analysis);
        for (const change of changes) {
          const duplicate = entry.updates.some((u) => productKey(u.name) === productKey(change.name) && productKey(u.summary) === productKey(change.summary));
          if (!duplicate) entry.updates.push({ ...change, when: updateWhen });
        }
      } else if (product.source && !product.sharedAnalysis) {
        for (const text of bullets(product.source)) entry.pendingItems.push({ text, when });
      }
      if (product.source) entry.sources.push({ when, text: product.source });
      entry.statuses.push(product.analysisStatus);
      entry.sourceMentionsBreaking = entry.sourceMentionsBreaking || Boolean(product.sourceMentionsBreaking);
    }
    for (const item of section.catalog || []) {
      if (!item.available) continue;
      const { key, label } = canonicalProduct(item.product);
      if (!env.catalog.has(key)) env.catalog.set(key, { key, name: label, dates: [], links: [] });
      const entry = env.catalog.get(key);
      for (const date of item.dates || []) {
        if (!entry.dates.includes(date)) entry.dates.push(date);
        env.dates.push(date);
      }
      for (const link of item.links || []) if (!entry.links.some((l) => l.url === link.url)) entry.links.push(link);
    }
  }

  return {
    envs: [...envs.values()].filter((env) => env.products.size || [...env.catalog.values()].length).map((env) => {
      const products = [...env.products.values()]
        .map((p) => {
          const catalog = env.catalog.get(p.key);
          const breaking = p.updates.filter((u) => u.breaking_change).length;
          const status = mergeStatus(p.statuses);
          return {
            ...p,
            status,
            breaking,
            updateCount: p.updates.length || p.pendingItems.length,
            summary: stripMarkdown(p.summaries[0] || p.pendingItems[0]?.text || ""),
            dates: byDate(catalog?.dates || []).map(shortDate),
            links: catalog?.links || [],
            flagMismatch: p.sourceMentionsBreaking && status !== "pending" && breaking === 0,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const catalogOnly = [...env.catalog.values()]
        .filter((c) => !env.products.has(c.key))
        .map((c) => ({ ...c, dates: byDate(c.dates).map(shortDate) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const latest = Math.max(...env.dates.map(dateValue).filter(Number.isFinite));
      const latestRelease = Number.isFinite(latest)
        ? `${Object.values(MONTH_ABBR)[new Date(latest).getUTCMonth()]} ${new Date(latest).getUTCDate()}`
        : "";
      return {
        name: env.name,
        short: env.short,
        products,
        catalogOnly,
        latestRelease,
        stats: {
          products: products.length,
          analysed: products.filter((p) => p.status === "ok" || p.status === "partial").length,
          updates: products.reduce((n, p) => n + p.updateCount, 0),
          breaking: products.reduce((n, p) => n + p.breaking, 0),
        },
      };
    }),
  };
}

export function productMatches(product, query, breakingOnly) {
  if (breakingOnly && !product.breaking && !product.sourceMentionsBreaking) return false;
  if (!query) return true;
  const text = [
    product.name,
    ...product.summaries,
    ...product.overall,
    ...product.pendingItems.map((i) => i.text),
    ...product.updates.flatMap((u) => [u.name, u.summary, u.impact, u.analysis]),
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(query.toLowerCase());
}
