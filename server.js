const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Invalid JSON body.");
  }
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function firstMatch(html, pattern) {
  const match = String(html || "").match(pattern);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

function allMatches(html, pattern, limit = 8) {
  const output = [];
  let match;
  const source = String(html || "");
  while ((match = pattern.exec(source)) && output.length < limit) {
    const value = stripHtml(match[1]);
    if (value && value.length > 2) output.push(value);
  }
  return output;
}

function extractMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return firstMatch(
    html,
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i")
  );
}

function productNameFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "");
    const base = host.split(".")[0] || "Your SaaS";
    return base
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  } catch (error) {
    return "Your SaaS";
  }
}

function cleanTitle(title) {
  return String(title || "")
    .split(/[|\-]/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSite(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ClipCueBot/0.1 (+https://clipcue.local)",
        "Accept": "text/html,application/xhtml+xml,text/plain"
      }
    });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `Site returned HTTP ${response.status}.`, html: text, contentType };
    }
    return { ok: true, html: text, contentType };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "The site took too long to respond." : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function analyzeHtml(url, html) {
  const title = cleanTitle(
    extractMeta(html, "og:title") ||
      extractMeta(html, "twitter:title") ||
      firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
  );
  const description =
    extractMeta(html, "description") ||
    extractMeta(html, "og:description") ||
    extractMeta(html, "twitter:description");
  const h1 = allMatches(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi, 3);
  const h2 = allMatches(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi, 8);
  const text = stripHtml(html).slice(0, 6000);
  return {
    title,
    description: description || h1[0] || "",
    headings: [...h1, ...h2].slice(0, 10),
    text,
    fallbackName: productNameFromUrl(url)
  };
}

function inferCategory(text) {
  const haystack = text.toLowerCase();
  if (/(crm|sales|pipeline|lead|prospect)/.test(haystack)) return "sales workflow";
  if (/(analytics|dashboard|metric|insight|report)/.test(haystack)) return "analytics platform";
  if (/(developer|api|deploy|code|github|database)/.test(haystack)) return "developer tool";
  if (/(design|figma|ui|brand|creative)/.test(haystack)) return "design tool";
  if (/(support|ticket|customer|helpdesk)/.test(haystack)) return "customer support tool";
  if (/(ai|agent|automation|prompt|workflow)/.test(haystack)) return "AI workflow product";
  return "SaaS product";
}

function inferAudience(text) {
  const haystack = text.toLowerCase();
  if (/(founder|startup|indie|maker)/.test(haystack)) return "startup founders";
  if (/(developer|engineer|dev team|api)/.test(haystack)) return "developer teams";
  if (/(marketer|growth|campaign|content)/.test(haystack)) return "growth teams";
  if (/(sales|revenue|pipeline)/.test(haystack)) return "sales teams";
  if (/(agency|client|white label)/.test(haystack)) return "agencies";
  return "busy SaaS teams";
}

function buildFeatures(scraped, productName) {
  const headings = (scraped.headings || [])
    .filter((item) => item.length < 90)
    .filter((item) => !/cookie|privacy|terms|login|sign up/i.test(item));
  const seeded = headings.slice(0, 4);
  while (seeded.length < 4) {
    const fallbacks = [
      `${productName} turns messy work into a cleaner workflow`,
      "Fast setup from a product URL",
      "Clear proof points for launch channels",
      "Built for founders who need launch assets quickly"
    ];
    seeded.push(fallbacks[seeded.length]);
  }
  return seeded.slice(0, 4);
}

function sceneDurations(total, count) {
  const base = Math.floor(total / count);
  const durations = Array.from({ length: count }, () => base);
  let rest = total - base * count;
  let index = durations.length - 1;
  while (rest > 0) {
    durations[index] += 1;
    rest -= 1;
    index = Math.max(0, index - 1);
  }
  return durations;
}

const TEMPLATE_FAMILIES = [
  {
    family: "editorial",
    label: "Forbes Editorial",
    treatment: "editorial",
    motion: "masthead-cut",
    displayFonts: ["Newsreader", "Playfair Display", "Bodoni Moda", "Fraunces"],
    sansFonts: ["Inter", "IBM Plex Sans", "Sora", "Archivo"],
    palettes: [
      { ink: "#080807", paper: "#f8f2e4", accent: "#b30c17", secondary: "#0d6f88", success: "#2f8f68", gold: "#b58b3a" },
      { ink: "#11100d", paper: "#f3ead7", accent: "#9f1d18", secondary: "#285f77", success: "#426f4f", gold: "#a98132" }
    ]
  },
  {
    family: "glass",
    label: "Glass Noir",
    treatment: "glass",
    motion: "glass-drift",
    displayFonts: ["Playfair Display", "Fraunces", "Newsreader", "Instrument Serif"],
    sansFonts: ["Space Grotesk", "Inter", "Sora", "IBM Plex Sans"],
    palettes: [
      { ink: "#f8f4ea", paper: "#060708", accent: "#e24a55", secondary: "#4cc9f0", success: "#63d19b", gold: "#d8b35e" },
      { ink: "#fff8ee", paper: "#070812", accent: "#ff4267", secondary: "#88d8ff", success: "#a0f0c2", gold: "#f2c66f" }
    ]
  },
  {
    family: "kinetic",
    label: "Luma Kinetic",
    treatment: "kinetic",
    motion: "word-stretch",
    displayFonts: ["Syne", "Space Grotesk", "Archivo", "Sora"],
    sansFonts: ["Inter", "Space Grotesk", "Archivo", "IBM Plex Sans"],
    palettes: [
      { ink: "#fffaf0", paper: "#050505", accent: "#ff2a3d", secondary: "#00bcd4", success: "#70ff9b", gold: "#ffe27a" },
      { ink: "#f7f7f1", paper: "#0b0b0f", accent: "#d7ff46", secondary: "#6b8cff", success: "#60e6aa", gold: "#f3b24d" }
    ]
  },
  {
    family: "luxury",
    label: "Luxury SaaS",
    treatment: "editorial",
    motion: "slow-reveal",
    displayFonts: ["Bodoni Moda", "Playfair Display", "Newsreader", "Fraunces"],
    sansFonts: ["Sora", "Inter", "IBM Plex Sans", "Space Grotesk"],
    palettes: [
      { ink: "#120f0a", paper: "#f4eadb", accent: "#7f1514", secondary: "#405765", success: "#596b47", gold: "#b9914b" },
      { ink: "#0f0d0a", paper: "#eee4d1", accent: "#4f1013", secondary: "#253f51", success: "#47614d", gold: "#c2a15c" }
    ]
  },
  {
    family: "terminal",
    label: "Founder Terminal",
    treatment: "terminal",
    motion: "command-line",
    displayFonts: ["IBM Plex Serif", "Newsreader", "Space Grotesk", "Archivo"],
    sansFonts: ["IBM Plex Sans", "Inter", "Space Grotesk", "Archivo"],
    palettes: [
      { ink: "#dfffea", paper: "#03120b", accent: "#55f08a", secondary: "#6fd6ff", success: "#9dffb5", gold: "#e7c86b" },
      { ink: "#f1fff7", paper: "#08100d", accent: "#8cffd0", secondary: "#72aaff", success: "#c7ff7a", gold: "#ffd166" }
    ]
  },
  {
    family: "minimal",
    label: "Swiss Minimal",
    treatment: "minimal",
    motion: "grid-snap",
    displayFonts: ["Space Grotesk", "Archivo", "Sora", "Inter"],
    sansFonts: ["Inter", "IBM Plex Sans", "Sora", "Archivo"],
    palettes: [
      { ink: "#080808", paper: "#f7f7f2", accent: "#df1f2d", secondary: "#006d77", success: "#2d9d64", gold: "#9d7c2e" },
      { ink: "#121212", paper: "#f2f0ea", accent: "#0a0a0a", secondary: "#c42b2b", success: "#377b55", gold: "#a8893c" }
    ]
  },
  {
    family: "product",
    label: "Product UI Cinema",
    treatment: "glass",
    motion: "ui-float",
    displayFonts: ["Sora", "Space Grotesk", "Inter", "Archivo"],
    sansFonts: ["Inter", "Sora", "IBM Plex Sans", "Space Grotesk"],
    palettes: [
      { ink: "#f8fbff", paper: "#071016", accent: "#ff4e6a", secondary: "#29c4ff", success: "#5ff0a0", gold: "#f8c75e" },
      { ink: "#f6fbff", paper: "#07111f", accent: "#a88bff", secondary: "#38d7ff", success: "#63e6be", gold: "#ffe08a" }
    ]
  },
  {
    family: "social",
    label: "Launch Social",
    treatment: "kinetic",
    motion: "jump-cut",
    displayFonts: ["Archivo", "Syne", "Space Grotesk", "Sora"],
    sansFonts: ["Inter", "Archivo", "Space Grotesk", "IBM Plex Sans"],
    palettes: [
      { ink: "#fffdf5", paper: "#111111", accent: "#ff324f", secondary: "#00d5ff", success: "#88ff55", gold: "#ffcc33" },
      { ink: "#ffffff", paper: "#15120f", accent: "#ff7a00", secondary: "#9eff00", success: "#00e3a2", gold: "#ffd15a" }
    ]
  },
  {
    family: "investor",
    label: "Investor Memo",
    treatment: "editorial",
    motion: "memo-build",
    displayFonts: ["IBM Plex Serif", "Newsreader", "Playfair Display", "Fraunces"],
    sansFonts: ["IBM Plex Sans", "Inter", "Sora", "Archivo"],
    palettes: [
      { ink: "#101010", paper: "#f6f1e7", accent: "#103c5c", secondary: "#a41e22", success: "#477a52", gold: "#a9853e" },
      { ink: "#0c1115", paper: "#f2eadc", accent: "#1b4c68", secondary: "#9b242a", success: "#53764f", gold: "#b79047" }
    ]
  },
  {
    family: "neon",
    label: "Neon Agent",
    treatment: "kinetic",
    motion: "scanline-pop",
    displayFonts: ["Syne", "Space Grotesk", "Sora", "Archivo"],
    sansFonts: ["Space Grotesk", "Inter", "Sora", "IBM Plex Sans"],
    palettes: [
      { ink: "#f7fbff", paper: "#06020d", accent: "#ff2bd6", secondary: "#00f0ff", success: "#6cff7d", gold: "#ffe65c" },
      { ink: "#fbfff7", paper: "#07051a", accent: "#8b5cff", secondary: "#16f7d2", success: "#a5ff4f", gold: "#ffbf4d" }
    ]
  }
];

const VARIANT_NAMES = [
  "Signature",
  "Boardroom",
  "Launch Day",
  "Founder Cut",
  "Proof First",
  "Glass Hero",
  "Social Sharp",
  "Quiet Luxury",
  "Deep Tech",
  "AI Agent",
  "Market Memo",
  "Velocity",
  "Authority",
  "Cinematic",
  "Founder Story",
  "Demo Pulse",
  "Signal",
  "Noir",
  "Category King",
  "Launch Reel",
  "Product Proof",
  "Operator",
  "Editorial Snap",
  "Conversion"
];

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hashString(value) {
  let hash = 0;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function buildTemplateCatalog() {
  const templates = [];
  TEMPLATE_FAMILIES.forEach((family, familyIndex) => {
    VARIANT_NAMES.forEach((variantName, variantIndex) => {
      const display = family.displayFonts[variantIndex % family.displayFonts.length];
      const sans = family.sansFonts[(variantIndex + familyIndex) % family.sansFonts.length];
      const palette = family.palettes[variantIndex % family.palettes.length];
      const speed = variantIndex % 3 === 0 ? "cinematic" : variantIndex % 3 === 1 ? "balanced" : "punchy";
      templates.push({
        id: `${family.family}-${String(variantIndex + 1).padStart(2, "0")}`,
        name: `${family.label} ${variantName}`,
        family: family.family,
        familyLabel: family.label,
        treatment: family.treatment,
        motion: family.motion,
        speed,
        density: variantIndex % 4 === 0 ? "spacious" : variantIndex % 4 === 1 ? "focused" : variantIndex % 4 === 2 ? "dense" : "cinematic",
        corner: family.treatment === "minimal" ? 4 : family.treatment === "glass" ? 18 : 10,
        fonts: { display, sans },
        palette,
        vibe: `${family.label.toLowerCase()} with ${display} and ${sans}`,
        recommendedFor:
          family.family === "editorial" || family.family === "investor"
            ? "premium SaaS launches, investor demos, authority-led brands"
            : family.family === "kinetic" || family.family === "social" || family.family === "neon"
              ? "fast social launches, AI tools, demo reels"
              : "product demos, founder launches, landing-page videos"
      });
    });
  });
  return templates;
}

const TEMPLATE_CATALOG = buildTemplateCatalog();

function pickTemplate(input, product) {
  if (input.templateId && input.templateId !== "auto") {
    const selected = TEMPLATE_CATALOG.find((template) => template.id === input.templateId);
    if (selected) return selected;
  }
  const tone = String(input.tone || "").toLowerCase();
  const seed = `${product.name} ${product.category} ${product.audience} ${tone}`;
  let family = "editorial";
  if (/glass|backdoor|noir|ui/.test(tone)) family = "glass";
  if (/luma|kinetic|crazy|social|punchy|product hunt/.test(tone)) family = "kinetic";
  if (/investor|memo|forbes|premium|editorial/.test(tone)) family = "editorial";
  if (/developer|terminal|api|code/.test(`${product.category} ${tone}`.toLowerCase())) family = "terminal";
  const candidates = TEMPLATE_CATALOG.filter((template) => template.family === family);
  return candidates[hashString(seed) % candidates.length] || TEMPLATE_CATALOG[0];
}

function generateStoryboard(input, scraped, fetchInfo) {
  const duration = Math.max(15, Math.min(90, Number(input.duration || 30)));
  const count = duration <= 20 ? 3 : duration <= 40 ? 5 : 6;
  const durations = sceneDurations(duration, count);
  const productName = (input.productName || scraped.title || scraped.fallbackName || "Your SaaS").trim();
  const rawPromise = input.description || scraped.description || scraped.headings[0] || `${productName} helps teams move faster.`;
  const corePromise = rawPromise.length > 190 ? `${rawPromise.slice(0, 187).trim()}...` : rawPromise;
  const category = inferCategory(`${scraped.text} ${corePromise}`);
  const audience = input.audience || inferAudience(`${scraped.text} ${corePromise}`);
  const features = buildFeatures(scraped, productName);
  const tone = input.tone || "premium founder launch";
  const productForTemplate = { name: productName, category, audience };
  const template = pickTemplate(input, productForTemplate);
  const statusNote = fetchInfo.ok
    ? "Analyzed live website content."
    : `Used generated fallback because the website could not be fetched: ${fetchInfo.error || "unknown error"}`;

  const hooks = [
    `${productName} should not launch with a forgettable screen recording.`,
    `Your ${category} needs a launch video people understand before they scroll.`,
    `Paste the URL. Get the launch story, scenes, voice, and export plan.`
  ];

  const sceneSeeds = [
    {
      type: "hook",
      title: "Cold open",
      caption: hooks[0],
      visual: "A launch checklist with the video asset still missing. The product page glows in the background.",
      motion: `${template.motion}: establish the launch gap with the ${template.name} look.`,
      voiceover: `${productName} is ready to launch, but the video still feels last minute.`
    },
    {
      type: "problem",
      title: "The launch gap",
      caption: "Great products lose attention when the demo looks unfinished.",
      visual: "A feed scrolls past generic demos, then pauses on a clean product frame.",
      motion: `${template.speed} attention shift with one focused product frame.`,
      voiceover: `For ${audience}, a weak demo can make serious software feel smaller than it is.`
    },
    {
      type: "reveal",
      title: "Product reveal",
      caption: `${productName} turns the page into a launch story.`,
      visual: "The URL breaks into promise, audience, proof points, captions, and scene cards.",
      motion: `${template.treatment} cards resolve into a storyboard system.`,
      voiceover: `ClipCue reads the product page and turns it into a launch-video brief.`
    },
    {
      type: "proof",
      title: "Feature proof",
      caption: features[0],
      visual: `Highlight the strongest product claim: ${features[0]}.`,
      motion: `Product UI proof moment using ${template.fonts.display} for the claim.`,
      voiceover: corePromise
    },
    {
      type: "workflow",
      title: "Storyboard build",
      caption: "Script, captions, voice, and motion notes arrive together.",
      visual: "A chat-like assistant creates the cut: hook, scenes, narrator, timeline.",
      motion: `Timeline compresses into a ${template.density} ${template.familyLabel} cut.`,
      voiceover: "Approve the story first, then render the launch asset when it feels right."
    },
    {
      type: "cta",
      title: "Export",
      caption: "Preview free. Export the launch MP4 when it is worth it.",
      visual: "Render progress reaches 100 percent and unlocks social and landing-page formats.",
      motion: "Progress bar fills, MP4 card flips open, CTA lands.",
      voiceover: `Launch ${productName} with a video that explains the product before the market scrolls past.`
    }
  ];

  const scenes = sceneSeeds.slice(0, count).map((scene, index) => ({
    sceneNumber: index + 1,
    duration: durations[index],
    ...scene
  }));

  const script = scenes.map((scene) => scene.voiceover).join(" ");

  return {
    generatedAt: new Date().toISOString(),
    statusNote,
    product: {
      name: productName,
      url: input.url,
      category,
      audience,
      corePromise,
      features,
      tone
    },
    template,
    templateCatalog: {
      total: TEMPLATE_CATALOG.length,
      selectedId: template.id,
      families: [...new Set(TEMPLATE_CATALOG.map((item) => item.familyLabel))]
    },
    hooks,
    video: {
      title: `${productName} launch video`,
      duration,
      aspectRatio: input.aspectRatio || "16:9",
      style: tone,
      script,
      scenes
    }
  };
}

async function handleGenerate(req, res) {
  let input;
  try {
    input = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  if (!input.url || typeof input.url !== "string") {
    sendJson(res, 400, { error: "Startup URL is required." });
    return;
  }

  let parsed;
  try {
    parsed = new URL(input.url);
  } catch (error) {
    sendJson(res, 400, { error: "Enter a valid http or https URL." });
    return;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    sendJson(res, 400, { error: "Only http and https URLs are supported." });
    return;
  }

  const fetchInfo = await fetchSite(parsed.toString());
  const scraped = fetchInfo.html
    ? analyzeHtml(parsed.toString(), fetchInfo.html)
    : {
        title: "",
        description: "",
        headings: [],
        text: "",
        fallbackName: productNameFromUrl(parsed.toString())
      };

  const output = generateStoryboard({ ...input, url: parsed.toString() }, scraped, fetchInfo);
  sendJson(res, 200, output);
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : decodeURIComponent(requestUrl.pathname);
  const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch (error) {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/generate") {
    handleGenerate(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }
  if (req.method === "GET" && req.url === "/api/templates") {
    sendJson(res, 200, {
      total: TEMPLATE_CATALOG.length,
      families: TEMPLATE_FAMILIES.map((family) => ({
        id: family.family,
        label: family.label,
        treatment: family.treatment,
        motion: family.motion
      })),
      templates: TEMPLATE_CATALOG
    });
    return;
  }
  if (req.method === "GET") {
    serveStatic(req, res).catch((error) => sendText(res, 500, error.message));
    return;
  }
  sendText(res, 405, "Method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ClipCue working MVP running at http://127.0.0.1:${PORT}`);
});
