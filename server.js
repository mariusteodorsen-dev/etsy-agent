const express = require("express");
const cron    = require("node-cron");
const axios   = require("axios");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const CFG = {
  ANTHROPIC_KEY:     process.env.ANTHROPIC_KEY     || "",
  ETSY_API_KEY:      process.env.ETSY_API_KEY      || "",
  ETSY_SHOP_ID:      process.env.ETSY_SHOP_ID      || "",
  ETSY_ACCESS_TOKEN: process.env.ETSY_ACCESS_TOKEN || "",
  PINTEREST_TOKEN:   process.env.PINTEREST_TOKEN   || "",
  PINTEREST_BOARD:   process.env.PINTEREST_BOARD   || "",
  PORT:              process.env.PORT               || 3001,
};

const DEFAULT_NICHES = [
  "digitale planleggere og produktivitetsverktoey",
  "SVG-filer for Cricut og hjemdekor",
  "personlige kartverk og reiseplakater",
  "selvhjelp og mental helse arbeidsark",
  "baby og barnegaver print-on-demand",
  "brudepike og bryllupsgaver digitale",
  "hundeportrett og kjaeledy rgaver",
  "vintagekokebok og oppskriftsmal",
  "budsjettplanlegger og oekonomiark",
  "treningslogg og helsesporing",
];

const DATA_FILE = path.join(__dirname, "data.json");

function defaultState() {
  return {
    running: false, products: [], queue: [], launched: [], promoted: [], logs: [],
    stats: { etsy: 0, pinterest: 0, pendingApproval: 0, cycles: 0, totalViews: 0, estimatedRevenue: 0 },
    nicheStats: {}, activeNiches: DEFAULT_NICHES.slice(),
    lastCycle: null, lastStrategy: null, lastImprovement: null,
    lastPerformanceCheck: null, nextCycleAt: null,
  };
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      var saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return Object.assign(defaultState(), saved, { running: false });
    }
  } catch (e) { console.error("Kunne ikke laste data:", e.message); }
  return defaultState();
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      products: state.products.slice(-300), launched: state.launched.slice(-1000),
      promoted: state.promoted.slice(-500), queue: state.queue,
      logs: state.logs.slice(-200), stats: state.stats, nicheStats: state.nicheStats,
      activeNiches: state.activeNiches, lastCycle: state.lastCycle,
      lastStrategy: state.lastStrategy, lastImprovement: state.lastImprovement,
      lastPerformanceCheck: state.lastPerformanceCheck, nextCycleAt: state.nextCycleAt,
    }, null, 2));
  } catch (e) { console.error("Feil ved lagring:", e.message); }
}

var state = loadState();
var nicheIdx = 0;

function log(msg, type) {
  if (!type) type = "info";
  var entry = { t: new Date().toISOString(), msg: msg, type: type };
  state.logs = state.logs.slice(-400).concat([entry]);
  console.log("[" + type.toUpperCase() + "] " + msg);
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function trackNiche(niche, field, amount) {
  if (!amount) amount = 1;
  if (!state.nicheStats[niche]) state.nicheStats[niche] = { cycles: 0, products: 0, views: 0, favorites: 0 };
  state.nicheStats[niche][field] = (state.nicheStats[niche][field] || 0) + amount;
}

async function callClaude(sys, user, maxTok) {
  if (!maxTok) maxTok = 1500;
  if (!CFG.ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY mangler");
  var res = await axios({
    method: "post",
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": CFG.ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    data: { model: "claude-sonnet-4-6", max_tokens: maxTok, system: sys, messages: [{ role: "user", content: user }] },
    timeout: 60000,
  });
  return res.data.content.map(function(b) { return b.text || ""; }).join("").trim();
}

async function generateProducts(niche) {
  log("Claude genererer produkter for: " + niche);
  var p = "Generer 3 unike Etsy-digitalprodukter for nisjen: " + niche + ". ";
  p += "SEO-titler maks 140 tegn, pris $4.99-$19.99, 13 tags maks 20 tegn hver. ";
  p += "Svar KUN med JSON: {\"products\":[{\"title\":\"SEO-tittel\",\"description\":\"250 ord\",\"price\":9.99,";
  p += "\"tags\":[\"t1\",\"t2\",\"t3\",\"t4\",\"t5\",\"t6\",\"t7\",\"t8\",\"t9\",\"t10\",\"t11\",\"t12\",\"t13\"],";
  p += "\"category\":\"Digital Downloads\",\"type\":\"digital\",\"imageKeyword\":\"planner\",";
  p += "\"pinterest_caption\":\"pin tekst #hashtag\",";
  p += "\"instagram_caption\":\"caption med emojis og #hashtags\",";
  p += "\"tiktok_hook\":\"15-sek hook\",";
  p += "\"tiktok_script\":\"30-sek video manus\",";
  p += "\"facebook_caption\":\"facebook post med emojis\"}]}";
  var raw = await callClaude("Du er Etsy-ekspert. Svar KUN med gyldig JSON, ingen markdown.", p, 3500);
  var json = JSON.parse(raw.replace(/```json/gi, "").replace(/```/gi, "").trim());
  return json.products || [];
}

async function runStrategyAnalysis() {
  log("AI-strategi-analyse starter...", "strategy");
  try {
    var nd = Object.entries(state.nicheStats).map(function(e) {
      return e[0] + ": " + (e[1].products || 0) + " prod, " + (e[1].views || 0) + " vis";
    }).join("\n") || "Ingen data";
    var p = "Analyser Etsy-butikk og optimaliser.\nNISJER:\n" + nd;
    p += "\nTOTALT: " + state.stats.etsy + " prod, " + state.stats.cycles + " sykl";
    p += "\nJSON: {\"analysis\":\"tekst\",\"topNiches\":[\"n1\",\"n2\"],\"newNichesToTest\":[\"n1\"],\"pricingAdvice\":\"tekst\",\"nextWeekFocus\":\"tekst\",\"promotionTips\":\"tekst\"}";
    var raw = await callClaude("Etsy-strateg. Svar KUN med JSON.", p, 1200);
    var s = JSON.parse(raw.replace(/```json/gi, "").replace(/```/gi, "").trim());
    if (s.newNichesToTest) s.newNichesToTest.forEach(function(n) { if (!state.activeNiches.includes(n)) state.activeNiches.push(n); });
    state.activeNiches = state.activeNiches.slice(0, 12);
    state.lastStrategy = Object.assign({ date: new Date().toISOString() }, s);
    log("Strategi oppdatert: " + s.analysis, "strategy");
    saveState();
  } catch (err) { log("Strategi feilet: " + err.message, "error"); }
}

async function runDailyImprovement() {
  log("Daglig AI-selvforbedring starter...", "strategy");
  try {
    var nd = Object.entries(state.nicheStats).map(function(e) {
      return e[0] + ": " + (e[1].products || 0) + " prod, " + (e[1].views || 0) + " vis, " + (e[1].favorites || 0) + " fav";
    }).join("\n") || "Ingen data";
    var p = "Daglig analyse. STATS: " + state.stats.cycles + " sykl, " + state.stats.etsy + " prod.\nNISJER:\n" + nd;
    p += "\nJSON: {\"todayFocus\":\"fokus idag\",\"nichesToBoost\":[\"n1\"],\"nichesToDrop\":[\"n1\"],\"priceTip\":\"tip\",\"contentTip\":\"tip\"}";
    var raw = await callClaude("Etsy-forbedrer. Svar KUN med JSON.", p, 800);
    var r = JSON.parse(raw.replace(/```json/gi, "").replace(/```/gi, "").trim());
    if (r.nichesToBoost) r.nichesToBoost.forEach(function(n) { if (!state.activeNiches.includes(n)) state.activeNiches.push(n); });
    if (r.nichesToDrop) state.activeNiches = state.activeNiches.filter(function(n) { return !r.nichesToDrop.includes(n); });
    state.activeNiches = state.activeNiches.slice(0, 12);
    state.lastImprovement = Object.assign({ date: new Date().toISOString() }, r);
    log("Daglig fokus: " + r.todayFocus, "strategy");
    saveState();
  } catch (err) { log("Daglig forbedring feilet: " + err.message, "error"); }
}

async function checkEtsyPerformance() {
  log("Sjekker Etsy-ytelse...", "info");
  if (!CFG.ETSY_API_KEY || !CFG.ETSY_SHOP_ID) { log("Etsy-nokler mangler", "warn"); return; }
  try {
    var res = await axios({
      method: "get",
      url: "https://openapi.etsy.com/v3/application/shops/" + CFG.ETSY_SHOP_ID + "/listings/active?limit=25",
      headers: { "x-api-key": CFG.ETSY_API_KEY, "Authorization": "Bearer " + CFG.ETSY_ACCESS_TOKEN },
      timeout: 15000,
    });
    var listings = res.data.results || [];
    var total = 0;
    listings.forEach(function(l) {
      total += l.views || 0;
      var p = state.launched.find(function(x) { return String(x.etsyId) === String(l.listing_id); });
      if (p) { p.views = l.views || 0; p.favorites = l.num_favorers || 0; }
    });
    state.stats.totalViews = total;
    state.lastPerformanceCheck = new Date().toISOString();
    log("Visninger: " + total + " | Listings: " + listings.length, "success");
    saveState();
  } catch (err) { log("Ytelsessjekk feilet: " + err.message, "error"); }
}

function getImgUrl(kw) {
  var c = { planner:"1a1a2e/B8FF47", wedding:"2d1b69/FFD6E7", svg:"0f3460/00E87A",
    baby:"533483/FFE4B5", dog:"1e3a5f/FFA500", budget:"0d2137/00D4FF", recipe:"3d1a00/FF8C42", fitness:"1a3a1a/B8FF47" };
  var k = Object.keys(c).find(function(x) { return (kw || "").toLowerCase().includes(x); }) || "planner";
  var pts = c[k].split("/");
  return "https://via.placeholder.com/600x900/" + pts[0] + "/" + pts[1] + "?text=" + encodeURIComponent((kw || "Product").slice(0, 20));
}

async function listOnEtsy(product) {
  if (!CFG.ETSY_API_KEY || !CFG.ETSY_SHOP_ID) {
    log("Simulerer Etsy-lansering (MOCK)", "warn");
    return { listing_id: "MOCK_" + Date.now(), url: "https://etsy.com/listing/mock" };
  }
  var res = await axios({
    method: "post",
    url: "https://openapi.etsy.com/v3/application/shops/" + CFG.ETSY_SHOP_ID + "/listings",
    headers: { "x-api-key": CFG.ETSY_API_KEY, "Authorization": "Bearer " + CFG.ETSY_ACCESS_TOKEN, "Content-Type": "application/json" },
    data: {
      quantity: 999, title: product.title.slice(0, 140), description: product.description,
      price: { amount: Math.round(product.price * 100), divisor: 100, currency_code: "USD" },
      who_made: "i_did", when_made: "made_to_order", taxonomy_id: 2078,
      tags: (product.tags || []).slice(0, 13), type: "download", is_digital: true,
      should_auto_renew: true, state: "active",
    },
    timeout: 20000,
  });
  return res.data;
}

async function pinOnPinterest(product, etsyUrl) {
  if (!CFG.PINTEREST_TOKEN || !CFG.PINTEREST_BOARD) {
    log("Simulerer Pinterest-pin (MOCK)", "warn");
    return { id: "PIN_" + Date.now() };
  }
  var res = await axios({
    method: "post", url: "https://api.pinterest.com/v5/pins",
    headers: { "Authorization": "Bearer " + CFG.PINTEREST_TOKEN, "Content-Type": "application/json" },
    data: { board_id: CFG.PINTEREST_BOARD, title: product.title.slice(0, 100),
      description: product.pinterest_caption, link: etsyUrl,
      media_source: { source_type: "image_url", url: getImgUrl(product.imageKeyword || "") } },
    timeout: 20000,
  });
  return res.data;
}

async function withRetry(fn, n) {
  if (!n) n = 3;
  for (var i = 0; i < n; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === n - 1) throw err;
      log("Forsok " + (i+1) + "/" + n + " feilet: " + err.message, "warn");
      await sleep(2000 * (i + 1));
    }
  }
}

async function runAgentCycle() {
  if (!state.running) return;
  state.stats.cycles++;
  var niches = (state.activeNiches && state.activeNiches.length) ? state.activeNiches : DEFAULT_NICHES;
  var niche = niches[nicheIdx % niches.length];
  nicheIdx++;
  log("=== SYKLUS " + state.stats.cycles + " === " + niche, "cycle");
  trackNiche(niche, "cycles");
  try {
    var products = await withRetry(function() { return generateProducts(niche); });
    log(products.length + " produkter generert", "info");
    trackNiche(niche, "products", products.length);
    for (var i = 0; i < products.length; i++) {
      var product = products[i];
      if (!state.running) break;
      product.id = "P_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      product.niche = niche; product.generatedAt = new Date().toISOString();
      product.views = 0; product.favorites = 0;
      try {
        var listing = await withRetry(function() { return listOnEtsy(product); });
        var etsyUrl = listing.url || "https://etsy.com/listing/" + listing.listing_id;
        product.etsyId = listing.listing_id; product.etsyUrl = etsyUrl;
        product.status = "launched"; product.launchedAt = new Date().toISOString();
        state.launched.push(product);
        state.stats.etsy++;
        state.stats.estimatedRevenue = parseFloat((state.stats.estimatedRevenue + product.price * 0.15).toFixed(2));
        log("Etsy: " + product.title.slice(0, 50) + " ($" + product.price + ")", "success");
        await sleep(1500);
        var pin = await withRetry(function() { return pinOnPinterest(product, etsyUrl); });
        product.pinterestId = pin.id; state.stats.pinterest++;
        log("Pinterest: " + product.title.slice(0, 40), "success");
        state.queue.push({
          id: "Q_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          title: product.title, description: product.description, price: product.price,
          niche: product.niche, etsyUrl: etsyUrl, imageKeyword: product.imageKeyword,
          instagram_caption: product.instagram_caption, tiktok_hook: product.tiktok_hook,
          tiktok_script: product.tiktok_script, pinterest_caption: product.pinterest_caption,
          facebook_caption: product.facebook_caption,
          platforms: ["tiktok", "instagram", "pinterest", "facebook"],
          queuedAt: new Date().toISOString(),
        });
        state.stats.pendingApproval = state.queue.length;
        log("Lagt i koen for sosiale medier", "info");
      } catch (err) { log("Feil: " + (product.title || "").slice(0, 30) + ": " + err.message, "error"); }
      await sleep(2000);
    }
    state.lastCycle = new Date().toISOString();
    state.nextCycleAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    state.products = state.products.concat(products).slice(-300);
    log("Syklus " + state.stats.cycles + " ferdig! Totalt: " + state.stats.etsy + " pa Etsy", "success");
    saveState();
  } catch (err) { log("Syklus feilet: " + err.message, "error"); saveState(); }
}

cron.schedule("0 */2 * * *",  function() { if (state.running) runAgentCycle(); });
cron.schedule("0 8 * * *",    function() { if (state.running) checkEtsyPerformance(); });
cron.schedule("0 7 * * *",    function() { if (state.running) runStrategyAnalysis(); });
cron.schedule("0 6 * * *",    function() { if (state.running) runDailyImprovement(); });
cron.schedule("*/10 * * * *", saveState);

app.get("/status",      function(req, res) { res.json({ running: state.running, stats: state.stats, lastCycle: state.lastCycle, nextCycleAt: state.nextCycleAt, lastStrategy: state.lastStrategy, lastImprovement: state.lastImprovement, lastPerformanceCheck: state.lastPerformanceCheck, activeNiches: state.activeNiches }); });
app.get("/products",    function(req, res) { res.json(state.products.slice(-20)); });
app.get("/launched",    function(req, res) { res.json(state.launched.slice().reverse().slice(0, 30)); });
app.get("/queue",       function(req, res) { res.json(state.queue); });
app.get("/logs",        function(req, res) { res.json(state.logs.slice(-150)); });
app.get("/stats",       function(req, res) { res.json(state.stats); });
app.get("/strategy",    function(req, res) { res.json(state.lastStrategy || { analysis: "Ingen strategi ennaa" }); });
app.get("/improvement", function(req, res) { res.json(state.lastImprovement || { todayFocus: "Ingen analyse ennaa" }); });
app.get("/niches",      function(req, res) { res.json({ active: state.activeNiches || DEFAULT_NICHES, stats: state.nicheStats }); });
app.get("/health",      function(req, res) { res.json({ status: "ok", uptime: process.uptime() }); });
app.get("/debug",       function(req, res) { res.json({ key: CFG.ANTHROPIC_KEY ? CFG.ANTHROPIC_KEY.slice(0,15) + "..." : "MANGLER", model: "claude-sonnet-4-6" }); });

app.post("/start",           function(req, res) { state.running = true; log("Agent startet! 24/7 aktivert.", "success"); runAgentCycle(); res.json({ ok: true }); });
app.post("/stop",            function(req, res) { state.running = false; state.nextCycleAt = null; log("Agent stoppet", "warn"); saveState(); res.json({ ok: true }); });
app.post("/run-now",         function(req, res) { runAgentCycle(); res.json({ ok: true }); });
app.post("/run-strategy",    function(req, res) { runStrategyAnalysis(); res.json({ ok: true }); });
app.post("/run-performance", function(req, res) { checkEtsyPerformance(); res.json({ ok: true }); });
app.post("/run-improvement", function(req, res) { runDailyImprovement(); res.json({ ok: true }); });

app.post("/approve/:id", function(req, res) {
  var item = state.queue.find(function(q) { return q.id === req.params.id; });
  if (!item) return res.status(404).json({ error: "Ikke funnet" });
  state.queue = state.queue.filter(function(q) { return q.id !== req.params.id; });
  state.promoted = state.promoted.concat([Object.assign({}, item, { approvedAt: new Date().toISOString() })]);
  state.stats.pendingApproval = state.queue.length;
  log("Godkjent: " + (item.title || "").slice(0, 40), "success");
  saveState(); res.json({ ok: true, item: item });
});

app.delete("/queue/:id", function(req, res) {
  state.queue = state.queue.filter(function(q) { return q.id !== req.params.id; });
  state.stats.pendingApproval = state.queue.length;
  saveState(); res.json({ ok: true });
});

app.post("/niches", function(req, res) {
  var n = (req.body.niche || "").trim();
  if (!n) return res.status(400).json({ error: "niche er pakrevd" });
  if (!state.activeNiches.includes(n)) { state.activeNiches.push(n); saveState(); }
  res.json({ ok: true, active: state.activeNiches });
});

app.delete("/niches", function(req, res) {
  var n = (req.body.niche || "");
  state.activeNiches = state.activeNiches.filter(function(x) { return x !== n; });
  saveState(); res.json({ ok: true, active: state.activeNiches });
});

app.listen(CFG.PORT, function() {
  log("Etsy AI Agent v3.0 kjorer pa port " + CFG.PORT, "success");
  log("Etsy: " + (CFG.ETSY_API_KEY ? "konfigurert" : "MANGLER nokkel"), "info");
  log("Pinterest: " + (CFG.PINTEREST_TOKEN ? "konfigurert" : "MANGLER token"), "info");
  log("Claude AI: " + (CFG.ANTHROPIC_KEY ? "konfigurert" : "MANGLER nokkel"), "info");
});
