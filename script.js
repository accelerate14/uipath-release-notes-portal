const monthDefinitions = ["january", "february", "march", "april", "may", "june", "july", "august"].map((month) => ({
  value: month,
  label: month[0].toUpperCase() + month.slice(1),
  slug: `cloud-platform-${month}-2026`
}));
const apiBase = "https://docs.uipath.com/_next/data/docs-build-134/release-notes/other/latest/release-notes/";
const state = { releases: [], filter: "All", product: "All", month: "All", deployment: "All", query: "", sort: "newest", showBookmarks: false, bookmarks: JSON.parse(localStorage.getItem("releaseBookmarks") || "[]") };
const list = document.querySelector("#releaseList");
const emptyState = document.querySelector("#emptyState");
const resultCount = document.querySelector("#resultCount");
const bookmarkCount = document.querySelector("#bookmarkCount");
const allCount = document.querySelector("#allCount");
const toast = document.querySelector("#toast");
const loadingState = document.querySelector("#loadingState");
let toastTimer;

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]));
}

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
      const links = [...row.querySelectorAll("a")].map((link) => ({ label: link.textContent.trim(), href: link.href }));
      releases.push({ id: `${month.value}-${releases.length}-${product}`, month: month.label, monthValue: month.value, year: "2026", day: date.match(/\b\d{1,2}\b/)?.[0] || "--", title: `${product} release notes`, description: date === "N/A" ? "No release-note entry was published during this timeframe." : `${deployment} release catalog entry published on ${date}.`, product, deployment, type: status, tag: status === "Available" ? "Published" : "None", link: links[0]?.href || "https://docs.uipath.com/release-notes" });
    });
  });
  return releases;
}

async function loadReleases() {
  loadingState.hidden = false;
  const payloads = await Promise.all(monthDefinitions.map(async (month) => {
    const query = new URLSearchParams({ productSlug: "release-notes", deliveryOption: "other", versionSlug: "latest", publicationType: "release-notes", topicSlug: month.slug });
    const response = await fetch(`${apiBase}${month.slug}.json?${query}`);
    if (!response.ok) throw new Error(`${month.label} request failed (${response.status})`);
    return { month, payload: await response.json() };
  }));
  state.releases = payloads.flatMap(({ month, payload }) => parseMonthPayload(payload, month));
  populateFilters();
  updateOverview();
  loadingState.hidden = true;
  render();
}

function populateFilters() {
  const options = (selector, values, label) => { document.querySelector(selector).innerHTML = `<option value="All">All ${label}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`; };
  document.querySelector("#monthSelect").innerHTML = `<option value="All">All months</option>${monthDefinitions.map((month) => `<option value="${month.value}">${month.label}</option>`).join("")}`;
  options("#deploymentSelect", [...new Set(state.releases.map((release) => release.deployment))].sort(), "deployments");
  options("#productSelect", [...new Set(state.releases.map((release) => release.product))].sort(), "products");
  document.querySelector("#productNav").innerHTML = [...new Set(state.releases.map((release) => release.product))].sort().slice(0, 8).map((product) => `<button class="product-link" data-product="${escapeHtml(product)}"><span class="product-dot"></span>${escapeHtml(product)}</button>`).join("");
  document.querySelectorAll(".product-link").forEach((button) => button.addEventListener("click", () => { state.product = state.product === button.dataset.product ? "All" : button.dataset.product; document.querySelector("#productSelect").value = state.product; state.showBookmarks = false; render(); document.querySelector("#updates").scrollIntoView({ behavior: "smooth" }); }));
}

function updateOverview() {
  const products = new Set(state.releases.map((release) => release.product));
  document.querySelector("#totalCount").textContent = state.releases.length;
  document.querySelector("#totalNote").textContent = `${products.size} products across 8 months`;
  document.querySelector("#monthCount").textContent = monthDefinitions.length;
  document.querySelector("#productCount").textContent = products.size;
  document.querySelector("#lastPublished").textContent = "AUG";
}

function getVisibleReleases() {
  const query = state.query.toLowerCase().trim();
  return state.releases.filter((release) => {
    const matchesType = state.filter === "All" || release.type === state.filter;
    const matchesProduct = state.product === "All" || release.product === state.product;
    const matchesMonth = state.month === "All" || release.monthValue === state.month;
    const matchesDeployment = state.deployment === "All" || release.deployment === state.deployment;
    const matchesQuery = !query || [release.title, release.description, release.product, release.deployment, release.type].join(" ").toLowerCase().includes(query);
    const matchesBookmarks = !state.showBookmarks || state.bookmarks.includes(release.id);
    return matchesType && matchesProduct && matchesMonth && matchesDeployment && matchesQuery && matchesBookmarks;
  }).sort((a, b) => { const monthDifference = monthDefinitions.findIndex((month) => month.value === b.monthValue) - monthDefinitions.findIndex((month) => month.value === a.monthValue); return state.sort === "newest" ? monthDifference || Number(b.day) - Number(a.day) : -monthDifference || Number(a.day) - Number(b.day); });
}

function render() {
  const visible = getVisibleReleases();
  list.innerHTML = visible.map((release, index) => `
    <article class="release-row" style="animation-delay:${index * 15}ms">
      <time class="release-date"><strong>${escapeHtml(release.day)}</strong>${escapeHtml(release.month.slice(0, 3).toUpperCase())} '${release.year.slice(2)}</time>
      <button class="release-title" data-open="${escapeHtml(release.id)}" aria-label="Read details for ${escapeHtml(release.title)}">
        <span class="type-mark ${release.type === "No release" ? "improvement" : ""}"></span>
        <span><h3>${escapeHtml(release.title)}</h3><p>${escapeHtml(release.description)}</p></span>
      </button>
      <span class="release-product">${escapeHtml(release.product)}</span>
      <span class="release-badge">${escapeHtml(release.tag)}</span>
      <button class="bookmark-button ${state.bookmarks.includes(release.id) ? "saved" : ""}" data-bookmark="${escapeHtml(release.id)}" aria-label="${state.bookmarks.includes(release.id) ? "Remove" : "Save"} bookmark">${state.bookmarks.includes(release.id) ? "★" : "☆"}</button>
    </article>`).join("");
  emptyState.hidden = visible.length > 0;
  resultCount.textContent = `${String(visible.length).padStart(2, "0")} update${visible.length === 1 ? "" : "s"}`;
  bookmarkCount.textContent = String(state.bookmarks.length).padStart(2, "0");
  allCount.textContent = String(state.releases.length).padStart(2, "0");
}

function showToast(message) { toast.textContent = message; toast.classList.add("visible"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200); }

function openDetails(id) {
  const release = state.releases.find((item) => item.id === id);
  if (!release) return;
  document.querySelector("#dialogContent").innerHTML = `<p class="dialog-kicker">${escapeHtml(release.product)} / ${escapeHtml(release.deployment)}</p><h2>${escapeHtml(release.title)}</h2><p class="dialog-description">${escapeHtml(release.description)}</p><div class="dialog-details"><span>${escapeHtml(release.day)} ${escapeHtml(release.month)} 2026</span><span>•</span><span>${escapeHtml(release.tag)}</span></div><a class="dialog-link" href="${escapeHtml(release.link)}" target="_blank" rel="noreferrer">Read official notes ↗</a>`;
  document.querySelector("#releaseDialog").showModal();
}

document.querySelector("#searchInput").addEventListener("input", (event) => { state.query = event.target.value; render(); });
document.querySelector("#sortSelect").addEventListener("change", (event) => { state.sort = event.target.value; render(); });
document.querySelector("#monthSelect").addEventListener("change", (event) => { state.month = event.target.value; render(); });
document.querySelector("#deploymentSelect").addEventListener("change", (event) => { state.deployment = event.target.value; render(); });
document.querySelector("#productSelect").addEventListener("change", (event) => { state.product = event.target.value; render(); });
document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".filter-button").forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.filter; render(); }));
document.querySelector("#bookmarksNav").addEventListener("click", () => { state.showBookmarks = true; document.querySelector("#bookmarksNav").classList.add("active"); document.querySelector(".nav-item[href=\"#updates\"]").classList.remove("active"); document.querySelector("#updatesTitle").textContent = "Bookmarked updates"; document.querySelector("#updates").scrollIntoView({ behavior: "smooth" }); render(); });
document.querySelector(".nav-item[href=\"#updates\"]").addEventListener("click", () => { state.showBookmarks = false; document.querySelector("#bookmarksNav").classList.remove("active"); document.querySelector(".nav-item[href=\"#updates\"]").classList.add("active"); document.querySelector("#updatesTitle").textContent = "Latest updates"; render(); });
list.addEventListener("click", (event) => { const bookmark = event.target.closest("[data-bookmark]"); if (bookmark) { const id = bookmark.dataset.bookmark; state.bookmarks = state.bookmarks.includes(id) ? state.bookmarks.filter((item) => item !== id) : [...state.bookmarks, id]; localStorage.setItem("releaseBookmarks", JSON.stringify(state.bookmarks)); render(); showToast(state.bookmarks.includes(id) ? "Release bookmarked" : "Bookmark removed"); return; } const title = event.target.closest("[data-open]"); if (title) openDetails(title.dataset.open); });
document.querySelector("#dialogClose").addEventListener("click", () => document.querySelector("#releaseDialog").close());
document.querySelector("#releaseDialog").addEventListener("click", (event) => { if (event.target.id === "releaseDialog") event.target.close(); });
document.querySelector("#clearFilters").addEventListener("click", () => { state.filter = "All"; state.product = "All"; state.month = "All"; state.deployment = "All"; state.query = ""; state.showBookmarks = false; document.querySelector("#searchInput").value = ""; ["monthSelect", "deploymentSelect", "productSelect"].forEach((id) => { document.querySelector(`#${id}`).value = "All"; }); document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("active", item.dataset.filter === "All")); document.querySelector("#bookmarksNav").classList.remove("active"); document.querySelector(".nav-item[href=\"#updates\"]").classList.add("active"); document.querySelector("#updatesTitle").textContent = "Latest updates"; render(); });
document.querySelector("#refreshButton").addEventListener("click", async () => { const button = document.querySelector("#refreshButton"); button.disabled = true; button.style.transform = "rotate(360deg)"; try { await loadReleases(); document.querySelector("#lastUpdated").textContent = "Updated just now"; showToast("Feed refreshed"); } catch (error) { showToast(error.message); } finally { button.disabled = false; button.style.transform = ""; } });
document.addEventListener("keydown", (event) => { if (event.key === "/" && document.activeElement.tagName !== "INPUT") { event.preventDefault(); document.querySelector("#searchInput").focus(); } });
loadReleases().catch((error) => { loadingState.textContent = `Could not load UiPath release notes: ${error.message}`; showToast("Feed unavailable"); });
