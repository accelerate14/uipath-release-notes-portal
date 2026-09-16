import { useEffect, useState } from "react";

const monthDefinitions = ["january", "february", "march", "april", "may", "june", "july", "august"].map((month) => ({
  value: month,
  label: month[0].toUpperCase() + month.slice(1),
  slug: `cloud-platform-${month}-2026`,
}));
const apiBase = "https://docs.uipath.com/_next/data/docs-build-135/release-notes/other/latest/release-notes/";

function parseMonthPayload(payload, month) {
  const body = payload.pageProps?.page?.containerItems?.[0]?.rawContent?.data?.Component?.Fields?.topicBody?.Values?.[0] || "";
  const document = new DOMParser().parseFromString(body, "text/html");
  const releases = [];
  let deployment = "Other";
  document.querySelectorAll("h3, table").forEach((element) => {
    if (element.tagName === "H3") {
      deployment = element.textContent.trim();
      return;
    }
    const headers = [...element.querySelectorAll("thead th")].map((header) => header.textContent.trim().toLowerCase());
    if (!headers.includes("product") || !headers.includes("release status")) return;
    let previousProduct = "";
    let previousStatus = "";
    element.querySelectorAll("tbody tr").forEach((row) => {
      const cells = [...row.children].map((cell) => cell.textContent.trim());
      if (cells.length < 2) return;
      const productCell = cells.length >= 5 ? cells[1] : previousProduct;
      const statusCell = cells.length >= 5 ? cells[2] : previousStatus;
      const product = productCell || "Unknown product";
      const status = statusCell.includes("✅") ? "Available" : "No release";
      const date = cells.length >= 5 ? cells[3] : cells[0];
      previousProduct = product;
      previousStatus = statusCell;
      const link = row.querySelector("a")?.href || "https://docs.uipath.com/release-notes";
        releases.push({ id: `${month.value}-${releases.length}-${product}`, month: month.label, monthValue: month.value, year: "2026", day: date.match(/\b\d{1,2}\b/)?.[0] || "--", title: `${product} release notes`, description: date === "N/A" ? "No release-note entry was published during this timeframe." : `${deployment} release catalog entry published on ${date}.`, product, deployment, type: status, tag: status === "Available" ? "Published" : "None", link, sourceContent: body });
    });
  });
  return { month, releases, content: body };
}

function sanitizeNoteContent(content) {
  const document = new DOMParser().parseFromString(content, "text/html");
  document.querySelectorAll("script, style, iframe, object, embed, form").forEach((element) => element.remove());
  document.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith("on") || attribute.name.toLowerCase() === "style") element.removeAttribute(attribute.name);
    });
    if (element.tagName === "A" && !/^https?:$/i.test(element.protocol)) element.removeAttribute("href");
  });
  return document.body.innerHTML;
}

async function fetchReleases() {
  const payloads = await Promise.all(monthDefinitions.map(async (month) => {
    const query = new URLSearchParams({ productSlug: "release-notes", deliveryOption: "other", versionSlug: "latest", publicationType: "release-notes", topicSlug: month.slug });
    const response = await fetch(`${apiBase}${month.slug}.json?${query}`);
    if (!response.ok) throw new Error(`${month.label} request failed (${response.status})`);
    return { month, payload: await response.json() };
  }));
  return payloads.map(({ month, payload }) => parseMonthPayload(payload, month));
}

function getPreviousMonth() {
  const date = new Date();
  date.setMonth(date.getMonth() - 1);
  return date.toLocaleString("en-US", { month: "long" }).toLowerCase();
}

function App() {
  const [releases, setReleases] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState(getPreviousMonth);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("Updated moments ago");
  const [toast, setToast] = useState("");

  const loadData = async () => {
    setLoading(true);
    setError("");
    try {
      setReleases(await fetchReleases());
      setLastUpdated("Updated just now");
    } catch (loadError) {
      setError(`Could not load UiPath release notes: ${loadError.message}`);
      setToast("Feed unavailable");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);
  useEffect(() => {
    if (releases.length && !releases.some((document) => document.month.value === selectedMonth)) {
      setSelectedMonth(releases[releases.length - 1].month.value);
    }
  }, [releases, selectedMonth]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(""), 2200); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => { const onKeyDown = (event) => { if (event.key === "/" && document.activeElement.tagName !== "INPUT") { event.preventDefault(); document.querySelector("#searchInput")?.focus(); } }; document.addEventListener("keydown", onKeyDown); return () => document.removeEventListener("keydown", onKeyDown); }, []);

  const totalReleases = releases.reduce((total, document) => total + document.releases.length, 0);
  const totalProducts = new Set(releases.flatMap((document) => document.releases.map((release) => release.product))).size;
  const selectedDocument = releases.find((document) => document.month.value === selectedMonth);

  return <>
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="UiPath Release Radar home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>release<br /><strong>radar</strong></span></a>
        <div className="sidebar-label">Workspace</div>
        <nav className="nav-list"><a className="nav-item active" href="#updates"><span className="nav-icon">◈</span>Release notes <span className="nav-count">{String(releases.length).padStart(2, "0")}</span></a></nav>
        <div className="sidebar-label">Browse by month</div><nav className="product-list" aria-label="Months">{releases.map((document) => <button className={`product-link ${selectedMonth === document.month.value ? "active" : ""}`} key={document.month.value} type="button" aria-pressed={selectedMonth === document.month.value} onClick={() => { setSelectedMonth(document.month.value); document.querySelector("#updates")?.scrollIntoView({ behavior: "smooth" }); }}><span className="product-dot" />{document.month.label}</button>)}</nav>
        <div className="sidebar-footer"><div className="status-indicator"><span />Feed status: {error ? "unavailable" : "healthy"}</div><p>Public release intelligence for the automation team.</p><a href="https://docs.uipath.com/" target="_blank" rel="noreferrer">Open UiPath docs ↗</a></div>
      </aside>
      <main id="top" className="main-content">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><b>/</b>Release radar</div><div className="topbar-actions"><span className="live-chip"><span />Public feed</span><button className="icon-button" type="button" title="Refresh release feed" aria-label="Refresh release feed" onClick={() => { loadData(); setToast("Feed refreshed"); }}>↻</button></div></header>
        <section className="hero" aria-labelledby="pageTitle"><div className="hero-copy"><p className="eyebrow">UiPath.com / product intelligence</p><h1 id="pageTitle">Know what<br /><em>just shipped.</em></h1><p className="hero-description">A clear, calm view of the latest UiPath product releases, improvements, and changes worth sharing.</p><div className="hero-meta"><span className="pulse" />{lastUpdated}<span className="meta-divider" />Source: UiPath release notes</div></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><div className="art-core"><span>UP</span></div><span className="art-label label-top">PRODUCT<br />CHANGELOG</span><span className="art-label label-bottom">08 / 24<br />LIVE ITEMS</span></div></section>
        <section id="updates" className="updates-section month-documents" aria-labelledby="updatesTitle"><div className="section-heading"><div><p className="eyebrow">UiPath release notes</p><h2 id="updatesTitle">2026 monthly documents</h2></div><span className="result-count">{selectedDocument ? `${selectedDocument.month.label} 2026` : `${String(releases.length).padStart(2, "0")} months`}</span></div>
          {loading && <div className="loading-state">Loading release notes from UiPath...</div>}{error && !loading && <div className="loading-state">{error}</div>}{!loading && !error && selectedDocument && <div className="month-document-list"><article className="month-document"><div className="month-document-heading"><p className="eyebrow">Cloud platform / 2026</p><h3>{selectedDocument.month.label} 2026</h3></div><div className="release-note-document" dangerouslySetInnerHTML={{ __html: sanitizeNoteContent(selectedDocument.content) }} /></article></div>}
        </section>
        <section className="source-banner"><div className="source-icon">↗</div><div><strong>Always go to the source.</strong><p>Release Radar is a lightweight view. Full notes, availability, and documentation live on UiPath.com.</p></div><a href="https://docs.uipath.com/release-notes" target="_blank" rel="noreferrer">Visit release notes <span>↗</span></a></section><footer className="footer"><span>Release Radar / v1.0</span><span>Made for teams who automate thoughtfully.</span></footer>
      </main>
    </div>
    {toast && <div className="toast visible" role="status" aria-live="polite">{toast}</div>}
  </>;
}

export default App;
