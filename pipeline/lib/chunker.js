// Release Radar v1.2 - context-preserving chunker.
//
// Why: Orchestrator accepts at most 10,000 characters for the JSON representation of a
// job's input arguments (names, quotes, escapes included). A UiPath monthly page is
// 14k-36k characters, so it must be split. Splitting by raw character count cuts
// sentences in half (the v1.1 failure). This chunker:
//   1. never mixes two sections (environment + timeframe) in one chunk,
//   2. packs whole product blocks, and splits an oversized product only at bullet
//      boundaries (then sentence boundaries as a last resort),
//   3. repeats the section header in every chunk so each chunk is self-describing,
//   4. measures the size exactly the way the request body is serialised.
//
// Pure functions only (no Node APIs) so the same file can be validated in a browser.

export const ORCHESTRATOR_ARGS_LIMIT = 10000;

/** Exact JSON length of the input-arguments payload that will be sent for `text`. */
export function measurePayload(text, { argName, callMode, extraArgs = {} }) {
  const body = { ...extraArgs, [argName]: text };
  if (callMode) body.$callMode = callMode;
  return JSON.stringify(body).length;
}

function sectionHeader(monthLabel, section) {
  const range = section.range ? ` (${section.range})` : "";
  return [
    `# UiPath release notes: ${monthLabel}`,
    `## ${section.environment}`,
    `### ${section.timeframe}${range}`,
    "#### Release highlights",
    "",
    "",
  ].join("\n");
}

function productHeading(product, part) {
  const released = product.releaseDate ? ` (released ${product.releaseDate})` : "";
  const partLabel = part ? ` (part ${part.index} of ${part.total})` : "";
  return `**${product.name}**${released}${partLabel}\n\n`;
}

/** Split a product block into bullet items; continuation lines stay with their bullet. */
function splitBullets(text) {
  const items = [];
  for (const line of text.split("\n")) {
    if (/^\s*[*-] /.test(line) || !items.length) items.push(line);
    else items[items.length - 1] += `\n${line}`;
  }
  return items.map((item) => item.replace(/\s+$/, "")).filter((item) => item.trim());
}

/** Last-resort split of a single huge bullet at sentence boundaries. */
function splitSentences(text, fits) {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) || [text];
  const pieces = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && !fits(current + sentence)) {
      pieces.push(current.trimEnd());
      current = "";
    }
    if (!fits(sentence)) {
      // A single sentence larger than the budget: hard split (flagged by caller).
      let rest = sentence;
      while (rest) {
        let size = rest.length;
        while (size > 1 && !fits(rest.slice(0, size))) size = Math.floor(size * 0.9);
        pieces.push(rest.slice(0, size));
        rest = rest.slice(size);
      }
      continue;
    }
    current += sentence;
  }
  if (current.trim()) pieces.push(current.trimEnd());
  return pieces;
}

/**
 * Build agent-ready chunks from a parsed document.
 * @returns {{chunks: object[], warnings: string[]}}
 */
export function buildChunks(doc, options) {
  const {
    monthLabel = doc.title,
    argName = "release_notes_markdown",
    callMode = "AsyncRequestReply",
    extraArgs = {},
    maxArgsJsonChars = 8000,
  } = options || {};

  if (maxArgsJsonChars > ORCHESTRATOR_ARGS_LIMIT) {
    throw new Error(
      `maxArgsJsonChars (${maxArgsJsonChars}) exceeds the Orchestrator limit of ${ORCHESTRATOR_ARGS_LIMIT}`,
    );
  }

  const measureOpts = { argName, callMode, extraArgs };
  const fits = (text) => measurePayload(text, measureOpts) <= maxArgsJsonChars;
  const chunks = [];
  const warnings = [];

  for (const section of doc.sections) {
    if (!section.products.length) continue;
    const header = sectionHeader(monthLabel, section);
    if (!fits(header)) throw new Error(`Section header alone exceeds the budget: ${section.id}`);

    let current = null;
    const startChunk = () => {
      current = { sectionId: section.id, text: header, products: [] };
      chunks.push(current);
    };
    const tryAppend = (block, productRef) => {
      if (current && current.products.length && fits(current.text + block)) {
        current.text += block;
        current.products.push(productRef);
        return true;
      }
      return false;
    };

    for (const product of section.products) {
      const block = `${productHeading(product)}${product.text}\n\n`;
      const ref = { name: product.name, releaseDate: product.releaseDate || null };

      if (tryAppend(block, ref)) continue;
      if (fits(header + block)) {
        startChunk();
        current.text += block;
        current.products.push(ref);
        continue;
      }

      // Oversized product: split at bullet boundaries into parts.
      const bullets = splitBullets(product.text);
      const parts = [];
      let partText = "";
      const partFits = (body) =>
        fits(header + productHeading(product, { index: 99, total: 99 }) + body + "\n\n");
      for (const bullet of bullets) {
        const candidate = partText ? `${partText}\n${bullet}` : bullet;
        if (partFits(candidate)) {
          partText = candidate;
          continue;
        }
        if (partText) parts.push(partText);
        if (partFits(bullet)) {
          partText = bullet;
        } else {
          warnings.push(`Bullet split at sentence level in "${product.name}" (${section.id})`);
          const pieces = splitSentences(bullet, partFits);
          parts.push(...pieces.slice(0, -1));
          partText = pieces[pieces.length - 1];
        }
      }
      if (partText) parts.push(partText);

      parts.forEach((body, index) => {
        const part = { index: index + 1, total: parts.length };
        startChunk();
        current.text += `${productHeading(product, part)}${body}\n\n`;
        current.products.push({ ...ref, part: part.index, parts: part.total });
      });
      current = null; // never append other products after a split part
    }
  }

  chunks.forEach((chunk, index) => {
    chunk.text = chunk.text.replace(/\s+$/, "\n");
    chunk.id = `${chunk.sectionId}#${String(index + 1).padStart(2, "0")}`;
    chunk.chars = chunk.text.length;
    chunk.payloadChars = measurePayload(chunk.text, measureOpts);
  });

  return { chunks, warnings };
}
