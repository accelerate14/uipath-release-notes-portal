// Release Radar v1.2 - portal.
// Reads pre-computed, validated analysis from static JSON (public/data) produced by the
// scheduled pipeline. The browser holds no credentials and never calls UiPath Orchestrator.
// Only fully analysed months are published, so there are no "pending" states to show.
//
// Layout: one tab per cloud; inside it one card per product for the whole month
// (timeframes merged). Clicking a card opens all of that product's updates.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import provider from "./data/static-provider.js";
import { buildMonthView, productMatches } from "./lib/view-model.js";

const ADMIN_RERUN_URL = import.meta.env.VITE_ADMIN_RERUN_URL || "";

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Safe inline formatting for UiPath text: **bold** and `code` only (React escapes the rest). */
function InlineText({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function SourceList({ text }) {
  const items = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <ul className="rr-source">
      {items.map((line, index) => (
        <li key={index} className={/^[*-] /.test(line) ? "" : "rr-source-plain"}>
          <InlineText text={line.replace(/^[*-] /, "")} />
        </li>
      ))}
    </ul>
  );
}

function ProductBadges({ product }) {
  if (!product.breaking) return null;
  return (
    <span className="rr-badges">
      <span className="rr-badge rr-badge-breaking">{product.breaking} breaking</span>
    </span>
  );
}

function ReleasedCard({ item }) {
  const body = (
    <>
      <span className="rr-pcard-name">{item.name}</span>
      <span className="rr-pcard-foot">
        <span>Released {item.dates.length ? item.dates.join(", ") : "this month"}</span>
        {item.links[0] && (
          <span className="rr-pcard-cta" aria-hidden="true">
            Release notes ↗
          </span>
        )}
      </span>
    </>
  );
  return item.links[0] ? (
    <a className="rr-pcard rr-pcard-small" href={item.links[0].url} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <div className="rr-pcard rr-pcard-small rr-pcard-static">{body}</div>
  );
}

function ProductCard({ product, onOpen }) {
  return (
    <button type="button" className={`rr-pcard ${product.breaking ? "is-breaking" : ""}`} onClick={(event) => onOpen(product.key, event.currentTarget)}>
      <span className="rr-pcard-top">
        <span className="rr-pcard-name">{product.name}</span>
        <ProductBadges product={product} />
      </span>
      <span className="rr-pcard-summary">{product.summary || "No summary available."}</span>
      <span className="rr-pcard-foot">
        <span>{plural(product.updateCount, "update")}</span>
        {product.dates.length > 0 && <span>Released {product.dates.join(", ")}</span>}
        <span className="rr-pcard-cta" aria-hidden="true">
          View updates →
        </span>
      </span>
    </button>
  );
}

function ProductDrawer({ product, env, monthLabel, monthPageUrl, onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("rr-no-scroll");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("rr-no-scroll");
    };
  }, [onClose]);

  return (
    <div className="rr-drawer-layer">
      <div className="rr-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="rr-drawer" role="dialog" aria-modal="true" aria-labelledby="rr-drawer-title">
        <header className="rr-drawer-head">
          <div>
            <p className="rr-drawer-eyebrow">
              {env.short} · {monthLabel}
            </p>
            <h2 id="rr-drawer-title">{product.name}</h2>
            <p className="rr-drawer-meta">
              {plural(product.updateCount, "update")}
              {product.dates.length > 0 && ` · Released ${product.dates.join(", ")}`}
            </p>
            <ProductBadges product={product} />
          </div>
          <button ref={closeRef} type="button" className="rr-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="rr-drawer-body">
          {product.flagMismatch && (
            <p className="rr-note rr-note-warn">UiPath's text mentions a breaking change that the analysis did not flag. Please verify.</p>
          )}

          {product.summaries.length > 0 && (
            <section className="rr-block">
              <h3>Summary</h3>
              {product.summaries.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
            </section>
          )}

          {product.updates.length > 0 && (
            <section className="rr-block">
              <h3>Updates</h3>
              <ol className="rr-updates">
                {product.updates.map((update, i) => (
                  <li key={`${update.name}-${i}`} className={update.breaking_change ? "is-breaking" : ""}>
                    <div className="rr-update-head">
                      <strong>{update.name || "Update"}</strong>
                      {update.breaking_change && <span className="rr-badge rr-badge-breaking">Breaking</span>}
                      {update.when && <span className="rr-when">{update.when}</span>}
                    </div>
                    {update.summary && <p>{update.summary}</p>}
                    {update.impact && (
                      <p className="rr-impact">
                        <span>Impact</span>
                        {update.impact}
                      </p>
                    )}
                    {update.analysis && (
                      <details className="rr-more">
                        <summary>Agent analysis</summary>
                        <p>{update.analysis}</p>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {product.updates.length === 0 && product.pendingItems.length > 0 && (
            <section className="rr-block">
              <h3>What UiPath announced</h3>
              <ul className="rr-pending">
                {product.pendingItems.map((item, i) => (
                  <li key={i}>
                    <InlineText text={item.text} />
                    {item.when && <span className="rr-when">{item.when}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {product.overall.length > 0 && (
            <section className="rr-block">
              <h3>Overall</h3>
              {product.overall.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
            </section>
          )}

          {product.sources.length > 0 && product.updates.length > 0 && (
            <details className="rr-more rr-original">
              <summary>UiPath's original wording</summary>
              {product.sources.map((source, i) => (
                <div key={i} className="rr-original-item">
                  {source.when && <p className="rr-when">{source.when}</p>}
                  <SourceList text={source.text} />
                </div>
              ))}
            </details>
          )}

          <div className="rr-drawer-links">
            {product.links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                {link.label} ↗
              </a>
            ))}
            {monthPageUrl && (
              <a href={monthPageUrl} target="_blank" rel="noreferrer">
                Full {monthLabel} notes on docs.uipath.com ↗
              </a>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function App() {
  const [index, setIndex] = useState(null);
  const [indexError, setIndexError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [month, setMonth] = useState(null);
  const [monthLoading, setMonthLoading] = useState(false);
  const [monthError, setMonthError] = useState("");
  const [envName, setEnvName] = useState("");
  const [query, setQuery] = useState("");
  const [breakingOnly, setBreakingOnly] = useState(false);
  const [openKey, setOpenKey] = useState("");
  const searchRef = useRef(null);
  const openerRef = useRef(null);

  const loadIndex = useCallback(async () => {
    setIndexError("");
    try {
      const data = await provider.loadIndex();
      setIndex(data);
      setSelectedId((current) => {
        if (current && data.months.some((m) => m.id === current)) return current;
        const best = data.months.find((m) => m.kind !== "release-dates");
        return (best || data.months[0])?.id || "";
      });
    } catch (error) {
      setIndexError(`Could not load release data: ${error.message}`);
    }
  }, []);

  useEffect(() => {
    loadIndex();
  }, [loadIndex]);

  useEffect(() => {
    if (!selectedId || !index) return undefined;
    const entry = index.months.find((m) => m.id === selectedId);
    if (!entry) return undefined;
    const controller = new AbortController();
    setMonthLoading(true);
    setMonthError("");
    setOpenKey("");
    provider
      .loadMonth(entry, controller.signal)
      .then((data) => setMonth(data))
      .catch((error) => {
        if (error.name !== "AbortError") setMonthError(`Could not load ${entry.label}: ${error.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setMonthLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, index]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const view = useMemo(() => buildMonthView(month), [month]);
  const env = view.envs.find((e) => e.name === envName) || view.envs[0];
  const products = useMemo(
    () => (env ? env.products.filter((p) => productMatches(p, query.trim(), breakingOnly)) : []),
    [env, query, breakingOnly],
  );
  const breakingList = useMemo(
    () => (env ? env.products.flatMap((p) => p.updates.filter((u) => u.breaking_change).map((u) => ({ product: p, update: u }))) : []),
    [env],
  );
  const openProduct = env?.products.find((p) => p.key === openKey) || null;
  const selectedEntry = index?.months.find((m) => m.id === selectedId);

  const open = useCallback((key, opener) => {
    openerRef.current = opener || null;
    setOpenKey(key);
  }, []);
  const close = useCallback(() => {
    setOpenKey("");
    openerRef.current?.focus?.();
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="Release Radar home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            release
            <br />
            <strong>radar</strong>
          </span>
        </a>
        <div className="sidebar-label">Months</div>
        <nav className="rr-month-list" aria-label="Months">
          {(index?.months || []).map((m) => (
            <button
              key={m.id}
              type="button"
              className={`product-link ${m.id === selectedId ? "active" : ""}`}
              aria-current={m.id === selectedId ? "page" : undefined}
              onClick={() => setSelectedId(m.id)}
            >
              <span className="rr-dot" />
              {m.label}
              {m.counts?.breakingChanges > 0 && (
                <span className="nav-count" title={`${m.counts.breakingChanges} breaking change(s)`}>
                  {m.counts.breakingChanges} breaking
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="status-indicator">
            <span />
            Data {index?.updatedAt ? `updated ${formatDateTime(index.updatedAt)}` : "loading"}
          </div>
          <p>Internal release intelligence for the Accelirate automation team.</p>
          <a href="https://docs.uipath.com/release-notes" target="_blank" rel="noreferrer">
            UiPath release notes ↗
          </a>
        </div>
      </aside>

      <main id="top" className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <b>/</b>Release radar
          </div>
          <div className="topbar-actions">
            {ADMIN_RERUN_URL && (
              <a className="rr-admin-link" href={ADMIN_RERUN_URL} target="_blank" rel="noreferrer" title="Admins only: opens the GitHub Actions workflow to re-run the analysis">
                Re-run analysis (admin) ↗
              </a>
            )}
            <button className="icon-button" type="button" title="Reload data" aria-label="Reload data" onClick={loadIndex}>
              ↻
            </button>
          </div>
        </header>

        <section className="rr-intro" aria-labelledby="pageTitle">
          <p className="eyebrow">UiPath Automation Cloud / release intelligence</p>
          <h1 id="pageTitle">
            Know what <em>just shipped.</em>
          </h1>
          <p className="rr-intro-text">Every UiPath product update of the month in one place, with impact and breaking changes called out.</p>
        </section>

        {indexError && (
          <div className="rr-alert" role="alert">
            {indexError}{" "}
            <button type="button" className="rr-link-btn" onClick={loadIndex}>
              Try again
            </button>
          </div>
        )}
        {!indexError && index && index.months.length === 0 && (
          <div className="loading-state">
            No month has been analysed yet. Run start-local.bat on your PC, or the Release Radar workflow on GitHub, once.
          </div>
        )}
        {!index && !indexError && <div className="loading-state">Loading release data…</div>}

        {selectedEntry && (
          <section className="rr-month" aria-labelledby="monthTitle">
            <div className="rr-month-head">
              <div>
                <p className="eyebrow">Release notes</p>
                <h2 id="monthTitle">{selectedEntry.label}</h2>
              </div>
              <div className="rr-month-meta">
                {month?.generatedAt && <span className="rr-muted-mono">Updated {formatDateTime(month.generatedAt)}</span>}
                {month?.source?.pageUrl && (
                  <a className="rr-muted-mono" href={month.source.pageUrl} target="_blank" rel="noreferrer">
                    Full notes on docs.uipath.com ↗
                  </a>
                )}
              </div>
            </div>

            {monthLoading && <div className="loading-state">Loading {selectedEntry.label}…</div>}
            {monthError && (
              <div className="rr-alert" role="alert">
                {monthError}
              </div>
            )}

            {month && !monthLoading && !monthError && env && (
              <>
                <div className="rr-tabs" role="tablist" aria-label="Cloud">
                  {view.envs.map((e) => (
                    <button
                      key={e.name}
                      type="button"
                      role="tab"
                      aria-selected={e.name === env.name}
                      className={`rr-tab ${e.name === env.name ? "active" : ""}`}
                      title={e.name}
                      onClick={() => {
                        setEnvName(e.name);
                        setOpenKey("");
                      }}
                    >
                      {e.short}
                      <span className="rr-tab-count">{e.stats.products || e.catalogOnly.length}</span>
                    </button>
                  ))}
                </div>

                {env.products.length > 0 ? (
                  <div className="rr-kpis">
                    <div className="rr-kpi">
                      <strong>{env.stats.products}</strong>
                      <span>products updated</span>
                    </div>
                    <div className="rr-kpi">
                      <strong>{env.stats.updates}</strong>
                      <span>updates</span>
                    </div>
                    <div className={`rr-kpi ${env.stats.breaking ? "is-breaking" : ""}`}>
                      <strong>{env.stats.breaking}</strong>
                      <span>breaking changes</span>
                    </div>
                    <div className="rr-kpi">
                      <strong>{env.latestRelease || "-"}</strong>
                      <span>latest release</span>
                    </div>
                  </div>
                ) : (
                  <div className="rr-kpis rr-kpis-2">
                    <div className="rr-kpi">
                      <strong>{env.catalogOnly.length}</strong>
                      <span>products released</span>
                    </div>
                    <div className="rr-kpi">
                      <strong>{env.latestRelease || "-"}</strong>
                      <span>latest release</span>
                    </div>
                  </div>
                )}

                {breakingList.length > 0 && (
                  <div className="rr-breaking" role="region" aria-label="Breaking changes">
                    <p className="rr-breaking-title">
                      ⚠ {plural(breakingList.length, "breaking change")} in {env.short} this month
                    </p>
                    <ul>
                      {breakingList.map(({ product, update }, i) => (
                        <li key={`${product.key}-${i}`}>
                          <button type="button" onClick={(event) => open(product.key, event.currentTarget)}>
                            <strong>{product.name}</strong> — {update.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {env.products.length > 0 && (
                  <div className="rr-toolbar">
                    <label className="rr-search">
                      <span aria-hidden="true">⌕</span>
                      <input
                        ref={searchRef}
                        type="search"
                        value={query}
                        placeholder={`Search ${env.short} products and updates`}
                        aria-label="Search products and updates"
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      <kbd>/</kbd>
                    </label>
                    <label className="rr-toggle">
                      <input type="checkbox" checked={breakingOnly} onChange={(event) => setBreakingOnly(event.target.checked)} />
                      Breaking only
                    </label>
                  </div>
                )}

                {env.products.length === 0 && (
                  <p className="rr-note">
                    For {selectedEntry.label}, UiPath published only release dates for {env.short} (no highlight text to analyse).
                  </p>
                )}
                {env.products.length > 0 && products.length === 0 && <div className="loading-state">No products match the current filters.</div>}

                <div className="rr-pgrid">
                  {products.map((product) => (
                    <ProductCard key={product.key} product={product} onOpen={open} />
                  ))}
                </div>

                {env.products.length === 0 && env.catalogOnly.length > 0 && (
                  <div className="rr-pgrid">
                    {env.catalogOnly.map((item) => (
                      <ReleasedCard key={item.key} item={item} />
                    ))}
                  </div>
                )}

                {env.products.length > 0 && env.catalogOnly.length > 0 && !query && !breakingOnly && (
                  <section className="rr-also">
                    <h3>Also released in {selectedEntry.label} (no highlights published)</h3>
                    <ul>
                      {env.catalogOnly.map((item) => (
                        <li key={item.key}>
                          {item.links[0] ? (
                            <a href={item.links[0].url} target="_blank" rel="noreferrer">
                              {item.name} ↗
                            </a>
                          ) : (
                            <span>{item.name}</span>
                          )}
                          {item.dates.length > 0 && <span className="rr-when">{item.dates.join(", ")}</span>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </section>
        )}

        <footer className="footer">
          <span>Release Radar v1.2</span>
          <span>AI-generated from UiPath's public release notes. Always confirm critical changes in the source.</span>
        </footer>
      </main>

      {openProduct && env && (
        <ProductDrawer product={openProduct} env={env} monthLabel={selectedEntry?.label || ""} monthPageUrl={month?.source?.pageUrl} onClose={close} />
      )}
    </div>
  );
}

export default App;
