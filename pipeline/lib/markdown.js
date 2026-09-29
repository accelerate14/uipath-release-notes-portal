// Release Radar v1.2 - UiPath release-notes markdown parser.
//
// Turns a UiPath "cloud-platform-<month>-<year>.md" page into a structured model:
//   environment (##) -> timeframe (###) -> highlights per product + release catalog.
//
// Pure functions only (no Node APIs) so the exact same file can run in Node, in tests
// and in a browser for validation against live pages.

const MONTH_NAMES =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_ONLY_RE = new RegExp(`^(${MONTH_NAMES}) \\d{1,2}, \\d{4}$`);
const DATE_IN_TEXT_RE = new RegExp(`(${MONTH_NAMES}) \\d{1,2}, \\d{4}`);
const BOLD_LINE_RE = /^\*\*(.+?)\*\*\s*$/;
// Looser date test for catalog cells: "August 4, 2026", "February 4th, 2026", "27 January, 2026".
const DATE_CELL_RE = new RegExp(`^(\\d{1,2}(st|nd|rd|th)? )?(${MONTH_NAMES})( \\d{1,2}(st|nd|rd|th)?)?,? \\d{4}$`);
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const STATUS_RE = /[✅❌]/; // check mark / cross mark used in UiPath catalog tables
// Catalog tables arrive as flattened HTML: a <colgroup> line (or a glued header line) then
// one cell per line, rows separated by whitespace-only lines.
const FLAT_TABLE_START_RE = /^(<colgroup|LayerProductRelease status)/i;

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalised key used to match product names coming back from the agent. */
export function productKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function splitPipeRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isPipeSeparator(line) {
  return /^\|?\s*:?-{3,}/.test(line.trim());
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function extractLinks(text) {
  const links = [];
  for (const match of String(text).matchAll(LINK_RE)) links.push({ label: match[1], url: match[2] });
  return links;
}

function stripLinks(text) {
  return String(text).replace(LINK_RE, "$1");
}

/** Plain cell text: links reduced to their label, **bold** markers removed. */
function plainCell(text) {
  return stripLinks(text).replace(/\*\*([^*]+)\*\*/g, "$1").trim();
}

/**
 * Parse a UiPath monthly release-notes markdown document.
 * @param {string} markdown
 * @returns {{title: string, sections: object[], warnings: string[]}}
 */
export function parseReleaseNotes(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const doc = { title: "", sections: [], warnings: [] };

  let environment = null;
  let section = null;
  let mode = null; // "highlights" | "catalog" | null
  let highlightDate = null; // Dedicated pages group highlights by release date
  let product = null;
  let catalog = null; // parser state for the current catalog block

  const flushProduct = () => {
    if (product) {
      product.text = trimBlankLines(product.lines).join("\n");
      delete product.lines;
      if (!product.text) {
        doc.warnings.push(`Empty highlight block for "${product.name}" in ${section?.id}`);
      }
      product = null;
    }
  };

  const addCatalogEntry = (entry) => {
    const existing = section.catalog.find((item) => productKey(item.product) === productKey(entry.product));
    if (!existing) {
      section.catalog.push(entry);
      return;
    }
    existing.available = existing.available || entry.available;
    existing.layer = existing.layer || entry.layer;
    for (const date of entry.dates) if (!existing.dates.includes(date)) existing.dates.push(date);
    for (const note of entry.notes) if (!existing.notes.includes(note)) existing.notes.push(note);
    for (const link of entry.links) if (!existing.links.some((l) => l.url === link.url)) existing.links.push(link);
  };

  const flushFlatGroup = () => {
    if (!catalog || !catalog.group.length) return;
    const group = catalog.group;
    catalog.group = [];
    // Header row, either one glued line ("LayerProductRelease status...") or one cell per line.
    if (group.some((cell) => /^(release status|layerproductrelease status.*)$/i.test(cell))) return;

    const isDate = (cell) => DATE_CELL_RE.test(cell) || cell === "N/A";
    const statusIndex = group.findIndex((cell) => STATUS_RE.test(cell));
    if (statusIndex >= 1) {
      // [layer?, product, status, date, notes...]
      const date = group[statusIndex + 1] || "";
      const entry = {
        product: plainCell(group[statusIndex - 1]),
        layer: statusIndex >= 2 ? plainCell(group[statusIndex - 2]) : "",
        available: group[statusIndex].includes("✅"),
        dates: date && date !== "N/A" ? [date] : [],
        notes: group.slice(statusIndex + 2).map(plainCell).filter((n) => n && n !== "N/A"),
        links: [],
      };
      catalog.last = entry;
      addCatalogEntry(entry);
      return;
    }
    const dateIndex = group.findIndex(isDate);
    if (dateIndex >= 0 && catalog.last) {
      // Continuation row for the previous product: [layer?, date, notes...]
      const date = group[dateIndex];
      const target = section.catalog.find((item) => productKey(item.product) === productKey(catalog.last.product));
      if (date !== "N/A" && !target.dates.includes(date)) target.dates.push(date);
      for (const note of group.slice(dateIndex + 1)) {
        if (note && note !== "N/A" && !target.notes.includes(note)) target.notes.push(note);
      }
      return;
    }
    doc.warnings.push(`Unrecognised catalog row in ${section.id}: ${group.join(" | ")}`);
  };

  const closeCatalog = () => {
    if (catalog?.flat) flushFlatGroup();
    catalog = null;
  };

  const closeMode = () => {
    flushProduct();
    closeCatalog();
    mode = null;
    highlightDate = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const heading = /^(#{1,6}) (.+)$/.exec(line);

    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();

      if (level === 1) {
        doc.title = text;
        continue;
      }
      if (level === 2) {
        closeMode();
        section = null;
        environment = /^see also$/i.test(text) ? null : text;
        continue;
      }
      if (level === 3) {
        closeMode();
        if (!environment) {
          section = null;
          continue;
        }
        section = {
          id: `${slugify(environment)}--${slugify(text)}`,
          environment,
          timeframe: text,
          publishingDate: "",
          range: "",
          note: "",
          products: [],
          catalog: [],
        };
        doc.sections.push(section);
        continue;
      }
      if (level === 4 && section) {
        closeMode();
        if (/release highlights/i.test(text)) mode = "highlights";
        else if (/release notes catalog/i.test(text)) {
          mode = "catalog";
          // "#### Automation Cloud Dedicated release notes catalog: January 19, 2026"
          const headingDate = DATE_IN_TEXT_RE.exec(text);
          catalog = { flat: false, group: [], last: null, date: headingDate ? headingDate[0] : null, columns: null };
        }
        continue;
      }
      // Dedicated pages group by release date with "##### March 19, 2026" (Mar-Jul 2026)
      // or "**August 21, 2026**" (Aug 2026+). A date heading is a group, never a product.
      if (level === 5 && section && mode === "highlights") {
        flushProduct();
        if (DATE_ONLY_RE.test(text)) {
          highlightDate = text;
          continue;
        }
        product = { name: text, releaseDate: highlightDate, lines: [] };
        section.products.push(product);
        continue;
      }
      if (level === 5 && section && mode === "catalog" && DATE_ONLY_RE.test(text)) {
        if (catalog.flat) flushFlatGroup();
        catalog.date = text;
        catalog.flat = false;
        continue;
      }
    }

    if (!section) continue;

    // Section preamble: "| Publishing date | Release timeframe |" table and optional note.
    if (!mode) {
      if (line.trim().startsWith("|")) {
        if (isPipeSeparator(line)) continue;
        const cells = splitPipeRow(line);
        if (/publishing date/i.test(cells[0] || "")) continue;
        section.publishingDate = cells[0] || "";
        section.range = (cells[1] || "").replace(/\s{2,}/g, ", ");
      } else if (line.trim()) {
        section.note = section.note ? `${section.note} ${line.trim()}` : line.trim();
      }
      continue;
    }

    if (mode === "highlights") {
      const bold = BOLD_LINE_RE.exec(line.trim());
      if (bold) {
        const inner = bold[1].trim();
        flushProduct();
        if (DATE_ONLY_RE.test(inner)) {
          highlightDate = inner;
        } else {
          product = { name: inner, releaseDate: highlightDate, lines: [] };
          section.products.push(product);
        }
        continue;
      }
      if (product) product.lines.push(line);
      // Text outside a product block is boilerplate intro text and is intentionally dropped.
      continue;
    }

    if (mode === "catalog") {
      const trimmed = line.trim();
      const bold = BOLD_LINE_RE.exec(trimmed);
      if (bold && DATE_ONLY_RE.test(bold[1].trim())) {
        if (catalog.flat) flushFlatGroup();
        catalog.date = bold[1].trim();
        catalog.flat = false;
        continue;
      }
      if (catalog.flat) {
        if (!trimmed) flushFlatGroup();
        else if (!/^<\/?col/i.test(trimmed) && !/^-+$/.test(trimmed)) catalog.group.push(trimmed);
        continue;
      }
      if (FLAT_TABLE_START_RE.test(trimmed)) {
        catalog.flat = true;
        catalog.group = /^<\/?col/i.test(trimmed) ? [] : [trimmed];
        continue;
      }
      if (trimmed.startsWith("|")) {
        if (isPipeSeparator(trimmed)) continue;
        const cells = splitPipeRow(trimmed);
        // Header row. Data rows can also contain a "Product" cell (the Layer column), so a
        // header must name both the Product and the Release status columns.
        if (cells.some((cell) => /^product$/i.test(cell)) && cells.some((cell) => /^release status$/i.test(cell))) {
          catalog.columns = cells.map((cell) => cell.toLowerCase());
          continue;
        }
        const columns = catalog.columns || ["product", "release status", "release notes"];
        const cell = (name) => cells[columns.findIndex((c) => c.startsWith(name))] ?? "";
        const notesCell = cell("release notes");
        const entry = {
          product: plainCell(cell("product")),
          layer: plainCell(cell("layer")),
          available: cell("release status").includes("✅"),
          dates: [],
          notes: [],
          links: extractLinks(notesCell),
        };
        const dateCell = cell("release date");
        if (dateCell && dateCell !== "N/A") entry.dates.push(dateCell);
        else if (entry.available) {
          // Date from the table's date group, or the section's single release date.
          const fallback = catalog.date || (DATE_ONLY_RE.test(section.range) ? section.range : null);
          if (fallback) entry.dates.push(fallback);
        }
        const plainNotes = plainCell(notesCell);
        if (plainNotes && plainNotes !== "N/A") entry.notes.push(plainNotes);
        if (entry.product) addCatalogEntry(entry);
      }
    }
  }

  closeMode();
  return doc;
}

/** Summary counts used in logs and tests. */
export function describeDocument(doc) {
  return {
    title: doc.title,
    sections: doc.sections.length,
    products: doc.sections.reduce((sum, s) => sum + s.products.length, 0),
    catalogEntries: doc.sections.reduce((sum, s) => sum + s.catalog.length, 0),
    highlightChars: doc.sections.reduce(
      (sum, s) => sum + s.products.reduce((inner, p) => inner + p.text.length, 0),
      0,
    ),
    warnings: doc.warnings.length,
  };
}
