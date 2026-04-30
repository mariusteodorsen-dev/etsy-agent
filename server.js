// ============================================================
//  ETSY AI AGENT – Backend Server
//  Hoster på Railway (gratis): railway.app
// ============================================================
const express  = require("express");
const cron     = require("node-cron");
const axios    = require("axios");
const cors     = require("cors");
const fs       = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG (sett disse som Environment Variables på Railway) ─
const CFG = {
  ANTHROPIC_KEY:    process.env.ANTHROPIC_KEY    || "",
  ETSY_API_KEY:     process.env.ETSY_API_KEY     || "",
  ETSY_SHOP_ID:     process.env.ETSY_SHOP_ID     || "",
  ETSY_ACCESS_TOKEN:process.env.ETSY_ACCESS_TOKEN|| "",
  PINTEREST_TOKEN:  process.env.PINTEREST_TOKEN  || "",
  PINTEREST_BOARD:  process.env.PINTEREST_BOARD  || "",
  PORT:             process.env.PORT              || 3001,
};

// ── STATE (in-memory – bytt til SQLite for produksjon) ───────
let state = {
  running:   false,
  products:  [],         // alle genererte produkter
  queue:     [],         // venter på godkjenning (Instagram/TikTok)
  launched:  [],         // lansert på Etsy
  promoted:  [],         // promotert
  logs:      [],
  stats:     { etsy: 0, pinterest: 0, pendingApproval: 0, cycles: 0 },
  lastCycle: null,
};

function log(msg, type = "info") {
  const entry = { t: new Date().toISOString(), msg, type };
  state.logs = [...state.logs.slice(-300), entry];
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ── CLAUDE: generer produktpakke ─────────────────────────────
async function generateProducts(niche) {
  log(`🤖 Genererer produkter for: ${niche}`);
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: "Du er Etsy-ekspert. Svar KUN med gyldig JSON, ingen markdown.",
      messages: [{
        role: "user",
        content: `Generer 3 Etsy-produkter for nisjen: "${niche}". 
JSON-format:
{
  "products": [
    {
      "title": "SEO-tittel maks 140 tegn",
      "description": "200 ord selgende produktbeskrivelse",
      "price": 9.99,
      "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7"],
      "category": "kategori",
      "type": "digital",
      "pinterest_caption": "Engasjerende Pinterest-tekst med emojier og hashtags",
      "instagram_caption": "Instagram-caption med emojier og hashtags",
      "tiktok_hook": "Første setning som stopper scrolling på TikTok"
    }
  ]
}`
      }]
    },
    { headers: { "x-api-key": CFG.ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
  );
  const raw  = res.data.content.map(b => b.text || "").join("");
  const json = JSON.parse(raw.replace(/```json|```/gi, "").trim());
  return json.products || [];
}

// ── ETSY: list produkt ───────────────────────────────────────
async function listOnEtsy(product) {
  if (!CFG.ETSY_API_KEY || !CFG.ETSY_SHOP_ID) {
    log("⚠️  Etsy-nøkler mangler – simulerer lansering", "warn");
    return { listing_id: `MOCK_${Date.now()}`, url: "https://etsy.com/listing/mock" };
  }
  const res = await axios.post(
    `https://openapi.etsy.com/v3/application/shops/${CFG.ETSY_SHOP_ID}/listings`,
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
    { headers: {
      "x-api-key": CFG.ETSY_API_KEY,
      "Authorization": `Bearer ${CFG.ETSY_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }}
  );
  return res.data;
}

// ── PINTEREST: publiser pin ──────────────────────────────────
async function pinOnPinterest(product, etsyUrl) {
  if (!CFG.PINTEREST_TOKEN) {
    log("⚠️  Pinterest-token mangler – simulerer pin", "warn");
    return { id: `PIN_${Date.now()}` };
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
    { headers: { "Authorization": `Bearer ${CFG.PINTEREST_TOKEN}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

// ── HOVED-AGENT-SYKLUS ───────────────────────────────────────
const NICHES = [
  "digitale planleggere og produktivitetsverktøy",
  "SVG-filer for Cricut og hjemdekor",
  "personlige kartverk og reiseplakater",
  "selvhjelp og mental helse arbeidsark",
  "baby- og barnegaver print-on-demand",
  "brudepike og bryllupsgaver digitale",
  "hundeportrett og kjæledyrgaver",
  "vintagekokebok og oppskriftsmal",
];
let nicheIdx = 0;

async function runAgentCycle() {
  if (!state.running) return;
  state.stats.cycles++;
  const niche = NICHES[nicheIdx % NICHES.length];
  nicheIdx++;
  log(`\n🔄 === SYKLUS ${state.stats.cycles} === Nisje: ${niche}`, "cycle");

  try {
    // 1. Generer produkter
    const products = await generateProducts(niche);
    log(`✅ ${products.length} produkter generert`);

    for (const product of products) {
      if (!state.running) break;

      // 2. List på Etsy (automatisk)
      try {
        const listing = await listOnEtsy(product);
        const etsyUrl = listing.url || `https://etsy.com/listing/${listing.listing_id}`;
        product.etsyId  = listing.listing_id;
        product.etsyUrl = etsyUrl;
        product.status  = "launched";
        product.launchedAt = new Date().toISOString();
        state.launched.push(product);
        state.stats.etsy++;
        log(`🏪 Lansert på Etsy: ${product.title.slice(0, 50)}…`, "success");

        // 3. Pinterest (automatisk)
        await new Promise(r => setTimeout(r, 1500));
        const pin = await pinOnPinterest(product, etsyUrl);
        product.pinterestId = pin.id;
        state.stats.pinterest++;
        log(`📌 Pinnet på Pinterest: ${product.title.slice(0, 40)}…`, "success");

        // 4. Instagram & TikTok → kø for godkjenning
        state.queue.push({
          ...product,
          id: `Q_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
          platforms: ["instagram", "tiktok"],
          queuedAt: new Date().toISOString(),
        });
        state.stats.pendingApproval++;
        log(`📋 Instagram/TikTok-innhold lagt i godkjenningskø`, "info");

      } catch (err) {
        log(`❌ Feil ved lansering: ${err.message}`, "error");
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    state.lastCycle = new Date().toISOString();
    state.products  = [...state.products, ...products].slice(-100);
    log(`🎉 Syklus ${state.stats.cycles} ferdig!`, "success");

  } catch (err) {
    log(`❌ Syklus feilet: ${err.message}`, "error");
  }
}

// ── CRON: kjør agent hvert 2. time ──────────────────────────
cron.schedule("0 */2 * * *", () => {
  if (state.running) runAgentCycle();
});

// ── REST API ─────────────────────────────────────────────────
app.get("/status",   (_, res) => res.json({ running: state.running, stats: state.stats, lastCycle: state.lastCycle }));
app.get("/products", (_, res) => res.json(state.products.slice(-20)));
app.get("/launched", (_, res) => res.json(state.launched.slice(-20)));
app.get("/queue",    (_, res) => res.json(state.queue));
app.get("/logs",     (_, res) => res.json(state.logs.slice(-100)));
app.get("/stats",    (_, res) => res.json(state.stats));

app.post("/start",   (_, res) => {
  state.running = true;
  log("🚀 Agent startet!", "success");
  runAgentCycle(); // kjør med en gang
  res.json({ ok: true });
});

app.post("/stop", (_, res) => {
  state.running = false;
  log("🛑 Agent stoppet", "warn");
  res.json({ ok: true });
});

// Godkjenn Instagram/TikTok-post
app.post("/approve/:id", (req, res) => {
  const item = state.queue.find(q => q.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Ikke funnet" });
  state.queue    = state.queue.filter(q => q.id !== req.params.id);
  state.promoted = [...state.promoted, { ...item, approvedAt: new Date().toISOString() }];
  state.stats.pendingApproval = Math.max(0, state.stats.pendingApproval - 1);
  log(`✅ Godkjent for posting: ${item.title?.slice(0, 40)}…`, "success");
  res.json({ ok: true, item });
});

// Avvis post
app.delete("/queue/:id", (req, res) => {
  state.queue = state.queue.filter(q => q.id !== req.params.id);
  state.stats.pendingApproval = Math.max(0, state.stats.pendingApproval - 1);
  res.json({ ok: true });
});

// Kjør syklus manuelt
app.post("/run-now", (_, res) => {
  runAgentCycle();
  res.json({ ok: true, message: "Syklus startet" });
});

app.listen(CFG.PORT, () => log(`🌐 Server kjører på port ${CFG.PORT}`, "success"));
