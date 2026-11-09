/**
 * Reiseberater – Cloudflare Worker
 * --------------------------------
 * Endpunkte:
 *   GET    /api/health              – Erreichbarkeit (ohne Zugangscode)
 *   POST   /api/offers              – 5 Angebote per Claude + Live-Websuche
 *   POST   /api/guide               – Reiseführer zum gewählten Angebot
 *   POST   /api/tip                 – Spontan-Tipp im Reise-Modus
 *   GET    /api/trips               – gespeicherte Reisen (Liste)
 *   GET    /api/trips/:id           – eine Reise
 *   POST   /api/trips               – Reise speichern
 *   PUT    /api/trips/:id           – Reise aktualisieren
 *   DELETE /api/trips/:id           – Reise löschen
 *   GET    /api/prefs               – Präferenzen aller Reisearten
 *   PUT    /api/prefs/:reiseart     – Präferenzen einer Reiseart speichern
 *   DELETE /api/prefs/:reiseart     – Präferenzen zurücksetzen
 *
 * Bindings / Variablen (Cloudflare Dashboard → Worker → Settings):
 *   ANTHROPIC_API_KEY  (Secret)   – API-Key aus der Claude Console
 *   APP_TOKEN          (Secret)   – frei gewählter Zugangscode für die App
 *   ALLOWED_ORIGIN     (Variable) – z. B. https://rsab19630401.github.io (mehrere mit Komma)
 *   MODEL              (Variable, optional) – Standard: claude-sonnet-5-5
 *   DB                 (D1-Binding) – Datenbank "reiseberater"
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_BODY_BYTES = 1_000_000;

// Obergrenzen für Websuchen pro Anfrage (Kostenbremse)
const SEARCH_LIMITS = { offers: 6, guide: 8, tip: 2 };

// Link-Prüfung: höchstens so viele Links pro Anfrage aktiv abrufen
// (Cloudflare begrenzt die Zahl ausgehender Anfragen je Aufruf)
const MAX_LINK_CHECKS = 25;
const LINK_TIMEOUT_MS = 8000;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    try {
      if (!originAllowed(origin, env)) {
        return json({ error: "Herkunft nicht erlaubt (ALLOWED_ORIGIN prüfen)." }, 403, cors);
      }

      if (path === "/api/health") {
        return json({ ok: true, model: env.MODEL || DEFAULT_MODEL, db: Boolean(env.DB) }, 200, cors);
      }

      if (!authorized(request, env)) {
        return json({ error: "Nicht autorisiert – bitte Zugangscode in den Einstellungen prüfen." }, 401, cors);
      }

      // --- KI-Endpunkte (lange Laufzeit → Stream mit Keep-alive) ---
      if (request.method === "POST" && path === "/api/offers") {
        const body = await readBody(request);
        return streamTask(ctx, cors, () => handleOffers(body, env));
      }
      if (request.method === "POST" && path === "/api/guide") {
        const body = await readBody(request);
        return streamTask(ctx, cors, () => handleGuide(body, env));
      }
      if (request.method === "POST" && path === "/api/tip") {
        const body = await readBody(request);
        return streamTask(ctx, cors, () => handleTip(body, env));
      }

      // --- Präferenzen je Reiseart (D1) ---
      if (path === "/api/prefs" || path.startsWith("/api/prefs/")) {
        if (!env.DB) return json({ error: "D1-Datenbank ist nicht gebunden (Binding-Name: DB)." }, 500, cors);
        const art = path.startsWith("/api/prefs/") ? decodeURIComponent(path.slice("/api/prefs/".length)) : null;
        return await handlePrefs(request, env, art, cors);
      }

      // --- Gespeicherte Reisen (D1) ---
      if (path === "/api/trips" || path.startsWith("/api/trips/")) {
        if (!env.DB) return json({ error: "D1-Datenbank ist nicht gebunden (Binding-Name: DB)." }, 500, cors);
        const id = path.startsWith("/api/trips/") ? decodeURIComponent(path.slice("/api/trips/".length)) : null;
        return await handleTrips(request, env, id, cors);
      }

      return json({ error: "Unbekannter Endpunkt." }, 404, cors);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500, cors);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Infrastruktur                                                       */
/* ------------------------------------------------------------------ */

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function originAllowed(origin, env) {
  const list = allowedOrigins(env);
  if (list.length === 0 || list.includes("*")) return true;
  if (!origin) return true; // z. B. Aufruf ohne Browser – Zugangscode schützt trotzdem
  return list.includes(origin.replace(/\/+$/, ""));
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  const allow = list.length === 0 || list.includes("*") ? "*" : list.includes(origin) ? origin : list[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function authorized(request, env) {
  if (!env.APP_TOKEN) return false; // ohne gesetzten Code bleibt alles gesperrt
  const given = request.headers.get("X-App-Token") || "";
  if (given.length !== env.APP_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.APP_TOKEN.charCodeAt(i);
  return diff === 0;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw httpError(413, "Anfrage zu groß.");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw httpError(400, "Ungültiges JSON in der Anfrage.");
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Lange KI-Anfragen (Websuche) dauern oft 1–3 Minuten.
 * Damit keine Verbindung zwischendurch abbricht, wird sofort geantwortet
 * und alle 15 s ein Leerzeichen gesendet. JSON.parse ignoriert führende Leerzeichen.
 * Fehler werden als {"error": "..."} im Stream zurückgegeben.
 */
function streamTask(ctx, cors, task) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const run = (async () => {
    const beat = setInterval(() => writer.write(enc.encode(" ")).catch(() => {}), 15000);
    let payload;
    try {
      payload = await task();
    } catch (err) {
      payload = { error: err.message || String(err) };
    } finally {
      clearInterval(beat);
    }
    try {
      await writer.write(enc.encode(JSON.stringify(payload)));
      await writer.close();
    } catch {
      /* Client hat die Verbindung beendet */
    }
  })();

  ctx.waitUntil(run);
  return new Response(readable, {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/* ------------------------------------------------------------------ */
/* Claude-Aufruf mit Websuche                                          */
/* ------------------------------------------------------------------ */

async function callClaude(env, { system, user, maxUses, maxTokens }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY fehlt im Worker.");

  const tools =
    maxUses > 0
      ? [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: maxUses,
            user_location: { type: "approximate", country: "DE", timezone: "Europe/Berlin" },
          },
        ]
      : undefined;

  const assistantContent = [];
  let lastStop = null;

  // Bei "pause_turn" wird die Antwort unverändert zurückgeschickt, damit Claude weitermacht.
  for (let round = 0; round < 5; round++) {
    const messages = [{ role: "user", content: user }];
    if (assistantContent.length) messages.push({ role: "assistant", content: assistantContent });

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL || DEFAULT_MODEL,
        max_tokens: maxTokens,
        system,
        messages,
        stream: true, // Datenstrom statt Warten: verhindert Zeitlimit-Abbrüche (Fehler 524) bei langen Recherchen
        ...(tools ? { tools } : {}),
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      if (res.status === 524 || res.status === 504) {
        throw new Error("Die Claude-API hat zu lange nicht geantwortet (Zeitlimit). Bitte erneut versuchen.");
      }
      if (res.status === 529) throw new Error("Die Claude-API ist gerade überlastet. Bitte in ein paar Minuten erneut versuchen.");
      throw new Error(`Claude-API-Fehler ${res.status}: ${t.slice(0, 400)}`);
    }

    const { content, stopReason } = await readClaudeStream(res);
    assistantContent.push(...content);
    lastStop = stopReason;
    if (lastStop !== "pause_turn") break;
  }

  const text = assistantContent
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const sources = [];
  const seen = new Set();
  let searches = 0;
  for (const b of assistantContent) {
    if (b.type === "server_tool_use" && b.name === "web_search") searches++;
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        if (r.type === "web_search_result" && r.url && !seen.has(r.url)) {
          seen.add(r.url);
          sources.push({ title: r.title || r.url, url: r.url });
        }
      }
    }
  }

  return { text, sources, searches, truncated: lastStop === "max_tokens" };
}

/**
 * Liest die Server-Sent-Events der Claude-API und baut daraus die Inhaltsblöcke
 * (Text, Websuche, Suchergebnisse) wie bei einer normalen Antwort zusammen.
 */
async function readClaudeStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const blocks = [];
  const partialJson = {};
  let stopReason = null;
  let buf = "";

  const handle = (ev) => {
    switch (ev.type) {
      case "content_block_start": {
        const b = { ...ev.content_block };
        if (b.type === "text") b.text = b.text || "";
        if (b.type === "server_tool_use" || b.type === "tool_use") partialJson[ev.index] = "";
        blocks[ev.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === "text_delta") b.text += d.text;
        else if (d.type === "input_json_delta") partialJson[ev.index] += d.partial_json || "";
        else if (d.type === "citations_delta" && d.citation) (b.citations ||= []).push(d.citation);
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b && ev.index in partialJson) {
          try { b.input = partialJson[ev.index] ? JSON.parse(partialJson[ev.index]) : b.input || {}; } catch { b.input = b.input || {}; }
        }
        break;
      }
      case "message_delta":
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        break;
      case "error": {
        const type = ev.error && ev.error.type;
        if (type === "overloaded_error") throw new Error("Die Claude-API ist gerade überlastet. Bitte in ein paar Minuten erneut versuchen.");
        throw new Error("Claude-API-Fehler: " + ((ev.error && ev.error.message) || "unbekannt"));
      }
    }
  };

  const flush = (final) => {
    buf = buf.replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1 || (final && buf.trim())) {
      let chunk;
      if (i === -1) { chunk = buf; buf = ""; } else { chunk = buf.slice(0, i); buf = buf.slice(i + 2); }
      let data = "";
      for (const line of chunk.split("\n")) if (line.startsWith("data:")) data += line.slice(5).trim();
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      handle(ev);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    flush(false);
  }
  buf += dec.decode();
  flush(true);

  return { content: blocks.filter(Boolean), stopReason };
}

function extractJson(text) {
  // den letzten <json>-Block nehmen (falls vorher etwas zitiert wurde)
  const tagged = [...text.matchAll(/<json>([\s\S]*?)<\/json>/gi)].pop();
  let candidate = tagged ? tagged[1] : null;
  if (!candidate) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) candidate = fenced[1];
  }
  if (!candidate) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a !== -1 && b > a) candidate = text.slice(a, b + 1);
  }
  if (!candidate) return null;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

/** Recherche mit Websuche, Ergebnis als JSON; ungültiges JSON wird einmal (ohne Websuche) repariert. */
async function researchAsJson(env, { system, user, maxUses, maxTokens }) {
  const result = await callClaude(env, { system, user, maxUses, maxTokens });
  let parsed = extractJson(result.text);

  // abgeschnittene Antworten nicht "reparieren" – dabei würden Inhalte erfunden
  if (!parsed && !result.truncated) {
    const repair = await callClaude(env, {
      system: "Du wandelst Text in gültiges JSON um. Antworte ausschließlich mit JSON zwischen <json> und </json>. Erfinde keine Inhalte.",
      user: `Der folgende Text sollte ein JSON-Objekt enthalten, ist aber ungültig. Gib es korrigiert und vollständig zurück:\n\n${result.text.slice(0, 60000)}`,
      maxUses: 0,
      maxTokens,
    });
    parsed = extractJson(repair.text);
  }

  if (!parsed && result.truncated) {
    throw new Error("Die Antwort war zu lang und wurde abgeschnitten. Bitte erneut versuchen – bei sehr großen Zielen hilft ein engeres Ziel.");
  }
  if (!parsed) throw new Error("Die Antwort konnte nicht ausgewertet werden. Bitte erneut versuchen.");
  return { data: parsed, sources: result.sources, searches: result.searches };
}

/* ------------------------------------------------------------------ */
/* Link-Prüfung                                                        */
/* ------------------------------------------------------------------ */

function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return "";
  }
}

function searchLink(query) {
  return "https://www.google.com/search?q=" + encodeURIComponent(query.replace(/\s+/g, " ").trim());
}

/** Ruft eine Adresse ab. true = erreichbar (oder nur für Bots gesperrt), false = nicht vorhanden/defekt. */
async function linkReachable(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Reiseberater-Linkpruefung)", Accept: "text/html,*/*" },
    });
    try { await res.body?.cancel(); } catch { /* egal */ }
    if (res.status === 404 || res.status === 410 || res.status >= 500) return false;
    return true; // 2xx/3xx sowie 401/403/405/429 (Bot-Sperren) gelten als vorhanden
  } catch {
    return false; // DNS-Fehler, Zeitüberschreitung, Verbindungsabbruch
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prüft alle "url"-Felder im Ergebnis:
 * - Adressen aus den Suchergebnissen bleiben unverändert.
 * - Andere werden abgerufen (max. MAX_LINK_CHECKS); nicht erreichbare oder ungültige
 *   werden durch eine Suche nach Name und Ort ersetzt und mit "url_ersatz": true markiert.
 */
async function verifyLinks(data, sources, baseCtx) {
  const known = new Set((sources || []).map((s) => normUrl(s.url)).filter(Boolean));
  const jobs = [];

  const visit = (node, ctx) => {
    if (Array.isArray(node)) { node.forEach((n) => visit(n, ctx)); return; }
    if (!node || typeof node !== "object") return;
    const own = {
      name: (node.unterkunft && node.unterkunft.name) || node.name || node.titel || ctx.name || "",
      ort: node.ort || ctx.ort || "",
    };
    if ("url" in node && typeof node.url === "string" && node.url.trim()) {
      const label = node.label && !/unterkunft|hotel/i.test(node.label) ? node.label : "";
      const query = "dokumente" in node
        ? `Einreisebestimmungen ${own.ort} Auswärtiges Amt`
        : [label, own.name, own.ort].filter(Boolean).join(" ");
      jobs.push({ node, query });
    }
    for (const [k, v] of Object.entries(node)) if (k !== "url" && v && typeof v === "object") visit(v, own);
  };
  visit(data, { name: "", ort: baseCtx.ort || "" });

  const replace = (job) => {
    job.node.url = searchLink(job.query || job.node.url);
    job.node.url_ersatz = true;
  };

  const toCheck = new Map(); // url -> jobs
  let ersetzt = 0, ausQuelle = 0;
  for (const job of jobs) {
    const u = job.node.url.trim();
    let valid = false;
    try { valid = /^https?:$/.test(new URL(u).protocol); } catch { /* ungültig */ }
    if (!valid) { replace(job); ersetzt++; continue; }
    if (known.has(normUrl(u))) { ausQuelle++; continue; }
    if (!toCheck.has(u)) toCheck.set(u, []);
    toCheck.get(u).push(job);
  }

  const urls = [...toCheck.keys()].slice(0, MAX_LINK_CHECKS);
  const results = new Map();
  for (let i = 0; i < urls.length; i += 8) {
    const batch = urls.slice(i, i + 8);
    const ok = await Promise.all(batch.map(linkReachable));
    batch.forEach((u, j) => results.set(u, ok[j]));
  }
  for (const [u, list] of toCheck) {
    if (results.get(u) === false) { list.forEach(replace); ersetzt += list.length; }
  }

  return { gesamt: jobs.length, ausQuellen: ausQuelle, geprueft: urls.length, ersetzt, ungeprueft: Math.max(0, toCheck.size - urls.length) };
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

function today() {
  return new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });
}

function baseSystem() {
  return `Du bist eine erfahrene, ehrliche Reiseberaterin in einem sehr guten deutschen Reisebüro. Heute ist der ${today()}.
Deine Kunden wohnen in Brühl (Baden), PLZ 68782, nahe Mannheim/Schwetzingen.

Arbeitsregeln:
1. Nutze die Websuche, um Unterkünfte, Preise, Verbindungen, Öffnungszeiten, Restaurants und Anbieter zu prüfen.
2. Erfinde nichts. Nenne nur Unterkünfte, Restaurants, Anbieter und Orte, die du in Suchergebnissen gefunden hast, jeweils mit URL.
   Übernimm URLs exakt aus den Suchergebnissen und baue keine Adressen selbst zusammen. Bevorzuge die offizielle Website;
   bei Portalen die allgemeine Seite des Hotels bzw. Angebots – keine Suchergebnislisten und keine Links mit Datums-, Such- oder Sitzungsparametern.
   Konntest du etwas nicht prüfen, setze "verifiziert": false und schreibe das ehrlich dazu.
3. Preise sind Richtwerte in Euro aus Suchergebnissen. Gib an, woher sie stammen und dass sie nicht verbindlich sind.
4. Berücksichtige den konkreten Reisezeitraum: Saison, Wetter, Öffnungszeiten, Feiertage, Veranstaltungen, Schließungen in der Nebensaison.
5. Sei kritisch und fair: Weise auf Nachteile hin (lange Anreise, Einzelzimmerzuschlag, Überfüllung, Baustellen, Wetterrisiko).
6. Schreibe auf Deutsch, klar und konkret, ohne Werbesprache.
7. Kriterien mit [MUSS] sind Ausschlusskriterien: Schlage nichts vor, das sie nachweislich verletzt. Lässt sich ein MUSS-Kriterium nicht prüfen, markiere es im Kriterien-Check als "unklar".
   Kriterien mit [wünschenswert] bevorzugst du, sie sind aber kein Ausschlussgrund. Findest du nicht genug passende Angebote, liefere weniger und sage ehrlich, woran es liegt.
8. Schreibe zwischen den Suchen KEINE Erläuterungen und keine Zwischenergebnisse – höchstens ein kurzer Satz. Die Ergebnisse gehören ausschließlich ins JSON.
9. Halte Texte im JSON knapp: Beschreibungen höchstens 2 Sätze, Stichpunkte höchstens 12 Wörter.
10. Gib am Ende genau EINEN JSON-Block zwischen <json> und </json> aus. Keine Kommentare im JSON, keine Zeilen außerhalb, die zum JSON gehören.`;
}

const ART_TEXT = {
  paar: `Reiseart: Urlaub als Ehepaar.
- Doppelzimmer, bevorzugt ruhige Lage, gern mit besonderem Ambiente.
- Die Interessen beider Partner zählen gleich. Plane so, dass beide auf ihre Kosten kommen; wo die Interessen auseinandergehen, schlage auch getrennte Halbtage vor.
- Abends bevorzugt gehobene regionale Küche, dazu auch ein, zwei besondere Orte für romantische Momente (Sonnenuntergang, Aussicht).`,
  allein: `Reiseart: Allein, ganz unabhängig.
- Einzelzimmer, möglichst ohne Einzelzimmerzuschlag; zentrale, sichere Lage. Nenne Zuschläge, wenn bekannt.
- Restaurants, in denen man allein entspannt sitzt (Tresenplätze, Tapas-/Weinbars, Markthallen, Gemeinschaftstische).
- Aktivitäten, die allein gut funktionieren; nenne Sicherheits-Hinweise für Alleinreisende, wo relevant.`,
  allein_gruppe: `Reiseart: Allein, aber mit Anschluss an andere.
- Einzelzimmer, möglichst ohne Einzelzimmerzuschlag; Unterkünfte mit Gemeinschaftsangeboten (gemeinsames Abendessen, Ausflugsprogramm, Gemeinschaftsräume) bevorzugen.
- Schwerpunkt auf organisierten Formaten: Kleingruppentouren, Kurse (Kochen, Sprache, Sport, Kunst), geführte Wanderungen, Tagesausflüge mit Gruppe, Free Walking Tours.
- Prüfe auch spezielle Reiseveranstalter für Alleinreisende und nenne sie, wenn sie zum Ziel und Zeitraum passen.
- Restaurants, die für Alleinreisende angenehm sind, und Orte, an denen man leicht ins Gespräch kommt.`,
};

function nights(start, end) {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  return Math.round((e - s) / 86400000);
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

const eigen = (p) => p && p.verkehrsmittel === "Eigenanreise";

function profileText(p) {
  const n = nights(p.start, p.ende);
  const lines = [
    ART_TEXT[p.reiseart] || ART_TEXT.paar,
    "",
    `Ziel/Wunschregion: ${p.ziel}`,
    `Reisezeitraum: ${fmtDate(p.start)} bis ${fmtDate(p.ende)} (${n} Nächte)` +
      (p.flexTage ? `, Termin flexibel um ±${p.flexTage} Tage` : ", Termin fest"),
    `Reisende: ${p.reiseart === "paar" ? "2 Erwachsene (Ehepaar)" : "1 Erwachsene Person"}`,
    `Abreise ab: ${p.abreiseOrt}`,
    `Anreise: ${eigen(p)
      ? "EIGENANREISE – der Kunde organisiert An- und Abreise selbst. Plane und kalkuliere KEINE Anreise, schlage keine Flüge, Bahnverbindungen oder Pauschalreisen vor."
      : p.verkehrsmittel === "flexibel" ? "flexibel – vergleiche Bahn, Auto und Flug (Flughäfen FRA, STR, FKB) und empfiehl das Sinnvollste" : p.verkehrsmittel}`,
    eigen(p)
      ? `Budget pro Person nur für Unterkunft und Verpflegung (ohne Anreise): ${p.budgetMin}–${p.budgetMax} €`
      : `Budget pro Person inkl. An- und Abreise und Unterkunft: ${p.budgetMin}–${p.budgetMax} €`,
    `Reisestil/Interessen: ${(p.stil || []).join(", ") || "keine Angabe"}`,
    `Tempo: ${p.tempo === "ruhig" ? "ruhig (max. 1 Programmpunkt pro Tag)" : p.tempo === "aktiv" ? "aktiv (2–3 Programmpunkte pro Tag)" : "moderat (1–2 Programmpunkte pro Tag)"}`,
    "",
    ...criteriaLines(p),
  ];

  if (p.reiseart === "paar" && p.paar) {
    const a = p.paar.nameA || "Partner/in 1";
    const b = p.paar.nameB || "Partner/in 2";
    if ((p.paar.interessenA || []).length) lines.push(`Besondere Interessen ${a}: ${p.paar.interessenA.join(", ")}`);
    if ((p.paar.interessenB || []).length) lines.push(`Besondere Interessen ${b}: ${p.paar.interessenB.join(", ")}`);
  }
  if (p.reiseart === "allein_gruppe" && p.gruppe) {
    if ((p.gruppe.formate || []).length) lines.push(`Gewünschte Gruppenformate: ${p.gruppe.formate.join(", ")}`);
    if (p.gruppe.alter) lines.push(`Bevorzugte Altersgruppe der Mitreisenden: ${p.gruppe.alter}`);
  }
  if (p.wuensche && p.wuensche.trim()) lines.push(`Weitere Wünsche/Einschränkungen: ${p.wuensche.trim()}`);

  return lines.join("\n");
}

/** Detailkriterien mit Kennzeichnung MUSS / wünschenswert. "egal"-Werte werden weggelassen. */
function criteriaLines(p) {
  const muss = p.muss || {};
  const h = p.hotel || {}, f = p.flug || {}, b = p.bahn || {}, m = p.mietwagen || {}, bu = p.buchung || {};
  const out = [];
  const add = (key, text, value) => {
    if (value === undefined || value === null || value === "" || value === "egal" || value === 0 ||
        (Array.isArray(value) && value.length === 0)) return;
    out.push(`- ${text} [${muss[key] ? "MUSS" : "wünschenswert"}]`);
  };
  const vm = p.verkehrsmittel || "flexibel";
  const fliegt = vm === "flexibel" || vm === "Flug";
  const bahnt = vm === "flexibel" || vm === "Bahn";   // bei "Eigenanreise" beides false

  out.push("Kriterien Unterkunft:");
  add("unterkunft", `Unterkunftsart: ${p.unterkunft}`, p.unterkunft === "egal – bestes Angebot" ? "" : p.unterkunft);
  add("sterne", `Kategorie: ca. ${p.sterne} Sterne`, +p.sterne);
  add("bewertung", `Gästebewertung mindestens ${String(h.bewertungMin).replace(".", ",")} von 10 (Durchschnitt großer Portale)`, +h.bewertungMin);
  add("groesse", `Hausgröße: ${h.groesse}`, h.groesse);
  if (p.reiseart === "paar") add("adultsOnly", "Erwachsenenhotel (adults only)", h.adultsOnly === "ja" ? "ja" : "");
  add("lage", `Lage: ${h.lage}`, h.lage);
  add("entfernung", `Entfernung zu Zentrum/Strand: ${h.entfernung}`, h.entfernung);
  add("zimmer", `Zimmer: ${(h.zimmer || []).join(", ")}`, h.zimmer);
  add("ausstattung", `Ausstattung: ${(h.ausstattung || []).join(", ")}`, h.ausstattung);
  add("verpflegung", `Verpflegung: ${p.verpflegung}`, p.verpflegung);
  add("ernaehrung", `Ernährung: ${p.ernaehrung}`, (p.ernaehrung || "").trim());

  out.push("Kriterien Anreise:");
  if (fliegt) {
    add("stopps", `Flug: ${f.stopps === "direkt" ? "nur Direktflug" : "höchstens 1 Umstieg, Direktflug bevorzugt"}`, f.stopps);
    add("abflug", `Abflug nicht vor ${f.abflugNichtVor} Uhr (auch Rückflug)`, f.abflugNichtVor);
    add("gepaeck", `Gepäck: ${f.gepaeck === "inklusive" ? "Aufgabegepäck inklusive" : "Handgepäck reicht"}`, f.gepaeck);
    add("klasse", `Flugklasse: ${f.klasse}`, f.klasse);
  }
  if (bahnt) {
    add("bahnklasse", `Bahn: ${b.klasse}`, b.klasse);
    add("umstiege", `Bahn: ${+b.maxUmstiege === 0 ? "nur Direktverbindung" : `höchstens ${b.maxUmstiege} Umstiege`}`, +b.maxUmstiege === 9 ? "" : String(b.maxUmstiege));
  }
  add("transfer", "Transfer vom Ankunftsort zum Hotel gewünscht", p.transfer === "gewünscht" ? "ja" : "");

  out.push("Mobilität vor Ort / Mietwagen:");
  if (m.bedarf === "nie") out.push("- Kein Mietwagen – nur ÖPNV, zu Fuß, Taxi [MUSS]");
  else {
    out.push(`- Mietwagen: ${m.bedarf === "immer" ? "für den ganzen Aufenthalt" : "nur empfehlen, wenn am Ziel sinnvoll"}`);
    add("mwKategorie", `Mietwagen-Kategorie: ${m.kategorie}`, m.kategorie);
    add("getriebe", `Getriebe: ${m.getriebe}`, m.getriebe);
    add("mwVersicherung", `Mietwagen-Versicherung: ${m.versicherung}`, m.versicherung);
    add("uebernahme", `Übernahme: ${m.uebernahme}`, m.uebernahme);
  }

  out.push("Buchung:");
  add("storno", "Kostenlos stornierbar", bu.storno === "bevorzugt" ? "ja" : "");
  if (!eigen(p)) add("buchungsart", `Buchungsart: ${bu.art === "pauschal" ? "Pauschalreise" : "Einzelbausteine"}`, bu.art === "vergleichen" ? "" : bu.art);
  return out;
}

function validateProfile(p) {
  if (!p || typeof p !== "object") throw httpError(400, "Reiseprofil fehlt.");
  if (!p.ziel || !String(p.ziel).trim()) throw httpError(400, "Bitte ein Ziel angeben.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(p.ende || "")) {
    throw httpError(400, "Bitte einen gültigen Reisezeitraum angeben.");
  }
  const n = nights(p.start, p.ende);
  if (n < 1 || n > 60) throw httpError(400, "Der Reisezeitraum muss zwischen 1 und 60 Nächten liegen.");
}

/* ------------------------------------------------------------------ */
/* Handler: Angebote                                                   */
/* ------------------------------------------------------------------ */

async function handleOffers(body, env) {
  const p = body.profile;
  validateProfile(p);
  const ausschluss = Array.isArray(body.exclude) && body.exclude.length
    ? `\nDiese Angebote kennt der Kunde schon – schlage andere vor: ${body.exclude.slice(0, 20).join("; ")}`
    : "";

  const user = `${profileText(p)}${ausschluss}

Aufgabe: Stelle GENAU 5 deutlich unterschiedliche Reiseangebote zusammen.
- Unterscheide sie spürbar (z. B. Teilregion, Art der Unterkunft, Charakter, Anreise, Preisniveau innerhalb des Budgets).
- Ist das Ziel eine größere Region oder ein Land, verteile die Angebote auf passende Orte. Ist es ein einzelner Ort, variiere Unterkunft, Lage und Schwerpunkt.
${eigen(p)
  ? `- Nenne für jedes Angebot eine konkrete, real existierende Unterkunft mit URL (Hotelwebsite oder Buchungsportal).
- Eigenanreise: Fülle "anreise" nur als kurzen Hinweis – "verkehrsmittel": "Eigenanreise", in "details" die nächstgelegenen Flughäfen/Bahnhöfe bzw. Parkmöglichkeit am Hotel, "dauer" leer, keine Kosten.
- Kalkuliere einen Richtpreis pro Person NUR für Unterkunft und Verpflegung im gesamten Zeitraum (ohne Anreise). Liegt ein Angebot über dem Budget, kennzeichne das.`
  : `- Nenne für jedes Angebot eine konkrete, real existierende Unterkunft mit URL (Hotelwebsite oder Buchungsportal) sowie eine realistische Anreise ab Brühl.
- Kalkuliere einen Richtpreis pro Person für den gesamten Zeitraum. Liegt ein Angebot über dem Budget, kennzeichne das.`}
- Prüfe für jedes Angebot die Kriterien oben und fasse das Ergebnis im "kriterienCheck" zusammen (nur Kriterien, die nicht "egal" sind).
- Gib Gästebewertungen nur mit Quelle (Portal) an; ohne Quelle "wert": null.
${eigen(p) || (p.buchung && p.buchung.art === "einzeln") ? "" : `- Mindestens eines der Angebote soll – sofern für Ziel und Zeitraum verfügbar – eine Pauschalreise eines Reiseveranstalters sein (z. B. Flug + Hotel), mit Link zur Angebotsseite des Veranstalters. Gibt es keine, sag es in "hinweiseAllgemein".
`}- Recherchiere einmal die Einreisebestimmungen für deutsche Staatsangehörige (bevorzugt Auswärtiges Amt) mit Quelle.
- Halte die Recherche schlank: Dies ist eine Vorauswahl, der ausführliche Reiseführer folgt später.

JSON-Schema:
<json>
{
  "angebote": [
    {
      "id": 1,
      "titel": "kurzer, aussagekräftiger Titel",
      "ort": "Ort, Region, Land",
      "charakter": "1 Satz zum Charakter",
      "kurzbeschreibung": "max. 2 Sätze",
      "passtWeil": "1 Satz",
      "unterkunft": { "name": "", "art": "", "sterne": 0, "lage": "", "entfernung": "zu Zentrum/Strand", "url": "", "verifiziert": true,
                      "bewertung": { "wert": 8.6, "skala": 10, "quelle": "Portal", "anzahl": "ca. Anzahl" },
                      "ausstattung": ["nur gefundene Merkmale"], "verpflegung": "", "adultsOnly": false },
      "anreise": { "verkehrsmittel": "Bahn|Auto|Flug", "details": "Strecke/Flughafen/Airline", "stopps": 0, "abflugzeiten": "typische Zeiten laut Quelle", "dauer": "ca. Stunden", "gepaeck": "", "transfer": "", "hinweis": "" },
      "mietwagen": { "empfohlen": true, "begruendung": "", "richtpreis": "" },
      "buchung": { "art": "Pauschalreise|Einzelbausteine", "anbieter": "", "storno": "Stornobedingungen laut Quelle" },
      "preis": { "proPersonVon": 0, "proPersonBis": 0, "enthalten": "was im Richtpreis steckt", "quelle": "woher die Preise stammen", "imBudget": true },
      "kriterienCheck": [ { "kriterium": "", "muss": true, "status": "erfüllt|nicht erfüllt|unklar", "hinweis": "" } ],
      "highlights": ["3–4 Stichpunkte"],
      "nachteile": ["ehrliche Nachteile/Risiken"],
      "buchungsLinks": [ { "label": "Unterkunft", "url": "" }, { "label": "Anreise", "url": "" } ]
    }
  ],
  "einreise": { "dokumente": "", "hinweis": "", "url": "" },
  "hinweiseAllgemein": ["Hinweise zu Zeitraum und Saison"]
}
</json>`;

  const { data, sources, searches } = await researchAsJson(env, {
    system: baseSystem(),
    user,
    maxUses: SEARCH_LIMITS.offers,
    maxTokens: 16000,
  });

  if (!Array.isArray(data.angebote) || data.angebote.length === 0) {
    throw new Error("Es konnten keine Angebote erstellt werden. Bitte Ziel oder Zeitraum anpassen und erneut versuchen.");
  }
  data.angebote = data.angebote.map((a, i) => ({ ...a, id: i + 1 }));
  const linkInfo = await verifyLinks(data, sources, { ort: p.ziel });
  if (data.angebote.length < 5) {
    data.hinweiseAllgemein = [
      `Es konnten nur ${data.angebote.length} passende Angebote verlässlich gefunden werden. Tipp: Ziel weiter fassen oder Zeitraum flexibler wählen.`,
      ...(data.hinweiseAllgemein || []),
    ];
  }
  return { ...data, quellen: sources, suchen: searches, links: linkInfo, erstellt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* Handler: Reiseführer                                                */
/* ------------------------------------------------------------------ */

async function handleGuide(body, env) {
  const p = body.profile;
  validateProfile(p);
  if (!body.offer || typeof body.offer !== "object") throw httpError(400, "Kein Angebot ausgewählt.");
  const n = nights(p.start, p.ende);
  const tage = Math.min(n + 1, 21);

  const user = `${profileText(p)}

Gewähltes Angebot:
${JSON.stringify(body.offer, null, 2).slice(0, 8000)}

Aufgabe: Erstelle einen persönlichen Reiseführer für genau dieses Angebot und diesen Zeitraum.
- 6–8 wichtigste Sehenswürdigkeiten (realistische Dauer, Eintritt, Öffnungs-/Saisonhinweise für den Zeitraum, Tipp gegen Wartezeiten).
- Aktivitäten getrennt nach "organisiert" (mit Anbieter, Preis, Buchungsweg, ob in der Gruppe) und "selbstorganisiert" (mit konkreter Anleitung), je 4–5.
- 3–4 Tagesausflüge in die Umgebung (Ziel, Entfernung/Fahrzeit, organisiert mit Anbieter und Preis oder selbst organisiert mit Anleitung).
- 4–5 besonders schöne Orte (Aussichtspunkte, Gassen, Strände, Gärten) mit bester Tageszeit.
- 6–8 Restaurants in gemischtem Preisniveau mit Küche, Lage, Reservierungshinweis und für wen sie besonders geeignet sind.
- Einen Tagesplan für ${tage} Tage (Anreisetag bis Abreisetag) mit Schlechtwetter-Alternative je Tag.${eigen(p) ? " Die Anreise organisiert der Kunde selbst – plane am ersten und letzten Tag nur leichte Programmpunkte ohne feste Uhrzeiten." : ""}
- Praktisches: Wetter im Zeitraum, Mobilität vor Ort, Bezahlen/Trinkgeld, Sicherheit, Feiertage/Events im Zeitraum.

JSON-Schema:
<json>
{
  "ueberblick": "3–5 Sätze",
  "praktisches": { "wetter": "", "mobilitaet": "", "geld": "", "sicherheit": "", "eventsImZeitraum": "" },
  "sehenswuerdigkeiten": [ { "name": "", "beschreibung": "", "dauer": "", "eintritt": "", "oeffnung": "", "tipp": "", "url": "", "verifiziert": true } ],
  "aktivitaeten": {
    "organisiert": [ { "name": "", "anbieter": "", "beschreibung": "", "preis": "", "dauer": "", "inGruppe": true, "buchung": "", "url": "", "verifiziert": true } ],
    "selbstorganisiert": [ { "name": "", "beschreibung": "", "soGehts": "", "kosten": "", "dauer": "", "url": "" } ]
  },
  "ausfluege": [ { "name": "", "ziel": "", "entfernung": "Fahrzeit", "art": "organisiert|selbst", "beschreibung": "", "anbieter": "", "preis": "", "dauer": "", "soGehts": "", "url": "" } ],
  "schoeneOrte": [ { "name": "", "warum": "", "besteZeit": "", "tipp": "", "url": "" } ],
  "restaurants": [ { "name": "", "kueche": "", "preisniveau": "€|€€|€€€|€€€€", "lage": "", "warum": "", "geeignetFuer": "", "reservierung": "", "url": "", "verifiziert": true } ],
  "tagesplan": [ { "tag": 1, "datum": "TT.MM.JJJJ", "titel": "", "vormittag": "", "nachmittag": "", "abend": "", "beiRegen": "" } ]
}
</json>`;

  const { data, sources, searches } = await researchAsJson(env, {
    system: baseSystem(),
    user,
    maxUses: SEARCH_LIMITS.guide,
    maxTokens: 18000,
  });

  const linkInfo = await verifyLinks(data, sources, { ort: body.offer.ort || p.ziel });
  return { ...data, quellen: sources, suchen: searches, links: linkInfo, erstellt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* Handler: Spontan-Tipp im Reise-Modus                                */
/* ------------------------------------------------------------------ */

async function handleTip(body, env) {
  const q = String(body.question || "").trim();
  if (!q) throw httpError(400, "Bitte eine Frage eingeben.");
  const ctxText = String(body.context || "").slice(0, 6000);
  let loc = "";
  if (body.location && Number.isFinite(body.location.lat) && Number.isFinite(body.location.lon)) {
    // auf ca. 100 m gerundet – genauer ist für Tipps nicht nötig
    loc = `\nAktueller Standort (gerundet): ${body.location.lat.toFixed(3)}, ${body.location.lon.toFixed(3)}`;
  }
  const now = new Date().toLocaleString("de-DE", { timeZone: body.timezone || "Europe/Berlin" });

  const user = `Der Kunde ist gerade im Urlaub und braucht einen schnellen, konkreten Tipp.
Jetzt: ${now}${loc}

Reisekontext:
${ctxText}

Frage: ${q}

Antworte kurz und praktisch. Prüfe Öffnungszeiten für heute, wenn möglich. Maximal 4 Vorschläge.
JSON-Schema:
<json>
{ "antwort": "2–4 Sätze", "vorschlaege": [ { "name": "", "warum": "", "entfernung": "", "hinweis": "", "url": "" } ] }
</json>`;

  const { data, sources } = await researchAsJson(env, {
    system: baseSystem(),
    user,
    maxUses: SEARCH_LIMITS.tip,
    maxTokens: 2500,
  });
  await verifyLinks(data, sources, { ort: "" });
  return { ...data, quellen: sources.slice(0, 8), frage: q, zeit: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* Handler: gespeicherte Reisen (D1)                                   */
/* ------------------------------------------------------------------ */

async function handleTrips(request, env, id, cors) {
  const db = env.DB;

  if (request.method === "GET" && !id) {
    const { results } = await db
      .prepare("SELECT id, title, ziel, reiseart, start_date, end_date, updated_at FROM trips ORDER BY start_date DESC")
      .all();
    return json({ trips: results }, 200, cors);
  }

  if (request.method === "GET" && id) {
    const row = await db.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
    if (!row) return json({ error: "Reise nicht gefunden." }, 404, cors);
    return json({ trip: { ...row, data: JSON.parse(row.data) } }, 200, cors);
  }

  if (request.method === "POST" && !id) {
    const b = await readBody(request);
    const t = tripFields(b);
    const newId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO trips (id, title, ziel, reiseart, start_date, end_date, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId, t.title, t.ziel, t.reiseart, t.start_date, t.end_date, t.data, now, now)
      .run();
    return json({ id: newId }, 201, cors);
  }

  if (request.method === "PUT" && id) {
    const b = await readBody(request);
    const t = tripFields(b);
    const now = new Date().toISOString();
    const r = await db
      .prepare("UPDATE trips SET title = ?, ziel = ?, reiseart = ?, start_date = ?, end_date = ?, data = ?, updated_at = ? WHERE id = ?")
      .bind(t.title, t.ziel, t.reiseart, t.start_date, t.end_date, t.data, now, id)
      .run();
    if (!r.meta || r.meta.changes === 0) return json({ error: "Reise nicht gefunden." }, 404, cors);
    return json({ ok: true, updated_at: now }, 200, cors);
  }

  if (request.method === "DELETE" && id) {
    await db.prepare("DELETE FROM trips WHERE id = ?").bind(id).run();
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "Methode nicht unterstützt." }, 405, cors);
}

/* ------------------------------------------------------------------ */
/* Handler: Präferenzen                                                */
/* ------------------------------------------------------------------ */

const REISEARTEN = ["paar", "allein", "allein_gruppe"];
let prefsTableReady = false;

async function ensurePrefsTable(db) {
  if (prefsTableReady) return;
  await db
    .prepare("CREATE TABLE IF NOT EXISTS prefs (reiseart TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)")
    .run();
  prefsTableReady = true;
}

async function handlePrefs(request, env, art, cors) {
  const db = env.DB;
  await ensurePrefsTable(db);

  if (request.method === "GET" && !art) {
    const { results } = await db.prepare("SELECT reiseart, data, updated_at FROM prefs").all();
    const prefs = {};
    for (const r of results || []) {
      try { prefs[r.reiseart] = { ...JSON.parse(r.data), _updated: r.updated_at }; } catch { /* defekter Eintrag wird ignoriert */ }
    }
    return json({ prefs }, 200, cors);
  }

  if (art && !REISEARTEN.includes(art)) return json({ error: "Unbekannte Reiseart." }, 400, cors);

  if (request.method === "PUT" && art) {
    const b = await readBody(request);
    if (!b || typeof b.data !== "object" || Array.isArray(b.data)) throw httpError(400, "Präferenzen fehlen.");
    const data = JSON.stringify(b.data);
    if (data.length > 100_000) throw httpError(413, "Präferenzen zu groß.");
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO prefs (reiseart, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(reiseart) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .bind(art, data, now)
      .run();
    return json({ ok: true, updated_at: now }, 200, cors);
  }

  if (request.method === "DELETE" && art) {
    await db.prepare("DELETE FROM prefs WHERE reiseart = ?").bind(art).run();
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "Methode nicht unterstützt." }, 405, cors);
}

function tripFields(b) {
  if (!b || typeof b !== "object" || !b.data) throw httpError(400, "Reisedaten fehlen.");
  const data = JSON.stringify(b.data);
  if (data.length > MAX_BODY_BYTES) throw httpError(413, "Reisedaten zu groß.");
  const p = b.data.profile || {};
  return {
    title: String(b.title || p.ziel || "Reise").slice(0, 200),
    ziel: String(p.ziel || "").slice(0, 200),
    reiseart: String(p.reiseart || "").slice(0, 30),
    start_date: String(p.start || ""),
    end_date: String(p.ende || ""),
    data,
  };
}
