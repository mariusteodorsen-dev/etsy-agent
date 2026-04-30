const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const CFG = {
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY || "",
  ETSY_API_KEY: process.env.ETSY_API_KEY || "",
  ETSY_SHOP_ID: process.env.ETSY_SHOP_ID || "",
  ETSY_ACCESS_TOKEN: process.env.ETSY_ACCESS_TOKEN || "",
  PINTEREST_TOKEN: process.env.PINTEREST_TOKEN || "",
  PINTEREST_BOARD: process.env.PINTEREST_BOARD || "",
  PORT: process.env.PORT || 3001,
};

let state = {
  running: false,
  products: [],
  queue: [],
  launched: [],
  promoted: [],
  logs: [],
  stats: { etsy: 0, pinterest: 0, pendingApproval: 0, cycles: 0 },
  lastCycle: null,
};

function log(msg, type = "info") {
  const entry = { t: new Date().toISOString(), msg, type };
  state.logs = [...state.logs.slice(-300), entry];
  console.log("[" + type.toUpperCase() + "] " + msg);
}

async function generateProducts(niche) {
  log("Genererer produkter for: " + niche);
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-3-haiku-20240307",
      max_tokens: 1000,
      system: "Du er Etsy-ekspert. Svar KUN med gyldig JSON, ingen markdown.",
      messages: [{
        role: "user",
        content: "Generer 3 Etsy-produkter for nisjen: \"" + niche + "\". JSON-format: {\"products\": [{\"title\": \"SEO-tittel maks 140 tegn\", \"description\": \"200 ord selgende produktbeskrivelse\", \"price\": 9.99, \"tags\": [\"tag1\",\"tag2\",\"tag3\",\"tag4\",\"tag5\"], \"category\": \"kategori\", \"type\": \"digital\", \"pinterest_caption\": \"Pinterest-tekst med hashtags\", \"instagram_caption\": \"Instagram-caption med hashtags\", \"tiktok_hook\": \"TikTok hook\"}]}"
      }]
    },
    {
      headers: {
        "x-api-key": CFG.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      }
    }
  );
  const raw = res.data.content.map(function(b) { return b.text || ""; }).join("");
  const json = JSON.parse(raw.replace(/```json|```/gi, "").trim());
  return json.products || [];
}

async function listOnEtsy(product) {
  if (!CFG.ETSY_API_KEY || !CFG.ETSY_SHOP_ID) {
    log("Etsy-nokler mangler - simulerer lansering", "warn");
    return { listing_id: "MOCK_" + Date.now(), url: "https://etsy.com/listing/mock" };
  }
  const res = await axios.post(
    "https://openapi.etsy.com/v3/application/shops/" + CFG.ETSY_SHOP_ID + "/listings",
    {
      quantity: 999,
      title: product.title,
      description: product.description,
      price: { amount: Math.round(product.price * 100), divisor: 100, currency_code: "USD" },
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: 2078,
      tags: product.tags,
      type: "download",
      is_digital: true,
      should_auto_renew: true,
      state: "active",
    },
    {
      headers: {
        "x-api-key": CFG.ETSY_API_KEY,
        "Authorization": "Bearer " + CFG.ETSY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
  return res.data;
}

async function pinOnPinterest(product, etsyUrl) {
  if (!CFG.PINTEREST_TOKEN) {
    log("Pinterest-token mangler - simulerer pin", "warn");
    return { id: "PIN_" + Date.now() };
  }
  const res = await axios.post(
    "https://api.pinterest.com/v5/pins",
    {
      board_id: CFG.PINTEREST_BOARD,
      title: product.title,
      description: product.pinterest_caption,
      link: etsyUrl,
      media_source: { source_type: "image_url", url: "https://via.placeholder.com/600x900/1a1a2e/00FF88?text=Etsy+Product" },
    },
    {
      headers: {
        "Authorization": "Bearer " + CFG.PINTEREST_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
  return res.data;
}

const NICHES = [
  "digitale planleggere og produktivitetsverktoey",
  "SVG-filer for Cricut og hjemdekor",
  "personlige kartverk og reiseplakater",
  "selvhjelp og mental helse arbeidsark",
  "baby- og barnegaver print-on-demand",
  "brudepike og bryllupsgaver digitale",
  "hundeportrett og kjaeledy rgaver",
  "vintagekokebok og oppskriftsmal",
];
let nicheIdx = 0;

async function runAgentCycle() {
  if (!state.running) return;
  state.stats.cycles++;
  const niche = NICHES[nicheIdx % NICHES.length];
  nicheIdx++;
  log("=== SYKLUS " + state.stats.cycles + " === Nisje: " + niche, "cycle");

  try {
    const products = await generateProducts(niche);
    log(products.length + " produkter generert");

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      if (!state.running) break;

      try {
        const listing = await listOnEtsy(product);
        const etsyUrl = listing.url || "https://etsy.com/listing/" + listing.listing_id;
        product.etsyId = listing.listing_id;
        product.etsyUrl = etsyUrl;
        product.status = "launched";
        product.launchedAt = new Date().toISOString();
        state.launched.push(product);
        state.stats.etsy++;
        log("Lansert pa Etsy: " + product.title.slice(0, 50), "success");

        await new Promise(function(r) { setTimeout(r, 1500); });
        const pin = await pinOnPinterest(product, etsyUrl);
        product.pinterestId = pin.id;
        state.stats.pinterest++;
        log("Pinnet pa Pinterest: " + product.title.slice(0, 40), "success");

        state.queue.push({
          ...product,
          id: "Q_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          platforms: ["instagram", "tiktok"],
          queuedAt: new Date().toISOString(),
        });
        state.stats.pendingApproval++;
        log("Instagram/TikTok-innhold lagt i godkjenningsko", "info");

      } catch (err) {
        log("Feil ved lansering: " + err.message, "error");
      }

      await new Promise(function(r) { setTimeout(r, 2000); });
    }

    state.lastCycle = new Date().toISOString();
    state.products = [...state.products, ...products].slice(-100);
    log("Syklus " + state.stats.cycles + " ferdig!", "success");

  } catch (err) {
    log("Syklus feilet: " + err.message, "error");
  }
}

cron.schedule("0 */2 * * *", function() {
  if (state.running) runAgentCycle();
});

app.get("/status", function(_, res) { res.json({ running: state.running, stats: state.stats, lastCycle: state.lastCycle }); });
app.get("/products", function(_, res) { res.json(state.products.slice(-20)); });
app.get("/launched", function(_, res) { res.json(state.launched.slice(-20)); });
app.get("/queue", function(_, res) { res.json(state.queue); });
app.get("/logs", function(_, res) { res.json(state.logs.slice(-100)); });
app.get("/stats", function(_, res) { res.json(state.stats); });

app.post("/start", function(_, res) {
  state.running = true;
  log("Agent startet!", "success");
  runAgentCycle();
  res.json({ ok: true });
});

app.post("/stop", function(_, res) {
  state.running = false;
  log("Agent stoppet", "warn");
  res.json({ ok: true });
});

app.post("/approve/:id", function(req, res) {
  const item = state.queue.find(function(q) { return q.id === req.params.id; });
  if (!item) return res.status(404).json({ error: "Ikke funnet" });
  state.queue = state.queue.filter(function(q) { return q.id !== req.params.id; });
  state.promoted = [...state.promoted, { ...item, approvedAt: new Date().toISOString() }];
  state.stats.pendingApproval = Math.max(0, state.stats.pendingApproval - 1);
  log("Godkjent for posting: " + (item.title || "").slice(0, 40), "success");
  res.json({ ok: true, item });
});

app.delete("/queue/:id", function(req, res) {
  state.queue = state.queue.filter(function(q) { return q.id !== req.params.id; });
  state.stats.pendingApproval = Math.max(0, state.stats.pendingApproval - 1);
  res.json({ ok: true });
});

app.post("/run-now", function(_, res) {
  runAgentCycle();
  res.json({ ok: true, message: "Syklus startet" });
});

app.listen(CFG.PORT, function() {
  log("Server kjorer pa port " + CFG.PORT, "success");
});
