"use strict";

/* Flutlicht: private Spielansicht. Die Daten liegen verschluesselt in data.enc
   und werden erst hier im Browser mit dem Passwort geoeffnet. */

const DATEN_URL = "data.enc";
const SPEICHER = "flutlicht.passwort";
const MIN_MINUTEN = 180;
const TZ = "Europe/Vienna";
const RASTER_X = 21;
const RASTER_Y = 14;

const app = document.getElementById("app");
const zustand = {
  daten: null,
  passwort: null,
  tab: "tipps",
  tippMarkt: "schuesse",
  tippTeam: "beide",
  tippGruppe: "torschuetzen",
  tippAbschnitt: { tore: "endergebnis" },
  bereichWahl: { art: "spiel", von: "2", bis: "3" },  // Tore-Bereich selbst waehlen
  heatTeam: "heim",
  heatQuelle: "form",
  metrik: "fouls90",
  spielerTeam: "beide",
  volle: new Map(),   // geladene Spiele mit voller Analyse (id -> Spiel)
  ladend: new Map(),  // laufende Ladevorgaenge (id -> Promise)
  generation: 0,      // steigt bei jedem Neuladen, damit alte Antworten nichts ueberschreiben
  schnellSpiel: null, // Spiel, bei dem die Schnell-Eingabe der Bet365-Quoten offen ist
  schnellGruppen: new Set(["torschuetzen"]), // offene Maerkte in der Schnell-Eingabe
  spielKombi: { anzahl: 0, quote: "" },  // Kombis aus einem Spiel: Anzahl Tipps (0 = egal), Wunschquote
};

/* ------------------------------------------------------------- Hilfen */

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function zahl(wert, stellen = 1) {
  if (wert == null || Number.isNaN(Number(wert))) return "-";
  return Number(wert).toLocaleString("de-AT", { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
}

const fmtUhr = new Intl.DateTimeFormat("de-AT", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtTag = new Intl.DateTimeFormat("de-AT", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const fmtKurz = new Intl.DateTimeFormat("de-AT", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
const fmtDatum = new Intl.DateTimeFormat("de-AT", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const fmtTagMonat = new Intl.DateTimeFormat("de-AT", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const fmtSchluessel = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

const uhr = (ts) => fmtUhr.format(new Date(ts * 1000));
const tagSchluessel = (ts) => fmtSchluessel.format(new Date(ts * 1000));

function kuerzel(team) {
  if (team.kurz && team.kurz.length <= 4) return team.kurz.toUpperCase();
  const worte = String(team.name || "").split(/\s+/).filter((w) => /^[A-Za-zÀ-ÿ]/.test(w));
  if (worte.length >= 2) return worte.slice(0, 3).map((w) => w[0]).join("").toUpperCase();
  return String(team.name || "?").slice(0, 3).toUpperCase();
}

const kurzName = (team) => team.kurz || team.name;

// Vereinslogos kommen direkt von FotMob. Laedt eins nicht, bleibt der Platz leer
// (im Spielkopf erscheint dann das Kuerzel).
function logo(id, klasse = "logo", gross = false) {
  if (!id) return `<span class="${klasse} ohne" aria-hidden="true"></span>`;
  const datei = gross ? `${id}.png` : `${id}_small.png`;
  return `<img class="${klasse}" src="https://images.fotmob.com/image_resources/logo/teamlogo/${datei}" alt="" loading="${gross ? "eager" : "lazy"}" referrerpolicy="no-referrer" onerror="this.classList.add('fehlt')">`;
}

const LAENDER = {
  Austria: "Österreich", Azerbaijan: "Aserbaidschan", Belgium: "Belgien", Bulgaria: "Bulgarien", Croatia: "Kroatien",
  Cyprus: "Zypern", Czechia: "Tschechien", "Czech Republic": "Tschechien", Denmark: "Dänemark", England: "England",
  Finland: "Finnland", France: "Frankreich", Georgia: "Georgien", Germany: "Deutschland", Greece: "Griechenland",
  Hungary: "Ungarn", Iceland: "Island", Ireland: "Irland", Israel: "Israel", Italy: "Italien", Lithuania: "Litauen",
  Netherlands: "Niederlande", Norway: "Norwegen", Poland: "Polen", Portugal: "Portugal", Romania: "Rumänien",
  Russia: "Russland", Scotland: "Schottland", Serbia: "Serbien", Slovakia: "Slowakei", Slovenia: "Slowenien",
  Spain: "Spanien", Sweden: "Schweden", Switzerland: "Schweiz", Turkey: "Türkei", "Türkiye": "Türkei",
  Ukraine: "Ukraine", Wales: "Wales",
};
const land = (name) => LAENDER[name] || name;

function lesen(schluessel) {
  try { return window.localStorage.getItem(schluessel); } catch (e) { return null; }
}
function schreiben(schluessel, wert) {
  try {
    if (wert == null) window.localStorage.removeItem(schluessel);
    else window.localStorage.setItem(schluessel, wert);
  } catch (e) { /* privat oder gesperrt: dann eben ohne Merken */ }
}

const ICON_ZURUECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>';
const ICON_NEU = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"></path><path d="M21 4v5h-5"></path></svg>';
const ICON_WARNUNG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z"></path><path d="M12 10v5"></path><path d="M12 18h.01"></path></svg>';

/* --------------------------------------------------------- Entschluesseln */

function base64(text) {
  const roh = atob(text);
  const bytes = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
  return bytes;
}

// Alle Dateien eines Exports teilen sich Salz und Schluessel. Die teure Ableitung
// (310.000 Runden) laeuft deshalb nur einmal, danach kommt der Schluessel aus dem Speicher.
const schluesselSpeicher = new Map();

function schluesselFuer(paket, passwort) {
  const id = `${paket.salz}|${paket.iterationen}|${passwort}`;
  if (!schluesselSpeicher.has(id)) {
    if (schluesselSpeicher.size > 4) schluesselSpeicher.clear();
    const versprechen = crypto.subtle
      .importKey("raw", new TextEncoder().encode(passwort), "PBKDF2", false, ["deriveKey"])
      .then((basis) => crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: base64(paket.salz), iterations: paket.iterationen, hash: "SHA-256" },
        basis,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      ));
    versprechen.catch(() => schluesselSpeicher.delete(id));
    schluesselSpeicher.set(id, versprechen);
  }
  return schluesselSpeicher.get(id);
}

async function entschluesseln(paket, passwort) {
  const schluessel = await schluesselFuer(paket, passwort);
  const klar = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64(paket.iv) }, schluessel, base64(paket.daten));
  return JSON.parse(new TextDecoder().decode(klar));
}

async function laden(passwort) {
  let antwort;
  try {
    antwort = await fetch(`${DATEN_URL}?t=${Date.now()}`, { cache: "no-store" });
  } catch (e) {
    throw new Error("Keine Verbindung. Prüfe dein Internet und versuche es noch einmal.");
  }
  if (antwort.status === 404) throw new Error("Es sind noch keine Daten veröffentlicht. Der nächste Sammler-Lauf stellt sie bereit.");
  if (!antwort.ok) throw new Error(`Die Daten konnten nicht geladen werden (Fehler ${antwort.status}).`);
  const paket = await antwort.json();
  try {
    const daten = await entschluesseln(paket, passwort);
    zustand.daten = daten;
    zustand.volle = new Map();
    zustand.ladend = new Map();
    zustand.generation += 1;
  } catch (e) {
    const fehler = new Error("Das Passwort stimmt nicht.");
    fehler.passwort = true;
    throw fehler;
  }
  zustand.passwort = passwort;
  if (typeof abgleichen === "function") setTimeout(abgleichen, 0);
}

/* ---------------------------------------------------------------- Sperre */

function zeigeSperre(meldung = "") {
  app.innerHTML = `
    <section class="sperre">
      <h1>Flut<span>licht</span></h1>
      <form id="sperre-form" autocomplete="on">
        <label for="passwort">Passwort</label>
        <input class="feld" id="passwort" name="password" type="password" autocomplete="current-password" required>
        <label class="haken"><input type="checkbox" id="merken" checked> Auf diesem Gerät merken</label>
        <button class="knopf" type="submit" id="oeffnen">Öffnen</button>
        <p class="fehler" role="alert">${esc(meldung)}</p>
      </form>
    </section>`;
  const form = document.getElementById("sperre-form");
  form.addEventListener("submit", async (ereignis) => {
    ereignis.preventDefault();
    const knopf = document.getElementById("oeffnen");
    const passwort = document.getElementById("passwort").value;
    knopf.disabled = true;
    knopf.textContent = "Wird geöffnet";
    try {
      await laden(passwort);
      schreiben(SPEICHER, document.getElementById("merken").checked ? passwort : null);
      route();
    } catch (fehler) {
      zeigeSperre(fehler.message);
    }
  });
  document.getElementById("passwort").focus();
}

/* ------------------------------------------------------------- Spielplan */

function fuss() {
  const d = zustand.daten;
  const zeit = d.letzter_lauf || d.stand;
  const leiste = scheinLeiste();
  document.body.classList.toggle("mit-leiste", Boolean(leiste));
  return `
    <div class="fuss">
      <span>Daten von ${esc(fmtKurz.format(new Date(zeit * 1000)))}, ${uhr(zeit)} Uhr</span>
      <button data-aktion="neu">Neu laden</button>
    </div>${leiste}`;
}

/* --------------------------------------------------------------- Spielkopf */

function formPillen(form) {
  return `<div class="form" aria-label="Form, älteste zuerst">${[...(form || "")]
    .slice(-5)
    .map((r) => `<i class="${r}">${r}</i>`)
    .join("")}</div>`;
}

function seiteKopf(team) {
  return `
    <div class="seite">
      <div class="wappen" aria-hidden="true"><span>${esc(kuerzel(team))}</span>${logo(team.id, "wappen-bild", true)}</div>
      <div class="name">${esc(team.name)}</div>
      ${formPillen(team.form)}
    </div>`;
}

function spielKopf(s) {
  const runde = s.runde && /^\d+$/.test(s.runde) ? `Spieltag ${esc(s.runde)}` : "";
  let aufstellung = "Aufstellung noch offen";
  let klasse = "pille";
  if (s.aufstellung === "standard") { aufstellung = "Aufstellung bestätigt"; klasse += " fix"; }
  else if (s.aufstellung) aufstellung = "Aufstellung voraussichtlich";
  return `
    <div class="oben">
      <button class="rund" data-aktion="zurueck" aria-label="Zurück zu den Spielen">${ICON_ZURUECK}</button>
      <div class="wer"><strong>${esc(s.wettbewerb || "")}</strong>${runde}</div>
      <span style="width:44px" aria-hidden="true"></span>
    </div>
    <div class="duell">
      ${seiteKopf(s.heim)}
      <div class="mitte" id="kopf-stand">${kopfStand(standVoll(s), s.anstoss)}</div>
      ${seiteKopf(s.gast)}
    </div>
    ${s.stadion ? `<div class="stadion">${esc(s.stadion)}</div>` : ""}
    <div class="hinweisband"><span class="${klasse}">${aufstellung}</span></div>`;
}

const TABS = [
  ["tipps", "Tipps"],
  ["aufstellung", "Aufstellung"],
  ["ueberblick", "Überblick"],
  ["heatmaps", "Heatmaps"],
  ["spieler", "Spieler"],
  ["schiri", "Schiri"],
];

function standVoll(s) {
  const details = liveDetails.get(s.id);
  if (details) return details.live.stand;
  if (liveListe.has(s.id)) return liveListe.get(s.id);
  if (s.status === "inprogress") return { art: "inprogress", h: s.heim_tore ?? 0, g: s.gast_tore ?? 0, minute: "live" };
  return null;
}

const spielBegonnen = (s) => s.anstoss * 1000 <= Date.now() || s.status !== "notstarted";
const tabsFuer = (s) =>
  spielBegonnen(s) ? [["live", "Live"], ["aufstellung", "Aufstellung"], ...TABS.filter(([k]) => k !== "aufstellung")] : TABS;

function zeigeSpiel(s) {
  timerStoppen();
  const tabListe = tabsFuer(s);
  if (!tabListe.some(([id]) => id === zustand.tab)) zustand.tab = tabListe[0][0];
  const tabs = `<nav class="tabs" role="tablist">${tabListe.map(
    ([schluessel, name]) =>
      `<button role="tab" data-tab="${schluessel}" aria-selected="${zustand.tab === schluessel}">${name}</button>`,
  ).join("")}</nav>`;
  let inhalt = "";
  if (zustand.tab === "live") inhalt = `<div id="live" data-id="${s.id}" data-ansicht="ticker">${liveInhalt(s.id, s, s.anstoss)}</div>`;
  else if (zustand.tab === "aufstellung") inhalt = `<div id="live" data-id="${s.id}" data-ansicht="aufstellung">${liveDetails.has(s.id) ? aufstellungInhalt(s.id) : '<p class="leer">Aufstellung wird geladen</p>'}</div>`;
  else if (zustand.tab === "tipps") inhalt = tabTipps(s);
  else if (zustand.tab === "heatmaps") inhalt = tabHeatmaps(s);
  else if (zustand.tab === "spieler") inhalt = tabSpieler(s);
  else if (zustand.tab === "schiri") inhalt = tabSchiri(s);
  else inhalt = tabUeberblick(s);
  app.innerHTML = spielKopf(s) + tabs + inhalt + fuss();
  if (zustand.tab === "heatmaps") heatmapZeichnen(s);
  if (zustand.tab === "live") liveStarten(s.id, s);
  if (zustand.tab === "aufstellung") liveStarten(s.id, s, { einmal: !spielBegonnen(s) || (standVoll(s) || {}).art === "finished" });
}

/* --------------------------------------------------------------- Ueberblick */

function marke(spieler) {
  if (spieler.hinweis === "fehlt") return '<span class="marke fehlt">fehlt</span>';
  if (spieler.hinweis === "fraglich") return '<span class="marke fraglich">fraglich</span>';
  if (spieler.startelf === false) return '<span class="marke">nicht in Startelf</span>';
  return "";
}

function spielweiseHtml(s) {
  const teams = [s.heim, s.gast].filter((t) => t.spielweise);
  if (!teams.length) return "";
  return `
    <section class="abschnitt">
      <h2>Spielweise</h2>
      <p>Aus den letzten Pflichtspielen, verglichen mit den anderen Teams in der Datenbank. Erwähnt wird nur, was deutlich vom Schnitt abweicht.</p>
      <div class="spielweise">${teams
        .map((t) => {
          const w = t.spielweise;
          const zeilen = [w.formation, w.seite, ...(w.punkte || [])].filter(Boolean);
          return `
          <div class="spielweise-team">
            <div class="kopf-team">${logo(t.id, "logo")}<strong>${esc(t.name)}</strong><span class="leise klein">${w.spiele} Spiele</span></div>
            ${w.hinweis ? `<p class="leise klein">${esc(w.hinweis)}</p>` : ""}
            <ul>${zeilen.map((z) => `<li>${esc(z)}</li>`).join("")}</ul>
          </div>`;
        })
        .join("")}</div>
    </section>`;
}

/* Fazit fuer das ganze Spiel: was die Zahlen fuer die Wetten heissen. Jede Aussage kommt aus denselben
   Erwartungen wie die Tipps (das Modell gegen den Liga-Schnitt), die Werte der Teams und des Schiris sind
   die Begruendung. So passt das Fazit immer zu den Chancen im Reiter Tipps. Am 07.11.2026 an 961 alten
   Spielen geprueft: Flanken, Fouls, Ballbesitz und Strafraumaktionen verbessern die Prognose fuer Ecken
   und Karten nicht ueber das hinaus, was das Modell schon nutzt. Sie stehen darum nur als Begruendung da. */
const FAZIT_SCHWELLE = { tore: 0.08, ecken: 0.08, karten: 0.1 };   // ab so viel Abweichung vom Liga-Schnitt
// "Eher viele Tore" nur, wenn die Wette an der ueblichen Linie der Liga (die halbe Linie am Liga-Schnitt,
// zum Beispiel ueber 2,5) mindestens so oft aufgeht. Sonst waere das Fazit ein Muenzwurf mit Ueberschrift.
const FAZIT_P = 0.6;   // 60 %: robust gegen ein paar Punkte Abweichung (Tore und Gelbe lagen zuletzt etwas daneben)

function fazitPunkte(s) {
  const pr = s.prognose;
  const liga = s.liga_schnitt;
  if (!pr || !pr.erw || !liga) return [];
  const idx = tippIndex(s);
  const H = kurzName(s.heim);
  const G = kurzName(s.gast);
  const hs = s.heim.schnitt || {};
  const gs = s.gast.schnitt || {};
  const ligaName = s.wettbewerb || "Liga";
  const tipp = (k) => { const t = idx.get(k); return t && t.p > 0 && !t.push ? t : null; };
  // Linie in eine Richtung: die, deren Chance am naechsten an 62 % liegt (zwischen 50 und 82 %)
  const linie = (markt, richtung, team = "") => {
    let beste = null;
    for (const t of idx.values()) {
      if (t.markt !== markt || t.push) continue;
      const [, , r, , tm] = t.k.split("|");
      if (r !== richtung || String(tm || "") !== String(team) || t.p < 0.5 || t.p > 0.82) continue;
      if (!beste || Math.abs(t.p - 0.62) < Math.abs(beste.p - 0.62)) beste = t;
    }
    return beste;
  };
  const z1 = (x) => zahl(x, 1);
  const punkte = [];
  // Wette an der halben Linie, die dem Liga-Schnitt am naechsten liegt, nur wenn sie oft genug aufgeht
  const amSchnitt = (markt, richtung, schnitt) => {
    const t = tipp(`${markt}|${Math.round(schnitt - 0.5) + 0.5}|${richtung}||`);
    return t && t.p >= FAZIT_P ? t : null;
  };

  // Sieger
  const pH = tipp("tore_ergebnis||heim||");
  const pX = tipp("tore_ergebnis||unentschieden||");
  const pG = tipp("tore_ergebnis||gast||");
  if (pH && pX && pG) {
    const heimFav = pH.p >= pG.p;
    const [fav, und, pf, pu, fs, us] = heimFav ? [H, G, pH, pG, hs, gs] : [G, H, pG, pH, gs, hs];
    const abstand = pf.p - pu.p;
    const gruende = [];
    if (fs.schuesse_fuer && us.schuesse_fuer && fs.schuesse_fuer - us.schuesse_fuer >= 2) gruende.push(`${fav} schießt im Schnitt ${z1(fs.schuesse_fuer)}-mal, ${und} ${z1(us.schuesse_fuer)}-mal`);
    if (fs.ballbesitz && us.ballbesitz && Math.abs(fs.ballbesitz - us.ballbesitz) >= 6) gruende.push(fs.ballbesitz > us.ballbesitz ? `${fav} hat meist mehr den Ball (${fs.ballbesitz} zu ${us.ballbesitz} %)` : `${und} hat zwar mehr den Ball (${us.ballbesitz} zu ${fs.ballbesitz} %), ${fav} ist aber gefährlicher`);
    const zahlen = `Sieg ${fav} ${prozent(pf.p)}, Unentschieden ${prozent(pX.p)}, Sieg ${und} ${prozent(pu.p)}.`;
    if (pf.p >= 0.5 || abstand >= 0.2) {
      const dc = tipp(heimFav ? "tore_doppelte_chance||1x||" : "tore_doppelte_chance||x2||");
      punkte.push({ gewicht: 0.5 + abstand, titel: pf.p >= 0.62 ? `${fav} ist klarer Favorit` : `${fav} ist Favorit`,
        text: `${zahlen} ${gruende.join(". ")}${gruende.length ? "." : ""}`, tipps: [pf.p >= 0.6 ? pf : dc].filter(Boolean) });
    } else if (abstand < 0.1) {
      punkte.push({ gewicht: 0.25, titel: "Offenes Spiel", text: `${zahlen} Auf den Sieger zu setzen ist hier ein Münzwurf, besser auf Tore, Ecken oder Karten schauen.`, tipps: [] });
    }
  }

  // Tore
  const torErw = pr.erw.tore ? pr.erw.tore[0] + pr.erw.tore[1] : null;
  if (torErw) {
    const r = torErw / liga.tore - 1;
    const teamText = `${H} trifft erwartet ${z1(pr.erw.tore[0])}-mal, ${G} ${z1(pr.erw.tore[1])}-mal`;
    const btts = tipp("tore_btts||ja||");
    const bttsN = tipp("tore_btts||nein||");
    const torTipp = Math.abs(r) >= FAZIT_SCHWELLE.tore ? amSchnitt("tore_spiel", r > 0 ? "ueber" : "unter", liga.tore) : null;
    if (torTipp) {
      const viel = r > 0;
      const gruende = [teamText];
      const [angr, abw, ats] = pr.erw.tore[0] >= pr.erw.tore[1] ? [H, G, hs, gs] : [G, H, gs, hs];
      if (viel && ats.schuesse_fuer >= 14) gruende.push(`${angr} schießt im Schnitt ${z1(ats.schuesse_fuer)}-mal (${z1(ats.aufs_tor_fuer)} aufs Tor)`);
      const raeng = ((pr.erw.tore[0] >= pr.erw.tore[1] ? s.gast : s.heim).spielweise || {}).raenge || {};
      if (viel && raeng.schuesse_gegen >= 0.75) gruende.push(`${abw} lässt viele Schüsse zu`);
      if (!viel && raeng.schuesse_gegen <= 0.25) gruende.push(`${abw} lässt wenig zu`);
      const t2 = viel ? (btts && btts.p >= 0.58 ? btts : null) : (bttsN && bttsN.p >= 0.55 ? bttsN : null);
      punkte.push({ gewicht: Math.abs(r) * 3, titel: viel ? "Eher viele Tore" : "Eher wenig Tore",
        text: `Erwartet sind etwa ${z1(torErw)} Tore, der Schnitt in der ${ligaName} liegt bei ${z1(liga.tore)}. ${gruende.join(". ")}.`,
        tipps: [torTipp, t2].filter(Boolean) });
    } else if (btts && (btts.p >= 0.62 || btts.p <= 0.38)) {
      punkte.push({ gewicht: Math.abs(btts.p - 0.5) * 2, titel: btts.p >= 0.62 ? "Beide treffen wahrscheinlich" : "Eher trifft nur ein Team",
        text: `${teamText}. Insgesamt etwa ${z1(torErw)} Tore erwartet, Schnitt der ${ligaName} ${z1(liga.tore)}.`,
        tipps: [btts.p >= 0.62 ? btts : bttsN].filter(Boolean) });
    }
    // Ein Team tut sich schwer
    [[0, H, s.heim.id], [1, G, s.gast.id]].forEach(([i, name, id]) => {
      if (pr.erw.tore[i] <= 0.85) {
        punkte.push({ gewicht: (0.85 - pr.erw.tore[i]) * 2 + 0.1, titel: `${name} tut sich schwer`, text: `${name} trifft erwartet nur ${z1(pr.erw.tore[i])}-mal.`,
          tipps: [linie("tore_team", "unter", id)].filter(Boolean) });
      }
    });
  }

  // Ecken
  if (pr.erw.ecken && liga.ecken) {
    const [eh, eg] = pr.erw.ecken;
    const r = (eh + eg) / liga.ecken - 1;
    const eckTipp = Math.abs(r) >= FAZIT_SCHWELLE.ecken ? amSchnitt("ecken_spiel", r > 0 ? "ueber" : "unter", liga.ecken) : null;
    if (eckTipp) {
      const viel = r > 0;
      const gruende = [];
      const [mehr, weniger, ms, ws] = eh >= eg ? [H, G, hs, gs] : [G, H, gs, hs];
      if (ms.ecken_fuer && ws.ecken_gegen) gruende.push(`${mehr} holt im Schnitt ${z1(ms.ecken_fuer)} Ecken, ${weniger} lässt ${z1(ws.ecken_gegen)} zu`);
      const flanken = [[s.heim, H], [s.gast, G]].filter(([t]) => (((t.spielweise || {}).raenge || {}).flanken ?? 0.5) >= 0.75).map(([, n]) => n);
      const keine = [[s.heim, H], [s.gast, G]].filter(([t]) => (((t.spielweise || {}).raenge || {}).flanken ?? 0.5) <= 0.25).map(([, n]) => n);
      if (viel && flanken.length) gruende.push(`${flanken.join(" und ")} ${flanken.length > 1 ? "flanken" : "flankt"} viel`);
      if (!viel && keine.length) gruende.push(`${keine.join(" und ")} ${keine.length > 1 ? "flanken" : "flankt"} kaum`);
      punkte.push({ gewicht: Math.abs(r) * 2.5, titel: viel ? "Eher viele Ecken" : "Eher wenig Ecken",
        text: `Erwartet sind etwa ${z1(eh + eg)} Ecken (${H} ${z1(eh)}, ${G} ${z1(eg)}), Schnitt der ${ligaName} ${z1(liga.ecken)}.${gruende.length ? ` ${gruende.join(". ")}.` : ""}`,
        tipps: [eckTipp] });
    }
    const verh = Math.max(eh, eg) / Math.max(0.1, Math.min(eh, eg));
    const meiste = tipp(`ecken_meiste||${eh >= eg ? "heim" : "gast"}||`);
    if (verh >= 1.3 && meiste && meiste.p >= 0.5) {
      punkte.push({ gewicht: (verh - 1) * 0.8, titel: `${eh >= eg ? H : G} holt mehr Ecken`, text: `Erwartet ${z1(Math.max(eh, eg))} zu ${z1(Math.min(eh, eg))} Ecken.`, tipps: [meiste] });
    }
  }

  // Gelbe Karten (mit Schiri)
  if (pr.erw.karten && liga.karten) {
    const [kh, kg] = pr.erw.karten;
    const r = (kh + kg) / liga.karten - 1;
    const kartTipp = Math.abs(r) >= FAZIT_SCHWELLE.karten ? amSchnitt("karten_spiel", r > 0 ? "ueber" : "unter", liga.karten) : null;
    if (kartTipp) {
      const viel = r > 0;
      const gruende = [];
      const sch = s.schiri;
      if (sch && sch.gelb && sch.gelb_schnitt && Math.abs(sch.gelb / sch.gelb_schnitt - 1) >= 0.12 && (sch.gelb > sch.gelb_schnitt) === viel) {
        gruende.push(`Schiri ${sch.name} zeigt im Schnitt ${z1(sch.gelb)} Gelbe pro Spiel, in seiner Liga sind es ${z1(sch.gelb_schnitt)}`);
      }
      const fouler = [[hs, H], [gs, G]].filter(([x]) => x.fouls_begangen >= 13).map(([x, n]) => `${n} foult viel (${z1(x.fouls_begangen)} pro Spiel)`);
      const brav = [[hs, H], [gs, G]].filter(([x]) => x.fouls_begangen && x.fouls_begangen <= 10).map(([x, n]) => `${n} foult wenig (${z1(x.fouls_begangen)} pro Spiel)`);
      gruende.push(...(viel ? fouler : brav));
      if (hs.gelbe != null && gs.gelbe != null) gruende.push(`${H} sieht im Schnitt ${z1(hs.gelbe)} Gelbe, ${G} ${z1(gs.gelbe)}`);
      punkte.push({ gewicht: Math.abs(r) * 2.5, titel: viel ? "Eher viele Gelbe" : "Eher wenig Gelbe",
        text: `Erwartet sind etwa ${z1(kh + kg)} Gelbe, Schnitt der ${ligaName} ${z1(liga.karten)}. ${gruende.slice(0, 3).join(". ")}.`,
        tipps: [kartTipp] });
    }
  }

  // Angriffsseiten (ohne Wette, Bet365 hat dafuer keinen Markt)
  const seiteH = (s.heim.spielweise || {}).seite_kurz;
  const seiteG = (s.gast.spielweise || {}).seite_kurz;
  const SEITE = { links: "über links", rechts: "über rechts", mitte: "durch die Mitte" };
  if (seiteH && seiteG && seiteH[0] === seiteG[0]) {
    punkte.push({ gewicht: 0.12, titel: `Beide greifen vor allem ${SEITE[seiteH[0]]} an`, text: `${H} mit ${seiteH[1]} %, ${G} mit ${seiteG[1]} % der Aktionen in der gegnerischen Hälfte.`, tipps: [] });
  } else if (seiteH || seiteG) {
    const [name, seite, gegner] = seiteH ? [H, seiteH, G] : [G, seiteG, H];
    const abwehr = seite[0] === "links" ? "rechte" : seite[0] === "rechts" ? "linke" : null;
    punkte.push({ gewicht: 0.1, titel: `${name} greift vor allem ${SEITE[seite[0]]} an`,
      text: `${seite[1]} % der Aktionen in der gegnerischen Hälfte${abwehr ? `, also gegen die ${abwehr} Abwehrseite von ${gegner}` : ""}.`, tipps: [] });
  }

  punkte.sort((a, b) => b.gewicht - a.gewicht);
  return punkte.slice(0, 5);
}

function fazitHtml(s) {
  if (!s.prognose || !s.liga_schnitt) return "";
  const punkte = fazitPunkte(s);
  const tippZeile = (t) => {
    const quote = t.quote ? ` · ${zahl(t.quote, 2)}` : "";
    return `<div class="fazit-tipp"><span><span class="n">${esc(t.titel)}</span><span class="leise klein"> · Chance ${prozent(t.p)}${quote}</span></span>${dazuKnopf(s, t.k, imSchein(s.id, t.k) ? "Auf dem Schein" : "Auf den Schein", "dazu")}</div>`;
  };
  const liste = punkte.length
    ? `<ul class="fazit-liste">${punkte.map((x) => `<li${x.tipps.length ? "" : ' class="info"'}><div class="fazit-titel">${esc(x.titel)}</div><p class="leise klein">${esc(x.text)}</p>${x.tipps.map(tippZeile).join("")}</li>`).join("")}</ul>`
    : "";
  const ohneWette = !punkte.some((x) => x.tipps.length);
  const inhalt = (ohneWette ? `<p><strong>Keine klare Richtung.</strong> Sieger, Tore, Ecken und Karten geben hier keine Wette her, die deutlich öfter aufgeht als eine Münze. Lieber nur kleine Einsätze oder ein anderes Spiel.</p>` : "") + liste;
  return `
    <section class="abschnitt fazit">
      <h2>Fazit</h2>
      ${inhalt}
      <p class="fussnote">Das Fazit kommt aus denselben Zahlen wie die Tipps: erwartete Tore, Ecken und Gelbe beider Teams gegen den Schnitt der ${esc(s.wettbewerb || "Liga")}, dazu der Schiri. Die Chancen sind dieselben wie im Reiter Tipps. Die Spielweise im Detail steht darunter.</p>
    </section>`;
}

function tabUeberblick(s) {
  let html = "";
  html += fazitHtml(s);

  const ausfaelle = [s.heim, s.gast].filter((t) => t.ausfaelle && t.ausfaelle.length);
  if (ausfaelle.length) {
    html += `
      <div class="warnung">${ICON_WARNUNG}
        <div>
          <div class="titel">Ausfälle</div>
          <ul>${ausfaelle
            .map((t) => `<li><b>${esc(kurzName(t))}:</b> ${t.ausfaelle.map((a) => `${esc(a.name)} (${esc(a.text)})`).join(", ")}</li>`)
            .join("")}</ul>
        </div>
      </div>`;
  }

  html += spielweiseHtml(s);

  if (s.duelle_platz && s.duelle_platz.length) {
    html += `
      <section class="abschnitt">
        <h2>Duelle auf dem Platz</h2>
        <p>Wer im Schnitt auf derselben Seite spielt: oft foulende Spieler gegen oft gefoulte Gegenspieler, jeweils pro 90 Minuten.</p>
        <div class="platz">${s.duelle_platz
          .map(
            (d) => `
          <div class="eintrag">
            <div class="wer">
              <div class="z">${zahl(d.verteidiger.fouls90, 2)}</div>
              <div class="n">${esc(d.verteidiger.name)} ${marke(d.verteidiger)}</div>
              <div class="t">${esc(d.verteidiger.team)}, Fouls</div>
            </div>
            <div class="gegen">gegen</div>
            <div class="wer r">
              <div class="z">${zahl(d.angreifer.gefoult90, 2)}</div>
              <div class="n">${esc(d.angreifer.name)} ${marke(d.angreifer)}</div>
              <div class="t">${esc(d.angreifer.team)}, gefoult</div>
            </div>
          </div>`,
          )
          .join("")}</div>
      </section>`;
  }

  const h = s.heim.schnitt;
  const g = s.gast.schnitt;
  const reihen = [
    ["Ecken für", h.ecken_fuer, g.ecken_fuer, 1],
    ["Ecken gegen", h.ecken_gegen, g.ecken_gegen, 1],
    ["Fouls begangen", h.fouls_begangen, g.fouls_begangen, 1],
    ["Fouls erlitten", h.fouls_erlitten, g.fouls_erlitten, 1],
    ["Schüsse", h.schuesse_fuer, g.schuesse_fuer, 1],
    ["Schüsse aufs Tor", h.aufs_tor_fuer, g.aufs_tor_fuer, 1],
    ["Gelbe Karten", h.gelbe, g.gelbe, 1],
    ["Ballbesitz in %", h.ballbesitz, g.ballbesitz, 0],
  ];
  html += `
    <section class="abschnitt">
      <h2>Teamvergleich</h2>
      <p>Schnitt pro Spiel aus den letzten ${Math.max(s.heim.form_spiele.length, s.gast.form_spiele.length)} Pflichtspielen.</p>
      <div class="vgl"><div class="kopfzeile"><span class="leise klein">${esc(kurzName(s.heim))}</span><span class="leise klein">${esc(kurzName(s.gast))}</span></div></div>
      <div class="vergleich">${reihen
        .map(([was, a, b, st]) => {
          const max = Math.max(a || 0, b || 0) || 1;
          const vorneA = (a || 0) > (b || 0);
          const vorneB = (b || 0) > (a || 0);
          return `
          <div class="vgl">
            <div class="kopfzeile"><span class="wert">${zahl(a, st)}</span><span class="was">${was}</span><span class="wert">${zahl(b, st)}</span></div>
            <div class="balken">
              <div><span class="${vorneA ? "vorne" : ""}" style="width:${Math.round(((a || 0) / max) * 100)}%"></span></div>
              <div><span class="${vorneB ? "vorne" : ""}" style="width:${Math.round(((b || 0) / max) * 100)}%"></span></div>
            </div>
          </div>`;
        })
        .join("")}</div>
    </section>`;

  for (const team of [s.heim, s.gast]) {
    html += `
      <section class="abschnitt">
        <h2 class="mit-logo">${logo(team.id, "logo gross")}${esc(kurzName(team))} <small>Form</small></h2>
        <div class="spielliste">${team.form_spiele
          .slice(0, 5)
          .map((f) => {
            const r = f.tore == null ? "" : f.tore > f.gegentore ? "S" : f.tore === f.gegentore ? "U" : "N";
            return `
            <div class="s">
              <span class="d">${esc(fmtTagMonat.format(new Date(f.anstoss * 1000)))}</span>
              <span class="g">${logo(f.gegner_id)}${f.heim ? "" : "bei "}${esc(f.gegner)} <small>${esc(f.wettbewerb || "")}</small></span>
              <span class="form"><i class="${r}">${r}</i> <span class="e">${f.tore ?? "-"}:${f.gegentore ?? "-"}</span></span>
            </div>`;
          })
          .join("")}</div>
        ${team.naechste && team.naechste.length ? `
        <p style="margin:14px 0 4px" class="leise klein">Danach</p>
        <div class="spielliste">${team.naechste
          .slice(0, 3)
          .map(
            (n) => `
            <div class="s">
              <span class="d">${esc(fmtTagMonat.format(new Date(n.anstoss * 1000)))}</span>
              <span class="g">${logo(n.gegner_id)}${n.heim ? "" : "bei "}${esc(n.gegner)} <small>${esc(n.wettbewerb || "")}</small></span>
              <span class="leise klein">${uhr(n.anstoss)}</span>
            </div>`,
          )
          .join("")}</div>` : ""}
      </section>`;
  }

  html += `<section class="abschnitt"><p style="margin-top:24px">Das sind Rohwerte aus den letzten Pflichtspielen. Wahrscheinlichkeiten und faire Quoten stehen unter „Tipps“.</p></section>`;
  return html;
}

/* ---------------------------------------------------------------- Heatmaps */

// Wo beide Teams viel unterwegs sind: das Gast-Raster wird gespiegelt, weil es in
// seiner eigenen Angriffsrichtung gespeichert ist, dann das geometrische Mittel je Feld
function brennpunkte(heim, gast) {
  if (!heim || !gast) return null;
  const werte = new Array(RASTER_X * RASTER_Y).fill(0);
  for (let y = 0; y < RASTER_Y; y++) {
    for (let x = 0; x < RASTER_X; x++) {
      const i = y * RASTER_X + x;
      const g = (RASTER_Y - 1 - y) * RASTER_X + (RASTER_X - 1 - x);
      werte[i] = Math.sqrt((heim[i] || 0) * (gast[g] || 0));
    }
  }
  const max = Math.max(...werte) || 1;
  return werte.map((w) => w / max);
}

function heatQuellen(s, seite) {
  if (seite === "beide") {
    const quellen = [{ id: "form", name: "Letzte Spiele", raster: brennpunkte(s.heim.heatmap, s.gast.heatmap) }];
    (s.duelle || []).forEach((d, i) => {
      if (d.heatmap_heim && d.heatmap_gast) {
        quellen.push({ id: `duell${i}`, name: `Duell ${fmtDatum.format(new Date(d.anstoss * 1000))}`, raster: brennpunkte(d.heatmap_heim, d.heatmap_gast) });
      }
    });
    return quellen;
  }
  const team = s[seite];
  const mitHeatmap = team.heatmap_spiele || 0;
  const alle = team.form_spiele.length;
  const name = mitHeatmap >= alle ? `Letzte ${alle} Spiele` : `${mitHeatmap} von ${alle} Spielen`;
  const quellen = [{ id: "form", name, raster: team.heatmap, seiten: team.seiten }];
  (s.duelle || []).forEach((d, i) => {
    if (d[`heatmap_${seite}`]) {
      quellen.push({
        id: `duell${i}`,
        name: `Duell ${fmtDatum.format(new Date(d.anstoss * 1000))}`,
        raster: d[`heatmap_${seite}`],
        seiten: d[`seiten_${seite}`],
        aehnlichkeit: d[`aehnlichkeit_${seite}`],
      });
    }
  });
  return quellen;
}

const PROZENT = (w) => (w == null ? "-" : `${w} %`);

function teamWahlHeat(s, seite) {
  return `
      <div class="wahl" role="group" aria-label="Team">
        <button data-heat-team="heim" aria-pressed="${seite === "heim"}">${logo(s.heim.id)}${esc(kurzName(s.heim))}</button>
        <button data-heat-team="gast" aria-pressed="${seite === "gast"}">${logo(s.gast.id)}${esc(kurzName(s.gast))}</button>
        <button data-heat-team="beide" aria-pressed="${seite === "beide"}" class="beide-knopf">Beide</button>
      </div>`;
}

const FELD_SVG = `
        <svg viewBox="0 0 105 68" aria-hidden="true" preserveAspectRatio="none">
          <rect x="0.5" y="0.5" width="104" height="67"></rect>
          <line x1="52.5" y1="0.5" x2="52.5" y2="67.5"></line>
          <circle cx="52.5" cy="34" r="9.15"></circle>
          <rect x="0.5" y="13.85" width="16.5" height="40.3"></rect>
          <rect x="88" y="13.85" width="16.5" height="40.3"></rect>
          <rect x="0.5" y="24.85" width="5.5" height="18.3"></rect>
          <rect x="99" y="24.85" width="5.5" height="18.3"></rect>
        </svg>`;

// Spieler, die im Schnitt auf einer Seite des Feldes spielen (aus Sicht des Heimteams)
function spielerAufSeite(team, drittel, gespiegelt) {
  const grenze = 68 / 3;
  const liste = team.spieler.filter((p) => {
    if (p.y == null || p.pos === "TW" || p.hinweis === "fehlt" || p.minuten < MIN_MINUTEN) return false;
    const y = gespiegelt ? 68 - p.y : p.y;
    return drittel === 0 ? y < grenze : drittel === 2 ? y > 2 * grenze : y >= grenze && y <= 2 * grenze;
  });
  const mitStart = liste.some((p) => p.startelf);
  return liste
    .filter((p) => !mitStart || p.startelf)
    .sort((a, b) => b.minuten - a.minuten)
    .slice(0, 3);
}

function tabBrennpunkte(s) {
  const quellen = heatQuellen(s, "beide");
  const quelle = quellen.find((q) => q.id === zustand.heatQuelle) || quellen[0];
  zustand.heatQuelle = quelle.id;
  const h = kurzName(s.heim);
  const g = kurzName(s.gast);
  let html = `
    <section class="abschnitt">
      <h2>Brennpunkte</h2>
      <p>Rot ist, wo beide Teams gleichzeitig am meisten unterwegs sind, dann absteigend orange, gelb, dunkelgrün und hellgrün. Dort treffen sie am häufigsten aufeinander, dort gibt es die meisten Zweikämpfe und damit auch Fouls.</p>
      ${teamWahlHeat(s, "beide")}
      <div class="wahl" role="group" aria-label="Zeitraum">
        ${quellen.map((q) => `<button data-heat-quelle="${q.id}" aria-pressed="${q.id === quelle.id}">${esc(q.name)}</button>`).join("")}
      </div>`;
  if (!quelle.raster) {
    return html + `<div class="keine-heatmap">Für eines der beiden Teams hat FotMob keine Heatmap. Dann lässt sich kein Brennpunkt berechnen.</div></section>`;
  }
  html += `
      <div class="feld-heatmap">
        <canvas id="heatmap" aria-label="Brennpunkte ${esc(h)} gegen ${esc(g)}" role="img"></canvas>
        ${FELD_SVG}
        <span class="pfeil">${esc(h)} greift nach rechts an</span>
      </div>
      <div class="skala">${SKALA_STUFEN}<span style="margin-left:auto">Oben: links bei ${esc(h)}</span></div>`;

  // Anteile der drei Laengsstreifen am gemeinsamen Geschehen
  const anteile = [0, 0, 0];
  quelle.raster.forEach((w, i) => {
    const y = Math.floor(i / RASTER_X);
    anteile[y < RASTER_Y / 3 ? 0 : y < (2 * RASTER_Y) / 3 ? 1 : 2] += w;
  });
  const summe = anteile.reduce((a, b) => a + b, 0) || 1;
  const prozente = anteile.map((a) => Math.round((a / summe) * 100));
  const namen = [`links bei ${h}, rechts bei ${g}`, "Mitte", `rechts bei ${h}, links bei ${g}`];
  const max = Math.max(...prozente);
  html += `
      <div class="drittel brenn">
        ${[0, 1, 2].map((i) => `<div><div class="zahl ${prozente[i] === max ? "heiss" : ""}">${prozente[i]} %</div><div class="leise klein">${esc(namen[i])}</div></div>`).join("")}
      </div>`;
  const sortiert = [0, 1, 2].sort((a, b) => prozente[b] - prozente[a]);
  const heiss = sortiert[0];
  const abstand = prozente[heiss] - prozente[sortiert[1]];
  const deutlich = abstand >= 2;
  const ort = heiss === 1 ? "im Zentrum" : `auf der Seite ${namen[heiss]}`;
  const heimSpieler = spielerAufSeite(s.heim, heiss, false);
  // Die linke Seite des Heimteams ist die rechte des Gasts: Drittel tauschen, nicht spiegeln
  const gastSpieler = spielerAufSeite(s.gast, 2 - heiss, false);
  const zeile = (p, team) => `
        <div class="brenn-spieler">
          <span class="n">${logo(team.id, "logo klein")}${esc(p.name)} ${marke(p)}</span>
          <span class="leise klein">foult ${zahl(p.fouls90, 1)} · gefoult ${zahl(p.gefoult90, 1)}</span>
        </div>`;
  html += `
      <div class="brenn-fazit">
        <div class="titel">${!deutlich ? "Kein klarer Brennpunkt, beide Teams verteilen sich ähnlich" : abstand >= 5 ? `Am meisten los ist ${esc(ort)}` : `Etwas mehr los ist ${esc(ort)}`}</div>
        ${deutlich && (heimSpieler.length || gastSpieler.length) ? `
        <p class="leise klein">Dort spielen im Schnitt, jeweils pro 90 Minuten:</p>
        ${heimSpieler.map((p) => zeile(p, s.heim)).join("")}
        ${gastSpieler.map((p) => zeile(p, s.gast)).join("")}` : ""}
      </div>
    </section>`;
  return html;
}

function tabHeatmaps(s) {
  const seite = zustand.heatTeam;
  if (seite === "beide") return tabBrennpunkte(s);
  const team = s[seite];
  const quellen = heatQuellen(s, seite);
  let quelle = quellen.find((q) => q.id === zustand.heatQuelle) || quellen[0];
  zustand.heatQuelle = quelle.id;

  let html = `
    <section class="abschnitt">
      <h2>Wo das Team spielt</h2>
      ${teamWahlHeat(s, seite)}
      <div class="wahl" role="group" aria-label="Zeitraum">
        ${quellen.map((q) => `<button data-heat-quelle="${q.id}" aria-pressed="${q.id === quelle.id}">${esc(q.name)}</button>`).join("")}
      </div>`;

  if (quelle.raster) {
    html += `
      <div class="feld-heatmap">
        <canvas id="heatmap" aria-label="Heatmap ${esc(team.name)}, ${esc(quelle.name)}" role="img"></canvas>
        <svg viewBox="0 0 105 68" aria-hidden="true" preserveAspectRatio="none">
          <rect x="0.5" y="0.5" width="104" height="67"></rect>
          <line x1="52.5" y1="0.5" x2="52.5" y2="67.5"></line>
          <circle cx="52.5" cy="34" r="9.15"></circle>
          <rect x="0.5" y="13.85" width="16.5" height="40.3"></rect>
          <rect x="88" y="13.85" width="16.5" height="40.3"></rect>
          <rect x="0.5" y="24.85" width="5.5" height="18.3"></rect>
          <rect x="99" y="24.85" width="5.5" height="18.3"></rect>
        </svg>
        <span class="pfeil">Angriffsrichtung</span>
      </div>
      <div class="skala">${SKALA_STUFEN}<span style="margin-left:auto">Oben ist die linke Seite</span></div>`;
  } else {
    html += `<div class="keine-heatmap">FotMob hat für diese Spiele von ${esc(team.name)} keine Heatmap. Das betrifft vor allem kleinere Ligen.</div>`;
  }

  if (quelle.seiten) {
    const w = quelle.seiten;
    const max = Math.max(w.links, w.mitte, w.rechts);
    html += `
      <p style="margin:18px 0 0" class="leise klein">Aufenthalt in der gegnerischen Hälfte</p>
      <div class="drittel">
        <div><div class="zahl ${w.links === max ? "vorne" : ""}">${w.links} %</div><div class="leise klein">links</div></div>
        <div><div class="zahl ${w.mitte === max ? "vorne" : ""}">${w.mitte} %</div><div class="leise klein">Mitte</div></div>
        <div><div class="zahl ${w.rechts === max ? "vorne" : ""}">${w.rechts} %</div><div class="leise klein">rechts</div></div>
      </div>`;
  }

  if (quelle.aehnlichkeit != null) {
    html += `<div class="kachel"><span class="t">So ähnlich spielt ${esc(kurzName(team))} heute wie in diesem Duell</span><span class="zahl">${quelle.aehnlichkeit} %</span></div>`;
  }
  const vergleich = s.duelle_vergleich && s.duelle_vergleich[seite];
  if (vergleich != null) {
    html += `<div class="kachel"><span class="t">Letztes und vorletztes Duell im Vergleich</span><span class="zahl">${vergleich} %</span></div>`;
  }
  html += `</section>`;

  if (s.duelle && s.duelle.length) {
    const ohneHeatmap = s.duelle.some((d) => !d[`heatmap_${seite}`]);
    html += `
      <section class="abschnitt">
        <h2>Letzte Duelle</h2>
        ${ohneHeatmap ? `<p>FotMob hat Heatmaps erst seit Februar 2026. Für ältere Duelle gibt es Formation und Kennzahlen.</p>` : ""}
        ${s.duelle.map((d) => altDuell(s, d, seite)).join("")}
      </section>`;
  } else {
    html += `<section class="abschnitt"><h2>Letzte Duelle</h2><p>Die beiden Teams sind sich bisher nicht in einem Pflichtspiel begegnet.</p></section>`;
  }
  return html;
}

function altDuell(s, d, seite) {
  const team = s[seite];
  const damals = d[`werte_${seite}`] || {};
  const jetzt = team.schnitt;
  const reihen = [
    ["Formation", esc(d[`formation_${seite}`] || "-"), esc(team.formation || "-")],
    ["Ballbesitz", PROZENT(damals.ballbesitz), PROZENT(jetzt.ballbesitz)],
    ["Schüsse", zahl(damals.schuesse, 0), zahl(jetzt.schuesse_fuer, 1)],
    ["Ecken", zahl(damals.ecken, 0), zahl(jetzt.ecken_fuer, 1)],
    ["Fouls", zahl(damals.fouls, 0), zahl(jetzt.fouls_begangen, 1)],
    ["Gelbe Karten", zahl(damals.gelb, 0), zahl(jetzt.gelbe, 1)],
  ];
  return `
    <div class="altduell">
      <div class="k">
        <span>${logo(d.heim_id)}${esc(d.heim)} <span class="leise">gegen</span> ${logo(d.gast_id)}${esc(d.gast)}</span>
        <span class="ergebnis">${d.heim_tore ?? "-"}:${d.gast_tore ?? "-"}</span>
      </div>
      <div class="leise klein">${esc(fmtDatum.format(new Date(d.anstoss * 1000)))}, ${esc(d.wettbewerb || "")}</div>
      <table>
        <thead><tr><th>${esc(kurzName(team))}</th><th>damals</th><th>jetzt (Schnitt)</th></tr></thead>
        <tbody>${reihen.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join("")}</tbody>
      </table>
    </div>`;
}

// Farbstufen wie bei SofaScore: wenig hellgruen, dann dunkelgruen, gelb, orange, am meisten rot.
// Die Zahl ist der Anteil am staerksten Feld, ab dem die Farbe gilt.
const HEAT_STUFEN = [
  [0.22, [150, 222, 92]],
  [0.38, [34, 158, 74]],
  [0.55, [244, 212, 56]],
  [0.72, [245, 140, 36]],
  [0.87, [232, 50, 40]],
];
const HEAT_KANTE = 0.012; // weicher Uebergang an den Stufengrenzen, damit nichts ausfranst
const HEAT_DECKKRAFT = [0.72, 0.85, 0.9, 0.92, 0.94];

function glaetten(raster) {
  // Ein leichter Weichzeichner (1-2-1), damit einzelne Felder nicht flackern
  const werte = new Array(raster.length).fill(0);
  for (let y = 0; y < RASTER_Y; y++) {
    for (let x = 0; x < RASTER_X; x++) {
      let summe = 0;
      let gewicht = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= RASTER_X || ny >= RASTER_Y) continue;
          const g = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
          summe += (raster[ny * RASTER_X + nx] || 0) * g;
          gewicht += g;
        }
      }
      werte[y * RASTER_X + x] = summe / gewicht;
    }
  }
  const max = Math.max(...werte) || 1;
  return werte.map((w) => w / max);
}

function heatmapZeichnen(s) {
  const canvas = document.getElementById("heatmap");
  if (!canvas) return;
  const quelle = heatQuellen(s, zustand.heatTeam).find((q) => q.id === zustand.heatQuelle);
  if (!quelle || !quelle.raster) return;
  const werte = glaetten(quelle.raster);

  const rahmen = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const breite = Math.max(1, Math.round(rahmen.width * dpr));
  const hoehe = Math.max(1, Math.round(rahmen.height * dpr));
  canvas.width = breite;
  canvas.height = hoehe;
  const c = canvas.getContext("2d");
  const bild = c.createImageData(breite, hoehe);

  // Werte zwischen den Feldmitten weich verbinden, die Farben aber in klaren Stufen setzen
  const wert = (gx, gy) => werte[gy * RASTER_X + gx];
  for (let py = 0; py < hoehe; py++) {
    const fy = Math.min(RASTER_Y - 1, Math.max(0, ((py + 0.5) / hoehe) * RASTER_Y - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(RASTER_Y - 1, y0 + 1);
    const ay = fy - y0;
    for (let px = 0; px < breite; px++) {
      const fx = Math.min(RASTER_X - 1, Math.max(0, ((px + 0.5) / breite) * RASTER_X - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(RASTER_X - 1, x0 + 1);
      const ax = fx - x0;
      const v =
        (wert(x0, y0) * (1 - ax) + wert(x1, y0) * ax) * (1 - ay) +
        (wert(x0, y1) * (1 - ax) + wert(x1, y1) * ax) * ay;
      // Stufe bestimmen, an den Grenzen kurz zwischen Nachbarstufen mischen
      let k = -1;
      for (let j = 0; j < HEAT_STUFEN.length; j++) if (v >= HEAT_STUFEN[j][0] - HEAT_KANTE) k = j;
      if (k < 0) continue;
      const anteil = Math.min(1, (v - (HEAT_STUFEN[k][0] - HEAT_KANTE)) / (2 * HEAT_KANTE));
      const oben = HEAT_STUFEN[k][1];
      const unten = k > 0 ? HEAT_STUFEN[k - 1][1] : oben;
      const deck = HEAT_DECKKRAFT[k] * anteil;
      const deckUnten = k > 0 ? HEAT_DECKKRAFT[k - 1] : 0;
      const i = (py * breite + px) * 4;
      bild.data[i] = Math.round(unten[0] + (oben[0] - unten[0]) * anteil);
      bild.data[i + 1] = Math.round(unten[1] + (oben[1] - unten[1]) * anteil);
      bild.data[i + 2] = Math.round(unten[2] + (oben[2] - unten[2]) * anteil);
      bild.data[i + 3] = Math.round(255 * (k > 0 ? deckUnten + (HEAT_DECKKRAFT[k] - deckUnten) * anteil : deck));
    }
  }
  c.putImageData(bild, 0, 0);
}

const SKALA_STUFEN = `<span>wenig</span>${HEAT_STUFEN.map(([, rgb]) => `<b style="background:rgb(${rgb.join(",")})"></b>`).join("")}<span>viel</span>`;

/* ----------------------------------------------------------------- Spieler */

const METRIKEN = [
  ["fouls90", "Foult", "Fouls pro 90 Min."],
  ["gefoult90", "Wird gefoult", "gefoult pro 90 Min."],
  ["aufs_tor90", "Aufs Tor", "aufs Tor pro 90 Min."],
  ["schuesse90", "Schüsse", "Schüsse pro 90 Min."],
  ["gelb", "Gelb", "Gelbe Karten"],
];

function tabSpieler(s) {
  const metrik = METRIKEN.find((m) => m[0] === zustand.metrik) || METRIKEN[0];
  const teams = zustand.spielerTeam === "heim" ? [s.heim] : zustand.spielerTeam === "gast" ? [s.gast] : [s.heim, s.gast];
  const liste = [];
  for (const team of teams) {
    for (const p of team.spieler) {
      if (p.minuten < MIN_MINUTEN || p.pos === "TW") continue;
      if (p[metrik[0]] == null) continue;
      liste.push({ ...p, team: kurzName(team), team_id: team.id });
    }
  }
  liste.sort((a, b) => b[metrik[0]] - a[metrik[0]] || b.minuten - a.minuten);
  const auswahl = liste.slice(0, 15);
  const stellen = metrik[0] === "gelb" ? 0 : 2;
  return `
    <section class="abschnitt abstand-oben">
      <div class="wahl" role="group" aria-label="Wert">
        ${METRIKEN.map(([id, name]) => `<button data-metrik="${id}" aria-pressed="${id === metrik[0]}">${name}</button>`).join("")}
      </div>
      <div class="wahl" role="group" aria-label="Team">
        <button data-spieler-team="beide" aria-pressed="${zustand.spielerTeam === "beide"}">Beide</button>
        <button data-spieler-team="heim" aria-pressed="${zustand.spielerTeam === "heim"}">${logo(s.heim.id)}${esc(kurzName(s.heim))}</button>
        <button data-spieler-team="gast" aria-pressed="${zustand.spielerTeam === "gast"}">${logo(s.gast.id)}${esc(kurzName(s.gast))}</button>
      </div>
      <p>Aus den letzten Pflichtspielen, nur Spieler ab ${MIN_MINUTEN} Einsatzminuten.</p>
      <div class="liste">${
        auswahl.length
          ? auswahl
              .map(
                (p, i) => `
        <div class="p">
          <span class="rang">${i + 1}</span>
          <div>
            <div class="n">${esc(p.name)}</div>
            <div class="info"><span>${logo(p.team_id, "logo klein")}${esc(p.team)}</span><span>${p.spiele} Spiele, ${p.minuten} Min.</span>${
              metrik[0] === "gelb" && p.gelb_meckern ? `<span>${p.gelb_meckern} davon fürs Meckern</span>` : ""
            }${marke(p)}</div>
          </div>
          <div class="wert">${zahl(p[metrik[0]], stellen)}<small>${metrik[2]}</small></div>
        </div>`,
              )
              .join("")
          : `<p class="leer">Keine Spieler mit genug Einsatzminuten.</p>`
      }</div>
    </section>`;
}

/* ------------------------------------------------------------------- Schiri */

function messung(titel, wert, schnitt, stellen) {
  if (wert == null) return "";
  const max = Math.max(wert, schnitt || 0) * 1.3 || 1;
  return `
    <div class="messung">
      <div class="k"><span>${titel}</span><span class="zahl">${zahl(wert, stellen)}</span></div>
      <div class="spur" aria-hidden="true">
        <div class="fuell" style="width:${Math.round((wert / max) * 100)}%"></div>
        ${schnitt != null ? `<div class="marker" style="left:${Math.round((schnitt / max) * 100)}%"></div>` : ""}
      </div>
      <div class="unter"><span>Liga-Schnitt ${zahl(schnitt, stellen)}</span><span>pro Spiel</span></div>
    </div>`;
}

function tabSchiri(s) {
  const r = s.schiri;
  if (!r) {
    return `<section class="abschnitt"><h2>Schiedsrichter</h2><p>Noch nicht bekannt. FotMob trägt den Schiedsrichter meist ein bis zwei Tage vor dem Spiel ein.</p></section>`;
  }
  let urteil = "Gelb etwa im Liga-Schnitt";
  if (r.gelb != null && r.gelb_schnitt) {
    const verhaeltnis = r.gelb / r.gelb_schnitt;
    if (verhaeltnis >= 1.1) urteil = "Zeigt mehr Gelb als der Liga-Schnitt";
    else if (verhaeltnis <= 0.9) urteil = "Zeigt weniger Gelb als der Liga-Schnitt";
  }
  return `
    <section class="abschnitt">
      <div class="schiri-name">${esc(r.name)}</div>
      <div class="leise">${esc(land(r.land || ""))}${r.liga ? `, Saison in der ${esc(r.liga)}` : ""}${r.spiele ? `, ${r.spiele} Spiele` : ""}</div>
      <span class="pille urteil ${r.gelb != null && r.gelb_schnitt && r.gelb >= r.gelb_schnitt * 1.1 ? "fix" : ""}">${urteil}</span>
      ${messung("Gelbe Karten", r.gelb, r.gelb_schnitt, 2)}
      ${messung("Fouls", r.fouls, r.fouls_schnitt, 1)}
      <div class="paar">
        <div><div class="zahl">${r.rot ?? "-"}</div><div class="leise klein">Rote Karten in der Saison</div></div>
        <div><div class="zahl">${r.elfmeter ?? "-"}</div><div class="leise klein">Elfmeter in der Saison</div></div>
      </div>
      <p style="margin-top:18px">Die Werte stammen aus seiner Saison in der Liga, die er hauptsächlich pfeift. In der Champions League kann er anders pfeifen.</p>
    </section>`;
}

/* ------------------------------------------------------------------- Tipps */

const SCHEIN_SPEICHER = "flutlicht.schein";

/* Nur Wetten, die es bei Bet365 gibt (Liste von Marcel, 06.11.2026), mit den Namen wie bei Bet365.
   wk: mit WK-Zeichen, laesst sich mit anderen Tipps kombinieren. bb: kommt in Kombis aus einem
   einzigen Spiel ("Wette erstellen"); dort rechnet die App die gemeinsame Chance ueber das
   Endergebnis, darum nur Wetten, die vom Endergebnis oder von einem Torschuetzen abhaengen, und Ecken.
   Schuesse, Fouls, Tacklings, Paesse, Paraden und Karten gibt es dort nicht mehr. */
const BET365 = {
  torschuetze: { name: "Torschützen (Einwechslung+)", wk: true, bb: true },
  torschuetze_erster: { name: "Torschützen: Erster", wk: true },
  torschuetze_paar: { name: "Einer der beiden erzielt ein Tor", wk: true },
  torschuetze_paar_erster: { name: "Einer der beiden erzielt zuerst ein Tor", wk: true },
  tore_ergebnis: { name: "Endergebnis", wk: true, bb: true },
  tore_doppelte_chance: { name: "Doppelte Chance", wk: true, bb: true },
  tore_ohne_unentschieden: { name: "Unentschieden - Wette ungültig", wk: false },
  tore_spiel: { name: "Tore mehr als/weniger als", wk: true, bb: true },
  tore_btts: { name: "Beide Teams erzielen mind. 1 Tor", wk: true, bb: true },
  tore_ergebnis_btts: { name: "Ergebnis/Beide Teams erzielen mind. 1 Tor", wk: true },
  tore_genau: { name: "Genaues Ergebnis", wk: true },
  tore_genau_hz1: { name: "Genaues Ergebnis zur Halbzeit", wk: true },
  tore_hzend: { name: "Halbzeit/Endergebnis", wk: true },
  tore_haelfte: { name: "Spielhälfte mit den meisten Toren", wk: true },
  tore_bereich: { name: "Spiel - Tore - Bereich", wk: true },
  tore_bereich_hz1: { name: "1. Hälfte - Tore - Bereich", wk: true },
  tore_bereich_hz2: { name: "2. Hälfte - Tore - Bereich", wk: true },
  tore_teambereich: { name: "Team - Tore - Bereich", wk: true },
  tore_ergebnis_bereich: { name: "Ergebnisse / Tore - Bereich", wk: false },
  tore_dc_bereich: { name: "Doppelte Chance / Tore - Bereich", wk: false },
  tore_europaeisch: { name: "Handicap", wk: true },
  tore_asiatisch: { name: "Handicap (2 Optionen)", wk: true },
  tore_asiatisch_hz1: { name: "1. Hälfte - Handicap (2 Optionen)", wk: true },
  tore_spezial: { name: "Team - Spezialwetten", wk: true, bb: true },
  ecken_dreiweg: { name: "Ecken", wk: true, bb: true },
  ecken_spiel: { name: "Ecken - Weitere Möglichkeiten", wk: true, bb: true },
  ecken_meiste: { name: "Team mit den meisten Ecken", wk: true, bb: true },
  // Nachtrag 06.11.2026: gibt es laut Marcel auch
  tore_team: { name: "Team - Tore mehr als/weniger als", wk: true, bb: true },
  tore_ergebnis_hz1: { name: "Halbzeit - Ergebnis", wk: true },
  tore_btts_hz1: { name: "Beide Teams treffen 1. Halbzeit", wk: true },
  tore_btts_hz2: { name: "Beide Teams treffen 2. Halbzeit", wk: true },
  ecken_team: { name: "Ecken - Team", wk: true, bb: true },
  ecken_spiel_hz1: { name: "Ecken - 1. Halbzeit", wk: true },
  karten_spiel: { name: "Gelbe Karten", wk: true, bb: true },
  karten_team: { name: "Gelbe Karten - Team", wk: true, bb: true },
  karten_meiste: { name: "Team mit den meisten Gelben Karten", wk: true, bb: true },
};
const bet365Ok = (markt) => Boolean(BET365[markt]);
const MARKT_GRUPPEN = [["torschuetzen", "Torschützen"], ["tore", "Tore"], ["ecken", "Ecken"], ["karten", "Karten"]];
const TORE_ABSCHNITTE = [["endergebnis", "Endergebnis"], ["tore", "Tore"], ["genau", "Genaues Ergebnis"],
  ["halbzeit", "Halbzeit"], ["bereich", "Tore-Bereich"], ["handicap", "Handicap"], ["spezial", "Team-Spezial"]];
const ECKEN_ABSCHNITTE = [["ecken", "Ecken"]];
const KARTEN_ABSCHNITTE = [["karten", "Gelbe Karten"]];

const prozent = (p) => `${Math.round(p * 100)} %`;
// Ab dieser Bet365-Quote lohnt sich ein einzelner Tipp: 10 % ueber fair, weil das Modell
// selbst ein paar Prozent danebenliegen kann
const LOHNT_AB = 1.1;
const mindestQuote = (p) => (p > 0 ? zahl(LOHNT_AB / p, 2) : "-");
const mitVorzeichen = (wert, stellen = 1) => `${wert >= 0 ? "+" : "−"}${zahl(Math.abs(wert), stellen)}`;
const fair = (p) => (p > 0 ? zahl(1 / p, 2) : "-");

function marktInfo(markt) {
  const m = zustand.daten.modell;
  return (m && m.maerkte && m.maerkte[markt]) || { name: markt, linien: null, geprueft: false, bewertung: "zu wenig Spiele" };
}

function teamVon(s, id) {
  if (s.heim.id === id) return s.heim;
  if (s.gast.id === id) return s.gast;
  return null;
}

// Alle Wetten eines Spiels mit eindeutigem Schluessel, wie ihn auch der Export bildet:
// "markt|linie|richtung|spieler|team". Jede Wette hat die Modell-Wahrscheinlichkeit p und, wenn
// Bet365 sie anbietet, die Quote, den Wert und pm (Modell mit dem Markt gemischt).
function tippIndex(s) {
  if (s._tipps) return s._tipps;
  const index = new Map();
  const pr = s.prognose;
  if (pr) {
    // Torschuetzen: trifft (Einwechslung+) und trifft zuerst; q ist der Anteil an den Toren seines Teams
    for (const sp of pr.torschuetzen || []) {
      for (const [markt, p, was] of [["torschuetze", sp.p, "trifft"], ["torschuetze_erster", sp.pe, "trifft zuerst"]]) {
        const k = `${markt}|1|ja|${sp.id}|${sp.team}`;
        index.set(k, { k, art: "spieler", markt, p, q: sp.q, team: sp.team, spieler: sp, name: sp.name, was, titel: `${sp.name} ${was}`,
          quote: null, wert: null, pm: null });
      }
    }
    const namen = new Map((pr.torschuetzen || []).map((sp) => [String(sp.id), sp]));
    for (const paar of pr.paare || []) {
      const a = namen.get(String(paar.a));
      const b = namen.get(String(paar.b));
      if (!a || !b) continue;
      for (const [markt, p, was] of [["torschuetze_paar", paar.p, "trifft"], ["torschuetze_paar_erster", paar.pe, "trifft zuerst"]]) {
        const k = `${markt}|1|ja|${a.id}+${b.id}|`;
        index.set(k, { k, art: "paar", markt, p, name: `${a.name} oder ${b.name}`, was, titel: `${a.name} oder ${b.name} ${was}`,
          quote: null, wert: null, pm: null });
      }
    }
    for (const abschnitt of pr.maerkte || []) {
      for (const zeile of abschnitt.zeilen) {
        zeile.z.forEach((z, i) => {
          if (!z) return;
          let was = zeile.t;
          if (zeile.typ === "ou") was = `${zeile.t}: ${i === 0 ? "über" : "unter"} ${zahl(zeile.l, 1)}`;
          else if (z.tt) was = z.tt;
          else if (z.a) was = `${zeile.t}: ${z.a}`;
          const markt = z.k.split("|")[0];
          index.set(z.k, {
            k: z.k, art: "spiel", markt, p: z.p, push: z.push || 0, name: abschnitt.t, was, titel: was,
            quote: z.q || null, wert: z.w ?? null, pm: z.pm ?? null,
          });
        });
      }
    }
    for (const w of pr.wert || []) {
      const vorhanden = index.get(w.k) || {};
      index.set(w.k, {
        ...vorhanden, k: w.k, art: w.art, markt: w.markt, titel: w.titel, quote: w.quote, wert: w.wert,
        pm: w.p, p: vorhanden.p ?? w.p_modell, push: w.push || 0, team: w.team, g: w.g,
        name: vorhanden.name || w.titel, was: vorhanden.was || "",
      });
    }
  }
  Object.defineProperty(s, "_tipps", { value: index, enumerable: false });
  return index;
}

/* Schein: im Browser gespeichert, damit er beim naechsten Oeffnen noch da ist */

function scheinLesen() {
  try {
    const roh = JSON.parse(lesen(SCHEIN_SPEICHER) || "null");
    if (roh && Array.isArray(roh.tipps)) return roh;
  } catch (e) { /* kaputt: neu anfangen */ }
  return { tipps: [], gesamt: "" };
}

function scheinSchreiben(schein) {
  schreiben(SCHEIN_SPEICHER, schein.tipps.length || schein.gesamt ? JSON.stringify(schein) : null);
}

function imSchein(spielId, k) {
  return scheinLesen().tipps.some((t) => t.spiel === spielId && t.k === k);
}

function scheinUmschalten(spielId, k) {
  const schein = scheinLesen();
  const i = schein.tipps.findIndex((t) => t.spiel === spielId && t.k === k);
  if (i >= 0) {
    schein.tipps.splice(i, 1);
  } else {
    const s = vollesSpiel(spielId);
    const t = s && tippIndex(s).get(k);
    if (!t) return;
    // Mit Bet365-Quote: Wahrscheinlichkeit mit dem Markt gemischt, Quote gleich eingetragen
    schein.tipps.push({
      spiel: s.id, k, titel: t.titel, p: t.pm ?? t.p, markt: t.markt, anstoss: s.anstoss,
      heim: kurzName(s.heim), gast: kurzName(s.gast), q: t.q,
      quote: t.quote ? zahl(t.quote, 2) : b365Quote(s.id, k) ? zahl(b365Quote(s.id, k), 2) : "",
      bet365: Boolean(t.quote),
      pModell: t.p,
      schaetzung: t.quote || t.push ? null : Math.round(schaetzeQuote(t.markt, t.p).quote * 100) / 100,
    });
  }
  scheinSchreiben(schein);
}

// Aktuelle Wahrscheinlichkeit nachschlagen; ist das Spiel nicht mehr in den Daten, bleibt der alte Wert
function scheinAktuell() {
  const schein = scheinLesen();
  for (const t of schein.tipps) {
    const info = spielInfo(t.spiel);
    const s = vollesSpiel(t.spiel);
    const neu = s && tippIndex(s).get(t.k);
    t.aktuell = s ? Boolean(neu) : Boolean(info);
    t.begonnen = !info || info.status !== "notstarted" || t.anstoss * 1000 <= Date.now();
    t.bestaetigt = Boolean(info && info.aufstellung === "standard");
    if (neu) {
      t.p = neu.pm ?? neu.p;
      t.titel = neu.titel;
      // Neue Bet365-Quote uebernehmen, solange der Nutzer keine eigene eingetragen hat
      if (neu.quote && (t.bet365 || !t.quote)) { t.quote = zahl(neu.quote, 2); t.bet365 = true; }
    }
    // Fuer mehrere Tipps aus einem Spiel: Endergebnis-Gitter und Torschuetzen-Anteil (nicht speichern)
    const gitter = (s && s.prognose && s.prognose.gitter) || (info && info.gitter) || null;
    const heimId = s ? s.heim.id : info && info.heim ? info.heim.id : null;
    Object.defineProperty(t, "gitter", { value: gitter, enumerable: false, configurable: true });
    Object.defineProperty(t, "heimId", { value: heimId, enumerable: false, configurable: true });
    if (neu && neu.q != null) Object.defineProperty(t, "q", { value: neu.q, enumerable: false, configurable: true });
  }
  return schein;
}

function quoteLesen(text) {
  const wert = parseFloat(String(text || "").replace(",", ".").trim());
  return Number.isFinite(wert) && wert > 1 ? wert : null;
}

const ICON_SPIELE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5l3.8 2.8-1.4 4.4H9.6L8.2 10.3z"></path></svg>';
const ICON_SCHEIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"></path><path d="M9 8h6"></path><path d="M9 12h6"></path></svg>';
const ICON_LEITER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h5v-5h5v-5h5V5h3"></path></svg>';
const ICON_WETTEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"></rect><path d="M16 12h5"></path><path d="M3 9h13"></path><circle cx="17" cy="12.5" r="0.6"></circle></svg>';

function scheinLeiste() {
  const ort = location.hash.replace(/^#\/?/, "").split("/")[0];
  const aktiv = ["schein", "wetten", "leiter"].includes(ort) ? ort : "spiele";
  const anzahl = scheinLesen().tipps.length;
  const offen = wettenLesen().filter((w) => !w.geloescht && w.status === "offen").length;
  const knopf = (ziel, icon, name, zahlText) => `
      <button data-nav="${ziel}" aria-current="${aktiv === ziel ? "page" : "false"}">
        <span class="nav-icon">${icon}${zahlText ? `<b>${zahlText}</b>` : ""}</span><span>${name}</span>
      </button>`;
  return `
    <nav class="unten" aria-label="Bereiche">
      ${knopf("spiele", ICON_SPIELE, "Spiele", "")}
      ${knopf("schein", ICON_SCHEIN, "Schein", anzahl ? String(anzahl) : "")}
      ${knopf("leiter", ICON_LEITER, "Verdoppeln", "")}
      ${knopf("wetten", ICON_WETTEN, "Meine Wetten", offen ? String(offen) : "")}
    </nav>`;
}

const ICON_WEITER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>';
const ICON_BILANZ = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M22 20H2"></path></svg>';

function dazuKnopf(s, k, inhalt, klasse = "") {
  const drin = imSchein(s.id, k);
  return `<button class="${klasse}" data-schein="${esc(k)}" aria-pressed="${drin}" aria-label="${drin ? "Vom Schein nehmen" : "Auf den Schein"}">${inhalt}</button>`;
}

function tabTipps(s) {
  const pr = s.prognose;
  if (!zustand.daten.modell || !pr) {
    return `<section class="abschnitt"><p class="leer">Für dieses Spiel gibt es noch keine Prognose. Sie kommt mit dem nächsten Daten-Update.</p></section>`;
  }
  let html = "";
  if (s.status !== "notstarted") {
    html += `<div class="warnung">${ICON_WARNUNG}<div><div class="titel">Das Spiel läuft</div><ul><li>Hier stehen die Werte und Quoten von vor dem Anpfiff. Live-Tipps und die aktuelle Chance deiner Tipps findest du im Reiter Live.</li></ul><button class="dazu" data-tab="live" style="margin-top:8px">Zu den Live-Tipps</button></div></div>`;
  } else if (s.aufstellung !== "standard") {
    html += `<div class="warnung">${ICON_WARNUNG}<div><div class="titel">Aufstellung noch nicht bestätigt</div><ul><li>Die Werte rechnen mit der ${s.aufstellung ? "voraussichtlichen Startelf" : "üblichen Einsatzzeit"}. Spielertipps zeigt die App deshalb erst ab 8 % Wert. Etwa eine Stunde vor Anpfiff steht die Startelf fest.</li></ul></div></div>`;
  }
  html += wertAbschnitt(s);
  html += spielKombiAbschnitt(s);
  html += alleWetten(s);
  return html;
}

// Top-Tipp: deutlicher Vorsprung bei Bet365 und eher wahrscheinlich als nicht
const TOP_WERT = 0.08;
const TOP_P = 0.5;
function topSchluessel(wert) {
  return new Set((wert || []).filter((w) => w.wert >= TOP_WERT && w.p >= TOP_P).slice(0, 2).map((w) => w.k));
}

function wertAbschnitt(s) {
  const pr = s.prognose;
  const wert = pr.wert || [];
  const index = tippIndex(s);
  if (!pr.mit_quoten) return pruefAbschnitt(s);
  let html = `<section class="abschnitt"><h2>Tipps mit Wert</h2>`;
  if (!wert.length) {
    html += `<p class="leer">Bei diesem Spiel zahlt Bet365 nirgends genug. Hier lieber nichts spielen.</p>`;
  } else {
    html += `<p>Hier zahlt Bet365 mehr, als die Wette nach unserer Rechnung wert ist. Mit ★ markiert sind die Top-Tipps: mindestens 8 % Wert und eher wahrscheinlich als nicht. Die Quote ist vom letzten Daten-Update, vergleich sie vor dem Setzen kurz in der Bet365-App.</p><div class="tipps">`;
    const top = topSchluessel(wert);
    wert.forEach((w, i) => { html += wertKarte(s, index, w, i + 1, top.has(w.k)); });
    html += `</div>`;
  }
  return html + `</section>`;
}

function wertKarte(s, index, w, rang, istTop) {
  const t = index.get(w.k) || {};
  const team = w.team ? teamVon(s, w.team) : null;
  const name = t.spieler ? t.spieler.name : w.titel;
  const was = t.spieler ? t.was : "";
  const markt = w.p_markt != null ? `Markt ${prozent(w.p_markt)}` : "";
  return `
      <article class="tipp wert-tipp${istTop ? " top-tipp" : ""}">
        <div class="tipp-kopf">
          <span class="rang">${rang}</span>
          <div class="was">
            ${istTop ? `<div class="etikett top">★ Top-Tipp</div>` : ""}
            <div class="n">${esc(name)}</div>
            ${was ? `<div class="m">${esc(was)}</div>` : ""}
          </div>
          <div class="chance"><span class="zahl">${zahl(w.quote, 2)}</span><small>Bet365</small></div>
        </div>
        <div class="wert-zeile">
          <span class="gruen">Wert ${mitVorzeichen(w.wert * 100)} %</span>
          <span>Chance ${prozent(w.p)}</span>
          <span class="leise">Modell ${prozent(w.p_modell)}${markt ? ` · ${markt}` : ""}</span>
        </div>
        <div class="tipp-fuss">
          <div class="gruende">${team ? `<span>${logo(team.id, "logo klein")}${esc(kurzName(team))}</span>` : ""}${(w.g || []).map((g) => `<span>${esc(g)}</span>`).join("")}</div>
          ${dazuKnopf(s, w.k, imSchein(s.id, w.k) ? "Auf dem Schein" : "Auf den Schein", "dazu")}
        </div>
      </article>`;
}

/* Quoten-Check: Bet365-Quote eintippen, sofort sehen, ob sie reicht */

const QUOTEN_SPEICHER = "flutlicht.quoten";

function quotenLesen() {
  try { return JSON.parse(lesen(QUOTEN_SPEICHER) || "{}") || {}; } catch (e) { return {}; }
}

function checkErgebnis(p, text) {
  const q = quoteLesen(text);
  if (!q) return `<span class="leise">lohnt ab ${mindestQuote(p)}</span>`;
  const wert = p * q - 1;
  if (wert >= LOHNT_AB - 1) return `<span class="gruen">lohnt, ${mitVorzeichen(wert * 100)} % über fair</span>`;
  if (wert >= 0) return `<span class="gelb">knapp, ${mitVorzeichen(wert * 100)} %</span>`;
  return `<span class="rot">lohnt nicht, ${mitVorzeichen(wert * 100)} %</span>`;
}

function quotenCheck(spielId, k, p) {
  const gespeichert = quotenLesen()[`${spielId}|${k}`] || "";
  return `
        <label class="quoten-check">
          <span class="leise klein">Bet365-Quote</span>
          <input type="text" inputmode="decimal" placeholder="Quote" value="${esc(gespeichert)}" data-check="${spielId}|${esc(k)}" data-check-p="${p}">
          <span class="klein" data-check-ergebnis="${spielId}|${esc(k)}">${checkErgebnis(p, gespeichert)}</span>
        </label>`;
}

function alleWetten(s) {
  const gruppe = MARKT_GRUPPEN.some(([id]) => id === zustand.tippGruppe) ? zustand.tippGruppe : "torschuetzen";
  let html = `
    <section class="abschnitt">
      <h2>Alle Wetten</h2>
      <div class="wahl" role="group" aria-label="Bereich">
        ${MARKT_GRUPPEN.map(([id, name]) => `<button data-tipp-gruppe="${id}" aria-pressed="${id === gruppe}">${name}</button>`).join("")}
      </div>`;
  if (gruppe === "torschuetzen") {
    html += `<div class="wahl klein-wahl" role="group" aria-label="Team">
        <button data-tipp-team="beide" aria-pressed="${zustand.tippTeam === "beide"}">Beide</button>
        <button data-tipp-team="heim" aria-pressed="${zustand.tippTeam === "heim"}">${logo(s.heim.id)}${esc(kurzName(s.heim))}</button>
        <button data-tipp-team="gast" aria-pressed="${zustand.tippTeam === "gast"}">${logo(s.gast.id)}${esc(kurzName(s.gast))}</button>
      </div>`;
    html += torschuetzenTabelle(s) + paareTabelle(s);
  } else {
    const liste = gruppe === "tore" ? TORE_ABSCHNITTE : gruppe === "karten" ? KARTEN_ABSCHNITTE : ECKEN_ABSCHNITTE;
    const vorhanden = new Set((s.prognose.maerkte || []).map((a) => a.id));
    const wahl = liste.filter(([id]) => vorhanden.has(id));
    let aktiv = zustand.tippAbschnitt[gruppe];
    if (!wahl.some(([id]) => id === aktiv) && wahl.length) aktiv = wahl[0][0];
    if (wahl.length > 1) {
      html += `<div class="wahl klein-wahl" role="group" aria-label="Markt">
        ${wahl.map(([id, name]) => `<button data-tipp-abschnitt="${id}" aria-pressed="${id === aktiv}">${name}</button>`).join("")}
      </div>`;
    }
    const abschnitt = (s.prognose.maerkte || []).find((a) => a.id === aktiv);
    html += abschnitt ? marktTabelle(s, abschnitt) : `<p class="leer">Für diesen Bereich fehlen noch Daten.</p>`;
    if (aktiv === "bereich" && s.prognose.gitter) html += `<div id="bereich-wahl">${bereichWahlHtml(s)}</div>`;
  }
  html += `<p class="fussnote">Die Namen sind wie bei Bet365. Tippe auf einen Wert, um ihn auf den Schein zu legen. Unter der Wahrscheinlichkeit steht die faire Quote, ≈ ist die geschätzte Bet365-Quote, eingetippte Quoten (bei „Tipps zum Prüfen“ oder im Schein) stehen dann hier. • heißt: lohnt sich laut eingetippter Quote.</p></section>`;
  return html;
}

// Torschuetzen: Spieler mit Chance zu treffen (Einwechslung+) und als Erster zu treffen
function torschuetzenTabelle(s) {
  const teamId = zustand.tippTeam === "heim" ? s.heim.id : zustand.tippTeam === "gast" ? s.gast.id : null;
  const liste = (s.prognose.torschuetzen || []).filter((sp) => !teamId || sp.team === teamId).slice(0, 28);
  if (!liste.length) return `<p class="leer">Für dieses Spiel fehlen noch Spielerdaten.</p>`;
  const spalten = "grid-template-columns: minmax(0, 1fr) repeat(2, 64px)";
  let html = `
    <div class="tabelle" role="table">
      <div class="reihe kopfreihe" role="row" style="${spalten}">
        <span role="columnheader">Spieler</span><span role="columnheader">Trifft</span><span role="columnheader">Zuerst</span>
      </div>`;
  const index = tippIndex(s);
  for (const sp of liste) {
    const team = teamVon(s, sp.team);
    const zusatz = [`${zahl(sp.r, 2)} Tore pro 90`, `${sp.t} ${sp.t === 1 ? "Tor" : "Tore"} in 10 Spielen`, `${sp.min} Min.`];
    const zelle = (markt) => {
      const k = `${markt}|1|ja|${sp.id}|${sp.team}`;
      const t = index.get(k);
      return t ? `<span role="cell">${dazuKnopf(s, k, tabellenZelle(s, t.k, t.p, 0, ""), "zelle")}</span>` : `<span role="cell"></span>`;
    };
    html += `
      <div class="reihe" role="row" style="${spalten}">
        <div class="wer" role="cell">
          <div class="n">${team ? logo(team.id, "logo klein") : ""}${esc(sp.name)} ${marke(sp)}</div>
          <div class="info">${zusatz.map((z) => esc(z)).join(" · ")}</div>
        </div>
        ${zelle("torschuetze")}${zelle("torschuetze_erster")}
      </div>`;
  }
  html += `</div><p class="fussnote">Einwechslung+: Wird der Spieler ausgewechselt, zählt der Einwechselspieler weiter. Die Chancen passen zur Tor-Erwartung des Teams; im Rückblick an 2.384 Team-Spielen stimmten sie (13,8 % gesagt, 14,2 % eingetroffen).</p>`;
  return html;
}

function paareTabelle(s) {
  const paare = s.prognose.paare || [];
  if (!paare.length) return "";
  const index = tippIndex(s);
  const spalten = "grid-template-columns: minmax(0, 1fr) repeat(2, 64px)";
  let html = `<h3 class="unterkopf">Einer der beiden erzielt ein Tor</h3>
    <div class="tabelle" role="table">
      <div class="reihe kopfreihe" role="row" style="${spalten}"><span role="columnheader">Spieler</span><span role="columnheader">Trifft</span><span role="columnheader">Zuerst</span></div>`;
  for (const paar of paare.slice(0, 10)) {
    const k1 = `torschuetze_paar|1|ja|${paar.a}+${paar.b}|`;
    const k2 = `torschuetze_paar_erster|1|ja|${paar.a}+${paar.b}|`;
    const t = index.get(k1);
    if (!t) continue;
    html += `<div class="reihe" role="row" style="${spalten}">
      <div class="wer" role="cell"><div class="n">${esc(t.name)}</div></div>
      <span role="cell">${dazuKnopf(s, k1, tabellenZelle(s, k1, paar.p, 0, ""), "zelle")}</span>
      <span role="cell">${dazuKnopf(s, k2, tabellenZelle(s, k2, paar.pe, 0, ""), "zelle")}</span>
    </div>`;
  }
  return html + `</div><p class="fussnote">Bet365 bietet nur bestimmte Paare an. Steht deins nicht hier, rechne mit den Einzelchancen: Die Chance für das Paar ist etwas weniger als beide zusammengezählt.</p>`;
}

// Zelle mit Wahrscheinlichkeit und darunter eingetippter oder geschaetzter Bet365-Quote (oder fair)
function tabellenZelle(s, k, p, push, beschriftung) {
  const markt = k.split("|")[0];
  const getippt = b365Quote(s.id, k);
  if (getippt) {
    const wert = p * getippt + (push || 0) - 1;
    return zellenInhalt(p, getippt, wert, push, beschriftung, p, wert >= TOP_WERT && p >= TOP_P ? "★" : wert >= KOMBI_MIN_WERT ? "•" : "");
  }
  return zellenInhalt(p, null, null, push, beschriftung, null, "", push ? null : schaetzeQuote(markt, p).quote);
}

/* Tore-Bereich selbst waehlen: Bet365 kann andere Bereiche anbieten als die Tabelle. Die App rechnet
   jeden Bereich aus dem Endergebnis-Gitter (Spiel und Teams) bzw. aus den Toren je Halbzeit. */
const BEREICH_ARTEN = [["spiel", "Spiel"], ["heim", "Heim"], ["gast", "Gast"], ["hz1", "1. Hälfte"], ["hz2", "2. Hälfte"]];

function bereichVerteilung(s, art) {
  const pr = s.prognose;
  if (art === "hz1" || art === "hz2") {
    const liste = (pr.hz || [])[art === "hz1" ? 0 : 1] || [];
    const summe = liste.reduce((a, x) => a + x, 0) || 1;
    return liste.map((x) => x / summe);
  }
  const gitter = pr.gitter || [];
  const n = gitter.length;
  const aus = new Array(art === "spiel" ? 2 * n : n).fill(0);
  let summe = 0;
  gitter.forEach((zeile, i) => zeile.forEach((w, j) => {
    summe += w;
    aus[art === "spiel" ? i + j : art === "heim" ? i : j] += w;
  }));
  return aus.map((x) => x / (summe || 1));
}

function bereichSchluessel(s, art, von, bis) {
  const text = bis === "+" ? `${von}+` : Number(bis) === Number(von) ? `${von}` : `${von}-${bis}`;
  if (art === "heim" || art === "gast") return `tore_teambereich||${text}||${art === "heim" ? s.heim.id : s.gast.id}`;
  return `${art === "spiel" ? "tore_bereich" : `tore_bereich_${art}`}||${text}||`;
}

function bereichWahlHtml(s) {
  const w = zustand.bereichWahl;
  const von = Math.max(0, Math.min(7, Number(w.von) || 0));
  const bis = w.bis === "+" ? "+" : Math.max(von, Math.min(9, Number(w.bis) || 0));
  const verteilung = bereichVerteilung(s, w.art);
  const p = verteilung.reduce((a, x, n) => a + (n >= von && (bis === "+" || n <= bis) ? x : 0), 0);
  const k = bereichSchluessel(s, w.art, von, bis);
  const name = (BEREICH_ARTEN.find(([id]) => id === w.art) || [, ""])[1];
  const teamName = w.art === "heim" ? kurzName(s.heim) : w.art === "gast" ? kurzName(s.gast) : name;
  const optionen = (liste, gewaehlt) => liste.map(([wert, text]) => `<option value="${wert}"${String(wert) === String(gewaehlt) ? " selected" : ""}>${text}</option>`).join("");
  const zahlen = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => [x, String(x)]);
  return `
    <h3 class="unterkopf">Bereich selbst wählen</h3>
    <p class="leise klein" style="margin:0 0 8px">Wenn Bet365 einen anderen Bereich anbietet als oben, stell ihn hier ein.</p>
    <div class="bereich-wahl">
      <label><span class="leise klein">Tore</span><select data-bereich="art">${optionen(BEREICH_ARTEN.map(([id, text]) => [id, id === "heim" ? kurzName(s.heim) : id === "gast" ? kurzName(s.gast) : text]), w.art)}</select></label>
      <label><span class="leise klein">von</span><select data-bereich="von">${optionen(zahlen, von)}</select></label>
      <label><span class="leise klein">bis</span><select data-bereich="bis">${optionen([...zahlen.filter(([x]) => x >= von), ["+", "oder mehr"]], bis)}</select></label>
    </div>
    <div class="zellen-reihe feste" style="grid-template-columns: 1fr">${dazuKnopf(s, k, tabellenZelle(s, k, p, 0, `${teamName}: ${bis === "+" ? `${von} oder mehr` : von === bis ? `genau ${von}` : `${von} bis ${bis}`} Tore`), "zelle")}</div>`;
}

// Inhalt einer Zelle: Wahrscheinlichkeit und darunter Bet365-Quote (grün, wenn sie Wert hat und
// auch sonst als Tipp in Frage kaeme) oder faire Quote
function zellenInhalt(p, quote, wert, push, beschriftung, pm, stern, schaetzung) {
  const regeln = (zustand.daten.modell || {}).wert || {};
  const lohnt = quote && wert != null && wert >= (regeln.min ?? 0.05)
    && (pm ?? p) >= (regeln.min_p ?? 0.3) && quote <= (regeln.max_quote ?? 4);
  const fairQuote = p > 0 ? (1 - (push || 0)) / p : null;
  const unten = quote
    ? `<small class="${lohnt ? "gruen" : "leise"}">B365 ${zahl(quote, 2)}</small>`
    : schaetzung
    ? `<small>≈ ${zahl(schaetzung, 2)}</small>`
    : `<small>fair ${fairQuote ? zahl(fairQuote, 2) : "-"}</small>`;
  return `${beschriftung ? `<span class="klein leise">${esc(beschriftung)}</span>` : ""}<span class="zahl">${stern ? `<b class="stern">${stern}</b>` : ""}${prozent(p)}</span>${unten}`;
}

function marktTabelle(s, abschnitt) {
  let html = "";
  if (abschnitt.e) {
    html += `<p class="leise klein" style="margin:0 0 8px">Erwartet: ${esc(kurzName(s.heim))} ${zahl(abschnitt.e[0], 1)}, ${esc(kurzName(s.gast))} ${zahl(abschnitt.e[1], 1)}</p>`;
  }
  // Zeilen mit gleichem Titel gehoeren zusammen
  const gruppen = [];
  for (const zeile of abschnitt.zeilen) {
    const letzte = gruppen[gruppen.length - 1];
    if (letzte && letzte.t === zeile.t && letzte.typ === zeile.typ) letzte.zeilen.push(zeile);
    else gruppen.push({ t: zeile.t, typ: zeile.typ, zeilen: [zeile] });
  }
  const tippe = new Set((s.prognose.wert || []).map((w) => w.k));
  const top = topSchluessel(s.prognose.wert);
  const zelle = (z, beschriftung) => {
    if (!z) return `<span></span>`;
    const inhalt = z.q
      ? zellenInhalt(z.p, z.q, z.w, z.push, beschriftung, z.pm, top.has(z.k) ? "★" : tippe.has(z.k) ? "•" : "")
      : tabellenZelle(s, z.k, z.p, z.push, beschriftung);
    return dazuKnopf(s, z.k, inhalt, "zelle");
  };
  for (const g of gruppen) {
    html += `<h3 class="unterkopf">${esc(g.t)}</h3>`;
    if (g.typ === "ou") {
      const spalten = "grid-template-columns: minmax(0, 1fr) repeat(2, 64px)";
      html += `<div class="tabelle" role="table">
        <div class="reihe kopfreihe" role="row" style="${spalten}"><span role="columnheader">Linie</span><span role="columnheader">Über</span><span role="columnheader">Unter</span></div>`;
      for (const zeile of g.zeilen) {
        html += `<div class="reihe" role="row" style="${spalten}">
          <div class="wer" role="cell"><div class="n">${zahl(zeile.l, Number.isInteger(zeile.l) ? 0 : zeile.l * 4 % 2 ? 2 : 1)}</div></div>
          <span role="cell">${zelle(zeile.z[0])}</span><span role="cell">${zelle(zeile.z[1])}</span>
        </div>`;
      }
      html += `</div>`;
    } else {
      for (const zeile of g.zeilen) {
        html += `<div class="zellen-reihe feste" style="grid-template-columns: repeat(${zeile.z.length}, minmax(0, 1fr))">${zeile.z.map((z) => zelle(z, z && z.a)).join("")}</div>`;
      }
    }
  }
  return html;
}

/* ------------------------------------------------------------------- Schein */

function scheinAuswertung(schein) {
  const n = schein.tipps.length;
  // Mehrere Tipps aus einem Spiel: gemeinsame Chance ueber das Endergebnis (siehe kombiDaten)
  const jeSpiel = new Map();
  for (const t of schein.tipps) {
    if (!jeSpiel.has(t.spiel)) jeSpiel.set(t.spiel, []);
    jeSpiel.get(t.spiel).push(t);
  }
  let zh = 1;
  for (const liste of jeSpiel.values()) if (liste.length > 1) zh *= zusammenhang(liste);
  const p = Math.min(0.999, schein.tipps.reduce((a, t) => a * t.p, 1) * zh);
  const einzel = schein.tipps.map((t) => quoteLesen(t.quote));
  // Bet Builder: Bet365 preist den Zusammenhang ein, dazu etwas Marge je weiterem Tipp
  const faktor = bbFaktor(schein.tipps) / Math.max(0.25, zh);
  const bb = jeSpiel.size < n;
  const ausEinzel = einzel.length && einzel.every((q) => q) ? einzel.reduce((a, q) => a * q, 1) * faktor : null;
  // Fehlen Einzelquoten, aber gibt es fuer alle eine Schaetzung: geschaetzte Gesamtquote
  const mitSchaetzung = !ausEinzel && einzel.length && schein.tipps.every((t, i) => einzel[i] || t.schaetzung)
    ? schein.tipps.reduce((a, t, i) => a * (einzel[i] || t.schaetzung), 1) * faktor : null;
  const quote = quoteLesen(schein.gesamt) || ausEinzel || mitSchaetzung;
  const einsatz = einsatzLesen(schein.einsatz);
  const ergebnis = { n, p, fair: 1 / p, quote, ausEinzel, einsatz, bb,
    quelle: quoteLesen(schein.gesamt) ? "gesamt" : ausEinzel ? "einzel" : mitSchaetzung ? "schaetzung" : null };
  if (quote) {
    ergebnis.wert = p * quote - 1;
    ergebnis.auszahlung = einsatz * quote;
    ergebnis.gewinn = ergebnis.auszahlung - einsatz;
    ergebnis.erwartung = einsatz * ergebnis.wert;
    // Je mehr Tipps, desto mehr kann sich die Unsicherheit des Modells aufsummieren
    ergebnis.schwelle = 0.1 + 0.05 * (n - 1);
    ergebnis.ampel = ergebnis.wert >= ergebnis.schwelle ? "gruen" : ergebnis.wert >= 0 ? "gelb" : "rot";
  }
  return ergebnis;
}

const EINSAETZE = [5, 10, 20, 50];
const STANDARD_EINSATZ = 10;

function einsatzLesen(text) {
  const wert = parseFloat(String(text ?? "").replace(",", ".").trim());
  return Number.isFinite(wert) && wert > 0 ? wert : STANDARD_EINSATZ;
}

const euro = (wert) => `${zahl(wert, 2)} €`;

function scheinErgebnisHtml(schein) {
  const e = scheinAuswertung(schein);
  const jeder = e.p > 0 ? Math.max(1, Math.round(1 / e.p)) : null;
  const haeufig = e.p >= 0.4
    ? `, etwa ${Math.round(e.p * 10)} von 10 Scheinen gehen durch`
    : jeder && jeder > 1 ? `, etwa jeder ${jeder}. Schein geht durch` : "";
  let html = `
    <div class="kombi-zahlen">
      <div><div class="zahl">${prozent(e.p)}</div><div class="leise klein">Chance laut Modell${haeufig}</div></div>
      <div><div class="zahl">${fair(e.p)}</div><div class="leise klein">faire Gesamtquote</div></div>
    </div>`;
  if (!e.quote) {
    html += `<p class="leise klein">Trag die Gesamtquote von Bet365 ein (oder alle Einzelquoten), dann siehst du Auszahlung, Gewinn und ob sich der Schein rechnet.</p>`;
    return html;
  }
  const verlust = Math.round((1 - e.p) * 100);
  html += `
    <div class="geld">
      <div><span class="leise klein">Einsatz</span><span class="zahl">${euro(e.einsatz)}</span></div>
      <div><span class="leise klein">Auszahlung bei Treffer</span><span class="zahl">${euro(e.auszahlung)}</span></div>
      <div><span class="leise klein">Gewinn bei Treffer</span><span class="zahl gruen">+${euro(e.gewinn)}</span></div>
    </div>
    <p class="leise klein geld-hinweis">Laut Modell sind die ${euro(e.einsatz)} in etwa ${verlust} von 100 Fällen weg.</p>`;
  const titel = {
    gruen: "Quote liegt deutlich über fair",
    gelb: "Knapp über fair",
    rot: "Quote liegt unter fair",
  }[e.ampel];
  const text = {
    gruen: `Laut Modell zahlt Bet365 hier mehr, als der Schein wert ist. Grün gibt es ab ${Math.round(e.schwelle * 100)} % über fair, weil das Modell selbst ein paar Prozent danebenliegen kann.`,
    gelb: `Der Vorsprung ist kleiner als die Unsicherheit des Modells (grün ab ${Math.round(e.schwelle * 100)} % bei ${e.n} ${e.n === 1 ? "Tipp" : "Tipps"}). Kein klarer Vorteil.`,
    rot: "Bet365 zahlt weniger, als der Schein laut Modell wert ist. Auf Dauer verliert man mit solchen Scheinen Geld.",
  }[e.ampel];
  html += `
    <div class="ampel ${e.ampel}">
      <div class="ampel-kopf"><strong>${titel}</strong><span class="zahl">${mitVorzeichen(e.wert * 100)} %</span></div>
      <div class="klein">Quote ${zahl(e.quote, 2)}${e.quelle === "einzel" ? " (aus den Einzelquoten)" : e.quelle === "schaetzung" ? " (teilweise geschätzt, trag die echten Einzelquoten ein)" : ""} gegen fair ${fair(e.p)}. Im Schnitt bringt dieser Schein bei ${euro(e.einsatz)} Einsatz ${mitVorzeichen(e.erwartung, 2)} €.</div>
      <p class="klein">${text}</p>
    </div>`;
  return html;
}

/* ------------------------------------------- Bet365-Quoten schaetzen und lernen */

/* Ohne Quoten-Dienst schaetzt die App, was Bet365 zahlt. Jede Quote, die du eintippst (bei
   "Zum Prüfen" oder im Schein), wird gespeichert und verbessert die Schaetzung: Je Markt lernt die
   App, wie weit Bet365 von unserer Wahrscheinlichkeit abweicht (in Logit-Schritten:
   Bet365 = a + b x Modell). Vorwissen aus deinen ersten Beispielen (Bellingham, Enciso): Bei
   Spielerwetten zahlt Bet365 deutlich weniger als fair, bei Spielwetten etwas weniger. */

const B365_SPEICHER = "flutlicht.b365";
// Bet365 = a + b x Modell (Logit). Torschuetzen: Bet365 zahlt etwa 20 bis 25 % unter fair, Spielwetten etwas weniger
const SCHAETZ_VORWISSEN = { spieler: [0.3, 1.0], spiel: [0.15, 1.0] };
const SCHAETZ_GEWICHT = 6;           // so viele eingetippte Quoten wiegt das Vorwissen
const PRUEF_QUOTE = [1.15, 4.0];     // sehr kurze Quoten lohnen nie, sehr lange sind Lotterie
const KOMBI_QUOTE = [1.2, 4.0];
const PRUEF_P = [0.5, 0.88];         // zum Pruefen nur Tipps, die eher eintreffen
const PRUEF_P_TOR = [0.3, 0.88];     // Torschuetzen: ab 30 % (kaum ein Spieler trifft oefter als jedes zweite Mal)
const PRUEF_ZIEL_P = 0.72;           // je Wette die Linie mit Chance um 72 %
const PRUEF_ZIEL_P_TOR = 0.42;
let schaetzerCache = null;
let b365Cache = null;

function b365Lesen() {
  if (!b365Cache) {
    b365Cache = [];
    try {
      const d = JSON.parse(lesen(B365_SPEICHER) || "null");
      if (d && Array.isArray(d.eintraege)) b365Cache = d.eintraege;
    } catch (e) { /* kaputt: neu anfangen */ }
  }
  return [...b365Cache];
}

function b365Schreiben(eintraege) {
  schreiben(B365_SPEICHER, JSON.stringify({ eintraege }));
  schaetzerCache = null;
  b365Cache = null;
}

// Maerkte, die es bei Bet365 in einem Wettbewerb nicht gibt: merkt sich die App, wenn du es sagst
function b365FehltSetzen(liga, gruppe, an) {
  const eintraege = b365Lesen();
  const id = `fehlt|${liga}|${gruppe}`;
  const i = eintraege.findIndex((e) => e.id === id);
  const neu = { id, fehlt: true, liga, gruppe, geloescht: !an, geaendert: Date.now() };
  if (i >= 0) eintraege[i] = neu;
  else eintraege.push(neu);
  b365Schreiben(eintraege);
  spaeterAbgleichen();
}

function b365Fehlend() {
  return new Set(b365Lesen().filter((e) => e.fehlt && !e.geloescht).map((e) => `${e.liga}|${e.gruppe}`));
}

function b365Merken(spiel, k, p, text) {
  const quote = quoteLesen(text);
  const eintraege = b365Lesen();
  const id = `${spiel}|${k}`;
  const i = eintraege.findIndex((e) => e.id === id);
  if (!quote) {
    if (i >= 0 && !eintraege[i].geloescht) {
      eintraege[i] = { ...eintraege[i], geloescht: true, geaendert: Date.now() };
      b365Schreiben(eintraege);
      spaeterAbgleichen();
    }
    return;
  }
  if (!(p > 0 && p < 1)) return;
  const neu = { id, spiel, k, markt: k.split("|")[0], p: Math.round(p * 1000) / 1000, quote, geaendert: Date.now() };
  if (i >= 0) eintraege[i] = neu;
  else eintraege.push(neu);
  b365Schreiben(eintraege);
  spaeterAbgleichen();
}

function b365Quote(spiel, k) {
  const e = b365Lesen().find((x) => x.id === `${spiel}|${k}` && !x.geloescht);
  return e ? e.quote : null;
}

const istSpielerMarkt = (markt) => String(markt).startsWith("torschuetze");
const schaetzGruppe = (markt) => (istSpielerMarkt(markt) ? markt : markt.replace(/_hz[12]$/, ""));
const logitVon = (x) => Math.log(Math.min(0.995, Math.max(0.005, x)) / (1 - Math.min(0.995, Math.max(0.005, x))));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Kleinste Quadrate mit Vorwissen (a0, b0) der Staerke w
function schaetzAnpassen(punkte, a0, b0, w) {
  let n = w, sx = 0, sy = w * a0, sxx = w, sxy = w * b0;
  for (const [x, y] of punkte) { n += 1; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const det = n * sxx - sx * sx;
  if (Math.abs(det) < 1e-9) return [a0, b0];
  return [(sy * sxx - sx * sxy) / det, (n * sxy - sx * sy) / det];
}

function schaetzer() {
  if (schaetzerCache) return schaetzerCache;
  const daten = b365Lesen().filter((e) => !e.geloescht && e.p > 0.02 && e.p < 0.98 && e.quote > 1.001 && bet365Ok(e.markt));
  const punkt = (e) => [logitVon(e.p), logitVon(1 / e.quote)];
  const eltern = {};
  for (const art of ["spieler", "spiel"]) {
    const eigene = daten.filter((e) => istSpielerMarkt(e.markt) === (art === "spieler"));
    eltern[art] = { werte: schaetzAnpassen(eigene.map(punkt), ...SCHAETZ_VORWISSEN[art], SCHAETZ_GEWICHT), n: eigene.length };
  }
  const gruppen = {};
  for (const e of daten) (gruppen[schaetzGruppe(e.markt)] = gruppen[schaetzGruppe(e.markt)] || []).push(e);
  const ergebnis = { eltern, gruppen: {} };
  for (const [g, liste] of Object.entries(gruppen)) {
    const elter = eltern[istSpielerMarkt(g) ? "spieler" : "spiel"].werte;
    ergebnis.gruppen[g] = { werte: schaetzAnpassen(liste.map(punkt), elter[0], elter[1], SCHAETZ_GEWICHT), n: liste.length };
  }
  // Wie gut trifft die Schaetzung? Fuer jede eingetippte Quote ohne sie selbst geschaetzt
  const fehler = {};
  for (const e of daten) {
    const g = schaetzGruppe(e.markt);
    const ohne = daten.filter((x) => x !== e && schaetzGruppe(x.markt) === g).map(punkt);
    const elter = eltern[istSpielerMarkt(g) ? "spieler" : "spiel"].werte;
    const [a, b] = schaetzAnpassen(ohne, elter[0], elter[1], SCHAETZ_GEWICHT);
    const q = 1 / sigmoid(a + b * logitVon(e.p));
    (fehler[g] = fehler[g] || []).push(Math.abs(q - e.quote) / e.quote);
  }
  ergebnis.fehler = fehler;
  ergebnis.anzahl = daten.length;
  schaetzerCache = ergebnis;
  return ergebnis;
}

// Geschaetzte Bet365-Quote fuer eine Wette mit unserer Wahrscheinlichkeit p
function schaetzeQuote(markt, p) {
  const s = schaetzer();
  const g = s.gruppen[schaetzGruppe(markt)];
  const [a, b] = g ? g.werte : s.eltern[istSpielerMarkt(markt) ? "spieler" : "spiel"].werte;
  const quote = Math.max(1.01, 1 / sigmoid(a + b * logitVon(p)));
  return { quote, n: g ? g.n : 0 };
}

// Lesbarer Name einer Schaetz-Gruppe (Spielermarkt oder Spielmarkt ohne Halbzeit)
function gruppenName(g) {
  if (BET365[g]) return BET365[g].name;
  return g.replace(/_/g, " ");
}

// Wie viel besser als ein einfacher Schnitt das Modell in diesem Markt ist (aus dem Rueckblick)
function marktStaerke(markt) {
  const m = zustand.daten.modell || {};
  if (istSpielerMarkt(markt)) {
    const v = ((m.maerkte || {})[markt] || {}).vorteil;
    return v == null ? 0 : v / 100;
  }
  const basis = markt.replace(/_(spiel|team)(_hz[12])?$/, "");
  const b = ((m.rueckblick_team || {}).maerkte || {})[basis];
  return b ? (b.brier_vorteil_prozent || 0) / 100 : 0;
}

// Nur, was es bei Bet365 gibt
function pruefMarktOk(markt) {
  return bet365Ok(markt);
}

/* Kombis, Verdoppeln und Tipps zum Pruefen (seit 06.11.2026): Torschuetzen, Endergebnis, Doppelte
   Chance, Tore, beide treffen, Ergebnis/beide treffen, Spielhaelfte mit den meisten Toren, Team-
   Spezialwetten, Handicap und Ecken, alle mit WK-Zeichen. Genaues Ergebnis, Halbzeit/Endergebnis,
   Tore-Bereich und die Paare stehen unter "Alle Wetten", sind fuer Kombis aber zu sehr Lotterie
   (oder Bet365 bietet nur bestimmte Paare an). */
const KOMBI_MAERKTE = new Set(["torschuetze", "tore_ergebnis", "tore_doppelte_chance", "tore_spiel", "tore_btts",
  "tore_ergebnis_btts", "tore_haelfte", "tore_spezial", "tore_europaeisch", "ecken_dreiweg", "ecken_spiel", "ecken_meiste",
  "tore_team", "ecken_team", "karten_spiel", "karten_team"]);
function kombiMarktOk(markt) {
  return KOMBI_MAERKTE.has(markt) && Boolean((BET365[markt] || {}).wk);
}
const istTeamBein = (b) => !b.k.split("|")[3];
// Frueher hoechstens ein Nicht-Spieler-Tipp je Kombi; seit es nur noch Torschuetzen als Spielerwette gibt, ohne Grenze
const teamBeineMax = (anzahl) => anzahl;

// Alle Wetten eines Spiels mit eingetippter oder geschaetzter Bet365-Quote. Reihenfolge: erst,
// was sich laut Schaetzung lohnt, dann Maerkte, in denen das Modell nachweislich stark ist.
function pruefKandidaten(s) {
  const liga = s.wettbewerb || "";
  const fehlend = b365Fehlend();
  const liste = [];
  for (const t of tippIndex(s).values()) {
    if (t.quote || t.push) continue;
    const gruppe = schaetzGruppe(t.markt);
    const eingetippt = b365Quote(s.id, t.k);
    const tor = t.markt === "torschuetze";
    if (!eingetippt) {
      const grenzen = tor ? PRUEF_P_TOR : PRUEF_P;
      if (!(t.p >= grenzen[0] && t.p <= grenzen[1]) || !pruefMarktOk(t.markt) || !kombiMarktOk(t.markt) || fehlend.has(`${liga}|${gruppe}`)) continue;
      if (t.art === "spieler" && t.spieler && (t.spieler.min < 60 || t.spieler.hinweis || t.spieler.startelf === false)) continue;
    } else if (!bet365Ok(t.markt)) continue;
    const schaetzung = schaetzeQuote(t.markt, t.p);
    const quote = eingetippt || schaetzung.quote;
    if (!eingetippt && (quote < PRUEF_QUOTE[0] || quote > PRUEF_QUOTE[1])) continue;
    const wert = t.p * quote - 1;
    const prio = wert + 0.4 * Math.min(0.25, Math.max(0, marktStaerke(t.markt))) - 0.3 * Math.abs(t.p - (tor ? PRUEF_ZIEL_P_TOR : PRUEF_ZIEL_P));
    liste.push({ ...t, quote, eingetippt: Boolean(eingetippt), schaetzung: schaetzung.quote, gelernt: schaetzung.n, wert, prio, gruppe });
  }
  // je Spieler und Markt bzw. je Wette nur eine Linie: die eingetippte, sonst die beste
  const beste = new Map();
  for (const x of liste) {
    const teile = x.k.split("|");
    const schl = teile[3] ? `${teile[0]}|${teile[3]}` : `${teile[0]}|${teile[2]}|${teile[4]}`;
    const alt = beste.get(schl);
    if (!alt || (x.eingetippt && !alt.eingetippt) || (x.eingetippt === alt.eingetippt && (x.eingetippt ? x.wert > alt.wert : x.prio > alt.prio))) beste.set(schl, x);
  }
  return [...beste.values()].sort((a, b) => (b.eingetippt - a.eingetippt) || (a.eingetippt ? b.wert - a.wert : b.prio - a.prio));
}

function pruefAbschnitt(s) {
  const alle = pruefKandidaten(s);
  const geprueft = alle.filter((x) => x.eingetippt && x.wert >= 0).slice(0, 5);
  const offen = alle.filter((x) => !x.eingetippt);
  // offene Tipps aus moeglichst verschiedenen Maerkten: hoechstens drei, die keine Torschuetzen sind
  const anzahl = Math.max(3, 5 - geprueft.length);
  const neu = [];
  const familien = new Set();
  const teamVoll = () => neu.filter((x) => x.art !== "spieler").length >= 3;
  for (const runde of [0, 1]) {
    for (const x of offen) {
      if (neu.length >= anzahl) break;
      if (neu.includes(x) || (x.art !== "spieler" && teamVoll())) continue;
      const familie = kombiFamilien(x.k).join(",");
      if (runde === 0 && familien.has(familie)) continue;
      familien.add(familie);
      neu.push(x);
    }
  }
  neu.sort((a, b) => b.prio - a.prio);
  const zeigen = [...geprueft, ...neu];
  const index = tippIndex(s);
  let html = `<section class="abschnitt"><h2>Tipps zum Prüfen</h2>
    <p>Ohne Quoten-Dienst kennt die App die Bet365-Quoten nicht und schätzt sie. Hier stehen Tipps mit guter Chance, nur aus Märkten, die es bei Bet365 gibt. Schau die Quote in Bet365 nach und tipp sie ein: Dann siehst du sofort, ob es sich lohnt, und die App lernt dazu.</p>`;
  if (!zeigen.length) {
    html += `<p class="leer">Für dieses Spiel gibt es keine Wette, bei der sich das Nachschauen lohnt.</p>`;
  } else {
    html += `<div class="tipps">${zeigen.map((x, i) => pruefKarte(s, index, x, i + 1)).join("")}</div>`;
  }
  const s365 = schaetzer();
  html += `<p class="fussnote">${s365.anzahl ? `Die Schätzung kennt schon ${s365.anzahl} eingetippte Bet365-Quoten.` : "Die Schätzung startet mit Vorwissen und wird mit jeder eingetippten Quote genauer."}</p>`;
  html += zustand.schnellSpiel === s.id ? schnellHtml(s)
    : `<button class="schnell-knopf" data-aktion="schnell-auf">Alle Quoten dieses Spiels eintippen</button>`;
  return html + `</section>`;
}

/* Schnell-Eingabe: die Bet365-Maerkte eines Spiels als Liste zum Durchtippen, in der Reihenfolge wie
   bei Bet365. Je Ueber/Unter-Markt die zwei Linien um 50 %, Torschuetzen der Startelf ab 8 %. */
const SCHNELL_WEITERE = new Set(["genau", "bereich", "handicap"]);
function schnellGruppen(s) {
  const pr = s.prognose;
  if (!pr) return [];
  const liga = s.wettbewerb || "";
  const fehlend = b365Fehlend();
  const zelleOk = (k, p, push) => {
    const markt = k.split("|")[0];
    return !push && p >= 0.08 && p <= 0.92 && pruefMarktOk(markt) && !fehlend.has(`${liga}|${schaetzGruppe(markt)}`);
  };
  const gruppen = [];
  // Torschuetzen zuerst: die wahrscheinlichsten Spieler der (voraussichtlichen) Startelf
  if (!fehlend.has(`${liga}|torschuetze`)) {
    const zeilen = (pr.torschuetzen || [])
      .filter((sp) => sp.p >= 0.08 && sp.min >= 45 && !sp.hinweis && sp.startelf !== false)
      .slice(0, 14)
      .map((sp) => ({ k: `torschuetze|1|ja|${sp.id}|${sp.team}`, p: sp.p, text: `${sp.name} trifft` }));
    if (zeilen.length) gruppen.push({ id: "torschuetzen", name: "Torschützen (Einwechslung+)", zeilen });
  }
  const tabellen = new Map((pr.maerkte || []).map((a) => [a.id, a]));
  for (const [id, name] of [...TORE_ABSCHNITTE, ...ECKEN_ABSCHNITTE, ...KARTEN_ABSCHNITTE]) {
    const a = tabellen.get(id);
    if (!a) continue;
    const zeilen = [];
    const ou = new Map();
    for (const z of a.zeilen) {
      if (z.typ === "ou") {
        if (!ou.has(z.t)) ou.set(z.t, []);
        ou.get(z.t).push(z);
        continue;
      }
      z.z.forEach((c) => {
        if (c && zelleOk(c.k, c.p, c.push)) zeilen.push({ k: c.k, p: c.p, text: c.tt || (z.typ === "eins" || !c.a ? z.t : `${z.t}: ${c.a}`) });
      });
    }
    for (const [titel, liste] of ou) {
      const ueber = (z) => (z.z[0] ? z.z[0].p : null);
      const drueber = liste.filter((z) => ueber(z) >= 0.5).sort((x, y) => ueber(x) - ueber(y))[0];
      const drunter = liste.filter((z) => ueber(z) != null && ueber(z) < 0.5).sort((x, y) => ueber(y) - ueber(x))[0];
      const gewaehlt = new Set([drueber, drunter].filter(Boolean));
      for (const z of liste) if (z.z.some((c) => c && b365Quote(s.id, c.k))) gewaehlt.add(z);
      for (const z of [...gewaehlt].sort((x, y) => x.l - y.l)) {
        z.z.forEach((c, i) => {
          if (c && zelleOk(c.k, c.p, c.push)) zeilen.push({ k: c.k, p: c.p, text: `${titel}: ${i === 0 ? "über" : "unter"} ${zahl(z.l, 1)}` });
        });
      }
    }
    if (zeilen.length) gruppen.push({ id, name: a.t || name, zeilen, weitere: SCHNELL_WEITERE.has(id) });
  }
  return gruppen.map((g, i) => [g, i]).sort((a, b) => (a[0].weitere ? 1 : 0) - (b[0].weitere ? 1 : 0) || a[1] - b[1]).map(([g]) => g);
}

function schnellZaehler(spiel) {
  const n = b365Lesen().filter((e) => e.spiel === spiel && e.quote && !e.geloescht).length;
  return n ? `${n} ${n === 1 ? "Quote" : "Quoten"} in diesem Spiel eingetippt` : "Noch keine Quote in diesem Spiel eingetippt";
}

function schnellHtml(s) {
  const gruppen = schnellGruppen(s);
  let html = `<div class="schnell" id="schnell">
    <div class="schnell-kopf"><h3 class="unterkopf">Quoten schnell eintippen</h3><button class="link-knopf" data-aktion="schnell-zu">Schließen</button></div>
    <p class="klein leise">Geh in Bet365 die Märkte dieses Spiels durch und tipp ein, was du dort siehst. Was es nicht gibt, lässt du leer. Mit „Weiter“ auf der Tastatur springst du zum nächsten Feld.</p>
    <p class="klein schnell-zahl" data-b365-zaehler="${s.id}">${schnellZaehler(s.id)}</p>`;
  if (!gruppen.length) return html + `<p class="leer">Für dieses Spiel gibt es noch keine Märkte zum Eintippen.</p></div>`;
  let trenner = false;
  for (const g of gruppen) {
    const n = g.zeilen.filter((z) => b365Quote(s.id, z.k)).length;
    if (g.weitere && !trenner) {
      trenner = true;
      html += `<p class="klein leise schnell-trenner">Weitere Märkte. Die kommen nicht in Kombis, helfen der Schätzung aber mit.</p>`;
    }
    html += `<details data-schnell-gruppe="${esc(g.id)}"${zustand.schnellGruppen.has(g.id) ? " open" : ""}>
      <summary><span>${esc(g.name)}</span><span class="leise klein">${n ? `${n} von ${g.zeilen.length}` : g.zeilen.length}</span></summary>
      ${g.zeilen.map((z) => schnellZeile(s, z)).join("")}
    </details>`;
  }
  return html + `</div>`;
}

function schnellZeile(s, z) {
  const markt = z.k.split("|")[0];
  const eingetippt = b365Quote(s.id, z.k);
  const schaetzung = schaetzeQuote(markt, z.p).quote;
  const id = `${s.id}|${z.k}`;
  return `
    <label class="schnell-zeile">
      <span><span class="n">${esc(z.text)}</span>
        <small>${prozent(z.p)} · lohnt ab ${zahl((1 + KOMBI_MIN_WERT) / z.p, 2)}<span class="schnell-urteil" data-b365-urteil="${esc(id)}" data-leer="1">${eingetippt ? pruefUrteil(z.p, eingetippt) : ""}</span></small></span>
      <input type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" placeholder="≈ ${zahl(schaetzung, 2)}" value="${eingetippt ? esc(zahl(eingetippt, 2)) : ""}" data-b365="${esc(id)}" data-b365-p="${z.p}" aria-label="Bet365-Quote ${esc(z.text)}">
    </label>`;
}

function pruefKarte(s, index, x, rang) {
  const team = x.team ? teamVon(s, x.team) : null;
  const lohntAb = (1 + KOMBI_MIN_WERT) / x.p;
  const name = x.spieler ? x.spieler.name : x.name || x.titel;
  const was = x.spieler ? x.was : x.was !== name ? x.was : "";
  const urteil = x.eingetippt ? pruefUrteil(x.p, x.quote) : `<span class="leise">geschätzt ≈ ${zahl(x.schaetzung, 2)}</span>`;
  const top = x.eingetippt && x.wert >= TOP_WERT && x.p >= TOP_P;
  const vermutlich = !x.eingetippt && x.gelernt >= 3 && x.wert >= KOMBI_MIN_WERT;
  return `
    <article class="tipp pruef-tipp${top ? " top-tipp" : ""}">
      <div class="tipp-kopf">
        <span class="rang">${rang}</span>
        <div class="was">
          ${top ? `<div class="etikett top">★ Top-Tipp</div>` : x.eingetippt && x.wert >= KOMBI_MIN_WERT ? `<div class="etikett">Lohnt sich</div>` : vermutlich ? `<div class="etikett">Lohnt sich vermutlich</div>` : ""}
          <div class="n">${esc(name)}</div>
          ${was ? `<div class="m">${esc(was)}</div>` : ""}
        </div>
        <div class="chance"><span class="zahl">${prozent(x.p)}</span><small>lohnt ab ${zahl(lohntAb, 2)}</small></div>
      </div>
      <label class="quoten-check">
        <span class="leise klein">Bet365-Quote</span>
        <input type="text" inputmode="decimal" placeholder="${zahl(x.schaetzung, 2)}" value="${x.eingetippt ? esc(zahl(x.quote, 2)) : ""}" data-b365="${s.id}|${esc(x.k)}" data-b365-p="${x.p}">
        <span class="klein" data-b365-urteil="${s.id}|${esc(x.k)}">${urteil}</span>
      </label>
      <div class="tipp-fuss">
        <div class="gruende">${x.eingetippt ? (team ? `<span>${logo(team.id, "logo klein")}${esc(kurzName(team))}</span>` : "")
          : `<button class="link-knopf" data-b365-fehlt="${esc(x.gruppe)}">Gibt's bei Bet365 nicht</button>`}</div>
        ${dazuKnopf(s, x.k, imSchein(s.id, x.k) ? "Auf dem Schein" : "Auf den Schein", "dazu")}
      </div>
    </article>`;
}

function pruefUrteil(p, quote) {
  const wert = p * quote - 1;
  if (wert >= KOMBI_MIN_WERT) return `<span class="gruen">lohnt sich, ${mitVorzeichen(wert * 100)} %</span>`;
  if (wert >= 0) return `<span class="gelb">knapp, ${mitVorzeichen(wert * 100)} %</span>`;
  return `<span class="rot">lohnt nicht, ${mitVorzeichen(wert * 100)} %</span>`;
}

// Worauf die Chance beruht: erwartete Tore, Ecken oder Gelbe beider Teams
function erwartetText(info, markt) {
  const basis = String(markt).split("_")[0];
  const e = (info.erw || {})[basis];
  if (!e) return "";
  const name = { tore: "Tore", ecken: "Ecken", karten: "Gelbe" }[basis];
  return `Erwartet ${zahl(e[0], 1)} zu ${zahl(e[1], 1)} ${name} (${kurzName(info.heim)} zu ${kurzName(info.gast)})`;
}

// Kombi-Pool ohne Quoten-Dienst: Kandidaten aus der Uebersicht mit eingetippter oder geschaetzter Quote
function kombiPoolGeschaetzt(spiele) {
  const pool = [];
  const fehlend = b365Fehlend();
  for (const info of spiele) {
    for (const x of info.kandidaten || []) {
      const markt = x.k.split("|")[0];
      if (!kombiMarktOk(markt)) continue;
      const eingetippt = b365Quote(info.id, x.k);
      if (!eingetippt && fehlend.has(`${info.wettbewerb || ""}|${schaetzGruppe(markt)}`)) continue;
      const quote = eingetippt || schaetzeQuote(markt, x.p).quote;
      if (quote < KOMBI_QUOTE[0] || quote > KOMBI_QUOTE[1]) continue;
      pool.push({ k: x.k, titel: x.t, p: x.p, q: x.q, g: x.g || erwartetText(info, markt), quote, wert: x.p * quote - 1, geschaetzt: !eingetippt,
                  spiel: info.id, anstoss: info.anstoss, heim: kurzName(info.heim), gast: kurzName(info.gast),
                  heimId: info.heim.id, gitter: info.gitter || null });
    }
  }
  return pool;
}

/* -------------------------------------------- Kombi-Vorschlaege und Ziel-Schein */

/* Kombis nur aus Wetten verschiedener Spiele: Dann ist die Bet365-Quote genau das Produkt der
   Einzelquoten und die Chance das Produkt der Einzelchancen. Was im Schnitt zurueckkommt, ist
   das Produkt aus (Chance x Quote) der einzelnen Tipps: Jeder Tipp ohne Wert macht den Schein schlechter. */

const KOMBI_MIN_WERT = 0.05;
let kombiLetzte = { vorschlaege: [], ziel: null, spiel: [] };

function kombiPool() {
  const jetzt = Date.now() / 1000;
  const spiele = (zustand.daten.spiele || []).filter((x) => x.status === "notstarted" && x.anstoss > jetzt + 300 && (x.pool || []).length);
  if (!spiele.length) {
    // Ohne Quoten-Dienst: eingetippte oder geschaetzte Bet365-Quoten
    const mitKandidaten = (zustand.daten.spiele || []).filter((x) => x.status === "notstarted" && x.anstoss > jetzt + 300 && (x.kandidaten || []).length);
    if (!mitKandidaten.length) return { tag: null, tage: [], pool: [] };
    const tage = [...new Set(mitKandidaten.map((x) => tagSchluessel(x.anstoss)))].sort();
    const tag = tage.includes(zustand.kombiTag) ? zustand.kombiTag : tage[0];
    return { tag, tage, pool: kombiPoolGeschaetzt(mitKandidaten.filter((x) => tagSchluessel(x.anstoss) === tag)), geschaetzt: true };
  }
  // heute, sonst der naechste Tag mit Wetten (oder der Tag, den du gewaehlt hast)
  const tage = [...new Set(spiele.map((x) => tagSchluessel(x.anstoss)))].sort();
  const tag = tage.includes(zustand.kombiTag) ? zustand.kombiTag : tage[0];
  const pool = [];
  for (const info of spiele) {
    if (tagSchluessel(info.anstoss) !== tag) continue;
    for (const w of info.pool) {
      if (w.push || !kombiMarktOk(w.k.split("|")[0])) continue;
      pool.push({ ...w, spiel: info.id, anstoss: info.anstoss, heim: kurzName(info.heim), gast: kurzName(info.gast) });
    }
  }
  return { tag, tage, pool };
}

/* Zwei Tipps aus einem Spiel gehen bei Bet365 nur ueber "Wette erstellen" (Bet Builder). Bet365
   rechnet dort selbst, wie eng die Tipps zusammenhaengen. Die App macht das seit 06.11.2026 auch: Fuer
   Tipps, die nur vom Endergebnis abhaengen (Endergebnis, Doppelte Chance, Tore, beide treffen,
   Handicap, zu Null) und fuer Torschuetzen rechnet sie die gemeinsame Chance ueber alle moeglichen
   Endergebnisse. Beispiel: "Bayern gewinnt" und "Kane trifft" gehen oft zusammen auf, die gemeinsame
   Chance ist hoeher als das Produkt, dafuer zahlt Bet365 weniger als das Produkt der Quoten. Ecken gelten
   als unabhaengig von den Toren. Je weiterem Tipp im selben Spiel rechnet die App zusaetzlich 5 % ab
   (Marge von Bet365). Nie zwei Tipps zur selben Sache (zwei Mal Endergebnis, zwei Mal Ecken, zwei
   Mal derselbe Spieler). */
const BB_FAKTOR = 0.95;
const KOMBI_JE_SPIEL = 2;

// Wozu ein Tipp gehoert: zwei Tipps aus einem Spiel duerfen keine Familie teilen
function kombiFamilien(k) {
  const [markt, , richtung, spieler] = k.split("|");
  if (markt.startsWith("torschuetze")) return String(spieler || "").split("+").map((id) => `spieler:${id}`);
  if (markt.startsWith("ecken")) return ["ecken"];
  if (markt.startsWith("karten")) return ["karten"];
  if (markt === "tore_team") return [`teamtore:${k.split("|")[4]}`];
  const f = [];
  if (["tore_ergebnis", "tore_doppelte_chance", "tore_ohne_unentschieden", "tore_europaeisch", "tore_asiatisch",
    "tore_ergebnis_btts", "tore_ergebnis_bereich", "tore_dc_bereich", "tore_genau", "tore_hzend"].includes(markt)
    || (markt === "tore_spezial" && richtung === "zu_null")) f.push("ausgang");
  if (["tore_spiel", "tore_bereich", "tore_ergebnis_bereich", "tore_dc_bereich", "tore_genau", "tore_teambereich"].includes(markt)) f.push("anzahl");
  if (["tore_btts", "tore_ergebnis_btts", "tore_genau"].includes(markt) || (markt === "tore_spezial" && ["zu_null", "weisse_weste"].includes(richtung))) f.push("btts");
  if (/_hz[12]$/.test(markt) || ["tore_hzend", "tore_haelfte"].includes(markt)
    || (markt === "tore_spezial" && !["zu_null", "weisse_weste"].includes(richtung))) f.push("halbzeit");
  return f.length ? f : [markt];
}
const kombiFamilie = (k) => kombiFamilien(k)[0];

// Darf in eine Kombi aus einem Spiel: Bet-Builder-Markt, und bei Team-Spezialwetten nur, was vom
// Endergebnis abhaengt (zu Null, ohne Gegentor). Halbzeit-Wetten haengen eng an den Toren, ohne dass
// die App den Zusammenhang rechnen kann.
function bbOk(k) {
  const [markt, , richtung] = k.split("|");
  if (!(BET365[markt] || {}).bb) return false;
  return markt !== "tore_spezial" || ["zu_null", "weisse_weste"].includes(richtung);
}

function bereichAus(text) {
  const t = String(text || "");
  if (t.endsWith("+")) return [Number(t.slice(0, -1)), Infinity];
  if (t.includes("-")) { const [a, b] = t.split("-").map(Number); return [a, b]; }
  return [Number(t), Number(t)];
}

// Haengt ein Tipp nur vom Endergebnis (i Heimtore, j Gasttore) ab? Dann die Bedingung, sonst null.
function standBedingung(k, heimId) {
  const [markt, linieText, richtung, , teamId] = k.split("|");
  const linie = Number(linieText);
  const ausgang = (i, j) => (i > j ? "heim" : i < j ? "gast" : "unentschieden");
  const dc = { "1x": ["heim", "unentschieden"], 12: ["heim", "gast"], x2: ["unentschieden", "gast"] };
  const heim = String(teamId) === String(heimId);
  switch (markt) {
    case "tore_ergebnis": return (i, j) => ausgang(i, j) === richtung;
    case "tore_doppelte_chance": return (i, j) => (dc[richtung] || []).includes(ausgang(i, j));
    case "tore_spiel":
      if (Math.abs(linie * 2 - Math.round(linie * 2)) > 1e-9 || Number.isInteger(linie)) return null;  // nur halbe Linien
      return richtung === "unter" ? (i, j) => i + j < linie : (i, j) => i + j > linie;
    case "tore_btts": return richtung === "ja" ? (i, j) => i > 0 && j > 0 : (i, j) => !(i > 0 && j > 0);
    case "tore_team":
      if (Number.isInteger(linie) || Math.abs(linie * 2 - Math.round(linie * 2)) > 1e-9) return null;
      return richtung === "unter" ? (i, j) => (heim ? i : j) < linie : (i, j) => (heim ? i : j) > linie;
    case "tore_ergebnis_btts": {
      const [a, b] = richtung.split("+");
      return (i, j) => ausgang(i, j) === a && ((i > 0 && j > 0) === (b === "ja"));
    }
    case "tore_genau": { const [a, b] = richtung.split(":").map(Number); return (i, j) => i === a && j === b; }
    case "tore_bereich": { const [a, b] = bereichAus(richtung); return (i, j) => i + j >= a && i + j <= b; }
    case "tore_teambereich": { const [a, b] = bereichAus(richtung); return (i, j) => (heim ? i : j) >= a && (heim ? i : j) <= b; }
    case "tore_europaeisch": return (i, j) => ausgang(i + linie, j) === richtung;
    case "tore_spezial":
      if (richtung === "weisse_weste") return (i, j) => (heim ? j : i) === 0;
      if (richtung === "zu_null") return (i, j) => (heim ? j : i) === 0 && (heim ? i : j) > 0;
      return null;
    default: return null;
  }
}

// P(alle Spieler in qs treffen | Team schiesst n Tore), jeder Treffer gehoert mit Anteil q dem Spieler
function alleTreffen(qs, n) {
  if (!qs.length) return 1;
  let summe = 0;
  for (let maske = 0; maske < 1 << qs.length; maske++) {
    let anteil = 0;
    let bits = 0;
    qs.forEach((q, i) => { if (maske & (1 << i)) { anteil += q; bits += 1; } });
    summe += (bits % 2 ? -1 : 1) * Math.max(0, 1 - anteil) ** n;
  }
  return Math.max(0, summe);
}

// Gemeinsame Chance von Tipps aus EINEM Spiel: Produkt der gezeigten Chancen mal dem Zusammenhang,
// den das Endergebnis-Gitter zeigt (gemeinsam / Produkt der Einzelchancen im Gitter).
function zusammenhang(beine) {
  const gitter = beine[0].gitter;
  if (!gitter || beine.length < 2) return 1;
  const heimId = beine[0].heimId;
  const teile = [];
  for (const b of beine) {
    const f = standBedingung(b.k, heimId);
    if (f) { teile.push({ f }); continue; }
    const [markt, , , , teamId] = b.k.split("|");
    if (markt === "torschuetze" && b.q > 0) teile.push({ seite: String(teamId) === String(heimId) ? "heim" : "gast", q: b.q });
  }
  if (teile.length < 2) return 1;
  const einzeln = new Array(teile.length).fill(0);
  let gemeinsam = 0;
  let summe = 0;
  gitter.forEach((zeile, i) => zeile.forEach((w, j) => {
    if (!w) return;
    summe += w;
    let alle = w;
    const qsH = [];
    const qsG = [];
    teile.forEach((t, x) => {
      if (t.f) {
        const ja = t.f(i, j) ? 1 : 0;
        einzeln[x] += w * ja;
        alle *= ja;
      } else {
        einzeln[x] += w * (1 - (1 - t.q) ** (t.seite === "heim" ? i : j));
        (t.seite === "heim" ? qsH : qsG).push(t.q);
      }
    });
    if (alle) gemeinsam += alle * alleTreffen(qsH, i) * alleTreffen(qsG, j);
  }));
  if (!summe) return 1;
  const produkt = einzeln.reduce((a, x) => a * (x / summe), 1);
  if (produkt <= 0) return 0;
  return Math.max(0, Math.min(4, (gemeinsam / summe) / produkt));
}

function bbFaktor(beine) {
  const proSpiel = new Map();
  for (const b of beine) proSpiel.set(b.spiel, (proSpiel.get(b.spiel) || 0) + 1);
  let faktor = 1;
  for (const n of proSpiel.values()) faktor *= BB_FAKTOR ** (n - 1);
  return faktor;
}

// Passt ein Tipp noch zu den schon gewaehlten? belegt: Set mit "spiel", "spiel#2", "spiel|f:..", "spiel|s:.."
function kombiPasst(belegt, b, maxJeSpiel = KOMBI_JE_SPIEL) {
  if (!belegt.has(`${b.spiel}`)) return true;
  if (maxJeSpiel < 2 || belegt.has(`${b.spiel}#2`)) return false;
  // im selben Spiel nur, was in "Wette erstellen" geht, und nie zweimal dieselbe Sache
  if (!bbOk(b.k)) return false;
  return !kombiFamilien(b.k).some((f) => belegt.has(`${b.spiel}|f:${f}`));
}

function kombiBelegen(belegt, b) {
  const neu = new Set(belegt);
  neu.add(neu.has(`${b.spiel}`) ? `${b.spiel}#2` : `${b.spiel}`);
  for (const f of kombiFamilien(b.k)) neu.add(`${b.spiel}|f:${f}`);
  if (!bbOk(b.k)) neu.add(`${b.spiel}#2`);  // dazu passt nichts mehr aus diesem Spiel
  return neu;
}

// Waehlt der Reihe nach Tipps: erst je Spiel einer, nur wenn das nicht reicht ein zweiter (Bet Builder)
function beineWaehlen(liste, anzahl, benutzt) {
  const beine = [];
  let belegt = new Set();
  const teamMax = teamBeineMax(anzahl);
  for (const max of [1, KOMBI_JE_SPIEL]) {
    for (const b of liste) {
      if (beine.length === anzahl) break;
      if (beine.includes(b) || (benutzt.get(`${b.spiel}|${b.k}`) || 0) >= 2 || !kombiPasst(belegt, b, max)) continue;
      if (istTeamBein(b) && beine.filter(istTeamBein).length >= teamMax) continue;
      beine.push(b);
      belegt = kombiBelegen(belegt, b);
    }
  }
  return beine.length === anzahl ? beine : null;
}

// Chance und Quote einer Kombi: Tipps aus verschiedenen Spielen unabhaengig, aus einem Spiel mit
// Zusammenhang (siehe oben). Bet365 preist den Zusammenhang selbst ein: Gehen die Tipps oft zusammen
// auf, zahlt der Bet Builder weniger als das Produkt. Darum bleibt "im Schnitt zurueck" beim Produkt.
function kombiDaten(beine) {
  const faktor = bbFaktor(beine);
  const jeSpiel = new Map();
  for (const b of beine) {
    if (!jeSpiel.has(b.spiel)) jeSpiel.set(b.spiel, []);
    jeSpiel.get(b.spiel).push(b);
  }
  let zh = 1;
  for (const liste of jeSpiel.values()) if (liste.length > 1) zh *= zusammenhang(liste);
  const p = Math.min(0.999, beine.reduce((a, b) => a * b.p, 1) * zh);
  const quote = Math.max(1.01, beine.reduce((a, b) => a * b.quote, 1) * faktor / Math.max(0.25, zh));
  const zurueck = p * quote;
  const spiele = jeSpiel.size;
  return { beine, quote, p, zurueck, spiele, bb: spiele < beine.length, zusammenhang: zh };
}

function kombiVorschlaege(pool, geschaetzt = false) {
  // Mit geschaetzten Quoten gibt es selten echten Wert: dann die besten verfuegbaren Tipps, ehrlich markiert
  const kandidaten = pool.filter((b) => b.wert >= (geschaetzt ? -0.3 : KOMBI_MIN_WERT) && b.p >= 0.35);
  const wertung = (b) => b.wert * (0.6 + b.p);
  const ideen = [
    { name: "Sicherer Zweier", anzahl: 2, sortierung: (a, b) => b.p - a.p },
    { name: "Dreier", anzahl: 3, sortierung: (a, b) => wertung(b) - wertung(a) },
    { name: "Vierer", anzahl: 4, sortierung: (a, b) => wertung(b) - wertung(a) },
    { name: "Sicherer Dreier", anzahl: 3, sortierung: (a, b) => b.p - a.p },
    { name: "Mutiger Dreier", anzahl: 3, filter: (b) => b.quote >= 1.8, sortierung: (a, b) => wertung(b) - wertung(a) },
  ];
  const vorschlaege = [];
  const gesehen = new Set();
  const benutzt = new Map();   // ein Tipp in hoechstens zwei Vorschlaegen, damit sie sich unterscheiden
  for (const idee of ideen) {
    const liste = kandidaten.filter(idee.filter || (() => true)).sort(idee.sortierung);
    const beine = beineWaehlen(liste, idee.anzahl, benutzt);
    if (!beine) continue;
    const schluessel = beine.map((b) => `${b.spiel}|${b.k}`).sort().join(",");
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    for (const b of beine) benutzt.set(`${b.spiel}|${b.k}`, (benutzt.get(`${b.spiel}|${b.k}`) || 0) + 1);
    vorschlaege.push({ name: idee.name, ...kombiDaten(beine) });
  }
  return vorschlaege;
}

// Sucht Tipps, deren Gesamtquote nah am Ziel liegt (plus/minus 8 %), und nimmt davon die
// Kombination, bei der im Schnitt am meisten zurueckkommt. Aus einem Spiel hoechstens zwei Tipps.
function zielSchein(pool, ziel, geschaetzt = false) {
  const zielLog = Math.log(ziel);
  const toleranz = Math.log(1.08);
  const kandidaten = pool.filter((b) => b.wert >= (geschaetzt ? -0.3 : -0.04) && b.p >= 0.3).sort((a, b) => b.wert - a.wert);
  let zustaende = [{ beine: [], belegt: new Set(), logq: 0, logev: 0, team: 0 }];
  const bb = Math.log(BB_FAKTOR);
  for (const b of kandidaten) {
    const lq = Math.log(b.quote);
    const lev = Math.log(1 + b.wert);
    const team = istTeamBein(b) ? 1 : 0;
    const neu = [];
    for (const z of zustaende) {
      if (z.beine.length >= 10 || z.team + team > 3 || !kombiPasst(z.belegt, b)) continue;
      const extra = z.belegt.has(`${b.spiel}`) ? bb : 0;
      if (z.logq + lq + extra > zielLog + toleranz) continue;
      neu.push({ beine: [...z.beine, b], belegt: kombiBelegen(z.belegt, b), logq: z.logq + lq + extra, logev: z.logev + lev + extra, team: z.team + team });
    }
    // Je Quotenstufe (und Zahl der Ecken-/Karten-Tipps) nur die besten behalten, sonst wird es zu viel
    const eimer = new Map();
    for (const z of zustaende.concat(neu)) {
      const stufe = `${Math.round(z.logq / 0.03)}|${z.team}`;
      const alt = eimer.get(stufe);
      if (!alt || z.logev > alt.logev + 1e-9 || (Math.abs(z.logev - alt.logev) < 1e-9 && z.beine.length < alt.beine.length)) eimer.set(stufe, z);
    }
    zustaende = [...eimer.values()];
  }
  // hoechstens ein Ecken- oder Karten-Tipp, ab sechs Tipps zwei
  const erlaubt = zustaende.filter((z) => z.beine.length && z.team <= teamBeineMax(z.beine.length));
  const passend = erlaubt.filter((z) => Math.abs(z.logq - zielLog) <= toleranz);
  if (passend.length) {
    passend.sort((a, b) => b.logev - a.logev || a.beine.length - b.beine.length);
    return { erreicht: true, ...kombiDaten(passend[0].beine) };
  }
  const beste = erlaubt.sort((a, b) => b.logq - a.logq)[0];
  return beste ? { erreicht: false, ...kombiDaten(beste.beine) } : null;
}

function kombiKarte(k, index, einsatz, art, ohneSpiel = false) {
  const auszahlung = einsatz * k.quote;
  const imSchnitt = einsatz * k.zurueck;
  const n = Math.max(1, Math.round(1 / k.p));
  return `
    <article class="kombi-karte">
      <div class="kombi-kopf">
        <div><div class="etikett">${esc(k.name || "Ziel-Schein")}</div><div class="leise klein">${k.beine.length === 1 ? "1 Tipp" : `${k.beine.length} Tipps aus ${k.spiele === 1 ? "1 Spiel" : `${k.spiele} Spielen`}`}</div></div>
        <div class="kombi-zahlen"><span class="zahl">${k.beine.some((b) => b.geschaetzt) ? "≈ " : ""}${zahl(k.quote, 2)}</span><small>${k.beine.some((b) => b.geschaetzt) ? "Bet365 geschätzt" : "Bet365 gesamt"}</small></div>
      </div>
      <ul class="kombi-beine">${k.beine.map((b) => `
        <li><span><span class="n">${esc(b.titel)}</span>${ohneSpiel ? "" : `<span class="leise klein">${esc(b.heim)} gegen ${esc(b.gast)}, ${uhr(b.anstoss)}</span>`}</span><span class="leise klein">${b.geschaetzt ? "≈ " : ""}${zahl(b.quote, 2)} · ${prozent(b.p)}</span></li>`).join("")}</ul>
      ${k.bb && !ohneSpiel ? `<p class="fussnote kombi-bb">Mehrere Tipps aus einem Spiel: bei Bet365 über „Wette erstellen“. Die App rechnet ein, wie eng die Tipps zusammenhängen, und schätzt die Quote. Trag im Schein die echte Quote ein.</p>` : ""}
      <div class="kombi-fuss">
        <span>Chance <strong>${prozent(k.p)}</strong>${k.p < 0.5 ? ` <span class="leise">(etwa 1 von ${n})</span>` : ""}</span>
        <span>${zahl(einsatz, 2)} € werden <strong>${zahl(auszahlung, 2)} €</strong></span>
        <span class="${k.zurueck >= 1 ? "gruen" : "rot"}">Im Schnitt zurück: ${zahl(imSchnitt, 2)} €</span>
      </div>
      <button class="dazu" data-kombi-uebernehmen="${art}:${index}">Als Schein übernehmen</button>
    </article>`;
}

function vorschlaegeHtml() {
  const { tag, tage, pool, geschaetzt } = kombiPool();
  const einsatz = einsatzLesen(scheinLesen().einsatz);
  let html = `<section class="abschnitt"><h2>Kombi-Vorschläge</h2>`;
  if (tage && tage.length > 1) {
    const heuteS = tagSchluessel(Date.now() / 1000);
    const morgenS = tagSchluessel(Date.now() / 1000 + 86400);
    const name = (t) => (t === heuteS ? "Heute" : t === morgenS ? "Morgen" : fmtTagLang.format(mittag(t)));
    html += `<div class="wahl klein-wahl" role="group" aria-label="Tag">${tage.map((t) => `<button data-kombi-tag="${t}" aria-pressed="${t === tag}">${esc(name(t))}</button>`).join("")}</div>`;
  }
  if (!pool.length) {
    html += `<p class="leer">Gerade stehen keine Spiele mit genug Daten für Kombi-Vorschläge an.</p></section>`;
    return html + zielHtml(null, []);
  }
  const heute = tagSchluessel(Date.now() / 1000);
  const wann = tag === heute ? "heute" : `für ${fmtTagLang.format(mittag(tag))}`;
  const vorschlaege = kombiVorschlaege(pool, geschaetzt);
  kombiLetzte.vorschlaege = vorschlaege;
  const anzahlSpiele = new Set(pool.map((b) => b.spiel)).size;
  const spieleText = anzahlSpiele < 4
    ? ` (${tag === heute ? "heute laufen nur noch" : "an diesem Tag gibt es nur"} ${anzahlSpiele === 1 ? "1 Spiel" : `${anzahlSpiele} Spiele`} mit Analyse, darum auch zwei Tipps aus einem Spiel)`
    : ", möglichst jeder Tipp aus einem anderen Spiel";
  if (!vorschlaege.length) {
    html += `<p class="leer">${tag === heute ? "Heute" : "An diesem Tag"} gibt es zu wenige passende Tipps für eine Kombi. Lieber einzeln spielen oder auf morgen warten.</p>`;
  } else {
    html += geschaetzt
      ? `<p>Aus den besten Tipps ${wann}${spieleText}. Die Bet365-Quoten sind <strong>geschätzt</strong> (≈), außer du hast sie schon eingetippt. Übernimm einen Schein und trag im Schein die echten Quoten ein, dann rechnet die App genau. „Im Schnitt zurück“ ist, was bei vielen solchen Scheinen pro Schein herauskommt.</p>`
      : `<p>Aus den Tipps mit Wert ${wann}${spieleText}. „Im Schnitt zurück“ ist, was bei vielen solchen Scheinen pro Schein herauskommt. Liegt es über dem Einsatz, lohnt sich der Schein nach unserer Rechnung.</p>`;
    html += vorschlaege.map((k, i) => kombiKarte(k, i, einsatz, "v")).join("");
  }
  html += `</section>`;
  return html + zielHtml(tag, pool);
}

function zielHtml(tag, pool) {
  const z = zustand.zielSchein || { einsatz: "5", ziel: "100" };
  let html = `
    <section class="abschnitt">
      <h2>Ziel-Schein</h2>
      <p>Sag, wie viel du setzen und wie viel du rausbekommen willst. Die App sucht dafür Tipps zusammen, bei denen Bet365 möglichst viel zahlt, höchstens zwei aus einem Spiel.</p>
      <form class="ziel-form" data-ziel-form="1">
        <label><span class="leise klein">Einsatz</span><span class="mit-einheit"><input class="feld" type="text" inputmode="decimal" id="ziel-einsatz" value="${esc(z.einsatz)}"><span>€</span></span></label>
        <label><span class="leise klein">Ziel</span><span class="mit-einheit"><input class="feld" type="text" inputmode="decimal" id="ziel-betrag" value="${esc(z.ziel)}"><span>€</span></span></label>
        <button class="knopf" type="submit"${pool.length ? "" : " disabled"}>Schein suchen</button>
      </form>`;
  const ergebnis = kombiLetzte.ziel;
  if (ergebnis && ergebnis.fehler) {
    html += `<p class="leer">${esc(ergebnis.fehler)}</p>`;
  } else if (ergebnis && ergebnis.kombi) {
    const k = ergebnis.kombi;
    if (!k.erreicht) {
      const wenige = new Set(pool.map((b) => b.spiel)).size;
      html += `<p class="leer">Mit den Tipps ${tag === tagSchluessel(Date.now() / 1000) ? "von heute" : "dieses Tages"} geht höchstens eine Quote von ${zahl(k.quote, 2)}. Das ist der Schein, der am nächsten drankommt.${wenige < 4 ? ` Es laufen nur ${wenige === 1 ? "1 Spiel" : `${wenige} Spiele`} mit Analyse. Für ein höheres Ziel nimm einen anderen Tag oder ein kleineres Ziel.` : ""}</p>`;
    }
    html += kombiKarte({ ...k, name: `Ziel ${zahl(ergebnis.ziel, 0)} €` }, 0, ergebnis.einsatz, "z");
    const verlust = k.zurueck < 1;
    html += `<p class="fussnote">${verlust
      ? `Ehrlich: Dieser Schein kostet dich im Schnitt ${zahl(ergebnis.einsatz * (1 - k.zurueck), 2)} € pro Versuch, weil nicht genug Tipps mit Wert dabei sind. Je höher das Ziel, desto mehr Tipps braucht es und desto mehr frisst die Marge von Bet365.`
      : `Nach unserer Rechnung lohnt sich dieser Schein im Schnitt. Er geht trotzdem nur etwa 1 von ${Math.max(1, Math.round(1 / k.p))} Mal durch, also nur mit Geld spielen, dessen Verlust dir nichts ausmacht.`}</p>`;
  }
  return html + `</section>`;
}

function kombiAlsSchein(kombi, einsatz) {
  const schein = scheinLesen();
  if (einsatz > 0) schein.einsatz = String(einsatz).replace(".", ",");
  schein.tipps = kombi.beine.map((b) => ({
    spiel: b.spiel, k: b.k, titel: b.titel, p: b.p, pModell: b.p, markt: b.k.split("|")[0], anstoss: b.anstoss, q: b.q,
    heim: b.heim, gast: b.gast, quote: b.geschaetzt ? "" : zahl(b.quote, 2), bet365: !b.geschaetzt && !b.eigen,
    schaetzung: b.geschaetzt ? Math.round(b.quote * 100) / 100 : null,
  }));
  schein.gesamt = "";
  scheinSchreiben(schein);
}

/* ----------------------------------------- Kombis aus einem Spiel (Bet Builder) */

/* Die besten Kombis aus einem einzigen Spiel: 2 bis 6 Tipps, auf Wunsch nah an einer Quote.
   Bei gleicher Quote ist die Kombi mit der hoechsten Chance auch die, bei der im Schnitt am
   meisten zurueckkommt. Was zu eng zusammenhaengt, kommt nie zusammen: Team- und Spielwetten
   nie aus derselben Familie (Sieger und Tore, Ecken und Ecken), nie zwei Tipps zum selben
   Spieler, hoechstens zwei Torschuetzen. Anzahl 0 heisst "egal": Die App sucht selbst, mit wie
   vielen Tipps die Wunschquote die hoechste Chance hat. */
const SPIEL_KOMBI_P = [0.35, 0.93];
// Mit Wunschquote nur Tipps, die mindestens jedes zweite Mal aufgehen (Marcel, 07.11.2026: "nicht wuerfeln",
// lieber mehr sichere Tipps). Bei langen Tipps liegt unsere Chance oft ueber der von Bet365, die geschaetzte
// Quote ist dann zu niedrig (Beispiel: geschaetzt 18, bei Bet365 29). Bei sicheren Tipps passt es viel besser.
const SPIEL_KOMBI_P_ZIEL = 0.5;
const SPIEL_KOMBI_P_TOR = 0.4;                  // Torschuetzen fuer "Mit Torschuetze": nur die Top-Stuermer
const SPIEL_KOMBI_SICHER = 0.5;                 // Gewicht: bei gleicher Quote gewinnt der sicherste schwaechste Tipp
const SPIEL_KOMBI_MAX = 10;
const SPIEL_KOMBI_TOLERANZ = Math.log(1.12);   // Wunschquote plus/minus 12 %
const SPIEL_KOMBI_NAECHSTE = Math.log(4);      // nichts in diesem Bereich: das, was am naechsten kommt
const SPIEL_KOMBI_MIN_QUOTE = 1.25;             // "Sicher" ohne Wunschquote: keine Mini-Quoten
const SPIEL_KOMBI_MIN_BEIN = 1.2;               // jeder Tipp muss etwas bringen: Ein Tipp zu 1,05
                                                // kostet Chance, hebt die Quote nach Bet-Builder-Abschlag aber kaum
const SPIEL_KOMBI_HEBT = Math.log(1.1);        // und muss die Gesamtquote spuerbar heben (sonst haengt er fast
                                                // ganz an den anderen, zum Beispiel "trifft" neben "gewinnt zu Null")

function spielKombiBeine(s, pMin = SPIEL_KOMBI_P[0], pTor = 0.2) {
  const liga = s.wettbewerb || "";
  const fehlend = b365Fehlend();
  const beine = [];
  for (const t of tippIndex(s).values()) {
    const tor = t.markt === "torschuetze";
    if (t.push || !(t.p >= (tor ? pTor : pMin) && t.p <= SPIEL_KOMBI_P[1])) continue;
    if (!bbOk(t.k) || !kombiMarktOk(t.markt) || fehlend.has(`${liga}|${schaetzGruppe(t.markt)}`)) continue;
    if (t.art === "spieler" && (!t.spieler || t.spieler.min < 60 || t.spieler.hinweis || t.spieler.startelf === false)) continue;
    const eingetippt = b365Quote(s.id, t.k);
    const quote = eingetippt || t.quote || schaetzeQuote(t.markt, t.p).quote;
    if (!(quote >= 1.04 && quote <= 8)) continue;
    beine.push({
      k: t.k, titel: t.titel || t.was, p: t.p, q: t.q, quote, wert: t.p * quote - 1, geschaetzt: !eingetippt && !t.quote,
      spiel: s.id, anstoss: s.anstoss, heim: kurzName(s.heim), gast: kurzName(s.gast), heimId: s.heim.id,
      gitter: (s.prognose || {}).gitter || null,
      familien: kombiFamilien(t.k), spieler: t.art === "spieler" && t.spieler ? String(t.spieler.id) : "",
    });
  }
  return beine;
}

// Nie zwei Tipps zur selben Sache, hoechstens zwei Torschuetzen
function spielKombiPasst(gewaehlt, b) {
  if (b.spieler && gewaehlt.filter((x) => x.spieler).length >= 2) return false;
  return !gewaehlt.some((x) => x.familien.some((f) => b.familien.includes(f)));
}

// Strahlsuche: Die Kombi waechst Tipp fuer Tipp. Nach jedem Schritt bleiben je Quotenstufe nur die
// Kombis mit der hoechsten Chance (mit und ohne Torschuetze getrennt), so bleibt es auch mit 6 Tipps
// schnell. Chance und Quote rechnet bei jedem Schritt kombiDaten, also mit dem Zusammenhang ueber das
// Endergebnis. Ohne Wunschquote nach Chance sortiert, mit Wunschquote nach dem, was im Schnitt
// zurueckkommt, etwas abgezogen, wenn die Quote vom Wunsch abweicht oder die Tipps sehr ungleich sind
// (zwei Mini-Quoten und ein Ausreisser).
const SPIEL_KOMBI_STUFE = 0.06;   // Quotenstufe: etwa 6 %
// Schliessen sich die Tipps fast aus (gemeinsam weniger als halb so oft wie unabhaengig), ist die Kombi
// eigentlich ein genaues Ergebnis ("unter 2,5 Tore" und "Gast trifft zweimal" heisst 0:2). Solche Quoten
// rechnet Bet365 mit eigener Marge, die Schaetzung waere unzuverlaessig: nicht vorschlagen.
const SPIEL_KOMBI_ZH_MIN = 0.5;

function spielKombiStrahl(alle, ziel, nVon, nBis, minQuote = SPIEL_KOMBI_MIN_BEIN, toleranz = SPIEL_KOMBI_TOLERANZ) {
  const zielLog = ziel ? Math.log(ziel) : null;
  const obenLog = zielLog == null ? Infinity : zielLog + toleranz;
  const bbLog = Math.log(BB_FAKTOR);
  // Kandidaten: je Quotenstufe die besten fuer ihre Quote (Chance x Quote), Torschuetzen getrennt,
  // sonst stehen vorne nur kurze Quoten oder nur eine Sorte
  const stufen = new Map();
  for (const b of alle) {
    if (b.quote < minQuote || Math.log(b.quote) > obenLog) continue;
    const st = `${b.spieler ? "s" : "t"}${Math.round(Math.log(b.quote) / 0.1)}`;
    if (!stufen.has(st)) stufen.set(st, []);
    stufen.get(st).push(b);
  }
  // ohne Wunschquote zaehlt nur die Chance: die sichersten Tipps, egal welche Quote
  const nachP = (liste) => liste.sort((a, b) => b.p - a.p);
  const kand = zielLog == null
    ? [...nachP(alle.filter((b) => b.spieler && b.quote >= minQuote)).slice(0, 8), ...nachP(alle.filter((b) => !b.spieler && b.quote >= minQuote)).slice(0, 34)]
    : [...stufen.entries()].flatMap(([st, liste]) => liste
      .sort((a, b) => b.p * b.quote - a.p * a.quote || b.p - a.p)
      .slice(0, st[0] === "s" ? 3 : 7));
  const jeStufe = zielLog == null ? 8 : 4;
  let ebene = kand.map((b, i) => ({ beine: [b], i, k: kombiDaten([b]), lq: Math.log(b.quote), s: b.spieler ? 1 : 0 }));
  const treffer = [];
  for (let n = 2; n <= nBis && ebene.length; n++) {
    const neu = [];
    for (const z of ebene) {
      for (let i = z.i + 1; i < kand.length; i++) {
        const b = kand[i];
        // grosszuegig abschneiden: der Zusammenhang kann die Quote noch deutlich senken
        if (z.lq + Math.log(b.quote) + bbLog > obenLog + Math.log(2.5)) continue;
        if (!spielKombiPasst(z.beine, b)) continue;
        const beine = [...z.beine, b];
        const k = kombiDaten(beine);
        const lq = Math.log(k.quote);
        if (lq > obenLog || lq < z.lq + SPIEL_KOMBI_HEBT || k.zusammenhang < SPIEL_KOMBI_ZH_MIN) continue;
        neu.push({ beine, i, k, lq, s: z.s + (b.spieler ? 1 : 0) });
      }
    }
    if (n >= nVon) {
      for (const z of neu) if (zielLog == null || Math.abs(z.lq - zielLog) <= toleranz) treffer.push(z);
    }
    const eimer = new Map();
    for (const z of neu) {
      const key = `${Math.round(z.lq / SPIEL_KOMBI_STUFE)}|${Math.min(1, z.s)}`;
      if (!eimer.has(key)) eimer.set(key, []);
      eimer.get(key).push(z);
    }
    ebene = [...eimer.values()].flatMap((l) => l.sort((a, b) => b.k.p - a.k.p).slice(0, jeStufe));
  }
  for (const t of treffer) {
    const logs = t.beine.map((b) => Math.log(b.quote));
    const spanne = Math.max(...logs) - Math.min(...logs);
    t.p = t.k.p;
    t.ev = t.k.zurueck;
    t.minP = Math.min(...t.beine.map((b) => b.p));
    t.wertung = t.k.zurueck - 0.15 * spanne - (zielLog == null ? 0 : 0.3 * Math.abs(t.lq - zielLog) - SPIEL_KOMBI_SICHER * (t.minP - 0.55));
  }
  return treffer.sort(zielLog == null ? (a, b) => b.p - a.p : (a, b) => b.wertung - a.wertung);
}

// Bis zu drei Kombis, die sich in den Tipps unterscheiden (gemeinsam hoechstens Anzahl minus 2, mindestens 1)
function spielKombiAuswahl(treffer, schon = [], max = 3) {
  const auswahl = [];
  for (const t of treffer) {
    if (auswahl.length >= max) break;
    const zuNah = [...schon, ...auswahl].some((a) => a.beine.filter((b) => t.beine.includes(b)).length
      > Math.max(1, Math.min(a.beine.length, t.beine.length) - 2));
    if (!zuNah) auswahl.push(t);
  }
  return auswahl;
}

// anzahl: 2 bis 6, oder 0 fuer "egal". Rueckgabe: { kombis, naechste } (naechste: die Wunschquote
// selbst gibt es nicht, das sind die, die am naechsten kommen)
function spielKombisSuchen(s, anzahl, ziel) {
  const [nVon, nBis] = anzahl ? [anzahl, anzahl] : [2, SPIEL_KOMBI_MAX];
  const alle = ziel ? spielKombiBeine(s, SPIEL_KOMBI_P_ZIEL, SPIEL_KOMBI_P_ZIEL) : spielKombiBeine(s);
  let ergebnis;
  let naechste = false;
  if (ziel) {
    let treffer = spielKombiStrahl(alle, ziel, nVon, nBis);
    if (!treffer.length) {
      treffer = spielKombiStrahl(alle, ziel, nVon, nBis, SPIEL_KOMBI_MIN_BEIN, SPIEL_KOMBI_NAECHSTE);
      // am naechsten am Wunsch zuerst
      treffer.sort((a, b) => Math.abs(a.lq - Math.log(ziel)) - Math.abs(b.lq - Math.log(ziel)) || b.wertung - a.wertung);
      naechste = treffer.length > 0;
    }
    ergebnis = spielKombiAuswahl(treffer).map((t, i) => ({ name: naechste ? `Am nächsten ${i + 1}` : `Platz ${i + 1}`, ...kombiDaten(t.beine) }));
  } else {
    // Ohne Wunschquote: sicher, mittel und mit mehr Quote (bei "egal" die sichere als 2er)
    const sicher = spielKombiStrahl(alle, null, anzahl || 2, anzahl || 2, SPIEL_KOMBI_MIN_QUOTE)[0];
    if (!sicher) return { kombis: [], naechste };
    ergebnis = [{ name: "Sicher", ...kombiDaten(sicher.beine) }];
    const basis = ergebnis[0].quote;
    for (const [name, faktor] of [["Mittel", 1.6], ["Mehr Quote", 2.6]]) {
      const t = spielKombiAuswahl(spielKombiStrahl(alle, basis * faktor, nVon, nBis), ergebnis, 1)[0];
      if (t) ergebnis.push({ name, ...kombiDaten(t.beine) });
    }
  }
  // Torschuetzen haben bei Bet365 mehr Marge und landen darum selten vorne. Ist keiner dabei, gibt es
  // zusaetzlich die beste Kombi mit Torschuetze (der Klassiker: Team gewinnt und sein Stuermer trifft).
  const mitTorBeine = ziel ? spielKombiBeine(s, SPIEL_KOMBI_P_ZIEL, SPIEL_KOMBI_P_TOR) : alle;
  if (!naechste && mitTorBeine.some((b) => b.spieler) && !ergebnis.some((k) => k.beine.some((b) => b.spieler))) {
    const mitTor = (liste) => liste.find((t) => t.beine.some((b) => b.spieler));
    const zielQuote = ziel || Math.max(2.5, (ergebnis[1] || ergebnis[0] || { quote: 3 }).quote);
    const t = mitTor(spielKombiStrahl(mitTorBeine, zielQuote, nVon, nBis)) || (!ziel && mitTor(spielKombiStrahl(mitTorBeine, null, nVon, Math.min(nBis, 4))));
    if (t) ergebnis.push({ name: "Mit Torschütze", ...kombiDaten(t.beine) });
  }
  return { kombis: ergebnis, naechste };
}

function spielKombiAbschnitt(s) {
  if (s.status !== "notstarted") return "";
  return `<section class="abschnitt" id="spiel-kombis">${spielKombiInhalt(s)}</section>`;
}

const SPIEL_KOMBI_ANZAHLEN = [[0, "Egal"], ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, String(n)])];

function spielKombiInhalt(s) {
  const wahl = zustand.spielKombi;
  const ziel = quoteLesen(wahl.quote);
  const { kombis, naechste } = spielKombisSuchen(s, wahl.anzahl, ziel);
  kombiLetzte.spiel = kombis;
  const einsatz = einsatzLesen(scheinLesen().einsatz);
  const geschaetzt = kombis.some((k) => k.beine.some((b) => b.geschaetzt));
  const wieViele = wahl.anzahl ? `${wahl.anzahl}er-Kombi` : "Kombi";
  let html = `<h2>Kombis für dieses Spiel</h2>
    <p>Mehrere Tipps aus diesem Spiel auf einem Schein, bei Bet365 über „Wette erstellen“. Gib eine Wunschquote ein, zum Beispiel 18: Die App nimmt dann nur Tipps, die mindestens jedes zweite Mal aufgehen, und sucht damit die Kombi rund um diese Quote, bei der auch der schwächste Tipp möglichst sicher ist. Bei „Egal“ entscheidet sie selbst, wie viele Tipps (bis 10). Ohne Wunschquote zeigt sie eine sichere, eine mittlere und eine Kombi mit mehr Quote.</p>
    <form class="ziel-form spiel-kombi-form" data-spiel-kombi-form="1">
      <label><span class="leise klein">Wunschquote</span><input class="feld" type="text" inputmode="decimal" id="spiel-kombi-quote" placeholder="egal" value="${esc(wahl.quote || "")}"></label>
      <button class="knopf" type="submit">Kombis suchen</button>
    </form>
    <div class="spiel-kombi-anzahl"><span class="leise klein">Tipps</span>
      <div class="wahl klein-wahl" role="group" aria-label="Anzahl Tipps">${SPIEL_KOMBI_ANZAHLEN.map(([n, text]) => `<button data-spiel-kombi-anzahl="${n}" aria-pressed="${n === wahl.anzahl}">${text}</button>`).join("")}</div>
    </div>`;
  if (!kombis.length) {
    html += `<p class="leer">${ziel ? `Für eine ${wieViele} um ${zahl(ziel, 2)} mit sicheren Tipps gibt es in diesem Spiel nichts Passendes${wahl.anzahl ? ". Probier „Egal“ oder eine andere Anzahl" : ". Probier eine andere Quote"}.` : "Für dieses Spiel gibt es zu wenige passende Tipps."}</p>`;
  } else {
    if (naechste) {
      const hoechste = Math.max(...kombis.map((k) => k.quote));
      html += `<p class="hinweis-box klein">${hoechste < ziel
        ? `Mit sicheren Tipps (jeder mindestens 50 %) kommt man in diesem Spiel nur auf etwa ${zahl(hoechste, 1)}. Für ${zahl(ziel, 0)} bräuchte es Würfel-Tipps. Besser: ein zweites Spiel dazunehmen, im Schein unter „Wunschquote“ sucht die App über alle Spiele.`
        : `Genau ${zahl(ziel, 2)} gibt es mit ${wahl.anzahl ? `${wahl.anzahl} sicheren Tipps` : "sicheren Tipps"} nicht. Das kommt am nächsten dran.`}</p>`;
    }
    html += kombis.map((k, i) => kombiKarte(k, i, einsatz, "s", true)).join("");
  }
  html += `<p class="fussnote">Nur Märkte, die es bei Bet365 unter „Wette erstellen“ gibt: Torschützen, Endergebnis, Doppelte Chance, Tore, Team-Tore, beide treffen, zu Null, Ecken und Gelbe Karten. Die Chance rechnet die App über alle möglichen Endergebnisse, so zählt zum Beispiel mit, dass „Team gewinnt“ und „sein Stürmer trifft“ oft zusammen aufgehen. Bei gleicher Quote haben weniger Tipps meist die höhere Chance, weil Bet365 auf jeden Tipp Marge nimmt. Die Quote rechnet Bet365 selbst${geschaetzt ? ", mit ≈ markierte Quoten sind geschätzt" : ""}. Trag im Schein die echte Quote ein. Zweimal dieselbe Sache (zwei Mal Endergebnis, zwei Mal Ecken) kommt nie zusammen.</p>`;
  return html;
}

function spielKombiNeu() {
  const s = aktuellesSpiel();
  const block = document.getElementById("spiel-kombis");
  if (s && block) block.innerHTML = spielKombiInhalt(s);
}

function zeigeSchein() {
  const schein = scheinAktuell();
  let html = `
    <header class="kopf">
      <button class="rund" data-aktion="zurueck" aria-label="Zurück">${ICON_ZURUECK}</button>
      <h1>Schein</h1>
      <span style="width:44px" aria-hidden="true"></span>
    </header>`;
  if (!schein.tipps.length) {
    html += `<p class="leer">Der Schein ist leer. Nimm einen Vorschlag unten oder öffne ein Spiel und tippe bei den Tipps auf „Auf den Schein“.</p>`;
    app.innerHTML = html + vorschlaegeHtml() + fuss();
    return;
  }
  html += `<section class="abschnitt"><p style="margin-top:8px">Die Chancen werden multipliziert. Für jeden Tipp kannst du die Einzelquote von Bet365 eintragen, um zu sehen, welcher Tipp sich lohnt.</p><div class="schein-liste">`;
  schein.tipps.forEach((t, i) => {
    const q = quoteLesen(t.quote);
    const wert = q ? t.p * q - 1 : null;
    html += `
      <div class="schein-tipp">
        <div class="oben-zeile">
          <div>
            <div class="n">${esc(t.titel)}</div>
            <div class="leise klein">${esc(t.heim)} gegen ${esc(t.gast)}, ${esc(fmtKurz.format(new Date(t.anstoss * 1000)))} ${uhr(t.anstoss)}${t.begonnen ? ", begonnen" : ""}</div>
          </div>
          <button class="weg" data-weg="${i}" aria-label="Tipp entfernen">×</button>
        </div>
        <div class="unten-zeile">
          <span><span class="zahl">${prozent(t.p)}</span> <span class="leise klein">fair ${fair(t.p)}</span></span>
          <label class="quote-feld">
            <span class="leise klein">Bet365</span>
            <input type="text" inputmode="decimal" placeholder="${t.schaetzung ? `≈ ${zahl(t.schaetzung, 2)}` : "Quote"}" value="${esc(t.quote || "")}" data-quote="${i}" aria-label="Einzelquote ${esc(t.titel)}">
          </label>
        </div>
        <div class="einzel-wert klein" data-einzel="${i}">${einzelWertText(wert)}</div>
      </div>`;
  });
  html += `</div>`;

  const warnungen = [];
  const proSpiel = {};
  for (const t of schein.tipps) proSpiel[t.spiel] = (proSpiel[t.spiel] || 0) + 1;
  if (Object.values(proSpiel).some((n) => n > 1)) {
    warnungen.push("Mehrere Tipps aus demselben Spiel gehen bei Bet365 nur über „Wette erstellen“, mit eigener Quote. Die App rechnet bei Endergebnis, Toren und Torschützen ein, wie eng die Tipps zusammenhängen, und schätzt die Quote daraus. Trag die echte Gesamtquote ein, dann rechnet sie genau.");
  }
  if (schein.tipps.some((t) => !bet365Ok(t.markt))) {
    warnungen.push("Der Schein enthält einen alten Tipp aus einem Markt, den es bei Bet365 nicht gibt (zum Beispiel Schüsse oder Fouls). Den lieber vom Schein nehmen.");
  }
  const auswertung = scheinAuswertung(schein);
  if (auswertung.wert != null && auswertung.wert > 0.3) {
    warnungen.push("Ungewöhnlich großer Vorsprung gegenüber Bet365. Das heißt meistens, dass der Buchmacher etwas weiß, was das Modell nicht weiß (Aufstellung, Verletzung, Rolle im Spiel). Lieber zweimal prüfen.");
  }
  const offen = schein.tipps.filter((t) => !t.begonnen && !t.bestaetigt).length;
  if (offen) warnungen.push(`Bei ${offen === 1 ? "einem Tipp" : `${offen} Tipps`} steht die Aufstellung noch nicht fest. Kurz vor Anpfiff neu laden, die Werte ändern sich dann.`);
  if (schein.tipps.length > 4) warnungen.push("Mit jedem weiteren Tipp sinkt die Chance, und die Marge des Buchmachers steckt in jeder Einzelquote.");
  if (schein.tipps.some((t) => t.begonnen)) warnungen.push("Mindestens ein Spiel hat schon begonnen. Die Werte sind von vor dem Anpfiff.");

  html += `
      <label class="gesamt-feld">
        <span>Gesamtquote bei Bet365</span>
        <input class="feld" type="text" inputmode="decimal" placeholder="zum Beispiel 3,50" value="${esc(schein.gesamt || "")}" data-gesamt="1">
      </label>
      <div class="gesamt-feld">
        <span>Einsatz</span>
        <div class="einsatz-reihe">
          ${EINSAETZE.map((b) => `<button class="einsatz-knopf" data-einsatz="${b}" aria-pressed="${einsatzLesen(schein.einsatz) === b && String(schein.einsatz || STANDARD_EINSATZ).trim() !== ""}">${b} €</button>`).join("")}
          <label class="einsatz-eigen"><input type="text" inputmode="decimal" placeholder="anderer" value="${EINSAETZE.includes(einsatzLesen(schein.einsatz)) ? "" : esc(schein.einsatz || "")}" data-einsatz-feld="1" aria-label="Eigener Einsatz in Euro"><span>€</span></label>
        </div>
      </div>
      <div id="kombi-ergebnis">${scheinErgebnisHtml(schein)}</div>
      <button class="knopf platziert" data-aktion="wette-platziert">Wette platziert, in Meine Wetten speichern</button>
      <p class="fehler" id="platziert-fehler"></p>
      ${warnungen.length ? `<ul class="schein-warnungen">${warnungen.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <button class="leeren" data-aktion="schein-leeren">Schein leeren</button>
    </section>`;
  app.innerHTML = html + vorschlaegeHtml() + fuss();
  scheinSpieleNachladen(schein);
}

// Damit der Schein die neuesten Chancen zeigt, die Analysen seiner Spiele im Hintergrund holen
function scheinSpieleNachladen(schein) {
  const fehlend = [...new Set(schein.tipps.map((t) => t.spiel))].filter((id) => spielInfo(id) && !vollesSpiel(id));
  if (!fehlend.length) return;
  Promise.allSettled(fehlend.map(spielLaden)).then((ergebnisse) => {
    if (!ergebnisse.some((e) => e.status === "fulfilled" && e.value)) return;
    if (location.hash.replace(/^#\/?/, "").split("/")[0] !== "schein") return;
    // Waehrend der Eingabe einer Quote nicht neu zeichnen, sonst springt der Cursor weg
    if (app.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    const y = window.scrollY;
    zeigeSchein();
    window.scrollTo(0, y);
  });
}

function einzelWertText(wert) {
  if (wert == null) return "";
  const klasse = wert >= 0.1 ? "gruen" : wert >= 0 ? "gelb" : "rot";
  return `<span class="${klasse}">${mitVorzeichen(wert * 100)} % gegenüber fair</span>`;
}

function scheinEingabe(feld) {
  const schein = scheinLesen();
  if (feld.dataset.gesamt) {
    schein.gesamt = feld.value;
  } else if (feld.dataset.einsatzFeld) {
    schein.einsatz = feld.value;
    app.querySelectorAll("[data-einsatz]").forEach((k) => k.setAttribute("aria-pressed", String(feld.value.trim() === "" ? Number(k.dataset.einsatz) === STANDARD_EINSATZ : false)));
    if (feld.value.trim() === "") schein.einsatz = "";
  } else if (feld.dataset.quote != null) {
    const i = Number(feld.dataset.quote);
    if (!schein.tipps[i]) return;
    schein.tipps[i].quote = feld.value;
    const leg = schein.tipps[i];
    if (!leg.bet365) b365Merken(leg.spiel, leg.k, leg.pModell ?? leg.p, feld.value);
    const q = quoteLesen(feld.value);
    const ziel = app.querySelector(`[data-einzel="${i}"]`);
    if (ziel) ziel.innerHTML = einzelWertText(q ? schein.tipps[i].p * q - 1 : null);
  }
  scheinSchreiben(schein);
  const ergebnis = document.getElementById("kombi-ergebnis");
  if (ergebnis) ergebnis.innerHTML = scheinErgebnisHtml(scheinAktuell());
}

/* ------------------------------------------------------------ Meine Wetten */

/* Die Wetten liegen auf dem Geraet und, wenn eingerichtet, verschluesselt in
   einem privaten GitHub-Projekt. Verschluesselt wird mit dem App-Passwort,
   GitHub sieht also nur unlesbare Daten. Der Zugangsschluessel bleibt auf dem
   Geraet und wird nur an api.github.com geschickt. */

const WETTEN_SPEICHER = "flutlicht.wetten";
const GITHUB_SPEICHER = "flutlicht.github";
const WETTEN_DATEI = "wetten.enc";
const KDF_RUNDEN = 310000;

const sync = { status: "", zeit: null, laeuft: false, nochmal: false, sha: null };

function wettenLesen() {
  try {
    const roh = JSON.parse(lesen(WETTEN_SPEICHER) || "null");
    if (roh && Array.isArray(roh.wetten)) return roh.wetten;
  } catch (e) { /* kaputt: leer anfangen */ }
  return [];
}

function wettenSchreiben(wetten) {
  schreiben(WETTEN_SPEICHER, JSON.stringify({ wetten }));
}

function githubEinstellungen() {
  try {
    const e = JSON.parse(lesen(GITHUB_SPEICHER) || "null");
    if (e && e.besitzer && e.projekt && e.schluessel) return e;
  } catch (e) { /* nicht eingerichtet */ }
  return null;
}

const neueId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* Verschluesseln wie data.enc: PBKDF2-SHA256 und AES-256-GCM */

const schluesselCache = new Map();

function alsBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function wettenSchluessel(passwort, salz) {
  const k = `${passwort}|${salz}`;
  if (!schluesselCache.has(k)) {
    const basis = await crypto.subtle.importKey("raw", new TextEncoder().encode(passwort), "PBKDF2", false, ["deriveKey"]);
    schluesselCache.set(k, await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: base64(salz), iterations: KDF_RUNDEN, hash: "SHA-256" },
      basis,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ));
  }
  return schluesselCache.get(k);
}

async function wettenVerschluesseln(inhalt, passwort, salz) {
  const salzText = salz || alsBase64(crypto.getRandomValues(new Uint8Array(16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const schluessel = await wettenSchluessel(passwort, salzText);
  const daten = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, schluessel, new TextEncoder().encode(JSON.stringify(inhalt)));
  return { v: 1, kdf: "pbkdf2-sha256", iterationen: KDF_RUNDEN, salz: salzText, iv: alsBase64(iv), daten: alsBase64(new Uint8Array(daten)) };
}

async function wettenEntschluesseln(paket, passwort) {
  const schluessel = await wettenSchluessel(passwort, paket.salz);
  const klar = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64(paket.iv) }, schluessel, base64(paket.daten));
  return JSON.parse(new TextDecoder().decode(klar));
}

/* GitHub */

async function github(methode, pfad, inhalt, einstellungen = githubEinstellungen()) {
  const antwort = await fetch(`https://api.github.com/repos/${encodeURIComponent(einstellungen.besitzer)}/${encodeURIComponent(einstellungen.projekt)}${pfad}`, {
    method: methode,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${einstellungen.schluessel}`,
      // Nur Kopfzeilen, die GitHub fuer Browser-Abrufe freigibt (Authorization, Content-Type, Accept)
      Accept: "application/vnd.github+json",
      ...(inhalt ? { "Content-Type": "application/json" } : {}),
    },
    body: inhalt ? JSON.stringify(inhalt) : undefined,
  });
  return antwort;
}

function githubFehler(antwort) {
  if (antwort.status === 401) return "Der Zugangsschlüssel stimmt nicht oder ist abgelaufen.";
  if (antwort.status === 403) return "Der Schlüssel darf in diesem Projekt nicht schreiben (Contents: Read and write fehlt).";
  if (antwort.status === 404) return "Das Projekt wurde nicht gefunden. Name und Schlüssel prüfen.";
  return `GitHub antwortet mit Fehler ${antwort.status}.`;
}

async function fernLaden() {
  const antwort = await github("GET", `/contents/${WETTEN_DATEI}`);
  if (antwort.status === 404) {
    // Datei fehlt: gibt es das Projekt ueberhaupt?
    const projekt = await github("GET", "");
    if (!projekt.ok) throw new Error(githubFehler(projekt));
    return { wetten: [], quoten: [], leitern: [], sha: null, salz: null };
  }
  if (!antwort.ok) throw new Error(githubFehler(antwort));
  const datei = await antwort.json();
  const paket = JSON.parse(atob(String(datei.content || "").replace(/\s/g, "")));
  let inhalt;
  try {
    inhalt = await wettenEntschluesseln(paket, zustand.passwort);
  } catch (e) {
    const fehler = new Error("Die Wetten in GitHub sind mit einem anderen App-Passwort verschlüsselt.");
    fehler.passwort = true;
    fehler.sha = datei.sha;
    throw fehler;
  }
  return { wetten: Array.isArray(inhalt.wetten) ? inhalt.wetten : [], quoten: Array.isArray(inhalt.quoten) ? inhalt.quoten : [],
           leitern: Array.isArray(inhalt.leitern) ? inhalt.leitern : [], sha: datei.sha, salz: paket.salz };
}

function zusammenfuehren(a, b) {
  const alle = new Map();
  for (const w of [...a, ...b]) {
    const alt = alle.get(w.id);
    if (!alt || (w.geaendert || 0) > (alt.geaendert || 0)) alle.set(w.id, w);
  }
  return [...alle.values()];
}

const gleich = (a, b) => JSON.stringify([...a].sort((x, y) => (x.id < y.id ? -1 : 1))) === JSON.stringify([...b].sort((x, y) => (x.id < y.id ? -1 : 1)));

// Holt den Stand von GitHub, fuehrt ihn mit dem Geraet zusammen und schreibt zurueck, wenn noetig
async function abgleichen() {
  if (!githubEinstellungen() || !zustand.passwort) {
    sync.status = "lokal";
    syncAnzeigen();
    return;
  }
  if (sync.laeuft) { sync.nochmal = true; return; }
  sync.laeuft = true;
  sync.status = "laeuft";
  syncAnzeigen();
  try {
    for (let versuch = 0; versuch < 2; versuch++) {
      const fern = await fernLaden();
      const zusammen = zusammenfuehren(wettenLesen(), fern.wetten);
      wettenSchreiben(zusammen);
      // Eingetippte Bet365-Quoten (fuer die Schaetzung) reisen mit, damit jedes Geraet davon lernt
      const quoten = zusammenfuehren(b365Lesen(), fern.quoten);
      b365Schreiben(quoten);
      // Verdoppeln-Leitern ebenso
      const leitern = zusammenfuehren(leiternLesen(), fern.leitern);
      leiternSchreiben(leitern);
      if (gleich(zusammen, fern.wetten) && gleich(quoten, fern.quoten) && gleich(leitern, fern.leitern)) { sync.sha = fern.sha; break; }
      const paket = await wettenVerschluesseln({ version: 2, wetten: zusammen, quoten, leitern }, zustand.passwort, fern.salz);
      const antwort = await github("PUT", `/contents/${WETTEN_DATEI}`, {
        message: "Wetten aktualisiert",
        content: btoa(JSON.stringify(paket)),
        ...(fern.sha ? { sha: fern.sha } : {}),
      });
      if (antwort.status === 409 || antwort.status === 422) continue; // zwischendurch geaendert: neu holen
      if (!antwort.ok) throw new Error(githubFehler(antwort));
      sync.sha = (await antwort.json()).content.sha;
      break;
    }
    sync.status = "ok";
    sync.zeit = Date.now();
  } catch (fehler) {
    sync.status = fehler.passwort ? "passwort" : "fehler";
    sync.fehler = fehler.message || "Keine Verbindung zu GitHub.";
    sync.fremdSha = fehler.sha || null;
  }
  sync.laeuft = false;
  syncAnzeigen();
  if (location.hash.startsWith("#/wetten")) wettenListeNeu();
  if (location.hash.startsWith("#/leiter")) leiterNeu();
  if (sync.nochmal) { sync.nochmal = false; abgleichen(); }
}

// Nach einer Passwort-Aenderung: die Wetten dieses Geraets mit dem neuen Passwort ablegen
async function neuVerschluesseln() {
  sync.status = "laeuft";
  syncAnzeigen();
  try {
    const paket = await wettenVerschluesseln({ version: 2, wetten: wettenLesen(), quoten: b365Lesen(), leitern: leiternLesen() }, zustand.passwort, null);
    const antwort = await github("PUT", `/contents/${WETTEN_DATEI}`, {
      message: "Wetten mit neuem Passwort gespeichert",
      content: btoa(JSON.stringify(paket)),
      ...(sync.fremdSha ? { sha: sync.fremdSha } : {}),
    });
    if (!antwort.ok) throw new Error(githubFehler(antwort));
    sync.status = "ok";
    sync.zeit = Date.now();
  } catch (fehler) {
    sync.status = "fehler";
    sync.fehler = fehler.message;
  }
  syncAnzeigen();
}

let abgleichTimer = null;
function spaeterAbgleichen() {
  clearTimeout(abgleichTimer);
  abgleichTimer = setTimeout(abgleichen, 600);
}

function wetteAendern(id, aenderung) {
  const wetten = wettenLesen();
  const w = wetten.find((x) => x.id === id);
  if (!w) return;
  Object.assign(w, aenderung, { geaendert: Date.now() });
  wettenSchreiben(wetten);
  spaeterAbgleichen();
}

function wetteNeu(wette) {
  const wetten = wettenLesen();
  wetten.push({ id: neueId(), erstellt: Date.now(), geaendert: Date.now(), geloescht: false, status: "offen", ...wette });
  wettenSchreiben(wetten);
  spaeterAbgleichen();
}

/* Auswertung ueber die Live-Daten */

function beinStand(t) {
  const d = liveDetails.get(t.spiel);
  if (!d) return null;
  return { ...tippStand(t.k, d.live), fertig: d.live.stand.art === "finished" };
}

async function wettenAuswerten() {
  const wetten = wettenLesen();
  const offen = wetten.filter((w) => !w.geloescht && w.status === "offen" && w.art === "app");
  const ids = new Set();
  for (const w of offen) for (const t of w.tipps || []) if (t.anstoss * 1000 <= Date.now()) ids.add(t.spiel);
  for (const id of ids) {
    const d = liveDetails.get(id);
    if (d && (d.live.stand.art === "finished" || Date.now() - d.geholt < 30000)) continue;
    try { await liveHolen(id); } catch (e) { /* spaeter nochmal */ }
  }
  let geaendert = false;
  for (const w of offen) {
    const beine = (w.tipps || []).map(beinStand);
    if (beine.some((b) => !b)) {
      if (beine.some((b) => b && b.status === "raus")) {
        Object.assign(w, { status: "verloren", auto: true, geaendert: Date.now() });
        geaendert = true;
      }
      continue;
    }
    if (beine.some((b) => b.status === "raus")) {
      Object.assign(w, { status: "verloren", auto: true, geaendert: Date.now() });
      geaendert = true;
    } else if (beine.every((b) => b.status === "drin")) {
      Object.assign(w, { status: "gewonnen", auszahlung: runden2(w.einsatz * w.quote), auto: true, geaendert: Date.now() });
      geaendert = true;
    } else if (beine.every((b) => b.fertig) && beine.some((b) => b.status === "ungueltig")) {
      if (!w.pruefen) { Object.assign(w, { pruefen: true, geaendert: Date.now() }); geaendert = true; }
    }
  }
  if (geaendert) {
    wettenSchreiben(wetten);
    spaeterAbgleichen();
  }
  if (location.hash.startsWith("#/wetten")) wettenListeNeu();
  if (geaendert && location.hash.startsWith("#/leiter")) leiterNeu();
}

const runden2 = (x) => Math.round(x * 100) / 100;

/* Anzeige */

function wettenBilanz(wetten) {
  const aktiv = wetten.filter((w) => !w.geloescht);
  const erledigt = aktiv.filter((w) => ["gewonnen", "verloren", "storniert"].includes(w.status));
  const offen = aktiv.filter((w) => w.status === "offen");
  const summe = (liste, f) => liste.reduce((a, w) => a + (Number(f(w)) || 0), 0);
  const eingesetzt = summe(erledigt.filter((w) => w.status !== "storniert"), (w) => w.einsatz);
  const ausgezahlt = summe(erledigt.filter((w) => w.status === "gewonnen"), (w) => w.auszahlung ?? w.einsatz * w.quote);
  const gewonnen = erledigt.filter((w) => w.status === "gewonnen").length;
  const verloren = erledigt.filter((w) => w.status === "verloren").length;
  const mitModell = erledigt.filter((w) => w.status !== "storniert" && w.art === "app" && w.p);
  return {
    eingesetzt,
    ausgezahlt,
    bilanz: ausgezahlt - eingesetzt,
    gewonnen,
    verloren,
    offen: offen.length,
    offenEinsatz: summe(offen, (w) => w.einsatz),
    gesamtEinsatz: summe(aktiv.filter((w) => w.status !== "storniert"), (w) => w.einsatz),
    erwartung: summe(mitModell, (w) => w.einsatz * (w.p * w.quote - 1)),
    mitModell: mitModell.length,
  };
}

function syncText() {
  const e = githubEinstellungen();
  if (!e) return `<span class="sync lokal">Nur auf diesem Gerät gespeichert</span><button class="link-knopf" data-aktion="speicher-zeigen">Speicher einrichten</button>`;
  if (sync.status === "laeuft") return `<span class="sync">Wird mit GitHub abgeglichen</span>`;
  if (sync.status === "fehler") return `<span class="sync fehler-text">${esc(sync.fehler)}</span><button class="link-knopf" data-aktion="abgleichen">Nochmal</button>`;
  if (sync.status === "passwort") {
    return `<span class="sync fehler-text">${esc(sync.fehler)} Hast du das Passwort geändert, speichere die Wetten von diesem Gerät mit dem neuen Passwort neu.</span><button class="link-knopf" data-aktion="neu-verschluesseln">Mit aktuellem Passwort neu speichern</button>`;
  }
  const einstellungen = `<button class="link-knopf" data-aktion="speicher-zeigen">Einstellungen</button>`;
  if (sync.status === "ok") return `<span class="sync ok">Verschlüsselt in GitHub gespeichert, ${uhr(sync.zeit / 1000)} Uhr</span>${einstellungen}`;
  return `<span class="sync">GitHub eingerichtet</span>${einstellungen}`;
}

function syncAnzeigen() {
  const ziel = document.getElementById("sync-zeile");
  if (ziel) ziel.innerHTML = syncText();
}

const STATUS_NAMEN = { offen: "offen", gewonnen: "gewonnen", verloren: "verloren", storniert: "storniert" };

// Paarung mit Stand und Spielminute fuer eine Zeile in "Meine Wetten": live aus der Abfrage, sonst aus den Daten
function beinSpielText(t) {
  const d = liveDetails.get(t.spiel);
  const info = spielInfo(t.spiel);
  const st = d ? d.live.stand : liveListe.get(t.spiel) || (info ? stand(info) : null);
  const paar = `${esc(t.heim)} gegen ${esc(t.gast)}`;
  if (st && (st.art === "inprogress" || st.art === "finished") && st.h != null) {
    const live = st.art === "inprogress";
    const zeit = live ? (st.minute && st.minute !== "live" ? st.minute : "läuft") : (!st.minute || st.minute === "Ende" ? "Endstand" : st.minute);
    return `<span class="${live ? "live-stand" : ""}">${esc(t.heim)} ${st.h}:${st.g} ${esc(t.gast)} · ${esc(zeit)}</span>`;
  }
  if (st && st.art === "cancelled") return `${paar} · abgesagt`;
  if (!t.anstoss) return paar;
  if (t.anstoss * 1000 <= Date.now()) return `${paar} · Anstoß war ${uhr(t.anstoss)} Uhr, Stand wird geladen`;
  const heute = tagSchluessel(Date.now() / 1000) === tagSchluessel(t.anstoss);
  return `${paar} · ${heute ? "heute" : esc(fmtKurz.format(new Date(t.anstoss * 1000)))}, ${uhr(t.anstoss)} Uhr`;
}

function wetteKarte(w) {
  const datum = new Date(w.erstellt);
  const auszahlung = w.status === "gewonnen" ? (w.auszahlung ?? w.einsatz * w.quote) : w.einsatz * w.quote;
  let beine = "";
  if (w.art === "app") {
    beine = `<ul class="beine">${(w.tipps || [])
      .map((t) => {
        const st = beinStand(t);
        const zeichen = !st ? "<i></i>" : st.status === "drin" ? '<i class="ja">✓</i>' : st.status === "raus" ? '<i class="nein">✗</i>' : st.status === "ungueltig" ? '<i class="leer-zeichen">–</i>' : '<i class="laeuft"></i>';
        const stand = st && st.wert != null ? `<span class="leise klein">${zahl(st.wert, 0)} von ${Number.isInteger(st.ziel) ? st.ziel : zahl(st.ziel, 1)}</span>` : "";
        // Antippen fuehrt zum Spiel (laeuft es, zum Live-Reiter)
        return `<li class="mit-knopf"><button class="bein-knopf" data-spiel="${t.spiel}" aria-label="Zum Spiel ${esc(t.heim)} gegen ${esc(t.gast)}">${zeichen}<span><span class="n">${esc(t.titel)}</span><span class="leise klein">${beinSpielText(t)}${st && st.notiz ? `, ${esc(st.notiz)}` : ""}</span></span>${stand}<span class="pfeil" aria-hidden="true">›</span></button></li>`;
      })
      .join("")}</ul>`;
  } else {
    beine = `<p class="eigen-text">${esc(w.text || "Eigene Wette")}</p>`;
  }
  const knoepfe = w.status === "offen"
    ? `<button data-wette-status="gewonnen" data-wette="${w.id}">Gewonnen</button><button data-wette-status="verloren" data-wette="${w.id}">Verloren</button><button data-wette-status="storniert" data-wette="${w.id}">Storniert</button>`
    : `<button data-wette-status="offen" data-wette="${w.id}">Wieder offen</button>`;
  return `
    <article class="wette ${w.status}">
      <div class="wette-kopf">
        <span class="status-pille ${w.status}">${STATUS_NAMEN[w.status] || w.status}${w.auto ? " (automatisch)" : ""}</span>
        <span class="leise klein">${w.leiter ? `Verdoppeln, Stufe ${w.leiter.stufe} · ` : ""}${esc(fmtKurz.format(datum))}, ${uhr(datum / 1000)}</span>
      </div>
      ${w.pruefen && w.status === "offen" ? `<p class="hinweis-box klein"><strong>Bitte prüfen.</strong> Ein Spieler hat nicht gespielt. Bei Bet365 zählt so ein Tipp meist als ungültig, die Quote ändert sich dann. Trag das Ergebnis von Hand ein.</p>` : ""}
      ${beine}
      <div class="wette-zahlen">
        <div><span class="leise klein">Einsatz</span><span class="zahl">${euro(w.einsatz)}</span></div>
        <div><span class="leise klein">Quote</span><span class="zahl">${zahl(w.quote, 2)}</span></div>
        <div><span class="leise klein">${w.status === "gewonnen" ? "Ausgezahlt" : w.status === "verloren" ? "Verlust" : w.status === "storniert" ? "Zurück" : "Mögliche Auszahlung"}</span><span class="zahl ${w.status === "gewonnen" ? "gruen" : w.status === "verloren" ? "rot" : ""}">${w.status === "verloren" ? `−${euro(w.einsatz)}` : w.status === "storniert" ? euro(w.einsatz) : euro(auszahlung)}</span></div>
      </div>
      ${w.status === "gewonnen" ? `<label class="auszahlung-feld"><span class="leise klein">Tatsächlich ausgezahlt</span><input type="text" inputmode="decimal" value="${zahl(auszahlung, 2)}" data-auszahlung="${w.id}"><span>€</span></label>` : ""}
      <div class="wette-knoepfe">${knoepfe}<button class="loeschen" data-wette-loeschen="${w.id}" aria-label="Wette löschen">Löschen</button></div>
    </article>`;
}

function wettenListeHtml() {
  const wetten = wettenLesen().filter((w) => !w.geloescht).sort((a, b) => b.erstellt - a.erstellt);
  const filter = zustand.wettenFilter || "alle";
  const liste = wetten.filter((w) => filter === "alle" || (filter === "offen" ? w.status === "offen" : w.status !== "offen"));
  if (!wetten.length) {
    return `<p class="leer">Noch keine Wetten gespeichert. Leg im Schein Tipps an, trag Quote und Einsatz ein und tippe auf „Wette platziert“. Oder trag unten eine eigene Wette ein.</p>`;
  }
  return `
    <div class="wahl" role="group" aria-label="Filter">
      ${[["alle", "Alle"], ["offen", "Offen"], ["erledigt", "Erledigt"]].map(([k, n]) => `<button data-wetten-filter="${k}" aria-pressed="${k === filter}">${n}</button>`).join("")}
    </div>
    <div class="wetten-liste">${liste.map(wetteKarte).join("") || '<p class="leer">Keine Wetten in dieser Auswahl.</p>'}</div>`;
}

function wettenListeNeu() {
  const leiste = app.querySelector(".unten");
  if (leiste) leiste.outerHTML = scheinLeiste();
  const ziel = document.getElementById("wetten-inhalt");
  const tippt = ziel && document.activeElement && ziel.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
  if (ziel && !tippt) ziel.innerHTML = wettenListeHtml();
  const kopf = document.getElementById("wetten-bilanz");
  if (kopf) kopf.innerHTML = bilanzKopfHtml();
  if (location.hash.startsWith("#/leiter")) leiterNeu();
}

function bilanzKopfHtml() {
  const b = wettenBilanz(wettenLesen());
  const quote = b.gewonnen + b.verloren ? Math.round((b.gewonnen / (b.gewonnen + b.verloren)) * 100) : null;
  return `
    <div class="wetten-bilanz">
      <div class="gross ${b.bilanz > 0 ? "gruen" : b.bilanz < 0 ? "rot" : ""}">
        <span class="leise klein">Bilanz</span>
        <span class="zahl">${b.bilanz >= 0 ? "+" : "−"}${euro(Math.abs(b.bilanz))}</span>
      </div>
      <div><span class="leise klein">Eingesetzt (abgerechnet)</span><span class="zahl">${euro(b.eingesetzt)}</span></div>
      <div><span class="leise klein">Ausgezahlt</span><span class="zahl">${euro(b.ausgezahlt)}</span></div>
      <div><span class="leise klein">Gewonnen</span><span class="zahl gruen">${b.gewonnen}</span></div>
      <div><span class="leise klein">Verloren</span><span class="zahl rot">${b.verloren}</span></div>
      <div><span class="leise klein">Offen</span><span class="zahl">${b.offen}</span><span class="leise klein">${euro(b.offenEinsatz)} im Spiel</span></div>
    </div>
    <p class="leise klein">Insgesamt eingesetzt: ${euro(b.gesamtEinsatz)}${quote != null ? `. Trefferquote ${quote} %` : ""}${b.mitModell ? `. Laut Modell wären bei diesen ${b.mitModell} App-Scheinen im Schnitt ${mitVorzeichen(b.erwartung, 2)} € zu erwarten gewesen, das zeigt, ob Glück oder Pech im Spiel war.` : "."}</p>`;
}

function speicherHtml() {
  const e = githubEinstellungen() || { besitzer: "FaCiN31", projekt: "fussball-wetten", schluessel: "" };
  return `
    <section class="abschnitt speicher${zustand.speicherOffen || !githubEinstellungen() ? "" : " zu"}" id="speicher">
      <h2>Speicher</h2>
      <p>Die Wetten werden mit deinem App-Passwort verschlüsselt und in einem privaten GitHub-Projekt abgelegt. So gehen sie nicht verloren und sind auf jedem Gerät da, auf dem du hier den Schlüssel einträgst.</p>
      <label class="gesamt-feld"><span>GitHub-Name</span><input class="feld" id="gh-besitzer" value="${esc(e.besitzer)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label class="gesamt-feld"><span>Projekt</span><input class="feld" id="gh-projekt" value="${esc(e.projekt)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label class="gesamt-feld"><span>Zugangsschlüssel</span><input class="feld" id="gh-schluessel" type="password" value="${esc(e.schluessel)}" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="speicher-knoepfe">
        <button class="knopf" data-aktion="speicher-sichern">Speichern und verbinden</button>
        ${githubEinstellungen() ? '<button class="leeren" data-aktion="speicher-trennen">Trennen</button>' : ""}
      </div>
      <p class="leise klein">Der Schlüssel bleibt nur auf diesem Gerät und geht ausschließlich an GitHub. Gib ihn nirgendwo anders ein.</p>
    </section>`;
}

function zeigeWetten() {
  app.innerHTML = `
    <header class="kopf">
      <h1>Meine Wetten</h1>
      <button class="rund" data-aktion="wetten-neu" aria-label="Wetten aktualisieren">${ICON_NEU}</button>
    </header>
    <div class="sync-zeile" id="sync-zeile">${syncText()}</div>
    <section class="abschnitt" id="wetten-bilanz">${bilanzKopfHtml()}</section>
    <section class="abschnitt" id="wetten-inhalt">${wettenListeHtml()}</section>
    <section class="abschnitt">
      <details class="eigene-wette"${zustand.eigeneOffen ? " open" : ""}>
        <summary>Eigene Wette eintragen</summary>
        <p class="leise klein">Für Wetten, die nicht aus dem Schein der App kommen. Die wertest du selbst aus.</p>
        <label class="gesamt-feld"><span>Was hast du getippt?</span><input class="feld" id="eigen-text" placeholder="zum Beispiel Bayern gewinnt und über 2,5 Tore"></label>
        <div class="zwei-felder">
          <label class="gesamt-feld"><span>Einsatz in €</span><input class="feld" id="eigen-einsatz" inputmode="decimal" placeholder="10"></label>
          <label class="gesamt-feld"><span>Quote</span><input class="feld" id="eigen-quote" inputmode="decimal" placeholder="2,50"></label>
        </div>
        <button class="knopf" data-aktion="eigen-sichern">Wette speichern</button>
        <p class="fehler" id="eigen-fehler"></p>
      </details>
    </section>
    ${speicherHtml()}
    ${fuss()}`;
  abgleichen();
  wettenAuswerten();
  // Laufen Spiele aus offenen Wetten, Stand und Minute jede Minute neu holen
  const laeuftWas = () => wettenLesen().some((w) => !w.geloescht && w.status === "offen" && (w.tipps || []).some((t) => {
    const d = liveDetails.get(t.spiel);
    return t.anstoss * 1000 <= Date.now() && Date.now() - t.anstoss * 1000 < 4 * 3600 * 1000 && !(d && d.live.stand.art === "finished");
  }));
  timerStoppen();
  if (laeuftWas()) {
    liveTimer = setInterval(() => {
      if (!location.hash.startsWith("#/wetten") || !laeuftWas()) { timerStoppen(); return; }
      wettenAuswerten();
    }, WETTEN_TAKT);
  }
}
const WETTEN_TAKT = 60000;

function ausSchein() {
  const schein = scheinAktuell();
  const e = scheinAuswertung(schein);
  if (!schein.tipps.length || !e.quote) return "Trag zuerst die Quote von Bet365 ein.";
  if (e.quelle === "schaetzung") return "Die ≈-Quote ist nur geschätzt. Trag die echten Quoten von Bet365 ein (einzeln oder oben die Gesamtquote).";
  if (e.bb && e.quelle !== "gesamt") return "Bei zwei Tipps aus einem Spiel (Bet Builder) trag bitte oben die Gesamtquote von Bet365 ein.";
  wetteNeu({
    art: "app",
    einsatz: e.einsatz,
    quote: runden2(e.quote),
    p: runden2(e.p * 10000) / 10000,
    tipps: schein.tipps.map((t) => ({ spiel: t.spiel, k: t.k, titel: t.titel, p: t.p, anstoss: t.anstoss, heim: t.heim, gast: t.gast })),
  });
  schreiben(SCHEIN_SPEICHER, null);
  return "";
}

/* ---------------------------------------------------------------- Verdoppeln */

/* Eine Leiter: Startbetrag auf einen Tipp oder eine kleine Kombi mit Quote um 2 setzen, bei
   Gewinn alles auf die naechste Stufe, bis das Ziel erreicht ist. Verloren ist hoechstens der
   Startbetrag. Jede Stufe ist eine normale Wette (mit leiter: {id, stufe}), damit sie wie alle
   App-Wetten automatisch ausgewertet und mit GitHub abgeglichen wird. Die Leitern selbst
   ({id, start, ziel, faktor, status}) reisen verschluesselt mit (wetten.enc). */

const LEITER_SPEICHER = "flutlicht.leitern";
const LEITER_MIN_QUOTE = 1.2;
const LEITER_TOLERANZ = Math.log(1.12);     // Quote der Stufe plus/minus 12 %
const LEITER_FAKTOREN = [1.5, 2, 2.5, 3];
// Quote je Stufe darf in einem Band liegen (bei 2: 1,70 bis 2,30), damit sich ueber den Tag gute Tipps finden
const LEITER_BAND = [1 / 1.18, 1.15];
// Die naechste Stufe erst, wenn das Spiel davor sicher vorbei ist: 2 Stunden nach Anpfiff
const LEITER_PAUSE_SEK = 2 * 3600;
const leiterBand = (quote) => [Math.max(LEITER_MIN_QUOTE, quote * LEITER_BAND[0]), quote * LEITER_BAND[1]];
// Fuer kuenftige Stufen, solange noch kein Tipp gewaehlt ist: Chance etwa 0,9 / Quote
// (so viel bleibt bei Bet365 nach der Marge typischerweise uebrig)
const LEITER_RUECKLAUF = 0.9;
const LEITER_VORSCHLAEGE = 10;   // so viele Vorschlaege je Anstosszeit fuer "Anderer Tipp"

function leiternLesen() {
  try {
    const roh = JSON.parse(lesen(LEITER_SPEICHER) || "null");
    if (roh && Array.isArray(roh.leitern)) return roh.leitern;
  } catch (e) { /* kaputt: leer anfangen */ }
  return [];
}

function leiternSchreiben(leitern) {
  schreiben(LEITER_SPEICHER, JSON.stringify({ leitern }));
}

function leiterAendern(id, aenderung) {
  const leitern = leiternLesen();
  const l = leitern.find((x) => x.id === id);
  if (!l) return;
  Object.assign(l, aenderung, { geaendert: Date.now() });
  leiternSchreiben(leitern);
  spaeterAbgleichen();
}

const leiterAktiv = () => leiternLesen().filter((l) => !l.geloescht && l.status === "laeuft").sort((a, b) => b.erstellt - a.erstellt)[0] || null;

function leiterWetten(l) {
  return wettenLesen().filter((w) => !w.geloescht && w.leiter && w.leiter.id === l.id)
    .sort((a, b) => a.leiter.stufe - b.leiter.stufe || a.erstellt - b.erstellt);
}

// Wo steht die Leiter? betrag: was jetzt auf die naechste Stufe geht
function leiterStand(l) {
  let betrag = l.start;
  let stufe = 1;
  let offen = null;
  let verloren = false;
  for (const w of leiterWetten(l)) {
    if (w.status === "offen") { offen = w; stufe = w.leiter.stufe; continue; }
    if (w.status === "gewonnen") { betrag = runden2(w.auszahlung ?? w.einsatz * w.quote); stufe = w.leiter.stufe + 1; }
    else if (w.status === "verloren") { verloren = true; stufe = w.leiter.stufe; }
    else if (w.status === "storniert") { betrag = w.einsatz; stufe = w.leiter.stufe; }
  }
  return { betrag, stufe, offen, verloren, geschafft: !verloren && !offen && betrag >= l.ziel - 0.005 };
}

// Die Stufen von betrag bis zum Ziel, je mit der noetigen Quote
function leiterPlan(betrag, ziel, faktor) {
  const stufen = [];
  let b = betrag;
  while (b < ziel - 0.005 && stufen.length < 15) {
    const quote = Math.max(LEITER_MIN_QUOTE, Math.min(faktor, ziel / b));
    stufen.push({ von: b, bis: b * quote, quote });
    b *= quote;
  }
  return stufen;
}

const leiterChance = (stufen, ersteP = null) =>
  stufen.reduce((p, s, i) => p * (i === 0 && ersteP ? ersteP : Math.min(0.95, LEITER_RUECKLAUF / s.quote)), 1);

// Alle Tipps fuer die Leiter: aus der Uebersicht (Bet365-Quote eingetippt, geschaetzt oder vom Quoten-Dienst)
function leiterSpiele() {
  const jetzt = Date.now() / 1000;
  return (zustand.daten.spiele || []).filter((x) => x.status === "notstarted" && x.anstoss > jetzt + 300
    && ((x.pool || []).length || (x.kandidaten || []).length));
}

function leiterPool(spiele) {
  if (spiele.some((x) => (x.pool || []).length)) {
    const pool = [];
    for (const info of spiele) {
      for (const w of info.pool || []) {
        if (w.push || !kombiMarktOk(w.k.split("|")[0])) continue;
        pool.push({ ...w, spiel: info.id, anstoss: info.anstoss, heim: kurzName(info.heim), gast: kurzName(info.gast) });
      }
    }
    return pool;
  }
  return kombiPoolGeschaetzt(spiele);
}

// Beste Einzeltipps, 2er und 3er rund um die Quote der Stufe. Bei gleicher Quote ist die hoechste
// Chance auch das, was im Schnitt am meisten zurueckbringt. Dazu ein kleiner Bonus fuer Maerkte, in
// denen das Modell nachweislich besser ist als ein Schnitt, und ein Abzug je weiterem Tipp
// (jede geschaetzte Quote kann danebenliegen, und Bet365 rechnet beim Bet Builder selbst).
function leiterOptionen(pool, ziel, band = leiterBand(ziel), max = LEITER_VORSCHLAEGE) {
  const zielLog = Math.log(ziel);
  const [unten, oben] = band;
  const staerke = new Map();
  const bonus = (b) => {
    const m = b.k.split("|")[0];
    if (!staerke.has(m)) staerke.set(m, Math.max(0, Math.min(0.3, marktStaerke(m))));
    return staerke.get(m);
  };
  const bewerten = (beine) => {
    const k = kombiDaten(beine);
    if (k.quote < unten || k.quote > oben) return null;
    const abstand = Math.abs(Math.log(k.quote) - zielLog);
    const wertung = k.p * k.quote + 0.1 * beine.reduce((a, b) => a + bonus(b), 0) / beine.length
      - 0.015 * (beine.length - 1) - 0.15 * abstand;
    return { ...k, wertung };
  };
  const passt = (beine) => {
    let belegt = new Set();
    let team = 0;
    for (const b of beine) {
      if (!kombiPasst(belegt, b)) return false;
      belegt = kombiBelegen(belegt, b);
      if (istTeamBein(b)) team += 1;
    }
    return team <= teamBeineMax(beine.length);
  };
  const beste = { 1: null, 2: null, 3: null };
  const alle = [];
  const merken = (k) => {
    if (!k) return;
    alle.push(k);
    if (!beste[k.beine.length] || k.wertung > beste[k.beine.length].wertung) beste[k.beine.length] = k;
  };
  const kandidaten = pool.filter((b) => b.p >= 0.25 && b.quote >= 1.05);
  for (const b of kandidaten) merken(bewerten([b]));
  // 2er: Partner rund um die noetige Restquote. Bei gleicher Gesamtquote gewinnen Tipps mit hoher
  // Chance fuer ihre Quote (Chance x Quote), darum nur die besten davon (sonst dauert es am Abend
  // mit 30 Spielen Sekunden), Spieler und andere getrennt, weil hoechstens ein Nicht-Spieler-Tipp
  // in eine Kombi darf
  // Je Quotenstufe die besten (sonst stehen vorne nur kurze Quoten, mit denen die Stufe nie erreicht wird)
  const geschichtet = (liste, jeStufe) => {
    const stufen = new Map();
    for (const b of liste) {
      const k = `${istTeamBein(b) ? "t" : "s"}${Math.round(Math.log(b.quote) / 0.08)}`;
      if (!stufen.has(k)) stufen.set(k, []);
      stufen.get(k).push(b);
    }
    return [...stufen.values()].flatMap((l) => l.sort((a, b) => b.p * b.quote - a.p * a.quote).slice(0, jeStufe));
  };
  const paarBasis = geschichtet(kandidaten.filter((b) => b.quote >= 1.1 && b.quote <= oben / 1.05), 10);
  const nachQuote = [...paarBasis].sort((a, b) => a.quote - b.quote);
  for (const a of paarBasis) {
    const rest = ziel / a.quote;
    if (rest < 1.05) continue;
    for (const b of nachQuote) {
      if (b.quote < (unten / a.quote) / 1.15) continue;
      if (b.quote > (oben / a.quote) * 1.2) break;
      if (a === b || a.k + a.spiel > b.k + b.spiel) continue;
      if (passt([a, b])) merken(bewerten([a, b]));
    }
  }
  // 3er aus Tipps mit passender Einzelquote, je Quotenstufe die besten
  const je = ziel ** (1 / 3);
  const drei = geschichtet(kandidaten.filter((b) => b.quote >= Math.max(1.1, je / 1.35) && b.quote <= je * 1.35), 6);
  for (let i = 0; i < drei.length; i++) {
    for (let j = i + 1; j < drei.length; j++) {
      if (!passt([drei[i], drei[j]])) continue;
      for (let m = j + 1; m < drei.length; m++) {
        const beine = [drei[i], drei[j], drei[m]];
        if (passt(beine)) merken(bewerten(beine));
      }
    }
  }
  // Vorne das Beste je Anzahl Tipps (wie bisher), dahinter die naechstbesten fuer "Anderer Tipp". Damit
  // sich die Vorschlaege wirklich unterscheiden, kommt jeder Tipp in hoechstens zwei davon vor.
  // Nie das Gegenteil eines schon gezeigten Tipps (erst "mehr als 3,5 Gelbe", dann "weniger als 3,5 Gelbe"):
  // Das waere kein anderer Tipp, sondern ein Muenzwurf.
  const schl = (b) => `${b.spiel}|${b.k}`;
  const markt = (b) => { const [m, linie, , spieler, team] = b.k.split("|"); return `${b.spiel}|${m}|${linie}|${spieler || ""}|${team || ""}`; };
  const oft = new Map();
  const richtung = new Map();
  const liste = [];
  const nehmen = (k) => {
    if (liste.length >= max || liste.includes(k)) return;
    if (k.beine.some((b) => (oft.get(schl(b)) || 0) >= 2 || (richtung.has(markt(b)) && richtung.get(markt(b)) !== b.k))) return;
    liste.push(k);
    k.beine.forEach((b) => { oft.set(schl(b), (oft.get(schl(b)) || 0) + 1); richtung.set(markt(b), b.k); });
  };
  [beste[1], beste[2], beste[3]].filter(Boolean).sort((a, b) => b.wertung - a.wertung).forEach(nehmen);
  alle.sort((a, b) => b.wertung - a.wertung).forEach(nehmen);
  return liste.map((k) => ({ ...k, name: k.beine.length === 1 ? "Einzeltipp" : `${k.beine.length}er-Kombi` }));
}

function leiterVorschauHtml() {
  const f = zustand.leiterForm || { start: "10", ziel: "100", faktor: 2 };
  const start = einsatzLesen(f.start);
  const zielBetrag = Math.max(start * 1.2, einsatzLesen(f.ziel));
  const plan = leiterPlan(start, zielBetrag, f.faktor);
  const chance = leiterChance(plan);
  return `${leiterPlanHtml(plan, 0)}
      <p class="leiter-chance">${plan.length === 1 ? "Ein Treffer reicht" : `Du brauchst ${plan.length} Treffer hintereinander`}. Bis zum Ziel kommst du ungefähr <strong>${prozent(chance)}</strong> der Versuche${chance < 0.5 ? ` (etwa 1 von ${Math.max(2, Math.round(1 / chance))})` : ""}.</p>`;
}

function leiterFormHtml() {
  const f = zustand.leiterForm || { start: "10", ziel: "100", faktor: 2 };
  return `
    <section class="abschnitt">
      <p>Du setzt einen Startbetrag auf einen Tipp oder eine kleine Kombi mit Quote um 2 (zwischen 1,70 und 2,30). Gewinnst du, kommt alles auf die nächste Stufe, am selben Tag frühestens 2 Stunden nach dem letzten Anpfiff. Verlierst du, ist die Leiter vorbei. Weg ist dann nur der Startbetrag, mehr nicht.</p>
      <form class="ziel-form" data-leiter-form="1">
        <label><span class="leise klein">Start</span><span class="mit-einheit"><input class="feld" type="text" inputmode="decimal" id="leiter-start" value="${esc(f.start)}"><span>€</span></span></label>
        <label><span class="leise klein">Ziel</span><span class="mit-einheit"><input class="feld" type="text" inputmode="decimal" id="leiter-ziel" value="${esc(f.ziel)}"><span>€</span></span></label>
        <div class="leiter-faktor"><span class="leise klein">Quote je Stufe</span>
          <div class="wahl klein-wahl" role="group" aria-label="Quote je Stufe">${LEITER_FAKTOREN.map((x) => `<button type="button" data-leiter-faktor="${x}" aria-pressed="${x === f.faktor}">${zahl(x, 1)}</button>`).join("")}</div>
        </div>
        <button class="knopf" type="submit">Leiter starten</button>
      </form>
      <div id="leiter-vorschau">${leiterVorschauHtml()}</div>
      <p class="fussnote">Die Chance ist grob gerechnet: Bei Bet365 klappt eine Wette mit Quote ${zahl(f.faktor, 1)} nach Abzug der Marge etwa ${prozent(Math.min(0.95, LEITER_RUECKLAUF / f.faktor))} der Fälle. Mehr ist bei dieser Quote nicht drin: Wäre eine Wette zu 80 % sicher, zahlte Bet365 dafür nur etwa 1,20. Die Marge zahlst du auf jeder Stufe, darum bringt die Leiter im Schnitt weniger zurück, als du einsetzt. Sie ist Spannung mit festem Risiko, kein Weg zu sicherem Gewinn.</p>
    </section>`;
}

function leiterPlanHtml(plan, erledigt, aktuell = -1) {
  return `<ol class="leiter-stufen">${plan.map((s, i) => {
    const art = i < erledigt ? "fertig" : i === aktuell ? "jetzt" : "";
    return `<li class="${art}"><span class="leiter-nr">${i < erledigt ? "✓" : i + 1}</span><span>${zahl(s.von, 2)} € → <strong>${zahl(s.bis, 2)} €</strong></span><span class="leise klein">Quote ${zahl(s.quote, 2)}</span></li>`;
  }).join("")}</ol>`;
}

function leiterKarte(k, index, betrag) {
  const geschaetzt = k.beine.some((b) => b.geschaetzt);
  const spielerOhneAufstellung = k.beine.some((b) => !istTeamBein(b) && (spielInfo(b.spiel) || {}).aufstellung !== "standard");
  const n = Math.max(1, Math.round(1 / k.p));
  return `
    <article class="kombi-karte leiter-karte">
      <div class="kombi-kopf">
        <div><div class="etikett">${esc(k.name)}</div><div class="leise klein">${k.beine.length === 1 ? "1 Tipp" : `${k.beine.length} Tipps aus ${k.spiele === 1 ? "1 Spiel" : `${k.spiele} Spielen`}`}</div></div>
        <div class="kombi-zahlen"><span class="zahl">${geschaetzt ? "≈ " : ""}${zahl(k.quote, 2)}</span><small>${geschaetzt ? "Bet365 geschätzt" : "Bet365 gesamt"}</small></div>
      </div>
      <ul class="kombi-beine">${k.beine.map((b) => `
        <li><span><span class="n">${esc(b.titel)}</span><span class="leise klein">${esc(b.heim)} gegen ${esc(b.gast)}, ${uhr(b.anstoss)}</span>${b.g ? `<span class="leise klein grund">${esc(b.g)}</span>` : ""}</span><span class="leise klein">${b.geschaetzt ? "≈ " : ""}${zahl(b.quote, 2)} · ${prozent(b.p)}</span></li>`).join("")}</ul>
      ${k.bb ? `<p class="fussnote kombi-bb">Mehrere Tipps aus einem Spiel: bei Bet365 über „Wette erstellen“, die Gesamtquote rechnet Bet365 selbst. Die Chance enthält schon, wie eng die Tipps zusammenhängen.</p>` : ""}
      ${spielerOhneAufstellung ? `<p class="hinweis-box klein">Die Aufstellung ist noch nicht da. Setz Spieler-Tipps erst, wenn sie feststeht (etwa 1 Stunde vor Anpfiff): Steht ein Spieler nicht in der Startelf, klappt sein Tipp nur noch etwa jedes 4. Mal.</p>` : ""}
      <div class="kombi-fuss">
        <span>Chance <strong>${prozent(k.p)}</strong>${k.p < 0.5 ? ` <span class="leise">(etwa 1 von ${n})</span>` : ""}</span>
        <span>${zahl(betrag, 2)} € werden <strong>${geschaetzt ? "≈ " : ""}${zahl(betrag * k.quote, 2)} €</strong></span>
      </div>
      <form class="leiter-setzen" data-leiter-setzen="${index}">
        <label><span class="leise klein">Echte Bet365-${k.beine.length > 1 ? "Gesamtquote" : "Quote"}</span><input class="feld" type="text" inputmode="decimal" placeholder="${geschaetzt ? `≈ ${zahl(k.quote, 2)}` : zahl(k.quote, 2)}" value="${geschaetzt ? "" : esc(zahl(k.quote, 2))}"></label>
        <button class="knopf" type="submit">Gesetzt</button>
      </form>
      <p class="fehler" data-leiter-fehler="${index}"></p>
    </article>`;
}

let leiterLetzte = [];

/* Tagesplan: Stufe fuer Stufe durch den Tag. Jede Stufe nimmt Spiele, die zur selben Zeit anfangen
   (bis 15 Minuten spaeter), die naechste Stufe erst 2 Stunden nach dem letzten Anpfiff davor. Je
   Anstosszeit sucht die App den besten Tipp oder die beste kleine Kombi mit Quote im Band und waehlt
   dann die Reihe von Anstosszeiten, mit der man am weitesten kommt (bei gleich vielen Stufen die mit
   dem besten Verhaeltnis aus Chance und Quote). */
function leiterTagesplan(spiele, betrag, ziel, faktor, ab) {
  const liste = spiele.filter((x) => x.anstoss >= ab).sort((a, b) => a.anstoss - b.anstoss);
  const stufen = leiterPlan(betrag, ziel, faktor);
  if (!liste.length || !stufen.length) return null;
  const zeiten = [...new Set(liste.map((x) => x.anstoss))];
  const slots = [];
  for (const t of zeiten) {
    if (slots.length && t - slots[slots.length - 1].t < 15 * 60) continue;  // gehoert zur Anstosszeit davor
    const gruppe = liste.filter((x) => x.anstoss >= t && x.anstoss < t + 15 * 60);
    slots.push({ t, ende: Math.max(...gruppe.map((x) => x.anstoss)), gruppe, optionen: new Map() });
  }
  const pool = new Map();
  const vorschlaege = (slot, quote) => {
    const schl = quote.toFixed(2);
    if (!slot.optionen.has(schl)) {
      if (!pool.has(slot.t)) pool.set(slot.t, leiterPool(slot.gruppe));
      slot.optionen.set(schl, leiterOptionen(pool.get(slot.t), quote));
    }
    return slot.optionen.get(schl);
  };
  const bestes = (slot, quote) => vorschlaege(slot, quote)[0] || null;
  let beste = null;
  const weiter = (start, schritte, b, wertung) => {
    if (schritte.length && (!beste || schritte.length > beste.schritte.length
        || (schritte.length === beste.schritte.length && wertung > beste.wertung))) {
      beste = { schritte: [...schritte], wertung, betrag: b };
    }
    if (b >= ziel - 0.005 || schritte.length >= 6) return;
    const quote = Math.max(LEITER_MIN_QUOTE, Math.min(faktor, ziel / b));
    for (let i = start; i < slots.length; i++) {
      const slot = slots[i];
      if (schritte.length && slot.t < schritte[schritte.length - 1].slot.ende + LEITER_PAUSE_SEK) continue;
      const option = bestes(slot, quote);
      if (!option) continue;
      schritte.push({ slot, option, von: b, alternativen: vorschlaege(slot, quote) });
      weiter(i + 1, schritte, b * option.quote, wertung + Math.log(option.p * option.quote));
      schritte.pop();
    }
  };
  weiter(0, [], betrag, 0);
  if (!beste) return null;
  const chance = beste.schritte.reduce((p, x) => p * x.option.p, 1);
  return { ...beste, chance, stufenGesamt: stufen.length };
}

// Der Tagesplan mit einem anderen Tipp fuer die erste Stufe (gleiche Anstosszeit): Der Rest wird mit dem
// neuen Betrag neu gerechnet, ab 2 Stunden nach dem letzten Anpfiff dieser Stufe.
function tagesplanMitErstem(amTag, l, betrag, schritt, option) {
  const nach = betrag * option.quote;
  const rest = nach < l.ziel - 0.005 ? leiterTagesplan(amTag, nach, l.ziel, l.faktor, schritt.slot.ende + LEITER_PAUSE_SEK) : null;
  return {
    schritte: [{ ...schritt, option }, ...(rest ? rest.schritte : [])],
    betrag: rest ? rest.betrag : nach,
    chance: option.p * (rest ? rest.chance : 1),
  };
}

function vorschlagNav(nav) {
  if (!nav || nav.n < 2) return "";
  return `<div class="vorschlag-nav">
      <button class="dazu" data-leiter-vorschlag="${nav.i - 1}" data-schluessel="${esc(nav.schluessel)}" ${nav.i === 0 ? "disabled" : ""} aria-label="Vorheriger Vorschlag">‹</button>
      <span class="leise klein">Vorschlag ${nav.i + 1} von ${nav.n}</span>
      <button class="dazu" data-leiter-vorschlag="${(nav.i + 1) % nav.n}" data-schluessel="${esc(nav.schluessel)}">${nav.i === nav.n - 1 ? "Zum ersten" : "Anderer Tipp ›"}</button>
    </div>`;
}

function tagesplanHtml(plan, betrag, mitKarte, tagName = "Heute", nav = null) {
  if (!plan) return "";
  let html = `<ol class="tagesplan">`;
  plan.schritte.forEach((x, i) => {
    const o = x.option;
    if (i === 0 && mitKarte) {
      html += `<li class="jetzt"><div class="tagesplan-kopf"><span class="leiter-nr">1</span><span>${uhr(x.slot.t)} Uhr</span><span class="leise klein">${zahl(x.von, 2)} € → ${o.beine.some((b) => b.geschaetzt) ? "≈ " : ""}${zahl(x.von * o.quote, 2)} €</span></div>${vorschlagNav(nav)}${leiterKarte(o, 0, betrag)}</li>`;
      return;
    }
    html += `<li><div class="tagesplan-kopf"><span class="leiter-nr">${i + 1}</span><span>${uhr(x.slot.t)} Uhr</span><span class="leise klein">${zahl(x.von, 2)} € → ≈ ${zahl(x.von * o.quote, 2)} €</span></div>
      <ul class="kombi-beine">${o.beine.map((b) => `<li><span><span class="n">${esc(b.titel)}</span><span class="leise klein">${esc(b.heim)} gegen ${esc(b.gast)}</span></span><span class="leise klein">${b.geschaetzt ? "≈ " : ""}${zahl(b.quote, 2)} · ${prozent(b.p)}</span></li>`).join("")}</ul>
      <p class="leise klein">Quote ${o.beine.some((b) => b.geschaetzt) ? "≈ " : ""}${zahl(o.quote, 2)} · Chance ${prozent(o.p)}</p></li>`;
  });
  html += `</ol>`;
  const n = plan.schritte.length;
  html += `<p class="leiter-chance">${tagName} ${n === 1 ? "geht sich nur 1 Stufe aus" : `gehen sich ${n} Stufen aus`}. Gehen ${n === 1 ? "sie" : "alle"} auf, werden aus ${zahl(plan.schritte[0].von, 2)} € etwa <strong>${zahl(plan.betrag, 2)} €</strong>, Chance etwa <strong>${prozent(plan.chance)}</strong>${plan.chance < 0.5 ? ` (etwa 1 von ${Math.max(2, Math.round(1 / plan.chance))})` : ""}.</p>`;
  if (n > 1) html += `<p class="fussnote">Die späteren Stufen sind ein Vorschlag mit dem Stand von jetzt. Nach jeder gewonnenen Stufe rechnet die App neu, mit dem neuen Betrag, den Aufstellungen und deinen eingetippten Quoten.</p>`;
  return html;
}

function leiterSucheHtml(l, stand, plan) {
  const spiele = leiterSpiele();
  const quote = plan[0].quote;
  const [unten, oben] = leiterBand(quote);
  let html = `<section class="abschnitt" id="leiter-suche"><h2>Tipp für Stufe ${stand.stufe}</h2>
    <p>${zahl(stand.betrag, 2)} € sollen etwa ${zahl(stand.betrag * quote, 2)} € werden: Quote zwischen ${zahl(unten, 2)} und ${zahl(oben, 2)}, als Einzeltipp oder kleine Kombi. Der Tagesplan geht Stufe für Stufe durch den Tag, jede Stufe erst, wenn das Spiel davor vorbei ist.</p>`;
  if (!spiele.length) {
    leiterLetzte = [];
    return html + `<p class="leer">Gerade stehen keine Spiele mit genug Daten an. Die Tipps kommen mit dem nächsten Daten-Update (die App sammelt Spiele bis etwa 40 Stunden vor Anpfiff).</p></section>`;
  }
  const tage = [...new Set(spiele.map((x) => tagSchluessel(x.anstoss)))].sort();
  const tag = tage.includes(zustand.leiterTag) ? zustand.leiterTag : tage[0];
  const amTag = spiele.filter((x) => tagSchluessel(x.anstoss) === tag);
  const zeiten = [...new Set(amTag.map((x) => uhr(x.anstoss)))].sort();
  const zeit = zeiten.includes(zustand.leiterZeit) ? zustand.leiterZeit : "";
  const heuteS = tagSchluessel(Date.now() / 1000);
  const morgenS = tagSchluessel(Date.now() / 1000 + 86400);
  const name = (t) => (t === heuteS ? "Heute" : t === morgenS ? "Morgen" : fmtTagLang.format(mittag(t)));
  if (tage.length > 1) html += `<div class="wahl klein-wahl" role="group" aria-label="Tag">${tage.map((t) => `<button data-leiter-tag="${t}" aria-pressed="${t === tag}">${esc(name(t))}</button>`).join("")}</div>`;
  const anzahl = (z) => amTag.filter((x) => uhr(x.anstoss) === z).length;
  html += `<div class="wahl klein-wahl" role="group" aria-label="Anstoß"><button data-leiter-zeit="" aria-pressed="${!zeit}">Tagesplan</button>${zeiten.map((z) => `<button data-leiter-zeit="${z}" aria-pressed="${z === zeit}">${z} Uhr${anzahl(z) > 1 ? ` (${anzahl(z)})` : ""}</button>`).join("")}</div>`;
  const hinweis = `<p class="fussnote">Nur Wetten, die es bei Bet365 gibt: Torschützen, Endergebnis, Doppelte Chance, Tore, Team-Tore, beide treffen, Team-Spezialwetten, Handicap, Ecken und Gelbe Karten. Unter jedem Tipp steht, worauf die Chance beruht. Bei gleicher Quote steht vorne, was die höhere Chance hat. Trag nach dem Setzen die echte Quote ein: Mit ihr rechnet die App die nächste Stufe.</p>`;
  const schluessel = `${l.id}|${stand.stufe}|${tag}|${zeit}`;
  const gewaehlt = (zustand.leiterVorschlag || {}).schluessel === schluessel ? zustand.leiterVorschlag.i : 0;
  if (!zeit) {
    let tagesplan = leiterTagesplan(amTag, stand.betrag, l.ziel, l.faktor, Date.now() / 1000 + 300);
    if (!tagesplan) {
      leiterLetzte = [];
      return html + `<p class="leer">An diesem Tag gibt es keinen Tipp mit Quote zwischen ${zahl(unten, 2)} und ${zahl(oben, 2)}. Probier einen anderen Tag oder eine andere Quote je Stufe.</p></section>`;
    }
    // Anderer Tipp fuer die erste Stufe: die naechstbesten zur selben Anstosszeit, der Rest neu gerechnet
    const erster = tagesplan.schritte[0];
    const alternativen = erster.alternativen && erster.alternativen.length ? erster.alternativen : [erster.option];
    const i = Math.min(gewaehlt, alternativen.length - 1);
    if (i > 0) tagesplan = tagesplanMitErstem(amTag, l, stand.betrag, erster, alternativen[i]);
    leiterLetzte = [tagesplan.schritte[0].option];
    return html + tagesplanHtml(tagesplan, stand.betrag, true, tag === heuteS ? "Heute" : tag === morgenS ? "Morgen" : `Am ${fmtTagLang.format(mittag(tag))}`,
      { i, n: alternativen.length, schluessel })
      + (alternativen.length > 1 ? `<p class="fussnote">Mit „Anderer Tipp“ bekommst du den nächstbesten Vorschlag für ${uhr(erster.slot.t)} Uhr, der Rest des Tages rechnet sich dann neu. Andere Anstoßzeiten wählst du oben.</p>` : "")
      + hinweis + `</section>`;
  }
  const auswahl = amTag.filter((x) => uhr(x.anstoss) === zeit);
  if (auswahl.length) {
    html += `<p class="leise klein">${auswahl.map((x) => `${esc(kurzName(x.heim))} gegen ${esc(kurzName(x.gast))}`).join(" · ")}</p>`;
  }
  const optionen = leiterOptionen(leiterPool(auswahl), quote);
  // erst drei, mit "Weitere Tipps" je drei mehr
  const zeigen = optionen.slice(0, 3 * (1 + gewaehlt));
  leiterLetzte = zeigen;
  if (!optionen.length) {
    html += `<p class="leer">Für eine Quote zwischen ${zahl(unten, 2)} und ${zahl(oben, 2)} gibt es um diese Uhrzeit nichts Passendes. Probier eine andere Zeit oder den Tagesplan.</p>`;
  } else {
    html += zeigen.map((k, i) => leiterKarte(k, i, stand.betrag)).join("");
    if (optionen.length > zeigen.length) {
      html += `<button class="dazu mehr-knopf" data-leiter-vorschlag="${gewaehlt + 1}" data-schluessel="${esc(schluessel)}">Weitere Tipps (${optionen.length - zeigen.length})</button>`;
    }
    html += hinweis;
  }
  return html + `</section>`;
}

function leiterInhalt() {
  const l = leiterAktiv();
  let html = "";
  if (!l) {
    html += leiterFormHtml();
  } else {
    const stand = leiterStand(l);
    const erledigt = leiterWetten(l).filter((w) => w.status === "gewonnen").length;
    const planGanz = [...leiterPlan(l.start, l.ziel, l.faktor)];
    const rest = stand.verloren || stand.geschafft ? [] : leiterPlan(stand.betrag, l.ziel, l.faktor);
    const offenP = stand.offen ? stand.offen.p : null;
    const chance = rest.length ? leiterChance(rest, offenP) : stand.geschafft ? 1 : 0;
    html += `<section class="abschnitt leiter-kopf">
      <div class="paar">
        <div><div class="zahl">${zahl(stand.verloren ? 0 : stand.betrag, 2)} €</div><div class="leise klein">${stand.verloren ? "verloren" : stand.geschafft ? "geschafft" : stand.offen ? "gesetzt, Stufe läuft" : "jetzt im Spiel"}</div></div>
        <div><div class="zahl">${zahl(l.ziel, 0)} €</div><div class="leise klein">Ziel, Start ${zahl(l.start, 2)} €</div></div>
      </div>
      ${leiterPlanHtml(erledigt ? [...leiterWetten(l).filter((w) => w.status === "gewonnen").map((w) => ({ von: w.einsatz, bis: w.auszahlung ?? w.einsatz * w.quote, quote: w.quote })), ...rest] : planGanz, erledigt, stand.verloren || stand.geschafft ? -1 : erledigt)}
      ${rest.length ? `<p class="leiter-chance">Noch ${rest.length === 1 ? "1 Treffer" : `${rest.length} Treffer`} bis zum Ziel, Chance ungefähr <strong>${prozent(chance)}</strong>${chance < 0.5 ? ` (etwa 1 von ${Math.max(2, Math.round(1 / chance))})` : ""}.</p>` : ""}
    </section>`;
    if (stand.verloren) {
      html += `<section class="abschnitt"><h2>Leiter vorbei</h2><p>Die Stufe ${stand.stufe} ist nicht aufgegangen. Verloren sind die ${zahl(l.start, 2)} € Start, mehr nicht.</p>
        <button class="knopf" data-aktion="leiter-neu">Neue Leiter</button></section>`;
    } else if (stand.geschafft) {
      html += `<section class="abschnitt"><h2>Ziel erreicht</h2><p>Aus ${zahl(l.start, 2)} € sind ${zahl(stand.betrag, 2)} € geworden. Glückwunsch, das klappt nur selten.</p>
        <button class="knopf" data-aktion="leiter-neu">Neue Leiter</button></section>`;
    } else if (stand.offen) {
      html += `<section class="abschnitt"><h2>Stufe ${stand.stufe} läuft</h2>
        <p class="leise klein">Die App wertet automatisch aus, sobald die Spiele vorbei sind. Du kannst das Ergebnis auch selbst eintragen.</p>
        ${wetteKarte(stand.offen)}</section>`;
      // Vorschau: wie es danach am selben Tag weitergehen koennte
      const letzter = Math.max(...(stand.offen.tipps || []).map((t) => t.anstoss || 0));
      const danach = stand.offen.einsatz * stand.offen.quote;
      if (letzter && danach < l.ziel - 0.005) {
        const ab = letzter + LEITER_PAUSE_SEK;
        const amTag = leiterSpiele().filter((x) => tagSchluessel(x.anstoss) === tagSchluessel(letzter));
        const vorschau = leiterTagesplan(amTag, danach, l.ziel, l.faktor, ab);
        html += `<section class="abschnitt"><h2>Danach</h2><p>Geht die Stufe auf, kannst du ab ${uhr(ab)} Uhr mit ${zahl(danach, 2)} € weitermachen.</p>
          ${vorschau ? tagesplanHtml(vorschau, danach, false, "Danach") : `<p class="leer">Danach läuft an diesem Tag kein Spiel mehr mit passendem Tipp. Weiter geht es am nächsten Spieltag.</p>`}</section>`;
      }
    } else {
      html += leiterSucheHtml(l, stand, rest);
    }
    if (!stand.verloren && !stand.geschafft && !stand.offen) {
      const text = erledigt ? `Aussteigen und ${zahl(stand.betrag, 2)} € behalten` : "Leiter abbrechen";
      html += `<section class="abschnitt"><button class="leeren" data-aktion="leiter-aus">${zustand.leiterAusFrage ? `Wirklich? ${text}` : text}</button></section>`;
    }
  }
  const frueher = leiternLesen().filter((x) => !x.geloescht && x.status !== "laeuft").sort((a, b) => b.erstellt - a.erstellt).slice(0, 8);
  if (frueher.length) {
    html += `<section class="abschnitt"><h2>Frühere Leitern</h2><div class="markt-liste">${frueher.map((x) => {
      const st = leiterStand(x);
      const ende = st.verloren ? `<span class="rot">verloren auf Stufe ${st.stufe}</span>` : st.geschafft ? `<span class="gruen">Ziel erreicht, ${zahl(st.betrag, 2)} €</span>` : `ausgestiegen mit ${zahl(x.ende ?? st.betrag, 2)} €`;
      return `<div class="markt-reihe"><span>${zahl(x.start, 0)} € → ${zahl(x.ziel, 0)} €<span class="leise klein"> · ${esc(fmtKurz.format(new Date(x.erstellt)))}</span></span><span class="klein">${ende}</span></div>`;
    }).join("")}</div></section>`;
  }
  return html;
}

function leiterFormLesen() {
  const f = zustand.leiterForm || { start: "10", ziel: "100", faktor: 2 };
  const start = document.getElementById("leiter-start");
  const ziel = document.getElementById("leiter-ziel");
  zustand.leiterForm = { ...f, start: start ? start.value.trim() : f.start, ziel: ziel ? ziel.value.trim() : f.ziel };
}

// Fehler unter einem Formular anzeigen (ohne Browser-Dialog)
function alertLos(form, text) {
  let feld = form.nextElementSibling;
  if (!feld || !feld.classList.contains("fehler")) {
    feld = document.createElement("p");
    feld.className = "fehler";
    form.after(feld);
  }
  feld.textContent = text;
}

function zeigeLeiter() {
  app.innerHTML = `
    <header class="kopf">
      <h1>Verdoppeln</h1>
      <button class="rund" data-aktion="leiter-aktualisieren" aria-label="Aktualisieren">${ICON_NEU}</button>
    </header>
    <div id="leiter-inhalt">${leiterInhalt()}</div>
    ${fuss()}`;
  const l = leiterAktiv();
  if (l && leiterStand(l).offen) wettenAuswerten();
}

function leiterNeu() {
  const ziel = document.getElementById("leiter-inhalt");
  if (ziel) ziel.innerHTML = leiterInhalt();
  const leiste = app.querySelector(".unten");
  if (leiste) leiste.outerHTML = scheinLeiste();
}

function leiterStarten() {
  const f = zustand.leiterForm || { start: "10", ziel: "100", faktor: 2 };
  const start = einsatzLesen(f.start);
  const ziel = einsatzLesen(f.ziel);
  if (ziel < start * 1.2) return "Das Ziel muss mindestens 20 % über dem Start liegen.";
  for (const alt of leiternLesen().filter((x) => x.status === "laeuft" && !x.geloescht)) leiterAendern(alt.id, { status: "aus" });
  const leitern = leiternLesen();
  leitern.push({ id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, start, ziel, faktor: f.faktor,
                 status: "laeuft", erstellt: Date.now(), geaendert: Date.now(), geloescht: false });
  leiternSchreiben(leitern);
  spaeterAbgleichen();
  return "";
}

function leiterSetzen(index, quoteText) {
  const l = leiterAktiv();
  const k = leiterLetzte[index];
  if (!l || !k) return "Bitte neu laden.";
  const quote = quoteLesen(quoteText);
  if (!quote) return `Trag die echte ${k.beine.length > 1 ? "Gesamtquote" : "Quote"} von Bet365 ein.`;
  const stand = leiterStand(l);
  wetteNeu({
    art: "app",
    einsatz: stand.betrag,
    quote: runden2(quote),
    p: runden2(k.p * 10000) / 10000,
    leiter: { id: l.id, stufe: stand.stufe },
    tipps: k.beine.map((b) => ({ spiel: b.spiel, k: b.k, titel: b.titel, p: b.p, anstoss: b.anstoss, heim: b.heim, gast: b.gast })),
  });
  return "";
}

/* ------------------------------------------------------------------- Bilanz */

const MARKT_NAMEN = {
  schuesse: "Schüsse", aufs_tor: "Schüsse aufs Tor", gefoult: "Gefoult werden", fouls: "Fouls begehen",
  gelb: "Gelbe Karte (Spieler)", ecken: "Ecken im Spiel", team_ecken: "Ecken je Team", gelb_gesamt: "Gelbe Karten im Spiel",
};

function vergleichsBalken(titel, vorhergesagt, eingetroffen, n) {
  return `
    <div class="kal">
      <div class="kal-kopf"><span>${titel}</span><span class="leise klein">${n} Tipps</span></div>
      <div class="kal-reihe"><span class="leise klein">Modell</span><div class="kal-spur"><div style="width:${Math.round(vorhergesagt * 100)}%"></div></div><span class="zahl">${prozent(vorhergesagt)}</span></div>
      <div class="kal-reihe"><span class="leise klein">Echt</span><div class="kal-spur echt"><div style="width:${Math.round(eingetroffen * 100)}%"></div></div><span class="zahl">${prozent(eingetroffen)}</span></div>
    </div>`;
}

function zeigeBilanz() {
  const m = zustand.daten.modell;
  let html = `
    <header class="kopf">
      <button class="rund" data-aktion="zurueck" aria-label="Zurück">${ICON_ZURUECK}</button>
      <h1>Bilanz</h1>
      <span style="width:44px" aria-hidden="true"></span>
    </header>`;
  if (!m) {
    app.innerHTML = html + `<p class="leer">Die Bilanz kommt mit dem nächsten Daten-Update.</p>` + fuss();
    return;
  }
  const t = m.tagebuch;
  const r = m.rueckblick;

  // Wo lag die App richtig, wo daneben? Alle Prognosen vor dem Anpfiff, nach dem Spiel ausgewertet
  const jm = t.je_markt;
  if (jm && jm.n) {
    const urteil = (d) => (Math.abs(d) <= 0.02 ? '<span class="gruen">passt</span>'
      : d < 0 ? `<span class="rot">App zu optimistisch (−${Math.round(-d * 100)} Pkt.)</span>`
      : `<span class="gelb">App zu vorsichtig (+${Math.round(d * 100)} Pkt.)</span>`);
    html += `<section class="abschnitt"><h2>Wo die App richtig lag</h2>
      <p>Alle Tipps, die vor dem Anpfiff in der App standen, nach dem Spiel ausgewertet: ${jm.n.toLocaleString("de-AT")} Tipps seit ${esc(fmtDatum.format(new Date(jm.seit * 1000)))}. Sagt die App 60 %, sollte es etwa 6 von 10 Mal klappen.</p>
      <div class="markt-liste">${jm.maerkte.map((x) => `<div class="markt-reihe"><span>${esc(x.name)}<span class="leise klein"> · ${x.n.toLocaleString("de-AT")} Tipps</span></span><span class="klein">${prozent(x.gesagt)} gesagt, ${prozent(x.echt)} echt · ${urteil(x.echt - x.gesagt)}</span></div>`).join("")}</div>
      ${jm.stufen.length ? `<h3 class="unterkopf">Nach Chance</h3>
      <div class="markt-liste">${jm.stufen.map((x) => `<div class="markt-reihe"><span>App sagte ${Math.round(x.von * 100)} bis ${Math.round(x.von * 100) + 10} %</span><span class="klein">eingetroffen ${prozent(x.echt)}<span class="leise"> · ${x.n.toLocaleString("de-AT")}</span></span></div>`).join("")}</div>` : ""}
      <p class="fussnote">Nur Märkte, die es bei Bet365 gibt. Was die App daraus lernt, fließt jeden Tag in die Chancen ein. Endergebnis, Tore und Ecken werden seit 05.11. mitgeschrieben, Torschützen und Spielhälfte mit den meisten Toren seit 06.11.</p>
    </section>`;
  }

  // Tipps mit Wert: das, worauf es ankommt, ist Gewinn oder Verlust
  const w = t.wert;
  html += `<section class="abschnitt"><h2>Tipps mit Wert</h2>`;
  if (!w || !w.n) {
    html += `<p>Seit dem 24.10. zeigt die App nur noch Tipps, bei denen Bet365 mehr zahlt, als sie wert sind. Hier steht, was dabei herausgekommen wäre, wenn man auf jeden Tipp 1 € gesetzt hätte.</p>
      <p class="leer" style="padding:12px 0">${w && w.offen ? `${w.offen} Tipps warten auf die Auswertung.` : "Noch kein Tipp mit Wert ausgewertet."}</p>`;
  } else {
    const plus = w.gewinn >= 0;
    html += `
      <p>Wenn man auf jeden Tipp mit Wert 1 € gesetzt hätte, zur Bet365-Quote vom letzten Daten-Update vor dem Anpfiff:</p>
      <div class="paar wert-bilanz">
        <div><div class="zahl ${plus ? "plus" : "minus"}">${mitVorzeichen(w.gewinn, 2)} €</div><div class="leise klein">bei ${w.einsatz} € Einsatz (${mitVorzeichen(w.rendite, 1)} %)</div></div>
        <div><div class="zahl">${w.gewonnen} / ${w.n}</div><div class="leise klein">gewonnen, erwartet ${zahl(w.erwartet_treffer, 1)}</div></div>
      </div>
      <p class="fussnote">Erwartet war eine Rendite von ${mitVorzeichen(w.erwartete_rendite, 1)} %. ${w.n < 100 ? "Bei weniger als 100 Tipps entscheidet noch sehr viel der Zufall, auch eine gute Methode kann so lange im Minus sein." : ""}</p>
      <ul class="ergebnis-liste">${w.letzte.slice(0, 20).map((x) => {
        const zeichen = x.ergebnis === 1 || x.ergebnis === 3 ? '<i class="ja">✓</i>' : x.ergebnis === 0 || x.ergebnis === 4 ? '<i class="nein">✗</i>' : x.ergebnis === 2 || x.ergebnis === -1 ? '<i class="leer-zeichen">zurück</i>' : '<i class="leer-zeichen">offen</i>';
        return `<li>${zeichen}<span>${esc(x.titel)}<span class="leise klein"> · ${esc(x.heim)} gegen ${esc(x.gast)}</span></span><span class="leise klein">${zahl(x.quote, 2)}</span></li>`;
      }).join("")}</ul>`;
  }
  html += `</section>`;

  // Wie gut schaetzt die App die Bet365-Quoten?
  const sch = schaetzer();
  html += `<section class="abschnitt"><h2>Bet365-Schätzung</h2>`;
  if (!sch.anzahl) {
    html += `<p>Jede Bet365-Quote, die du eintippst (bei „Tipps zum Prüfen“ oder im Schein), bringt der App bei, wie Bet365 rechnet. Hier steht dann, wie genau die Schätzung schon ist.</p><p class="leer" style="padding:12px 0">Noch keine Quote eingetippt.</p>`;
  } else {
    const zeilen = Object.entries(sch.fehler).map(([g, liste]) => [g, liste.length, liste.reduce((a, x) => a + x, 0) / liste.length]).sort((a, b) => b[1] - a[1]);
    const gesamt = Object.values(sch.fehler).flat();
    const mittel = gesamt.reduce((a, x) => a + x, 0) / gesamt.length;
    html += `
      <p>So weit lag die geschätzte Quote im Schnitt neben der echten, die du eingetippt hast. Jede Quote wird dabei ohne sich selbst geschätzt, wie bei einer neuen Wette.</p>
      <div class="paar">
        <div><div class="zahl">${sch.anzahl}</div><div class="leise klein">Quoten eingetippt</div></div>
        <div><div class="zahl">${Math.round(mittel * 100)} %</div><div class="leise klein">daneben im Schnitt</div></div>
      </div>
      <div class="markt-liste">${zeilen.map(([g, n, f]) => `<div class="markt-reihe"><span>${esc(gruppenName(g))}</span><span class="leise klein">${n} ${n === 1 ? "Quote" : "Quoten"}, ${Math.round(f * 100)} % daneben</span></div>`).join("")}</div>
      <p class="fussnote">Bei unter 10 Quoten pro Markt rechnet die App noch stark mit Vorwissen.</p>`;
  }
  const versteckt = b365Lesen().filter((e) => e.fehlt && !e.geloescht);
  if (versteckt.length) {
    html += `<h3 class="unterkopf">Bei Bet365 nicht gefunden</h3>
      <div class="markt-liste">${versteckt.map((e) => `<div class="markt-reihe"><span>${esc(gruppenName(e.gruppe))}<span class="leise klein"> · ${esc(e.liga || "alle")}</span></span><button class="link-knopf" data-b365-zurueck="${esc(JSON.stringify([e.liga, e.gruppe]))}">wieder zeigen</button></div>`).join("")}</div>`;
  }
  html += `</section>`;

  html += `
    <section class="abschnitt">
      <h2>Rückblick-Test Torschützen</h2>
      <p>Das Torschützen-Modell hat 2.384 bereits gespielte Team-Spiele nachgerechnet, jeweils nur mit den Daten von vor dem Anpfiff und mit der echten Startelf, mit Einwechslung+ wie bei Bet365.</p>
      <div class="paar">
        <div><div class="zahl">13,8 %</div><div class="leise klein">der Startelf-Spieler sollten treffen</div></div>
        <div><div class="zahl">14,2 %</div><div class="leise klein">haben getroffen</div></div>
      </div>
      <div class="markt-liste">
        <div class="markt-reihe"><span>Stürmer</span><span class="klein">29,1 % gesagt, 28,6 % echt</span></div>
        <div class="markt-reihe"><span>Mittelfeld</span><span class="klein">12,3 % gesagt, 13,7 % echt</span></div>
        <div class="markt-reihe"><span>Abwehr</span><span class="klein">4,9 % gesagt, 5,1 % echt</span></div>
      </div>
      <p class="fussnote">Besser als nur nach Position zu gehen, aber Bet365 kennt dieselben Zahlen. Wert gibt es nur, wenn Bet365 einen Spieler unterschätzt. Ab jetzt schreibt das Tagebuch jeden Torschützen mit, die Bilanz oben zeigt dann, wie es im echten Einsatz läuft.</p>
    </section>`;

  html += `
    <section class="abschnitt">
      <h2>So liest du das</h2>
      <div class="erklaerung">
        <p><strong>Faire Quote</strong> ist 1 geteilt durch die Wahrscheinlichkeit. Bei 80 % sind das 1,25. Sie ist nicht die Quote von Bet365, sondern die Schwelle: Lohnend wird ein Tipp erst ab etwa 10 % darüber („lohnt ab“). Zahlt Bet365 weniger, verliert man auf Dauer, auch wenn der Tipp oft aufgeht.</p>
        <p><strong>Einwechslung+:</strong> Bei Bet365 zählt bei Torschützen nach einer Auswechslung der Einwechselspieler weiter. Das Modell rechnet die Restminuten deshalb mit einem Ersatzspieler derselben Position, und der Live-Tracker zählt den Einwechselspieler mit.</p>
        <p><strong>Wahrscheinlich heißt nicht sicher.</strong> Von zehn 80-%-Tipps gehen im Schnitt zwei verloren. Ein Kombischein aus fünf solchen Tipps geht nur in etwa jedem dritten Fall durch.</p>
        <p><strong>Nicht ins Modell fließen:</strong> Taktik-Ansagen, Wetter, Motivation, Rotation vor wichtigen Spielen und kurzfristige Ausfälle nach dem letzten Daten-Update.</p>
      </div>
    </section>`;
  app.innerHTML = html + fuss();
}

/* -------------------------------------------------------- Wochenplan, live */

/* Live-Daten holt die App direkt von FotMob (die Schnittstelle erlaubt Abrufe
   aus dem Browser). Alles andere kommt aus den verschluesselten Daten. */
const FOTMOB = "https://www.fotmob.com/api/data/";
const LIVE_TAKT_SPIEL = 30000;
const LIVE_TAKT_LISTE = 60000;
const TAGE_ZURUECK = 3;
const TAGE_VORAUS = 7;
const REIHENFOLGE = [42, 73, 10216, 38, 47, 87, 55, 54, 53, 57, 61, 40, 9806];

const liveListe = new Map(); // Spiel-ID -> Stand aus der FotMob-Tagesliste
const liveDetails = new Map(); // Spiel-ID -> {d: matchDetails, geholt: ms}
let liveTimer = null;

function timerStoppen() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
}

/* Der Zwischenspeicher von FotMob liefert manchmal eine Antwort ohne die Freigabe
   fuer Browser-Abrufe aus, wenn sie zuvor ohne Browser abgerufen wurde. Ein
   Zeitfenster-Parameter sorgt fuer einen eigenen Eintrag mit Freigabe, der fuer
   das ganze Fenster wiederverwendet wird. So entsteht hoechstens eine Anfrage
   pro Fenster bei FotMob selbst. */
async function fotmob(pfad, fensterMs = LIVE_TAKT_SPIEL) {
  const fenster = Math.floor(Date.now() / fensterMs);
  let letzterFehler = null;
  for (const zusatz of [`${fenster}`, `${fenster}w`]) {
    try {
      const antwort = await fetch(`${FOTMOB}${pfad}&t=${zusatz}`);
      if (!antwort.ok) throw new Error(`FotMob antwortet mit ${antwort.status}`);
      return await antwort.json();
    } catch (fehler) {
      letzterFehler = fehler;
    }
  }
  throw letzterFehler;
}

const ohneSteuerzeichen = (text) => String(text || "").replace(/[‎‏’’']/g, "").trim();

const STATUS_KURZ = { HT: "HZ", FT: "Ende", AET: "n. V.", AP: "i. E.", Pen: "i. E.", PP: "verlegt", Ab: "abgebr.", Can: "abges." };

// Stand aus einem FotMob-Status (Tagesliste oder matchDetails)
function standAus(status, heimTore, gastTore) {
  const st = status || {};
  let h = heimTore;
  let g = gastTore;
  if (st.scoreStr) {
    const teile = st.scoreStr.split("-").map((x) => parseInt(x, 10));
    if (teile.length === 2 && !teile.some(Number.isNaN)) [h, g] = teile;
  }
  const kurz = (st.reason && st.reason.short) || "";
  let art = "notstarted";
  if (st.cancelled) art = "cancelled";
  else if (st.finished) art = "finished";
  else if (st.started || st.ongoing) art = "inprogress";
  let minute = "";
  if (art === "inprogress") {
    minute = ohneSteuerzeichen(st.liveTime && st.liveTime.short) || STATUS_KURZ[kurz] || "live";
    if (/^\d/.test(minute)) minute += "′";
    else minute = STATUS_KURZ[minute] || minute;
  } else if (art === "finished") {
    minute = STATUS_KURZ[kurz] || "Ende";
  }
  return { art, h, g, minute, zeit: Date.now() };
}

// Stand eines Spiels: was die Live-Abfrage weiss, sonst die Daten vom letzten Sammler-Lauf
function stand(eintrag) {
  const live = liveListe.get(eintrag.id);
  if (live) return live;
  const art = eintrag.status || "notstarted";
  return {
    art,
    h: eintrag.heim_tore,
    g: eintrag.gast_tore,
    minute: art === "finished" ? "Ende" : art === "inprogress" ? "live" : "",
    alt: true,
  };
}

function wochenplan() {
  const d = zustand.daten;
  if (d.wochenplan) return d.wochenplan;
  // aeltere Daten ohne Wochenplan
  return d.spiele.map((s) => ({
    id: s.id, anstoss: s.anstoss, status: s.status, w: 42, heim_id: s.heim.id, heim: s.heim.name,
    gast_id: s.gast.id, gast: s.gast.name, heim_tore: s.heim_tore, gast_tore: s.gast_tore,
  }));
}

// Uebersicht eines Spiels (bei geteilten Daten ohne Analyse, sonst das volle Spiel)
const spielInfo = (id) => zustand.daten.spiele.find((s) => s.id === id) || null;
// Spiel mit voller Analyse, falls schon geladen
const vollesSpiel = (id) => (zustand.daten.geteilt ? zustand.volle.get(id) || null : spielInfo(id));

// Laedt die Analyse eines Spiels aus spiele/<id>.enc. Mehrfache Aufrufe teilen sich einen Abruf.
function spielLaden(id) {
  const d = zustand.daten;
  const fertig = vollesSpiel(id);
  if (fertig || !d.geteilt) return Promise.resolve(fertig);
  if (!spielInfo(id)) return Promise.resolve(null);
  if (!zustand.ladend.has(id)) {
    const generation = zustand.generation;
    const passwort = zustand.passwort;
    const versprechen = (async () => {
      let antwort;
      try {
        antwort = await fetch(`spiele/${id}.enc?v=${d.stand}`, { cache: "no-store" });
      } catch (e) {
        throw new Error("Keine Verbindung. Prüfe dein Internet und versuche es noch einmal.");
      }
      if (antwort.status === 404) throw new Error("Die Daten wurden inzwischen aktualisiert. Bitte neu laden.");
      if (!antwort.ok) throw new Error(`Die Analyse konnte nicht geladen werden (Fehler ${antwort.status}).`);
      const s = await entschluesseln(await antwort.json(), passwort);
      if (generation === zustand.generation) zustand.volle.set(id, s);
      return s;
    })();
    zustand.ladend.set(id, versprechen);
    versprechen.then(() => zustand.ladend.delete(id), () => zustand.ladend.delete(id));
  }
  return zustand.ladend.get(id);
}
const planEintrag = (id) => wochenplan().find((m) => m.id === id) || null;

function wettbewerbName(w) {
  const namen = zustand.daten.wettbewerbe || {};
  return namen[String(w)] || "Weitere";
}

// Kalendertage unabhaengig von der Zeitumstellung
function tagVerschieben(schluessel, tage) {
  const [j, m, t] = schluessel.split("-").map(Number);
  return new Date(Date.UTC(j, m - 1, t + tage, 12)).toISOString().slice(0, 10);
}
const fmtWochentag = new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", weekday: "short" });
const fmtTagLang = new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
const fmtTagZahl = new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", day: "2-digit", month: "2-digit" });
const mittag = (schluessel) => new Date(`${schluessel}T12:00:00Z`);

function tagesreiter(gewaehlt, proTag) {
  const heute = tagSchluessel(Date.now() / 1000);
  let html = `<nav class="tage" aria-label="Tage">`;
  for (let i = -TAGE_ZURUECK; i <= TAGE_VORAUS; i++) {
    const k = tagVerschieben(heute, i);
    const name = i === 0 ? "Heute" : i === 1 ? "Morgen" : i === -1 ? "Gestern" : fmtWochentag.format(mittag(k)).replace(".", "");
    const spiele = proTag.get(k) || [];
    const live = spiele.some((m) => stand(m).art === "inprogress" && Date.now() - m.anstoss * 1000 < 3.5 * 3600000);
    html += `
      <button class="tag-knopf${spiele.length ? "" : " leer-tag"}" data-tag="${k}" aria-pressed="${k === gewaehlt}">
        <span class="w">${esc(name)}</span><span class="d">${esc(fmtTagZahl.format(mittag(k)))}</span>
        ${live ? '<i class="live-punkt" aria-label="live"></i>' : ""}
      </button>`;
  }
  return html + `</nav>`;
}

function planZeile(m) {
  const st = stand(m);
  const voll = spielInfo(m.id);
  const tippAnzahl = voll ? (voll.prognose ? (voll.prognose.wert || []).length : voll.tipps || 0) : 0;
  const topAnzahl = voll ? (voll.prognose ? topSchluessel(voll.prognose.wert).size : voll.top || 0) : 0;
  let links = `<span class="uhr">${uhr(m.anstoss)}</span>`;
  let rechts = "";
  if (st.art === "inprogress") {
    links = `<span class="uhr live">${esc(st.minute)}</span>`;
    rechts = `<span class="ergebnis live">${st.h ?? 0}:${st.g ?? 0}</span>`;
  } else if (st.art === "finished") {
    links = `<span class="uhr fertig">${esc(st.minute || "Ende")}</span>`;
    rechts = `<span class="ergebnis">${st.h ?? "-"}:${st.g ?? "-"}</span>`;
  } else if (st.art === "cancelled") {
    links = `<span class="uhr fertig">abges.</span>`;
  } else if (voll) {
    rechts = `<span class="rechts${voll.aufstellung === "standard" ? " fix" : ""}">${tippAnzahl ? `<span class="tipps-marke${topAnzahl ? " top" : ""}">${topAnzahl ? "★ " : ""}${tippAnzahl === 1 ? "1 Tipp" : `${tippAnzahl} Tipps`}</span>` : ""}${voll.aufstellung === "standard" ? "<br>Aufstellung fix" : ""}</span>`;
  }
  const ziel = voll ? `data-spiel="${m.id}"` : `data-partie="${m.id}"`;
  const sieger = st.art === "finished" && st.h != null && st.g != null ? (st.h > st.g ? "h" : st.g > st.h ? "g" : "") : "";
  return `
    <button class="zeile" ${ziel}>
      ${links}
      <span class="teams"><span class="${sieger === "h" ? "sieger" : ""}">${logo(m.heim_id)}${esc(m.heim)}</span><span class="${sieger === "g" ? "sieger" : ""}">${logo(m.gast_id)}${esc(m.gast)}</span></span>
      ${rechts}
    </button>`;
}

function zeigeSpielplan(tag, optionen = {}) {
  const proTag = new Map();
  for (const m of wochenplan()) {
    const k = tagSchluessel(m.anstoss);
    if (!proTag.has(k)) proTag.set(k, []);
    proTag.get(k).push(m);
  }
  const heute = tagSchluessel(Date.now() / 1000);
  const gewaehlt = tag || zustand.tag || heute;
  zustand.tag = gewaehlt;
  const spiele = proTag.get(gewaehlt) || [];

  let html = `
    <header class="kopf">
      <h1>Spiele</h1>
      <div class="knoepfe">
        <button class="text-knopf" data-aktion="bilanz">${ICON_BILANZ}Bilanz</button>
        <button class="rund" data-aktion="neu" aria-label="Daten neu laden">${ICON_NEU}</button>
      </div>
    </header>
    ${tagesreiter(gewaehlt, proTag)}
    <div class="tag"><strong>${esc(fmtTagLang.format(mittag(gewaehlt)))}</strong></div>`;

  if (!spiele.length) {
    html += `<p class="leer">An diesem Tag spielt keiner der Wettbewerbe, die die App verfolgt.</p>`;
  }
  const gruppen = new Map();
  for (const m of spiele) {
    if (!gruppen.has(m.w)) gruppen.set(m.w, []);
    gruppen.get(m.w).push(m);
  }
  const ordnung = (w) => { const i = REIHENFOLGE.indexOf(Number(w)); return i < 0 ? 99 : i; };
  for (const [w, liste] of [...gruppen.entries()].sort((a, b) => ordnung(a[0]) - ordnung(b[0]))) {
    const mitTipps = liste.some((m) => spielInfo(m.id));
    html += `
      <div class="wettbewerb-kopf"><span>${esc(wettbewerbName(w))}</span>${mitTipps ? '<span class="leise klein">mit Tipps</span>' : ""}</div>
      <div>${liste.map(planZeile).join("")}</div>`;
  }
  const scrollY = window.scrollY;
  const alteLeiste = app.querySelector(".tage");
  const scrollX = alteLeiste ? alteLeiste.scrollLeft : null;
  app.innerHTML = html + fuss();
  const leiste = app.querySelector(".tage");
  const aktiv = leiste && leiste.querySelector('[aria-pressed="true"]');
  if (leiste && scrollX != null && (optionen.leisteBehalten || optionen.vomTimer)) leiste.scrollLeft = scrollX;
  else if (leiste && aktiv) leiste.scrollLeft = aktiv.offsetLeft - (leiste.clientWidth - aktiv.offsetWidth) / 2;
  if (optionen.vomTimer) window.scrollTo(0, scrollY);
  if (!optionen.vomTimer) listeLiveStarten(spiele);
}

// Laufende oder gerade beendete Spiele des Tages regelmaessig bei FotMob nachsehen
function listeLiveStarten(spiele) {
  timerStoppen();
  const offen = () =>
    spiele.filter((m) => {
      if (m.anstoss * 1000 > Date.now() + 60000) return false;
      if (m.status === "finished" && !liveListe.has(m.id)) return false;
      const st = stand(m);
      if (st.art === "finished" || st.art === "cancelled") return false;
      return st.art === "inprogress" || Date.now() - m.anstoss * 1000 < 4 * 3600000;
    });
  if (!offen().length) return;
  const runde = async () => {
    if (document.hidden) return;
    const kandidaten = offen();
    if (!kandidaten.length) { timerStoppen(); return; }
    const daten = new Set(kandidaten.map((m) => new Date(m.anstoss * 1000).toISOString().slice(0, 10).replace(/-/g, "")));
    let geaendert = false;
    for (const datum of daten) {
      try {
        const liste = await fotmob(`matches?date=${datum}`, LIVE_TAKT_LISTE);
        for (const liga of liste.leagues || []) {
          for (const x of liga.matches || []) {
            if (!kandidaten.some((m) => m.id === x.id)) continue;
            const neu = standAus(x.status, x.home && x.home.score, x.away && x.away.score);
            const alt = liveListe.get(x.id);
            if (!alt || alt.art !== neu.art || alt.h !== neu.h || alt.g !== neu.g || alt.minute !== neu.minute) geaendert = true;
            liveListe.set(x.id, neu);
          }
        }
      } catch (e) { /* ohne Netz bleibt der letzte Stand stehen */ }
    }
    const teile = location.hash.replace(/^#\/?/, "").split("/");
    if (geaendert && (teile[0] === "" || teile[0] === "tag")) zeigeSpielplan(zustand.tag, { vomTimer: true });
  };
  runde();
  liveTimer = setInterval(runde, LIVE_TAKT_LISTE);
}

/* Spieldetails von FotMob auswerten */

function flacheWerte(gruppen) {
  const werte = {};
  for (const gruppe of gruppen || []) {
    const eintraege = Array.isArray(gruppe.stats) ? gruppe.stats : Object.values(gruppe.stats || {});
    for (const e of eintraege) {
      if (!e || !e.key || e.key in werte) continue;
      if (e.stat) {
        werte[e.key] = e.stat.value;
        if (e.stat.total != null) werte[`${e.key}__total`] = e.stat.total;
      }
      else if (Array.isArray(e.stats) && e.type !== "title") werte[e.key] = e.stats;
    }
  }
  return werte;
}

function liveLesen(d) {
  const kopf = d.header || {};
  const teams = kopf.teams || [];
  const inhalt = d.content || {};
  const fakten = inhalt.matchFacts || {};
  const ereignisse = ((fakten.events || {}).events || []).filter((e) => !e.isPenaltyShootoutEvent);
  const perioden = (inhalt.stats && inhalt.stats.Periods) || {};
  const statistik = flacheWerte((perioden.All || {}).stats);
  const statistik_hz1 = flacheWerte((perioden.FirstHalf || {}).stats);
  const statistik_hz2 = flacheWerte((perioden.SecondHalf || {}).stats);
  const spieler = {};
  for (const p of Object.values(inhalt.playerStats || {})) {
    if (p && p.id != null) spieler[String(p.id)] = { name: p.name, team: p.teamId, werte: flacheWerte(p.stats) };
  }
  const allgemein = d.general || {};
  const status = kopf.status || {};
  const zeitText = ohneSteuerzeichen((status.liveTime && status.liveTime.short) || "");
  const pause = /^(HT|Pause|Halbzeit)/i.test(zeitText) || ((status.reason || {}).short === "HT");
  return {
    id: Number(allgemein.matchId),
    zeitText,
    pause,
    heim: teams[0] || {},
    gast: teams[1] || {},
    stand: standAus(kopf.status, teams[0] && teams[0].score, teams[1] && teams[1].score),
    anstoss: kopf.status && kopf.status.utcTime ? Date.parse(kopf.status.utcTime) / 1000 : null,
    wettbewerb: allgemein.leagueName,
    runde: allgemein.leagueRoundName,
    ereignisse,
    statistik,
    statistik_hz1,
    statistik_hz2,
    spieler,
    aufstellung: aufstellungLesen(inhalt),
  };
}

async function liveHolen(id) {
  const d = await fotmob(`matchDetails?matchId=${id}`);
  const live = liveLesen(d);
  liveDetails.set(id, { live, geholt: Date.now() });
  liveListe.set(id, live.stand);
  return live;
}

/* Tipp-Stand live: Schluessel "markt|linie|richtung|spieler|team" */

const STAT_SCHLUESSEL = {
  schuesse: "total_shots", aufs_tor: "ShotsOnTarget", gefoult: "was_fouled", fouls: "fouls",
  tacklings: "matchstats.headers.tackles", paesse: "accurate_passes__total", paraden: "saves",
};
// Teamwerte (gleich wie teammaerkte.ZAEHLWERTE in Python)
const TEAM_STAT = {
  ecken: "corners", schuesse: "total_shots", aufs_tor: "ShotsOnTarget", fouls: "fouls", karten: "yellow_cards",
  abseits: "Offsides", einwuerfe: "player_throws", paraden: "keeper_saves", paesse: "passes",
  tacklings: "matchstats.headers.tackles", zweikaempfe: "duel_won",
};

function zahlAus(wert) {
  if (wert == null) return 0;
  const n = parseFloat(String(wert).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function teamWert(live, schluessel, seite) {
  const w = live.statistik[schluessel];
  if (!Array.isArray(w)) return null;
  return zahlAus(w[seite === "heim" ? 0 : 1]);
}

// Bet365 "Sub On Play On": Wird ein Spieler ausgewechselt, zaehlt sein Einwechselspieler weiter
const SUB_PLUS = true;

function ersatzKette(live, spielerId) {
  const ids = [spielerId];
  for (let i = 0; i < 3; i++) {
    const e = live.ereignisse.find((x) => x.type === "Substitution" && x.swap && x.swap[1] && String(x.swap[1].id) === ids[ids.length - 1]);
    if (!e || !e.swap[0] || e.swap[0].id == null) break;
    ids.push(String(e.swap[0].id));
  }
  return ids;
}

function liveWert(live, id, markt) {
  if (markt === "gelb") {
    return live.ereignisse.filter((e) => e.type === "Card" && String((e.player || {}).id) === id && /yellow/i.test(e.card || "")).length;
  }
  const p = live.spieler[id];
  if (!p) return 0;
  if (markt === "schuesse" && p.werte.total_shots == null) {
    return zahlAus(p.werte.ShotsOnTarget) + zahlAus(p.werte.ShotsOffTarget) + zahlAus(p.werte.blocked_shots);
  }
  return zahlAus(p.werte[STAT_SCHLUESSEL[markt]]);
}

// Torschuetzen (Einwechslung+): Eigentore zaehlen nicht. Erster Torschuetze: das erste Tor, das kein Eigentor ist.
function torStand(markt, spielerText, live) {
  const fertig = live.stand.art === "finished";
  const ids = String(spielerText).split("+");
  const ketten = ids.map((id) => (SUB_PLUS ? ersatzKette(live, id) : [id]));
  const alle = new Set(ketten.flat());
  const tore = live.ereignisse
    .filter((e) => e.type === "Goal" && !e.ownGoal && e.player && e.player.id != null)
    .sort((a, b) => (Number(a.time) - Number(b.time)) || ((a.overloadTime || 0) - (b.overloadTime || 0)));
  const gespielt = ids.some((id) => live.spieler[id] && zahlAus(live.spieler[id].werte.minutes_played) > 0);
  const nameVon = (e) => e.nameStr || (e.player || {}).name || "";
  if (markt.endsWith("_erster")) {
    if (!tore.length) return { wert: 0, ziel: 1, status: fertig ? (gespielt ? "raus" : "ungueltig") : "offen", notiz: fertig ? "kein Tor" : "noch kein Tor" };
    const treffer = alle.has(String(tore[0].player.id));
    return { wert: treffer ? 1 : 0, ziel: 1, status: treffer ? "drin" : "raus", notiz: treffer ? "" : `erstes Tor: ${nameVon(tore[0])}` };
  }
  const wert = tore.filter((e) => alle.has(String(e.player.id))).length;
  if (wert >= 1) return { wert, ziel: 1, status: "drin", notiz: "" };
  if (fertig && !gespielt) return { wert, ziel: 1, status: "ungueltig", notiz: "nicht eingesetzt, bei Bet365 meist ungültig" };
  // Kann noch ein Tor kommen? Nicht, wenn alle Ketten raus sind (ausgewechselt ohne Ersatz oder Rot)
  const vorbei = ketten.every((kette) => {
    const letzter = kette[kette.length - 1];
    return live.ereignisse.some((e) => (e.type === "Substitution" && e.swap && e.swap[1] && String(e.swap[1].id) === letzter)
      || (e.type === "Card" && String((e.player || {}).id) === letzter && /red/i.test(e.card || "")));
  });
  let notiz = "";
  if (ketten.some((kette) => kette.length > 1)) {
    const ersatz = ketten.map((kette) => live.spieler[kette[kette.length - 1]]).filter(Boolean).map((x) => x.name);
    if (ersatz.length) notiz = `zählt mit ${ersatz.join(" und ")} weiter`;
  }
  return { wert, ziel: 1, status: fertig || vorbei ? "raus" : "offen", notiz };
}

function tippStand(k, live) {
  const [markt, linieText, richtung, spielerId, teamId] = k.split("|");
  if (markt.startsWith("torschuetze")) return torStand(markt, spielerId, live);
  const linie = Number(linieText);
  const fertig = live.stand.art === "finished";
  const ergebnis = (wert, ziel, drin, raus, notiz = "") => ({
    wert, ziel, notiz, status: drin ? "drin" : raus ? "raus" : "offen",
  });
  if (spielerId) {
    const p = live.spieler[spielerId];
    const kette = SUB_PLUS ? ersatzKette(live, spielerId) : [spielerId];
    const letzter = kette[kette.length - 1];
    const wert = kette.reduce((summe, id) => summe + liveWert(live, id, markt), 0);
    // Kann noch etwas dazukommen? Nicht, wenn der letzte in der Kette raus ist oder Rot sah
    const letzterRaus = live.ereignisse.some((e) => e.type === "Substitution" && e.swap && e.swap[1] && String(e.swap[1].id) === letzter);
    const rot = live.ereignisse.some((e) => e.type === "Card" && String((e.player || {}).id) === letzter && /red/i.test(e.card || ""));
    const minuten = p ? zahlAus(p.werte.minutes_played) : 0;
    const unter = richtung === "unter";
    const drin = unter ? fertig && wert < linie : wert >= linie;
    let notiz = "";
    if (kette.length > 1) {
      const ersatz = live.spieler[letzter];
      notiz = `ausgewechselt, zählt mit ${ersatz ? ersatz.name : "Ersatzspieler"} weiter`;
    }
    if (!drin && rot) notiz = "vom Platz gestellt";
    else if (!drin && letzterRaus) notiz = "ausgewechselt";
    else if (live.stand.art !== "notstarted" && !p && !fertig) notiz = "noch nicht eingesetzt";
    else if (fertig && !minuten && kette.length === 1 && !drin) {
      return { wert, ziel: linie, notiz: "nicht eingesetzt, bei Bet365 meist ungültig", status: "ungueltig" };
    }
    if (unter) return ergebnis(wert, linie, drin, wert >= linie, notiz);
    return ergebnis(wert, linie, drin, !drin && (fertig || letzterRaus || rot), notiz);
  }
  if (markt.includes("_") && !["team_ecken", "gelb_gesamt"].includes(markt)) return marktStand(markt, linie, richtung, teamId, live);
  let wert = null;
  if (markt === "ecken") {
    const h = teamWert(live, "corners", "heim");
    const g = teamWert(live, "corners", "gast");
    wert = h == null || g == null ? null : h + g;
  } else if (markt === "team_ecken") {
    wert = teamWert(live, "corners", String(live.heim.id) === teamId ? "heim" : "gast");
  } else if (markt === "gelb_gesamt") {
    wert = live.ereignisse.filter((e) => e.type === "Card" && /^yellow$/i.test(e.card || "")).length;
  }
  if (wert == null) return { wert: null, ziel: linie, status: "offen", notiz: "noch keine Daten" };
  const ueber = wert > linie;
  if (richtung === "unter") return ergebnis(wert, linie, fertig && !ueber, ueber);
  return ergebnis(wert, linie, ueber, fertig && !ueber);
}

// Team- und Spielwetten live: Zaehlwerte aus der Statistik, Tore aus dem Spielstand
function marktStand(marktSchluessel, linie, richtung, teamId, live) {
  const fertig = live.stand.art === "finished";
  let markt = marktSchluessel;
  let periode = "voll";
  if (markt.endsWith("_hz1")) { periode = "hz1"; markt = markt.slice(0, -4); }
  else if (markt.endsWith("_hz2")) { periode = "hz2"; markt = markt.slice(0, -4); }
  const basis = Object.keys(TEAM_STAT).concat(["tore"]).sort((a, b) => b.length - a.length).find((b) => markt.startsWith(`${b}_`));
  const umfang = basis ? markt.slice(basis.length + 1) : "";
  const seite = String(live.heim.id) === String(teamId) ? "heim" : "gast";
  // Ist die Halbzeit schon vorbei? (fuer Halbzeit-Wetten)
  const htEreignis = live.ereignisse.find((e) => e.type === "Half" && e.halfStrShort === "HT");
  const hzFertig = periode === "hz1" ? Boolean(htEreignis) || fertig : fertig;
  const abrechnen = (wert, l, r) => {
    if (wert == null) return { wert: null, ziel: l, status: "offen", notiz: "noch keine Daten" };
    const ueber = wert > l + 1e-9;
    const gleich = Math.abs(wert - l) < 1e-9;
    if (r === "unter") return { wert, ziel: l, notiz: "", status: ueber ? "raus" : hzFertig ? (gleich ? "ungueltig" : "drin") : "offen" };
    return { wert, ziel: l, notiz: "", status: ueber ? "drin" : hzFertig ? (gleich ? "ungueltig" : "raus") : "offen" };
  };
  if (basis && basis !== "tore") {
    const quelle = periode === "hz1" ? live.statistik_hz1 : periode === "hz2" ? live.statistik_hz2 : live.statistik;
    const werte = (quelle || {})[TEAM_STAT[basis]];
    if (!Array.isArray(werte)) return { wert: null, ziel: linie, status: "offen", notiz: "noch keine Daten" };
    const h = zahlAus(werte[0]);
    const g = zahlAus(werte[1]);
    if (umfang === "meiste") {
      const ja = { heim: h > g, unentschieden: h === g, gast: h < g }[richtung];
      return { wert: null, ziel: null, notiz: hzFertig ? "" : `aktuell ${h}:${g}`, status: hzFertig ? (ja ? "drin" : "raus") : "offen" };
    }
    if (umfang === "dreiweg") {
      const summe = h + g;
      if (richtung === "ueber") return { wert: summe, ziel: linie, notiz: "", status: summe > linie ? "drin" : hzFertig ? "raus" : "offen" };
      if (richtung === "unter") return { wert: summe, ziel: linie, notiz: "", status: summe >= linie ? "raus" : hzFertig ? "drin" : "offen" };
      return { wert: summe, ziel: linie, notiz: "", status: summe > linie ? "raus" : hzFertig ? (summe === linie ? "drin" : "raus") : "offen" };
    }
    return abrechnen(umfang === "team" ? (seite === "heim" ? h : g) : h + g, linie, richtung);
  }
  // Tore
  let h = live.stand.h ?? 0;
  let g = live.stand.g ?? 0;
  if (periode !== "voll") {
    const ht = htEreignis ? [htEreignis.homeScore ?? 0, htEreignis.awayScore ?? 0] : null;
    if (periode === "hz1" && ht) { h = ht[0]; g = ht[1]; }
    else if (periode === "hz2") {
      if (!ht) return { wert: null, ziel: linie, status: "offen", notiz: "2. Halbzeit noch nicht begonnen" };
      h -= ht[0]; g -= ht[1];
    }
  }
  const jaNein = (bedingung, notiz) => ({ wert: null, ziel: null, notiz: hzFertig ? "" : notiz, status: hzFertig ? (bedingung ? "drin" : "raus") : "offen" });
  const stand = `aktuell ${h}:${g}`;
  if (umfang === "spiel") return abrechnen(h + g, linie, richtung);
  if (umfang === "team") return abrechnen(seite === "heim" ? h : g, linie, richtung);
  if (umfang === "ergebnis") return jaNein({ heim: h > g, unentschieden: h === g, gast: h < g }[richtung], stand);
  if (umfang === "btts") {
    const beide = h > 0 && g > 0;
    if (richtung === "ja" && beide) return { wert: null, ziel: null, notiz: "", status: "drin" };
    if (richtung === "nein" && beide) return { wert: null, ziel: null, notiz: "", status: "raus" };
    return jaNein(richtung === "ja" ? beide : !beide, stand);
  }
  if (umfang === "doppelte_chance") return jaNein({ "1x": h >= g, 12: h !== g, x2: h <= g }[richtung], stand);
  if (umfang === "ohne_unentschieden") {
    if (fertig && h === g) return { wert: null, ziel: null, notiz: "Unentschieden, Einsatz zurück", status: "ungueltig" };
    return jaNein(richtung === "heim" ? h > g : g > h, stand);
  }
  if (umfang === "asiatisch") {
    const d = (seite === "heim" ? h - g : g - h) + linie;
    if (fertig && Math.abs(d) < 1e-9) return { wert: null, ziel: null, notiz: "Einsatz zurück", status: "ungueltig" };
    return jaNein(d > 0, stand);
  }
  if (umfang === "europaeisch") {
    const d = h + linie - g;
    return jaNein({ heim: d > 0, unentschieden: d === 0, gast: d < 0 }[richtung], stand);
  }
  const raus = { wert: null, ziel: null, notiz: "", status: "raus" };
  const ausgang = h > g ? "heim" : h < g ? "gast" : "unentschieden";
  if (umfang === "genau") {
    const [i, j] = richtung.split(":").map(Number);
    if (h > i || g > j) return raus;
    return jaNein(h === i && g === j, stand);
  }
  if (umfang === "ergebnis_btts") {
    const [a, b] = richtung.split("+");
    const beide = h > 0 && g > 0;
    if (b === "nein" && beide) return raus;
    return jaNein(ausgang === a && beide === (b === "ja"), stand);
  }
  if (umfang === "bereich" || umfang === "teambereich") {
    const [von, bis] = bereichAus(richtung);
    const wert = umfang === "teambereich" ? (seite === "heim" ? h : g) : h + g;
    if (wert > bis) return raus;
    return jaNein(wert >= von, stand);
  }
  if (umfang === "ergebnis_bereich" || umfang === "dc_bereich") {
    const [vorne, hinten] = richtung.split("+");
    const [von, bis] = bereichAus(hinten);
    if (h + g > bis) return raus;
    const passt = { heim: ["heim"], unentschieden: ["unentschieden"], gast: ["gast"], "1x": ["heim", "unentschieden"],
      12: ["heim", "gast"], x2: ["unentschieden", "gast"] }[vorne] || [];
    return jaNein(passt.includes(ausgang) && h + g >= von, stand);
  }
  // Halbzeit-Wetten auf das ganze Spiel: Stand zur Pause aus dem Halbzeit-Ereignis
  const ht = htEreignis ? [htEreignis.homeScore ?? 0, htEreignis.awayScore ?? 0] : null;
  if (umfang === "hzend") {
    const [pause, ende] = richtung.split("/");
    if (ht) {
      const p = ht[0] > ht[1] ? "heim" : ht[0] < ht[1] ? "gast" : "unentschieden";
      if (p !== pause) return raus;
    }
    return jaNein(ausgang === ende, stand);
  }
  if (umfang === "haelfte") {
    if (!ht) return { wert: null, ziel: null, notiz: fertig ? "" : stand, status: "offen" };
    const erste = ht[0] + ht[1];
    const zweite = h + g - erste;
    return jaNein({ hz1: erste > zweite, hz2: zweite > erste, gleich: erste === zweite }[richtung], `1. Halbzeit ${erste}, 2. Halbzeit ${zweite}`);
  }
  if (umfang === "spezial") {
    const eigene = seite === "heim" ? h : g;
    const gegner = seite === "heim" ? g : h;
    if (richtung === "weisse_weste") return gegner > 0 ? raus : jaNein(true, stand);
    if (richtung === "zu_null") return gegner > 0 ? raus : jaNein(eigene > 0, stand);
    const e1 = ht ? (seite === "heim" ? ht : [ht[1], ht[0]]) : [eigene, gegner];
    const e2 = ht ? [eigene - e1[0], gegner - e1[1]] : [0, 0];
    const drin = { wert: null, ziel: null, notiz: "", status: "drin" };
    if (richtung === "trifft_hz1") return e1[0] > 0 ? drin : ht || fertig ? raus : jaNein(false, stand);
    if (richtung === "trifft_hz2") return ht && e2[0] > 0 ? drin : jaNein(false, stand);
    if (richtung === "trifft_beide") {
      if (ht && e1[0] === 0) return raus;
      return ht && e1[0] > 0 && e2[0] > 0 ? drin : jaNein(false, stand);
    }
    if (richtung === "gewinnt_eine") {
      if (ht && e1[0] > e1[1]) return drin;
      return jaNein(Boolean(ht) && e2[0] > e2[1], stand);
    }
    if (richtung === "gewinnt_beide") {
      if (ht && !(e1[0] > e1[1])) return raus;
      return jaNein(Boolean(ht) && e2[0] > e2[1], stand);
    }
  }
  return { wert: null, ziel: null, status: "offen", notiz: stand };
}

/* ---------------------------------------------------- Live-Wahrscheinlichkeiten */

/* Waehrend des Spiels rechnet die App jede Wette neu: was schon passiert ist plus
   der erwartete Rest. Der Rest kommt aus der Prognose vor dem Spiel und wird mit dem
   bisherigen Spielverlauf angepasst (mehr Schuesse als erwartet heisst: das Spiel ist
   offener, es kommen wahrscheinlich auch spaeter mehr). Wie stark, ist an 502 Spielen
   geschaetzt (Stand zur Pause gegen Endstand). */

const STATSAPI_SPEICHER = "flutlicht.statsapi";
const STATSAPI_URL = "https://api.thestatsapi.com/api";
const LIVE_MIN_WERT = 0.06;     // live etwas strenger als vor dem Spiel
const LIVE_SPERRE_SEK = 180;    // nach Tor oder Rot keine Live-Tipps: die Quoten hinken hinterher
const LIVE_QUOTEN_TAKT = 55000;
const liveQuoten = new Map();   // API-Spiel -> { zeit, markets, fehler }

function statsapiSchluessel() {
  return (lesen(STATSAPI_SPEICHER) || "").trim();
}

// Wo steht das Spiel? f1/f2: gespielter Anteil der 1. und 2. Halbzeit (mit Nachspielzeit)
function spielzeit(live) {
  const st = live.stand;
  if (st.art === "finished") return { phase: "ende", f1: 1, f2: 1 };
  if (st.art !== "inprogress") return { phase: "vor", f1: 0, f2: 0 };
  if (live.pause) return { phase: "pause", f1: 1, f2: 0 };
  const m = String(live.zeitText || "").match(/^(\d+)(?:\s*\+\s*(\d+))?/);
  const zweite = live.ereignisse.some((e) => e.type === "Half" && e.halfStrShort === "HT");
  if (!m) return zweite ? { phase: "2", f1: 1, f2: 0.5 } : { phase: "1", f1: 0.5, f2: 0 };
  const minute = Number(m[1]);
  const plus = Number(m[2] || 0);
  if (!zweite && minute <= 45) return { phase: "1", f1: Math.min(1, (minute + plus) / 47), f2: 0 };
  return { phase: "2", f1: 1, f2: Math.min(0.97, Math.max(0, minute - 45 + plus) / 50) };
}

function nbListeJs(mittel, r, bis) {
  const werte = new Array(bis + 1).fill(0);
  if (!(mittel > 0)) { werte[0] = 1; return werte; }
  if (r >= 1e5) {
    werte[0] = Math.exp(-mittel);
    for (let i = 1; i <= bis; i++) werte[i] = werte[i - 1] * mittel / i;
    return werte;
  }
  const p = r / (r + mittel);
  werte[0] = Math.exp(r * Math.log(p));
  for (let i = 1; i <= bis; i++) werte[i] = werte[i - 1] * (i - 1 + r) / i * (1 - p);
  return werte;
}

// Verteilung des Rests als Liste P(X = 0..n); grosse Zahlen (Paesse) ueber die Normalverteilung
function restVerteilung(mittel, r) {
  if (mittel > 150) return { normal: true, mittel, sd: Math.sqrt(mittel + mittel * mittel / Math.min(r, 1e5)) };
  const bis = Math.ceil(mittel + 10 * Math.sqrt(mittel + mittel * mittel / Math.min(r, 1e5)) + 12);
  return { liste: nbListeJs(mittel, r, bis) };
}

function momente(x) {
  if (x.normal) return [x.mittel, x.sd * x.sd];
  let m = 0;
  x.liste.forEach((w, i) => { m += w * i; });
  let v = 0;
  x.liste.forEach((w, i) => { v += w * (i - m) * (i - m); });
  return [m, v];
}

function falten(a, b) {
  if (a.normal || b.normal) {
    const [ma, va] = momente(a);
    const [mb, vb] = momente(b);
    return { normal: true, mittel: ma + mb, sd: Math.sqrt(Math.max(va + vb, 1e-9)) };
  }
  const ergebnis = new Array(a.liste.length + b.liste.length - 1).fill(0);
  a.liste.forEach((x, i) => { if (x > 1e-12) b.liste.forEach((y, j) => { ergebnis[i + j] += x * y; }); });
  return { liste: ergebnis };
}

function normalUeber(x, mittel, sd) {
  const z = (x - mittel) / sd;
  // Abramowitz-Stegun fuer die Fehlerfunktion
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 - erf) : 0.5 * (1 + erf);
}

// (Gewinn, Einsatz zurueck) fuer "Endwert ueber/unter linie" bei bisher b und Rest-Verteilung v
function linieAbrechnen(v, b, linie, richtung) {
  const viertel = Math.abs(linie * 4 - Math.round(linie * 4)) < 1e-9 && Math.abs(linie * 2 - Math.round(linie * 2)) > 1e-9;
  if (viertel) {
    const x = linieAbrechnen(v, b, linie - 0.25, richtung);
    const y = linieAbrechnen(v, b, linie + 0.25, richtung);
    return [(x[0] + y[0]) / 2, (x[1] + y[1]) / 2];
  }
  const grenze = linie - b;  // der Rest muss darueber (oder darunter) liegen
  let drueber;
  let genau = 0;
  if (v.normal) {
    drueber = normalUeber(grenze + 0.5, v.mittel, v.sd);
    if (Math.abs(grenze - Math.round(grenze)) < 1e-9) genau = normalUeber(grenze - 0.5, v.mittel, v.sd) - drueber;
  } else {
    drueber = v.liste.reduce((s, w, i) => s + (i > grenze + 1e-9 ? w : 0), 0);
    genau = v.liste.reduce((s, w, i) => s + (Math.abs(i - grenze) < 1e-9 ? w : 0), 0);
  }
  return richtung === "unter" ? [Math.max(0, 1 - drueber - genau), genau] : [drueber, genau];
}

function restAnteil(z, anteil1, c, periode) {
  const e1 = anteil1;
  const e2 = (1 - anteil1) * c;
  const bisher = e1 * z.f1 + e2 * z.f2;
  const rest = periode === "hz1" ? e1 * (1 - z.f1) : periode === "hz2" ? e2 * (1 - z.f2) : e1 * (1 - z.f1) + e2 * (1 - z.f2);
  return { bisher, rest };
}

function liveRest(erwartet, anteil1, c, alpha, beobachtet, z, periode = "voll") {
  const { bisher, rest } = restAnteil(z, anteil1, c, periode);
  const update = alpha >= 1e5 ? 1 : (alpha + beobachtet) / (alpha + erwartet * bisher);
  return Math.max(0, erwartet * rest * update);
}

function htStand(live) {
  const e = live.ereignisse.find((x) => x.type === "Half" && x.halfStrShort === "HT");
  return e ? [Number(e.homeScore ?? 0), Number(e.awayScore ?? 0)] : null;
}

// Tore: Endstand-Verteilung als Gitter ab dem aktuellen Stand
function torGitter(restH, restG) {
  const ph = nbListeJs(restH, 1e6, 10);
  const pg = nbListeJs(restG, 1e6, 10);
  return ph.map((x) => pg.map((y) => x * y));
}

function torSumme(gitter, bedingung) {
  let s = 0;
  gitter.forEach((zeile, i) => zeile.forEach((w, j) => { if (bedingung(i, j)) s += w; }));
  return s;
}

/* Live-Wahrscheinlichkeit fuer einen Tipp-Schluessel "markt|linie|richtung|spieler|team".
   Gibt [Gewinn, Einsatz zurueck] oder null (unbekannt, z. B. Spieler nicht im Spiel) zurueck. */
function liveChance(s, live, k) {
  const pr = s && s.prognose;
  if (!pr || !pr.live) return null;
  const z = spielzeit(live);
  if (z.phase === "vor") return null;
  const [marktSchluessel, linieText, richtung, spielerId, teamId] = k.split("|");
  const linie = Number(linieText);
  if (spielerId) return liveSpielerChance(s, live, z, spielerId, marktSchluessel, linie, richtung);
  let markt = marktSchluessel;
  let periode = "voll";
  if (markt.endsWith("_hz1")) { periode = "hz1"; markt = markt.slice(0, -4); }
  else if (markt.endsWith("_hz2")) { periode = "hz2"; markt = markt.slice(0, -4); }
  const basis = Object.keys(TEAM_STAT).concat(["tore"]).sort((a, b) => b.length - a.length).find((b) => markt.startsWith(`${b}_`));
  if (!basis) return null;
  const umfang = markt.slice(basis.length + 1);
  const seite = String(teamId) === String(s.heim.id) ? "heim" : "gast";
  const par = pr.live.zaehl[basis];
  if (!par) return null;
  const [eh, eg, anteil1, alpha, c, r] = par;
  if (basis !== "tore") {
    const alle = live.statistik[TEAM_STAT[basis]];
    if (!Array.isArray(alle)) return null;
    const voll = [zahlAus(alle[0]), zahlAus(alle[1])];
    let jetzt = voll;
    if (periode !== "voll") {
      const w = ((periode === "hz1" ? live.statistik_hz1 : live.statistik_hz2) || {})[TEAM_STAT[basis]];
      jetzt = Array.isArray(w) ? [zahlAus(w[0]), zahlAus(w[1])] : periode === "hz2" && z.phase !== "2" ? [0, 0] : null;
      if (!jetzt) return null;
    }
    const restH = restVerteilung(liveRest(eh, anteil1, c, alpha, voll[0], z, periode), r);
    const restG = restVerteilung(liveRest(eg, anteil1, c, alpha, voll[1], z, periode), r);
    if (umfang === "team") return linieAbrechnen(seite === "heim" ? restH : restG, seite === "heim" ? jetzt[0] : jetzt[1], linie, richtung === "unter" ? "unter" : "ueber");
    return linieAbrechnen(falten(restH, restG), jetzt[0] + jetzt[1], linie, richtung === "unter" ? "unter" : "ueber");
  }
  // Tore
  const h = live.stand.h ?? 0;
  const g = live.stand.g ?? 0;
  const ht = htStand(live);
  let basisH = h;
  let basisG = g;
  if (periode === "hz1") { if (ht) { basisH = ht[0]; basisG = ht[1]; } }
  else if (periode === "hz2") { basisH = ht ? h - ht[0] : 0; basisG = ht ? g - ht[1] : 0; }
  const gitter = torGitter(liveRest(eh, anteil1, c, alpha, h, z, periode), liveRest(eg, anteil1, c, alpha, g, z, periode));
  const p = (bed) => torSumme(gitter, (i, j) => bed(basisH + i, basisG + j));
  if (umfang === "spiel" || umfang === "team") {
    const anzahl = umfang === "team" ? (seite === "heim" ? (a) => a[0] : (a) => a[1]) : (a) => a[0] + a[1];
    const viertel = Math.abs(linie * 4 - Math.round(linie * 4)) < 1e-9 && Math.abs(linie * 2 - Math.round(linie * 2)) > 1e-9;
    const einfach = (l) => {
      const drueber = p((x, y) => anzahl([x, y]) > l + 1e-9);
      const genau = p((x, y) => Math.abs(anzahl([x, y]) - l) < 1e-9);
      return richtung === "unter" ? [1 - drueber - genau, genau] : [drueber, genau];
    };
    if (viertel) { const a = einfach(linie - 0.25); const b = einfach(linie + 0.25); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    return einfach(linie);
  }
  if (umfang === "ergebnis") return [p((x, y) => ({ heim: x > y, unentschieden: x === y, gast: x < y }[richtung])), 0];
  if (umfang === "btts") { const ja = p((x, y) => x > 0 && y > 0); return [richtung === "ja" ? ja : 1 - ja, 0]; }
  if (umfang === "doppelte_chance") return [p((x, y) => ({ "1x": x >= y, 12: x !== y, x2: x <= y }[richtung])), 0];
  if (umfang === "ohne_unentschieden") return [p((x, y) => (richtung === "heim" ? x > y : y > x)), p((x, y) => x === y)];
  return null;  // Handicaps live nicht: Bet365 rechnet sie ab dem Zeitpunkt der Wette
}

function liveSpielerChance(s, live, z, spielerId, markt, k, richtung) {
  if (markt === "torschuetze") {
    // Rest der erwarteten Tore des Spielers (bzw. seines Einwechselspielers), gleichmaessig ueber die Zeit
    const sp = (s.prognose.torschuetzen || []).find((x) => String(x.id) === String(spielerId));
    if (!sp || !(sp.p > 0 && sp.p < 1)) return null;
    const rest = Math.max(0, 1 - 0.5 * (z.f1 || 0) - 0.5 * (z.f2 || 0));
    return [1 - Math.exp(Math.log(1 - sp.p) * rest), 0];
  }
  const sp = (s.prognose.spieler || []).find((x) => String(x.id) === String(spielerId));
  if (!sp || !sp.m || !sp.m[markt]) return null;
  const id = String(spielerId);
  const aufstellung = live.aufstellung || {};
  const startelf = ["heim", "gast"].some((seite) => aufstellung[seite] && aufstellung[seite].startelf.some((x) => x.id === id));
  const eingewechselt = live.ereignisse.some((e) => e.type === "Substitution" && e.swap && e.swap[0] && String(e.swap[0].id) === id);
  if (!startelf && !eingewechselt) return null;  // nicht im Spiel: bei Bet365 meist ungueltig
  const ohneErsatz = markt === "paraden" || !startelf;
  const kette = ohneErsatz ? [id] : ersatzKette(live, id);
  const bisher = kette.reduce((summe, x) => summe + liveWert(live, x, markt), 0);
  const letzter = kette[kette.length - 1];
  const rot = live.ereignisse.some((e) => e.type === "Card" && String((e.player || {}).id) === letzter && /red/i.test(e.card || ""));
  const raus = ohneErsatz && live.ereignisse.some((e) => e.type === "Substitution" && e.swap && e.swap[1] && String(e.swap[1].id) === letzter);
  const r = (s.prognose.live.spieler_r || {})[markt] ?? 10;
  const anteil1 = (s.prognose.live.spieler_hz1 || {})[markt] ?? 0.47;
  // Eingewechselte ohne Ersatzregel: nur die Rate fuer die eigene Restzeit
  const erwartet = sp.m[markt].e * (startelf ? 1 : Math.min(1, 90 / Math.max(30, sp.min || 30)));
  const rest = rot || raus || z.phase === "ende" ? 0 : liveRest(erwartet, anteil1, 1.0, r, bisher, z, "voll");
  if (richtung === "unter") {
    if (bisher >= k) return [0, 0];
    return [1 - pMindestensRest(rest, r, Math.ceil(k - bisher)), 0];
  }
  if (bisher >= k) return [1, 0];
  return [pMindestensRest(rest, r, k - bisher), 0];
}

function pMindestensRest(mittel, r, k) {
  if (k <= 0) return 1;
  if (!(mittel > 0)) return 0;
  if (mittel > 150) return normalUeber(k - 0.5, mittel, Math.sqrt(mittel + mittel * mittel / Math.min(r, 1e5)));
  const liste = nbListeJs(mittel, r, k - 1);
  return Math.max(0, 1 - liste.reduce((a, b) => a + b, 0));
}

/* Live-Quoten von Bet365 (nur mit eigenem Schluessel von TheStatsAPI, der auf dem Geraet bleibt) */

// API-Markt -> (unser Markt, Art der Auswahl), live nur Wetten auf das ganze Spiel oder die laufende Halbzeit
const LIVE_API = {
  match_odds: ["tore_ergebnis", "seite"], first_half_result: ["tore_ergebnis_hz1", "seite"],
  second_half_result: ["tore_ergebnis_hz2", "seite"], double_chance: ["tore_doppelte_chance", "dc"],
  draw_no_bet: ["tore_ohne_unentschieden", "seite"], btts: ["tore_btts", "janein"],
  btts_first_half: ["tore_btts_hz1", "janein"], btts_second_half: ["tore_btts_hz2", "janein"],
  total_goals: ["tore_spiel", "ou"], team_total_goals: ["tore_team", "team_ou"],
  match_corners: ["ecken_spiel", "ou"], team_corners: ["ecken_team", "team_ou"], total_cards: ["karten_spiel", "ou"],
};
const API_SEITE = { home: "heim", draw: "unentschieden", away: "gast" };

async function liveQuotenHolen(apiId) {
  const schluessel = statsapiSchluessel();
  if (!schluessel || !apiId) return null;
  const alt = liveQuoten.get(apiId);
  if (alt && Date.now() - alt.zeit < LIVE_QUOTEN_TAKT) return alt;
  const eintrag = { zeit: Date.now(), markets: null, fehler: "" };
  liveQuoten.set(apiId, eintrag);
  try {
    const antwort = await fetch(`${STATSAPI_URL}/football/matches/${encodeURIComponent(apiId)}/odds/live?bookmaker=bet365,betfair-exchange`, {
      headers: { Authorization: `Bearer ${schluessel}`, Accept: "application/json" },
    });
    if (antwort.status === 401 || antwort.status === 403) eintrag.fehler = "Der Schlüssel wird nicht angenommen. Ist die Testwoche abgelaufen?";
    else if (antwort.status === 404) eintrag.fehler = "Bet365 bietet für dieses Spiel gerade keine Live-Quoten an.";
    else if (antwort.status === 429) eintrag.fehler = "Zu viele Abfragen, gleich noch einmal.";
    else if (!antwort.ok) eintrag.fehler = `Live-Quoten gerade nicht erreichbar (Fehler ${antwort.status}).`;
    else {
      const daten = await antwort.json();
      const nachBuchmacher = {};
      for (const b of (daten.data || {}).bookmakers || []) nachBuchmacher[String(b.bookmaker || "").toLowerCase()] = b.markets || {};
      eintrag.markets = nachBuchmacher;
    }
  } catch (e) {
    eintrag.fehler = "Live-Quoten gerade nicht erreichbar.";
  }
  return eintrag;
}

// Flache Liste aller Bet365-Live-Wetten: { k, titel, quote, gegen: {auswahl: quote} }
function liveWetten(s, markets) {
  const b365 = markets.bet365 || {};
  const liste = [];
  const zahlVon = (x) => { const n = parseFloat(x && x.live); return n > 1 ? n : null; };
  const namen = { heim: kurzName(s.heim), gast: kurzName(s.gast) };
  for (const [api, [markt, art]] of Object.entries(LIVE_API)) {
    if (!bet365Ok(markt)) continue;
    const inhalt = b365[api];
    if (!inhalt) continue;
    const hz = markt.endsWith("_hz1") ? " 1. Halbzeit" : markt.endsWith("_hz2") ? " 2. Halbzeit" : "";
    if (art === "seite" || art === "dc" || art === "janein") {
      const gruppe = {};
      for (const [auswahl, wert] of Object.entries(inhalt)) { const q = zahlVon(wert); if (q) gruppe[auswahl] = q; }
      for (const [auswahl, q] of Object.entries(gruppe)) {
        let richtung;
        let titel;
        if (art === "seite") {
          richtung = API_SEITE[auswahl];
          if (!richtung) continue;
          titel = markt.startsWith("tore_ohne") ? `Sieg ${namen[richtung]} ohne Unentschieden` : richtung === "unentschieden" ? `Unentschieden${hz}` : `Sieg ${namen[richtung]}${hz}`;
        } else if (art === "dc") {
          richtung = { home_draw: "1x", home_away: "12", draw_away: "x2" }[auswahl];
          if (!richtung) continue;
          titel = `Doppelte Chance ${richtung.toUpperCase()}`;
        } else {
          richtung = auswahl === "yes" ? "ja" : auswahl === "no" ? "nein" : null;
          if (!richtung) continue;
          titel = `${richtung === "ja" ? "Beide treffen" : "Nicht beide treffen"}${hz}`;
        }
        liste.push({ k: `${markt}||${richtung}||`, titel, quote: q, gegen: gruppe, auswahl });
      }
    } else if (art === "ou") {
      for (const [linie, paar] of Object.entries(inhalt)) {
        const gruppe = {};
        for (const a of ["over", "under"]) { const q = zahlVon(paar && paar[a]); if (q) gruppe[a] = q; }
        const name = markt.startsWith("tore") ? "Tore" : markt.startsWith("ecken") ? "Ecken" : "Gelbe Karten";
        for (const [a, q] of Object.entries(gruppe)) {
          const richtung = a === "over" ? "ueber" : "unter";
          liste.push({ k: `${markt}|${Number(linie)}|${richtung}||`, titel: `${richtung === "ueber" ? "Über" : "Unter"} ${zahl(Number(linie), linie.includes(".25") || linie.includes(".75") ? 2 : 1)} ${name}${hz}`, quote: q, gegen: gruppe, auswahl: a });
        }
      }
    } else if (art === "team_ou") {
      for (const [apiSeite, linien] of Object.entries(inhalt)) {
        const seite = API_SEITE[apiSeite];
        if (!seite || !linien) continue;
        const team = seite === "heim" ? s.heim : s.gast;
        for (const [linie, paar] of Object.entries(linien)) {
          const gruppe = {};
          for (const a of ["over", "under"]) { const q = zahlVon(paar && paar[a]); if (q) gruppe[a] = q; }
          const name = markt.startsWith("tore") ? "Tore" : "Ecken";
          for (const [a, q] of Object.entries(gruppe)) {
            const richtung = a === "over" ? "ueber" : "unter";
            liste.push({ k: `${markt}|${Number(linie)}|${richtung}||${team.id}`, titel: `${namen[seite]} ${richtung === "ueber" ? "über" : "unter"} ${zahl(Number(linie), 1)} ${name}`, quote: q, gegen: gruppe, auswahl: a });
          }
        }
      }
    }
  }
  return liste;
}

// Ist in den letzten Minuten etwas passiert, das die Quoten stark verschiebt?
function liveGesperrt(live) {
  const z = spielzeit(live);
  if (z.phase === "pause") return false;
  const minute = z.phase === "1" ? z.f1 * 47 : 45 + z.f2 * 50;
  return live.ereignisse.some((e) => (e.type === "Goal" || (e.type === "Card" && /red/i.test(e.card || ""))) && minute - Number(e.time || 0) < LIVE_SPERRE_SEK / 60);
}

function liveTippsBerechnen(s, live, markets) {
  const ergebnis = [];
  for (const w of liveWetten(s, markets)) {
    const chance = liveChance(s, live, w.k);
    if (!chance) continue;
    const [pModell, push] = chance;
    if (pModell <= 0.001 || pModell >= 0.999) continue;  // schon entschieden
    // Markt ohne Marge (Bet365 mit allen Auswahlen derselben Wette)
    const summe = Object.values(w.gegen).reduce((a, q) => a + 1 / q, 0);
    let pMarkt = Object.keys(w.gegen).length >= 2 && summe > 0 ? (1 / w.quote) / summe : null;
    // Live nur mit Vergleich zum Markt. Liegen Modell und Markt sehr weit auseinander, ist fast
    // immer eine Quote veraltet oder ein Wert noch nicht aktualisiert: dann lieber kein Tipp.
    if (pMarkt == null) continue;
    if (push > 0) pMarkt *= 1 - push;
    if (Math.abs(pModell - pMarkt) > 0.25) continue;
    const p = 0.5 * pModell + 0.5 * pMarkt;
    const wert = p * w.quote + push - 1;
    ergebnis.push({ ...w, p, pModell, pMarkt, push, wert });
  }
  return ergebnis;
}

function liveTippsAbschnitt(id, live, s) {
  if (!s || !s.prognose || !s.prognose.live || live.stand.art !== "inprogress") return "";
  const z = spielzeit(live);
  const kopf = `<h2>Live-Tipps${z.phase === "pause" ? " zur Pause" : ""}</h2>`;
  if (!statsapiSchluessel()) {
    return `
      <section class="abschnitt">${kopf}
        <p>Für Live-Tipps braucht die App die Live-Quoten von Bet365. Trag dafür einmal deinen Schlüssel von TheStatsAPI ein. Er bleibt nur auf diesem Gerät und geht nur an TheStatsAPI.</p>
        <form class="schluessel-form" data-statsapi-form="1">
          <input class="feld" type="password" autocomplete="off" placeholder="Schlüssel von TheStatsAPI" id="statsapi-feld">
          <button class="knopf" type="submit">Speichern</button>
        </form>
      </section>`;
  }
  if (!s.prognose.api_id) {
    return `<section class="abschnitt">${kopf}<p class="leer">Dieses Spiel ist bei TheStatsAPI noch nicht zugeordnet. Das passiert beim nächsten Daten-Update, sobald es Quoten gibt.</p></section>`;
  }
  const eintrag = liveQuoten.get(s.prognose.api_id);
  if (!eintrag || (!eintrag.markets && !eintrag.fehler)) return `<section class="abschnitt">${kopf}<p class="leer">Live-Quoten werden geladen</p></section>`;
  if (eintrag.fehler) return `<section class="abschnitt">${kopf}<p class="leer">${esc(eintrag.fehler)}</p></section>`;
  if (liveGesperrt(live)) {
    return `<section class="abschnitt">${kopf}<p class="leer">Gerade ist ein Tor oder eine Rote Karte gefallen. Die Quoten brauchen ein paar Minuten, bis sie stimmen. Live-Tipps gibt es danach wieder.</p></section>`;
  }
  const alle = liveTippsBerechnen(s, live, eintrag.markets);
  const tipps = alle
    .filter((t) => t.wert >= LIVE_MIN_WERT && t.p >= 0.3 && t.quote <= 4)
    .sort((a, b) => b.wert * (0.6 + b.p) - a.wert * (0.6 + a.p))
    .slice(0, 3);
  let html = `<section class="abschnitt">${kopf}`;
  if (!tipps.length) {
    html += `<p class="leer">Gerade zahlt Bet365 live nirgends genug. Die App rechnet bei jedem Update neu.</p>`;
  } else {
    html += `<p>Bet365 zahlt hier gerade mehr, als die Wette nach dem bisherigen Spielverlauf wert ist. Live ändern sich die Quoten schnell, vergleich sie vor dem Setzen in der Bet365-App.</p><div class="tipps">`;
    tipps.forEach((t, i) => {
      html += `
        <article class="tipp wert-tipp">
          <div class="tipp-kopf">
            <span class="rang">${i + 1}</span>
            <div class="was"><div class="etikett">Live${z.phase === "pause" ? " · Pause" : ""}</div><div class="n">${esc(t.titel)}</div></div>
            <div class="chance"><span class="zahl">${zahl(t.quote, 2)}</span><small>Bet365 live</small></div>
          </div>
          <div class="wert-zeile">
            <span class="gruen">Wert ${mitVorzeichen(t.wert * 100)} %</span>
            <span>Chance ${prozent(t.p)}</span>
            <span class="leise">Modell ${prozent(t.pModell)}${t.pMarkt != null ? ` · Markt ${prozent(t.pMarkt)}` : ""}</span>
          </div>
        </article>`;
    });
    html += `</div>`;
  }
  html += `<p class="fussnote">Quoten von ${new Intl.DateTimeFormat("de-AT", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(eintrag.zeit))}. <button class="link-knopf" data-aktion="statsapi-weg">Schlüssel von diesem Gerät löschen</button></p></section>`;
  return html;
}

const MARKT_EINHEIT = { schuesse: "Schüsse", aufs_tor: "aufs Tor", gefoult: "gefoult", fouls: "Fouls", gelb: "Gelb", ecken: "Ecken", team_ecken: "Ecken", gelb_gesamt: "Gelbe" };

function tippTracker(id, live, s) {
  const eintraege = new Map();
  const archiv = (zustand.daten.tipps_archiv || {})[String(id)];
  const vorher = archiv || (s && s.prognose ? (s.prognose.wert || []).map((t) => ({ k: t.k, titel: t.titel, p: t.p, art: "wert", quote: t.quote })) : []);
  const NAMEN = { wert: "Wert", top: "Top", mutig: "Mutig" };
  for (const t of vorher) eintraege.set(t.k, { k: t.k, titel: t.titel, p: t.p, quote: t.quote, quellen: [NAMEN[t.art] || "Tipp"], gespeichert: t.ergebnis });
  for (const t of scheinLesen().tipps.filter((x) => x.spiel === id)) {
    const e = eintraege.get(t.k);
    if (e) e.quellen.push("Schein");
    else eintraege.set(t.k, { k: t.k, titel: t.titel, p: t.p, quellen: ["Schein"] });
  }
  if (!eintraege.size) return "";
  let html = `
    <section class="abschnitt">
      <h2>Deine Tipps</h2>
      <p>${archiv ? "Die Tipps, wie sie vor dem Anpfiff in der App standen" : "Die Tipps mit Wert"}, dazu alles von deinem Schein zu diesem Spiel.</p>
      <div class="tracker">`;
  for (const e of eintraege.values()) {
    const st = tippStand(e.k, live);
    const markt = e.k.split("|")[0];
    const ohneLinie = st.ziel == null || Number.isNaN(st.ziel);
    const ziel = ohneLinie ? "" : Number.isInteger(st.ziel) ? st.ziel : zahl(st.ziel, 1);
    const standText = st.wert == null ? "-" : zahl(st.wert, 0);
    const zeichen = st.status === "drin" ? '<i class="ja">✓</i>' : st.status === "raus" ? '<i class="nein">✗</i>' : st.status === "ungueltig" ? '<i class="leer-zeichen">–</i>' : '<i class="laeuft"></i>';
    const jetzt = st.status === "offen" && live.stand.art === "inprogress" ? liveChance(s, live, e.k) : null;
    const anteil = st.wert == null ? 0 : Math.min(1, st.wert / Math.max(st.ziel, 0.5));
    const spielerId = e.k.split("|")[3];
    html += `
      <div class="tracker-zeile ${st.status}">
        ${zeichen}
        <div class="was">
          ${spielerId && !spielerId.includes("+") ? `<button class="n link-name" data-spieler-detail="${esc(spielerId)}">${esc(e.titel)}</button>` : `<div class="n">${esc(e.titel)}</div>`}
          <div class="leise klein">${e.quellen.join(" und ")} · vorher ${prozent(e.p)}${jetzt ? ` · <span class="${jetzt[0] >= e.p ? "gruen" : "gelb"}">jetzt ${prozent(jetzt[0])}</span>` : ""}${e.quote ? ` · Quote ${zahl(e.quote, 2)}` : ""}${st.notiz ? ` · ${esc(st.notiz)}` : ""}</div>
          ${!ohneLinie && Number.isInteger(st.ziel) ? `<div class="spur"><div style="width:${Math.round(anteil * 100)}%"></div></div>` : ""}
        </div>
        <div class="stand-wert"><span class="zahl">${esc(ohneLinie ? (live.stand.h != null ? `${live.stand.h}:${live.stand.g}` : "-") : standText)}</span><small>${ohneLinie ? "Spielstand" : Number.isInteger(st.ziel) ? `von ${ziel}` : `Linie ${ziel}`}</small></div>
      </div>`;
  }
  return html + `</div></section>`;
}

function tippTitel(s, k) {
  const t = tippIndex(s).get(k);
  return t ? t.titel : k;
}

const ICON_BALL = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5l3.8 2.8-1.4 4.4H9.6L8.2 10.3z"></path></svg>';

function wechselGrund(live, rausId) {
  const a = live.aufstellung;
  if (!a) return "";
  for (const t of [a.heim, a.gast]) {
    if (!t) continue;
    const p = [...t.startelf, ...t.bank].find((x) => x.id === rausId);
    if (p && p.raus) return WECHSEL_GRUND[p.raus.reason] || "";
  }
  return "";
}

function minuteText(e) {
  const zusatz = e.overloadTime ? `+${e.overloadTime}` : "";
  return `${e.time ?? ""}${zusatz}′`;
}

function ereignisHtml(e, live) {
  const team = e.isHome ? live.heim : live.gast;
  const wappen = team && team.id ? logo(team.id, "logo klein") : "";
  if (e.type === "Half") {
    const kurz = e.halfStrShort === "HT" ? "Halbzeit" : e.halfStrShort === "FT" ? "Abpfiff" : e.time > 90 ? "Ende der Verlängerung" : "Ende der regulären Spielzeit";
    return `<div class="ev trenner"><span>${kurz}</span><span>${e.homeScore ?? 0}:${e.awayScore ?? 0}</span></div>`;
  }
  if (e.type === "AddedTime") {
    return `<div class="ev nachspiel"><span>+${esc(e.minutesAddedInput ?? "")} Min. Nachspielzeit</span></div>`;
  }
  let symbol = "";
  let name = "";
  let detail = "";
  let rechts = wappen;
  let klasse = "";
  if (e.type === "Goal") {
    klasse = "tor";
    symbol = ICON_BALL;
    name = e.nameStr || (e.player || {}).name || "Tor";
    const teile = [];
    if (e.ownGoal) teile.push("Eigentor");
    if (/pen/i.test(`${e.goalDescription || ""} ${e.suffix || ""} ${e.goalDescriptionKey || ""}`)) teile.push("Elfmeter");
    if (e.assistInput) teile.push(`Vorlage ${e.assistInput}`);
    detail = teile.join(" · ");
    if (e.newScore) rechts = `<span class="neu-stand">${e.newScore[0]}:${e.newScore[1]}</span>${wappen}`;
  } else if (e.type === "Card") {
    const karte = String(e.card || "");
    klasse = /red/i.test(karte) ? "rot-karte" : "gelb-karte";
    symbol = /yellow/i.test(karte) && /red/i.test(karte)
      ? '<i class="karte gelb"></i><i class="karte rot zweite"></i>'
      : `<i class="karte ${/red/i.test(karte) ? "rot" : "gelb"}"></i>`;
    name = e.nameStr || (e.player || {}).name || "";
    detail = /yellow/i.test(karte) && /red/i.test(karte) ? "Gelb-Rot" : /red/i.test(karte) ? "Rote Karte" : "";
  } else if (e.type === "Substitution" && e.swap && e.swap.length >= 2) {
    klasse = "wechsel";
    symbol = '<span class="pfeile"><i class="rein">↑</i><i class="raus">↓</i></span>';
    name = `${e.swap[0].name} kommt für ${e.swap[1].name}`;
    const grund = wechselGrund(live, String(e.swap[1].id || ""));
    detail = `Wechsel bei ${team && team.name ? team.name : "Team"}${grund ? `, ${grund}` : ""}`;
  } else if (e.type === "MissedPenalty") {
    klasse = "verschossen";
    symbol = "✗";
    name = e.nameStr || (e.player || {}).name || "";
    detail = "Elfmeter verschossen";
  } else {
    return "";
  }
  return `
    <div class="ev ${klasse}">
      <span class="min">${minuteText(e)}</span>
      <span class="sym">${symbol}</span>
      <div class="txt"><div class="n">${esc(name)}</div>${detail ? `<div class="d">${esc(detail)}</div>` : ""}</div>
      <span class="neben">${rechts}</span>
    </div>`;
}

function liveStatistik(live) {
  const reihen = [
    ["Ballbesitz in %", "BallPossesion", 0],
    ["Erwartete Tore (xG)", "expected_goals", 2],
    ["Schüsse", "total_shots", 0],
    ["Schüsse aufs Tor", "ShotsOnTarget", 0],
    ["Ecken", "corners", 0],
    ["Fouls", "fouls", 0],
    ["Gelbe Karten", "yellow_cards", 0],
    ["Rote Karten", "red_cards", 0],
  ].filter(([, k]) => Array.isArray(live.statistik[k]));
  if (!reihen.length) return "";
  return `
    <section class="abschnitt">
      <h2>Statistik</h2>
      <div class="vgl"><div class="kopfzeile"><span class="leise klein">${esc(live.heim.name || "")}</span><span class="leise klein">${esc(live.gast.name || "")}</span></div></div>
      <div class="vergleich">${reihen
        .map(([was, k, st]) => {
          const a = zahlAus(live.statistik[k][0]);
          const b = zahlAus(live.statistik[k][1]);
          const max = Math.max(a, b) || 1;
          return `
          <div class="vgl">
            <div class="kopfzeile"><span class="wert">${zahl(a, st)}</span><span class="was">${was}</span><span class="wert">${zahl(b, st)}</span></div>
            <div class="balken">
              <div><span class="${a > b ? "vorne" : ""}" style="width:${Math.round((a / max) * 100)}%"></span></div>
              <div><span class="${b > a ? "vorne" : ""}" style="width:${Math.round((b / max) * 100)}%"></span></div>
            </div>
          </div>`;
        })
        .join("")}</div>
    </section>`;
}

const baldOderBegonnen = (anstoss) => anstoss * 1000 <= Date.now() + 10 * 60000;

function liveInhalt(id, s, anstoss) {
  const eintrag = liveDetails.get(id);
  if (!eintrag && anstoss && !baldOderBegonnen(anstoss)) {
    return `<section class="abschnitt"><p class="leer">Anpfiff am ${esc(fmtKurz.format(new Date(anstoss * 1000)))} um ${uhr(anstoss)} Uhr. Ab dann läuft hier der Live-Ticker mit Toren, Karten und Statistik.</p></section>`;
  }
  if (!eintrag) return `<p class="leer">Live-Daten werden geladen</p>`;
  const live = eintrag.live;
  if (live.stand.art === "notstarted") {
    return `<section class="abschnitt"><p class="leer">Das Spiel hat noch nicht begonnen. Anpfiff ${live.anstoss ? `um ${uhr(live.anstoss)} Uhr` : "folgt"}. Ab dann läuft hier der Ticker.</p></section>`;
  }
  const laeuft = live.stand.art === "inprogress";
  const ereignisse = live.ereignisse.slice().sort((a, b) => (a.time - b.time) || ((a.overloadTime || 0) - (b.overloadTime || 0)));
  if (laeuft) ereignisse.reverse();
  const zeilen = ereignisse.map((e) => ereignisHtml(e, live)).filter(Boolean);
  return `
    ${liveTippsAbschnitt(id, live, s)}
    ${tippTracker(id, live, s)}
    <section class="abschnitt">
      <h2>${laeuft ? "Ticker" : "Spielverlauf"}</h2>
      ${laeuft ? '<p>Neueste Ereignisse oben. Aktualisiert sich alle 30 Sekunden.</p>' : ""}
      <div class="ticker">${zeilen.join("") || '<p class="leer">Noch keine Ereignisse.</p>'}</div>
    </section>
    ${liveStatistik(live)}
    <section class="abschnitt">
      <div class="live-fuss">
        <span>Live von FotMob, Stand ${new Intl.DateTimeFormat("de-AT", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(eintrag.geholt))}</span>
        <button data-aktion="live-neu">Aktualisieren</button>
      </div>
    </section>`;
}

function kopfStand(st, anstoss) {
  if (!st || st.art === "notstarted" || st.art === "cancelled") {
    return `<div class="uhrzeit">${st && st.art === "cancelled" ? "abges." : uhr(anstoss)}</div><div class="datum">${esc(fmtKurz.format(new Date(anstoss * 1000)))}</div>`;
  }
  return `<div class="uhrzeit${st.art === "inprogress" ? " live" : ""}">${st.h ?? 0}:${st.g ?? 0}</div><div class="datum${st.art === "inprogress" ? " live" : ""}">${esc(st.minute)}</div>`;
}

// Laedt die Live-Daten und setzt sie ein, ohne die Seite neu aufzubauen
async function liveAktualisieren(id, s) {
  try {
    const live = await liveHolen(id);
    if (s && s.prognose && s.prognose.api_id && live.stand.art === "inprogress" && statsapiSchluessel()) {
      await liveQuotenHolen(s.prognose.api_id);
    }
  } catch (e) {
    const ziel = document.getElementById("live");
    if (ziel && !liveDetails.has(id)) {
      ziel.innerHTML = `<section class="abschnitt"><p class="leer">Live-Daten von FotMob sind gerade nicht erreichbar. Prüfe die Verbindung und tippe auf Aktualisieren.</p><button class="dazu" data-aktion="live-neu">Aktualisieren</button></section>`;
    }
    return;
  }
  const ziel = document.getElementById("live");
  if (ziel && ziel.dataset.kopfFehlt && Number(ziel.dataset.id) === id) {
    const y = window.scrollY;
    zeigePartie(id, { ohneStart: true });
    window.scrollTo(0, y);
  } else if (ziel && Number(ziel.dataset.id) === id) {
    ziel.innerHTML = ziel.dataset.ansicht === "aufstellung" ? aufstellungInhalt(id) : liveInhalt(id, s, null);
  }
  if (zustand.blatt && zustand.blatt.spiel === id) spielerBlattNeu();
  const kopf = document.getElementById("kopf-stand");
  const eintrag = liveDetails.get(id);
  if (kopf && eintrag) kopf.innerHTML = kopfStand(eintrag.live.stand, s ? s.anstoss : eintrag.live.anstoss);
  if (eintrag && eintrag.live.stand.art === "finished") timerStoppen();
}

function liveStarten(id, s, optionen = {}) {
  timerStoppen();
  liveAktualisieren(id, s);
  if (optionen.einmal) return;
  liveTimer = setInterval(() => {
    if (!document.hidden) liveAktualisieren(id, s);
  }, LIVE_TAKT_SPIEL);
}

/* -------------------------------------------------------------- Aufstellung */

const FOTO_URL = "https://images.fotmob.com/image_resources/playerimages/";
const MONATE_DE = {
  January: "Jänner", February: "Februar", March: "März", April: "April", May: "Mai", June: "Juni", July: "Juli",
  August: "August", September: "September", October: "Oktober", November: "November", December: "Dezember",
};
const AUSFALL_ART = { injury: "verletzt", suspension: "gesperrt", international: "Länderspiel" };
const WECHSEL_GRUND = { injury: "verletzt", tactical: "taktisch" };

function rueckkehrText(text) {
  if (!text) return "";
  let t = String(text).trim();
  if (/^doubtful$/i.test(t)) return "fraglich";
  if (/^unknown$/i.test(t)) return "Rückkehr unbekannt";
  if (/^back in training$/i.test(t)) return "wieder im Training";
  t = t.replace(/^Early /, "Anfang ").replace(/^Mid /, "Mitte ").replace(/^Late /, "Ende ");
  for (const [en, de] of Object.entries(MONATE_DE)) t = t.replace(en, de);
  return t.replace("About ", "ca. ").replace("A few ", "einige ").replace("weeks", "Wochen").replace("week", "Woche")
    .replace("days", "Tage").replace("day", "Tag").replace("months", "Monate").replace("month", "Monat");
}

// Foto mit Rueckennummer darunter: laedt das Foto nicht, bleibt die Nummer sichtbar
function foto(id, nummer, klasse = "foto") {
  return `
    <span class="${klasse}">
      <span class="nr-ersatz">${esc(nummer || "")}</span>
      ${id ? `<img src="${FOTO_URL}${esc(id)}.png" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
    </span>`;
}

function spielerLesen(s) {
  const leistung = s.performance || {};
  const wechsel = leistung.substitutionEvents || [];
  const name = s.name || "";
  return {
    id: s.id != null ? String(s.id) : "",
    name,
    kurz: s.lastName || name.split(" ").slice(-1)[0] || name,
    nummer: s.shirtNumber || "",
    x: s.verticalLayout ? s.verticalLayout.x : null,
    y: s.verticalLayout ? s.verticalLayout.y : null,
    note: leistung.rating != null ? Number(leistung.rating) : null,
    ereignisse: (leistung.events || []).map((e) => e.type),
    raus: wechsel.find((w) => w.type === "subOut") || null,
    rein: wechsel.find((w) => w.type === "subIn") || null,
    kapitaen: Boolean(s.isCaptain),
  };
}

function aufstellungLesen(inhalt) {
  const l = inhalt.lineup || {};
  const team = (t) =>
    t && (t.starters || []).length
      ? {
          id: t.id,
          name: t.name,
          formation: t.formation || "",
          trainer: t.coach && t.coach.name,
          startelf: (t.starters || []).map(spielerLesen),
          bank: (t.subs || []).map(spielerLesen),
          fehlen: (t.unavailable || []).map((u) => ({
            id: u.id != null ? String(u.id) : "",
            name: u.name,
            art: AUSFALL_ART[(u.unavailability || {}).type] || "fehlt",
            rueckkehr: rueckkehrText((u.unavailability || {}).expectedReturn),
          })),
        }
      : null;
  return { art: l.lineupType || "", heim: team(l.homeTeam), gast: team(l.awayTeam) };
}

// Wer kam fuer wen? Aus den Wechsel-Ereignissen, sonst ueber die Minute
function wechselPaare(live) {
  const paare = new Map(); // raus-ID -> {rein, minute, grund}
  const alle = [];
  for (const seite of ["heim", "gast"]) {
    const t = live.aufstellung && live.aufstellung[seite];
    if (t) alle.push(...t.startelf, ...t.bank);
  }
  const nachId = new Map(alle.map((p) => [p.id, p]));
  for (const e of live.ereignisse) {
    if (e.type !== "Substitution" || !e.swap || e.swap.length < 2) continue;
    const rein = String(e.swap[0].id || "");
    const raus = String(e.swap[1].id || "");
    const p = nachId.get(raus);
    paare.set(raus, {
      rein: nachId.get(rein) || { id: rein, name: e.swap[0].name, kurz: String(e.swap[0].name || "").split(" ").slice(-1)[0], nummer: "" },
      minute: e.time,
      zusatz: e.overloadTime,
      grund: p && p.raus ? WECHSEL_GRUND[p.raus.reason] || "" : "",
    });
  }
  // Ohne Ereignisse: gleiche Minute, gleiche Reihenfolge
  for (const seite of ["heim", "gast"]) {
    const t = live.aufstellung && live.aufstellung[seite];
    if (!t) continue;
    const raus = [...t.startelf, ...t.bank].filter((p) => p.raus && !paare.has(p.id));
    const rein = t.bank.filter((p) => p.rein && ![...paare.values()].some((x) => x.rein.id === p.id));
    for (const r of raus) {
      const i = rein.findIndex((x) => x.rein.time === r.raus.time);
      if (i < 0) continue;
      paare.set(r.id, { rein: rein[i], minute: r.raus.time, grund: WECHSEL_GRUND[r.raus.reason] || "" });
      rein.splice(i, 1);
    }
  }
  return paare;
}

function symbole(p) {
  const zaehle = (typ) => p.ereignisse.filter((e) => e === typ).length;
  let html = "";
  const tore = zaehle("goal") + zaehle("penaltyGoal");
  for (let i = 0; i < Math.min(tore, 3); i++) html += MINI_BALL;
  if (zaehle("ownGoal")) html += MINI_BALL.replace('class="mini-ball"', 'class="mini-ball eigen"');
  if (zaehle("yellowCard")) html += `<i class="karte gelb mini"></i>`;
  if (zaehle("redCard") || zaehle("yellowRedCard") || zaehle("secondYellow")) html += `<i class="karte rot mini"></i>`;
  return html;
}

const MINI_BALL = '<svg class="mini-ball" viewBox="0 0 12 12" aria-label="Tor"><circle cx="6" cy="6" r="5.2"></circle><path d="M6 3.5l2.2 1.6-.85 2.6h-2.7l-.85-2.6z"></path></svg>';

const noteKlasse = (n) => (n >= 8 ? "gut" : n < 6 ? "schwach" : "");

/* ------------------------------------------------- Spieler-Karte (Werte im Spiel) */

// Werte aus FotMob in eigenen Gruppen, wie in Fussball-Apps: Angriff, Ballbesitz, Verteidigung ...
const SPIELER_GRUPPEN = [
  ["Angriff", [
    ["goals", "Tore"], ["assists", "Vorlagen"], ["total_shots", "Schüsse"], ["ShotsOnTarget", "Schüsse aufs Tor"],
    ["ShotsOffTarget", "Schüsse vorbei"], ["blocked_shots", "Schüsse geblockt"], ["shots_woodwork", "Aluminium"],
    ["expected_goals", "Erwartete Tore (xG)"], ["expected_assists", "Erwartete Vorlagen (xA)"],
    ["chances_created", "Chancen vorbereitet"], ["touches_opp_box", "Ballkontakte im Strafraum"],
    ["dribbles_succeeded", "Dribblings erfolgreich"], ["Offsides", "Abseits"], ["penalties_won", "Elfmeter herausgeholt"],
  ]],
  ["Ballbesitz", [
    ["touches", "Ballkontakte"], ["accurate_passes", "Pässe angekommen"], ["passes_into_final_third", "Pässe ins letzte Drittel"],
    ["line_breaking_passes", "Linienbrechende Pässe"], ["long_balls_accurate", "Lange Bälle angekommen"],
    ["accurate_crosses", "Flanken angekommen"], ["corners", "Ecken"], ["player_throws", "Einwürfe"], ["dispossessed", "Ballverluste"],
  ]],
  ["Verteidigung", [
    ["matchstats.headers.tackles", "Tacklings"], ["interceptions", "Abgefangene Bälle"], ["recoveries", "Balleroberungen"],
    ["clearances", "Klärungen"], ["headed_clearance", "Kopfball-Klärungen"], ["shot_blocks", "Schüsse geblockt"],
    ["defensive_actions", "Defensivaktionen"], ["dribbled_past", "Ausgedribbelt worden"], ["conceded_penalties", "Elfmeter verursacht"],
  ]],
  ["Zweikämpfe", [
    ["duel_won", "Zweikämpfe gewonnen"], ["duel_lost", "Zweikämpfe verloren"], ["ground_duels_won", "Bodenzweikämpfe gewonnen"],
    ["aerials_won", "Kopfballduelle gewonnen"], ["was_fouled", "Gefoult worden"], ["fouls", "Fouls begangen"],
  ]],
  ["Torwart", [
    ["saves", "Paraden"], ["goals_conceded", "Gegentore"], ["saves_inside_box", "Paraden im Strafraum"],
    ["keeper_diving_save", "Paraden im Sprung"], ["keeper_high_claim", "Hohe Bälle abgefangen"], ["punches", "Fäuste"],
    ["keeper_sweeper", "Als Libero"], ["expected_goals_on_target_faced", "xGOT gegen sich"], ["goals_prevented", "Verhinderte Tore"],
  ]],
  ["Laufen", [
    ["physical_metrics_distance_covered", "Laufstrecke"], ["physical_metrics_topspeed", "Höchstgeschwindigkeit"],
    ["physical_metrics_number_of_sprints", "Sprints"],
  ]],
];

function spielerWertText(werte, schluessel) {
  const wert = werte[schluessel];
  if (wert == null || wert === "") return null;
  const gesamt = werte[`${schluessel}__total`];
  const n = Number(wert);
  if (schluessel === "physical_metrics_distance_covered") return `${zahl(n / 1000, 1)} km`;
  if (schluessel === "physical_metrics_topspeed") return `${zahl(n, 1)} km/h`;
  if (gesamt != null && Number(gesamt) > 0) return `${zahl(n, 0)} von ${zahl(Number(gesamt), 0)} (${Math.round((n / Number(gesamt)) * 100)} %)`;
  if (Number.isFinite(n) && !Number.isInteger(n)) return zahl(n, 2);
  return String(wert);
}

function spielerBlattHtml(spielId, spielerId) {
  const eintrag = liveDetails.get(spielId);
  if (!eintrag) return `<p class="leer">Live-Daten werden geladen</p>`;
  const live = eintrag.live;
  const p = live.spieler[spielerId];
  let name = p ? p.name : "";
  let team = p ? p.team : null;
  for (const seite of ["heim", "gast"]) {
    const t = live.aufstellung && live.aufstellung[seite];
    const x = t && [...t.startelf, ...t.bank].find((y) => y.id === spielerId);
    if (x) { name = name || x.name; team = team || t.id; }
  }
  const werte = p ? p.werte : {};
  const minuten = werte.minutes_played;
  const note = werte.rating_title;
  let html = `
    <div class="blatt-kopf">
      ${foto(spielerId, "", "foto blatt-foto")}
      <div class="was">
        <div class="n">${esc(name || "Spieler")}</div>
        <div class="leise klein">${team ? `${logo(team, "logo klein")}` : ""}${minuten != null ? `${esc(minuten)} Min. gespielt` : "noch nicht eingesetzt"}${live.stand.art === "inprogress" ? ` · ${esc(live.stand.minute)}` : live.stand.art === "finished" ? " · Endstand" : ""}</div>
      </div>
      ${note ? `<span class="note ${noteKlasse(Number(note))}">${zahl(Number(note), 1)}</span>` : ""}
      <button class="rund blatt-zu" data-blatt-zu="1" aria-label="Schließen">×</button>
    </div>`;
  if (!p) return html + `<p class="leer">Für diesen Spieler gibt es noch keine Werte aus dem Spiel.</p>`;
  for (const [gruppe, felder] of SPIELER_GRUPPEN) {
    const zeilen = felder.map(([schluessel, text]) => [text, spielerWertText(werte, schluessel)]).filter(([, w]) => w != null);
    if (gruppe === "Torwart" && werte.saves == null) continue;
    if (!zeilen.length) continue;
    html += `<h3 class="unterkopf">${gruppe}</h3><div class="blatt-werte">${zeilen.map(([text, w]) => `<div><span>${esc(text)}</span><strong>${esc(w)}</strong></div>`).join("")}</div>`;
  }
  return html + `<p class="fussnote">Werte von FotMob, Stand ${new Intl.DateTimeFormat("de-AT", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(eintrag.geholt))}. Aktualisiert sich mit dem Live-Ticker.</p>`;
}

function spielerBlattOeffnen(spielId, spielerId) {
  zustand.blatt = { spiel: spielId, spieler: String(spielerId) };
  let huelle = document.getElementById("spieler-blatt");
  if (!huelle) {
    huelle = document.createElement("div");
    huelle.id = "spieler-blatt";
    huelle.className = "blatt-huelle";
    huelle.innerHTML = `<div class="blatt" role="dialog" aria-modal="true" aria-label="Werte des Spielers"><div class="blatt-inhalt"></div></div>`;
    huelle.addEventListener("click", (ereignis) => {
      if (ereignis.target === huelle || ereignis.target.closest("[data-blatt-zu]")) spielerBlattSchliessen();
    });
    document.body.appendChild(huelle);
  }
  huelle.querySelector(".blatt-inhalt").innerHTML = spielerBlattHtml(spielId, String(spielerId));
  document.body.classList.add("blatt-offen");
  huelle.hidden = false;
  if (!liveDetails.has(spielId)) liveHolen(spielId).then(spielerBlattNeu).catch(() => {});
}

function spielerBlattNeu() {
  const huelle = document.getElementById("spieler-blatt");
  if (!huelle || huelle.hidden || !zustand.blatt) return;
  huelle.querySelector(".blatt-inhalt").innerHTML = spielerBlattHtml(zustand.blatt.spiel, zustand.blatt.spieler);
}

function spielerBlattSchliessen() {
  const huelle = document.getElementById("spieler-blatt");
  if (huelle) huelle.hidden = true;
  document.body.classList.remove("blatt-offen");
  zustand.blatt = null;
}

function feldMarke(p, seite, paare, begonnen) {
  if (p.x == null || p.y == null) return "";
  const links = seite === "heim" ? p.x * 100 : (1 - p.x) * 100;
  // y laeuft bei FotMob von 0,1 (Tor) bis 0,87 (Sturm). Die Namen stehen unter dem Foto,
  // deshalb bekommt das untere Team unten etwas mehr Rand.
  const t = Math.min(1, Math.max(0, (p.y - 0.1) / 0.77));
  const oben = seite === "heim" ? 3.5 + t * 40 : 93.5 - t * 38.5;
  const wechsel = paare.get(p.id);
  const sym = symbole(p);
  return `
    <button class="marke-spieler" data-spieler-detail="${esc(p.id)}" aria-label="Werte von ${esc(p.name || p.kurz)}" style="left:${Math.min(90, Math.max(10, links)).toFixed(1)}%;top:${oben.toFixed(1)}%">
      <span class="foto-rahmen${wechsel ? " raus" : ""}">
        ${foto(p.id, p.nummer)}
        ${sym ? `<span class="sym-ecke">${sym}</span>` : ""}
        ${begonnen && p.note ? `<span class="note ${noteKlasse(p.note)}">${zahl(p.note, 1)}</span>` : ""}
        ${wechsel ? foto(wechsel.rein.id, wechsel.rein.nummer, "foto mini-foto") : ""}
      </span>
      <span class="name">${p.nummer ? `<b>${esc(p.nummer)}</b> ` : ""}${esc(p.kurz)}</span>
      ${wechsel ? `<span class="wechsel-info">↑ ${esc(wechsel.rein.kurz)} ${esc(wechsel.minute)}′</span>` : ""}
    </button>`;
}

function aufstellungInhalt(id) {
  const eintrag = liveDetails.get(id);
  if (!eintrag) return `<p class="leer">Aufstellung wird geladen</p>`;
  const live = eintrag.live;
  const a = live.aufstellung;
  if (!a || (!a.heim && !a.gast)) {
    return `<section class="abschnitt"><p class="leer">Die Aufstellung ist noch nicht bekannt. FotMob trägt meist ein bis zwei Tage vorher eine voraussichtliche Startelf ein, die echte etwa eine Stunde vor Anpfiff.</p></section>`;
  }
  const begonnen = live.stand.art !== "notstarted";
  const paare = wechselPaare(live);
  const art = a.art === "predicted" ? "Voraussichtliche Aufstellung" : begonnen ? "Aufstellung" : "Aufstellung bestätigt";
  const kopfTeam = (t, seite) =>
    t ? `<div class="feld-team ${seite}">${logo(t.id, "logo klein")}<span>${esc(t.name)}</span><span class="formation">${esc(t.formation)}</span></div>` : "";
  let html = `
    <section class="abschnitt">
      <div class="hinweisband links"><span class="pille${a.art === "predicted" ? "" : " fix"}">${art}</span></div>
      ${kopfTeam(a.heim, "oben")}
      <div class="feld-aufstellung">
        <svg class="feld-linien" viewBox="0 0 68 105" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0.5" y="0.5" width="67" height="104"></rect>
          <line x1="0.5" y1="52.5" x2="67.5" y2="52.5"></line>
          <circle cx="34" cy="52.5" r="9.15"></circle>
          <rect x="13.85" y="0.5" width="40.3" height="16.5"></rect>
          <rect x="24.85" y="0.5" width="18.3" height="5.5"></rect>
          <rect x="13.85" y="88" width="40.3" height="16.5"></rect>
          <rect x="24.85" y="99" width="18.3" height="5.5"></rect>
        </svg>
        ${a.heim ? a.heim.startelf.map((p) => feldMarke(p, "heim", paare, begonnen)).join("") : ""}
        ${a.gast ? a.gast.startelf.map((p) => feldMarke(p, "gast", paare, begonnen)).join("") : ""}
      </div>
      ${kopfTeam(a.gast, "unten")}
      ${paare.size ? `<p class="fussnote">Ausgewechselte Spieler bleiben auf ihrer Position, das kleine Foto zeigt, wer für sie kam.</p>` : ""}
    </section>`;

  const reinVon = new Map([...paare.entries()].map(([raus, x]) => [x.rein.id, { raus, minute: x.minute }]));
  const nameVon = new Map();
  for (const t of [a.heim, a.gast]) if (t) for (const p of [...t.startelf, ...t.bank]) nameVon.set(p.id, p.name);

  for (const t of [a.heim, a.gast]) {
    if (!t) continue;
    const eingesetzt = t.bank.filter((p) => reinVon.has(p.id) || p.rein).sort((x, y) => ((reinVon.get(x.id) || {}).minute || 999) - ((reinVon.get(y.id) || {}).minute || 999));
    const uebrig = t.bank.filter((p) => !eingesetzt.includes(p));
    const zeile = (p) => {
      const kam = reinVon.get(p.id);
      const raus = paare.get(p.id);
      const teile = [];
      if (kam) teile.push(`kam ${kam.minute}′ für ${nameVon.get(kam.raus) || ""}`);
      else if (p.rein) teile.push(`kam ${p.rein.time}′`);
      if (raus) teile.push(`ging ${raus.minute}′ für ${raus.rein.name}`);
      return `
        <button class="bank-zeile${kam || p.rein ? " drin" : ""}" data-spieler-detail="${esc(p.id)}">
          ${foto(p.id, p.nummer, "foto bank-foto")}
          <div class="was">
            <div class="n">${p.nummer ? `<b>${esc(p.nummer)}</b> ` : ""}${esc(p.name)} ${symbole(p)}</div>
            ${teile.length ? `<div class="leise klein">${esc(teile.join(", "))}</div>` : ""}
          </div>
          ${begonnen && p.note ? `<span class="note ${noteKlasse(p.note)}">${zahl(p.note, 1)}</span>` : ""}
        </button>`;
    };
    html += `
      <section class="abschnitt">
        <h3 class="unterkopf">${logo(t.id)}${esc(t.name)}${t.trainer ? ` <small>Trainer ${esc(t.trainer)}</small>` : ""}</h3>`;
    if (t.bank.length) {
      html += `<div class="leise klein bank-titel">${begonnen ? "Eingewechselt und Bank" : "Ersatzbank"}</div><div class="bank">${[...eingesetzt, ...uebrig].map(zeile).join("")}</div>`;
    } else if (a.art === "predicted") {
      html += `<p class="leise klein">Die Ersatzbank steht erst mit der offiziellen Aufstellung fest.</p>`;
    }
    if (t.fehlen.length) {
      html += `<div class="leise klein bank-titel">Fehlen</div><div class="bank">${t.fehlen
        .map(
          (f) => `
          <div class="bank-zeile fehlt-zeile">
            ${foto(f.id, "", "foto bank-foto")}
            <div class="was"><div class="n">${esc(f.name)}</div><div class="leise klein">${esc([f.art, f.rueckkehr].filter(Boolean).join(", "))}</div></div>
          </div>`,
        )
        .join("")}</div>`;
    }
    html += `</section>`;
  }
  return html;
}

/* Seite fuer Spiele ohne Prognose (andere Ligen, beendete Spiele) */

function zeigePartie(id, optionen = {}) {
  const m = planEintrag(id);
  const eintrag = liveDetails.get(id);
  const live = eintrag && eintrag.live;
  const heim = m ? { id: m.heim_id, name: m.heim } : live ? { id: live.heim.id, name: live.heim.name } : { name: "" };
  const gast = m ? { id: m.gast_id, name: m.gast } : live ? { id: live.gast.id, name: live.gast.name } : { name: "" };
  const anstoss = m ? m.anstoss : live ? live.anstoss : Date.now() / 1000;
  const st = live ? live.stand : m ? stand(m) : null;
  const wettbewerb = m ? wettbewerbName(m.w) : live ? live.wettbewerb : "";
  const kopf = (team) => `
    <div class="seite">
      <div class="wappen" aria-hidden="true"><span>${esc(kuerzel(team))}</span>${logo(team.id, "wappen-bild", true)}</div>
      <div class="name">${esc(team.name)}</div>
    </div>`;
  const ohneTipps = !(zustand.daten.tipps_archiv || {})[String(id)] && !scheinLesen().tipps.some((t) => t.spiel === id);
  const ansicht = zustand.partieTab === "aufstellung" ? "aufstellung" : "ticker";
  const reiter = [["ticker", st && st.art === "finished" ? "Spielverlauf" : "Live"], ["aufstellung", "Aufstellung"]];
  const inhalt = ansicht === "aufstellung"
    ? (liveDetails.has(id) ? aufstellungInhalt(id) : `<p class="leer">Aufstellung wird geladen</p>`)
    : liveInhalt(id, null, anstoss);
  app.innerHTML = `
    <div class="oben">
      <button class="rund" data-aktion="zurueck" aria-label="Zurück zu den Spielen">${ICON_ZURUECK}</button>
      <div class="wer"><strong>${esc(wettbewerb || "")}</strong>${esc(fmtKurz.format(new Date(anstoss * 1000)))}</div>
      <span style="width:44px" aria-hidden="true"></span>
    </div>
    <div class="duell">
      ${kopf(heim)}
      <div class="mitte" id="kopf-stand">${kopfStand(st, anstoss)}</div>
      ${kopf(gast)}
    </div>
    ${ohneTipps && m && (!st || st.art === "notstarted") ? `<div class="hinweisband"><span class="pille">${
      (zustand.daten.mit_tipps || [42]).includes(Number(m.w)) ? "Tipps kommen mit einem der nächsten Daten-Updates" : "Für diesen Wettbewerb gibt es keine Tipps"
    }</span></div>` : ""}
    <nav class="tabs" role="tablist">${reiter
      .map(([k, name]) => `<button role="tab" data-partie-tab="${k}" aria-selected="${k === ansicht}">${name}</button>`)
      .join("")}</nav>
    <div id="live" data-id="${id}" data-ansicht="${ansicht}" ${m || live ? "" : 'data-kopf-fehlt="1"'}>${inhalt}</div>
    ${fuss()}`;
  if (optionen.ohneStart) return;
  if (baldOderBegonnen(anstoss)) liveStarten(id, null, { einmal: st && st.art === "finished" });
  else if (ansicht === "aufstellung") liveStarten(id, null, { einmal: true });
}

/* ------------------------------------------------------------- Navigation */

function aktuellesSpiel() {
  const teile = location.hash.replace(/^#\/?/, "").split("/");
  if (teile[0] !== "spiel" || !teile[1]) return null;
  return vollesSpiel(Number(teile[1]));
}

// Kopf des Spiels sofort zeigen, die Analyse kommt nach
function zeigeSpielLadend(info, fehler = "") {
  timerStoppen();
  app.innerHTML = spielKopf(info) + (fehler
    ? `<section class="abschnitt"><p class="leer">${esc(fehler)}</p><p style="text-align:center"><button class="text-knopf" data-aktion="neu">${ICON_NEU}Neu laden</button></p></section>`
    : `<p class="leer laedt">Analyse wird geladen</p>`) + fuss();
}

function spielOeffnen(id) {
  const hash = location.hash;
  const info = spielInfo(id);
  zeigeSpielLadend(info);
  spielLaden(id).then(
    (s) => { if (location.hash === hash && s) route(); },
    (fehler) => { if (location.hash === hash) zeigeSpielLadend(info, fehler.message); },
  );
}

function route() {
  if (!zustand.daten) return;
  if (zustand.blatt) spielerBlattSchliessen();
  const teile = location.hash.replace(/^#\/?/, "").split("/");
  timerStoppen();
  if (teile[0] === "schein") return zeigeSchein();
  if (teile[0] === "bilanz") return zeigeBilanz();
  if (teile[0] === "wetten") return zeigeWetten();
  if (teile[0] === "leiter") return zeigeLeiter();
  if (teile[0] === "partie" && teile[1]) {
    zustand.partieTab = teile[2] === "aufstellung" ? "aufstellung" : "ticker";
    return zeigePartie(Number(teile[1]));
  }
  if (teile[0] === "spiel" && teile[1]) {
    const id = Number(teile[1]);
    const s = vollesSpiel(id);
    if (!s && spielInfo(id)) return spielOeffnen(id);
    if (!s) {
      // Spiel ist nicht mehr in den Daten (alter Link): Ticker und Aufstellung gibt es trotzdem
      zustand.partieTab = "ticker";
      return zeigePartie(id);
    }
    if (teile[2] && tabsFuer(s).some(([k]) => k === teile[2])) zustand.tab = teile[2];
    else zustand.tab = spielBegonnen(s) ? "live" : "tipps";
    zeigeSpiel(s);
  } else if (teile[0] === "tag" && /^\d{4}-\d{2}-\d{2}$/.test(teile[1] || "")) {
    zeigeSpielplan(teile[1]);
  } else {
    zeigeSpielplan(zustand.tag);
  }
}

function tabSetzen(tab) {
  zustand.tab = tab;
  const s = aktuellesSpiel();
  if (!s) return;
  history.replaceState(null, "", `#/spiel/${s.id}/${tab}`);
  zeigeSpiel(s);
}

async function neuLaden() {
  try {
    await laden(zustand.passwort);
    route();
  } catch (fehler) {
    if (fehler.passwort) { schreiben(SPEICHER, null); zeigeSperre("Das Passwort hat sich geändert. Bitte neu eingeben."); }
    else alert(fehler.message);
  }
}

app.addEventListener("click", (ereignis) => {
  const ziel = ereignis.target.closest("button");
  if (!ziel) return;
  if (ziel.dataset.nav) {
    location.hash = ["schein", "wetten", "leiter"].includes(ziel.dataset.nav) ? `#/${ziel.dataset.nav}` : zustand.tag ? `#/tag/${zustand.tag}` : "#/";
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "wette-platziert") {
    const fehler = ausSchein();
    if (fehler) {
      const ziel2 = document.getElementById("platziert-fehler");
      if (ziel2) ziel2.textContent = fehler;
    } else {
      zustand.wettenFilter = "offen";
      location.hash = "#/wetten";
      window.scrollTo(0, 0);
    }
  } else if (ziel.dataset.wetteStatus) {
    const w = wettenLesen().find((x) => x.id === ziel.dataset.wette);
    if (!w) return;
    const status = ziel.dataset.wetteStatus;
    wetteAendern(w.id, {
      status,
      auto: false,
      pruefen: false,
      auszahlung: status === "gewonnen" ? runden2(w.einsatz * w.quote) : null,
    });
    wettenListeNeu();
  } else if (ziel.dataset.wetteLoeschen) {
    if (ziel.dataset.sicher !== "1") {
      ziel.dataset.sicher = "1";
      ziel.textContent = "Wirklich löschen?";
      return;
    }
    wetteAendern(ziel.dataset.wetteLoeschen, { geloescht: true });
    wettenListeNeu();
  } else if (ziel.dataset.wettenFilter) {
    zustand.wettenFilter = ziel.dataset.wettenFilter;
    wettenListeNeu();
  } else if (ziel.dataset.aktion === "wetten-neu") {
    abgleichen();
    wettenAuswerten();
  } else if (ziel.dataset.aktion === "abgleichen") {
    abgleichen();
  } else if (ziel.dataset.aktion === "neu-verschluesseln") {
    neuVerschluesseln();
  } else if (ziel.dataset.aktion === "speicher-zeigen") {
    zustand.speicherOffen = true;
    const s = document.getElementById("speicher");
    if (s) { s.classList.remove("zu"); s.scrollIntoView({ behavior: "smooth", block: "start" }); }
  } else if (ziel.dataset.aktion === "speicher-sichern") {
    const besitzer = document.getElementById("gh-besitzer").value.trim();
    const projekt = document.getElementById("gh-projekt").value.trim();
    const schluessel = document.getElementById("gh-schluessel").value.trim();
    if (!besitzer || !projekt || !schluessel) {
      sync.status = "fehler";
      sync.fehler = "Bitte Name, Projekt und Schlüssel ausfüllen.";
      syncAnzeigen();
      return;
    }
    schreiben(GITHUB_SPEICHER, JSON.stringify({ besitzer, projekt, schluessel }));
    zustand.speicherOffen = false;
    zeigeWetten();
  } else if (ziel.dataset.aktion === "speicher-trennen") {
    schreiben(GITHUB_SPEICHER, null);
    sync.status = "lokal";
    zeigeWetten();
  } else if (ziel.dataset.aktion === "eigen-sichern") {
    const text = document.getElementById("eigen-text").value.trim();
    const einsatz = parseFloat(document.getElementById("eigen-einsatz").value.replace(",", "."));
    const quote = quoteLesen(document.getElementById("eigen-quote").value);
    const fehler = document.getElementById("eigen-fehler");
    if (!text || !(einsatz > 0) || !quote) {
      fehler.textContent = "Bitte Tipp, Einsatz und Quote (größer als 1) eintragen.";
      return;
    }
    wetteNeu({ art: "eigen", text, einsatz: runden2(einsatz), quote: runden2(quote) });
    zustand.eigeneOffen = false;
    zustand.wettenFilter = "offen";
    zeigeWetten();
  } else if (ziel.dataset.spielKombiAnzahl) {
    zustand.spielKombi.anzahl = Number(ziel.dataset.spielKombiAnzahl);
    spielKombiNeu();
  } else if (ziel.dataset.leiterFaktor) {
    leiterFormLesen();
    zustand.leiterForm.faktor = Number(ziel.dataset.leiterFaktor);
    leiterNeu();
  } else if (ziel.dataset.leiterTag !== undefined) {
    zustand.leiterTag = ziel.dataset.leiterTag;
    zustand.leiterZeit = "";
    leiterNeu();
  } else if (ziel.dataset.leiterZeit !== undefined) {
    zustand.leiterZeit = ziel.dataset.leiterZeit;
    leiterNeu();
  } else if (ziel.dataset.leiterVorschlag !== undefined) {
    zustand.leiterVorschlag = { schluessel: ziel.dataset.schluessel, i: Math.max(0, Number(ziel.dataset.leiterVorschlag)) };
    const y = window.scrollY;
    leiterNeu();
    window.scrollTo(0, y);
  } else if (ziel.dataset.aktion === "leiter-neu") {
    const l = leiterAktiv();
    if (l) leiterAendern(l.id, { status: "aus", ende: leiterStand(l).verloren ? 0 : leiterStand(l).betrag });
    zustand.leiterAusFrage = false;
    leiterNeu();
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "leiter-aus") {
    const l = leiterAktiv();
    if (!l) return;
    if (!zustand.leiterAusFrage) { zustand.leiterAusFrage = true; leiterNeu(); return; }
    zustand.leiterAusFrage = false;
    leiterAendern(l.id, { status: "aus", ende: leiterStand(l).betrag });
    leiterNeu();
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "leiter-aktualisieren") {
    abgleichen();
    wettenAuswerten();
    leiterNeu();
  } else if (ziel.dataset.kombiTag) {
    zustand.kombiTag = ziel.dataset.kombiTag;
    kombiLetzte.ziel = null;
    const y = window.scrollY;
    zeigeSchein();
    window.scrollTo(0, y);
  } else if (ziel.dataset.aktion === "schnell-auf" || ziel.dataset.aktion === "schnell-zu") {
    const s = aktuellesSpiel();
    if (!s) return;
    const auf = ziel.dataset.aktion === "schnell-auf";
    const y = window.scrollY;
    zustand.schnellSpiel = auf ? s.id : null;
    zeigeSpiel(s);
    window.scrollTo(0, y);
    const block = document.getElementById("schnell");
    if (auf && block) block.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (ziel.dataset.b365Fehlt) {
    const s = aktuellesSpiel();
    if (!s) return;
    const y = window.scrollY;
    b365FehltSetzen(s.wettbewerb || "", ziel.dataset.b365Fehlt, true);
    zeigeSpiel(s);
    window.scrollTo(0, y);
  } else if (ziel.dataset.b365Zurueck) {
    const [liga, gruppe] = JSON.parse(ziel.dataset.b365Zurueck);
    const y = window.scrollY;
    b365FehltSetzen(liga, gruppe, false);
    zeigeBilanz();
    window.scrollTo(0, y);
  } else if (ziel.dataset.scheinKombi) {
    const s = aktuellesSpiel();
    if (!s) return;
    const y = window.scrollY;
    const keys = ziel.dataset.scheinKombi.split(",");
    const alleDrin = keys.every((k) => imSchein(s.id, k));
    for (const k of keys) if (alleDrin || !imSchein(s.id, k)) scheinUmschalten(s.id, k);
    zeigeSpiel(s);
    window.scrollTo(0, y);
  } else if (ziel.dataset.schein) {
    const s = aktuellesSpiel();
    if (!s) return;
    const y = window.scrollY;
    scheinUmschalten(s.id, ziel.dataset.schein);
    zeigeSpiel(s);
    window.scrollTo(0, y);
  } else if (ziel.dataset.tag) {
    zustand.tag = ziel.dataset.tag;
    history.replaceState(null, "", `#/tag/${ziel.dataset.tag}`);
    zeigeSpielplan(ziel.dataset.tag, { leisteBehalten: true });
    window.scrollTo(0, 0);
  } else if (ziel.dataset.partieTab) {
    const id = location.hash.replace(/^#\/?/, "").split("/")[1];
    history.replaceState(null, "", `#/partie/${id}/${ziel.dataset.partieTab}`);
    route();
  } else if (ziel.dataset.partie) {
    location.hash = `#/partie/${ziel.dataset.partie}`;
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "live-neu") {
    const live = document.getElementById("live");
    if (live) liveAktualisieren(Number(live.dataset.id), aktuellesSpiel());
  } else if (ziel.dataset.spiel) {
    const neu = spielInfo(Number(ziel.dataset.spiel));
    zustand.tab = neu && spielBegonnen(neu) ? "live" : "tipps";
    zustand.heatTeam = "heim";
    zustand.heatQuelle = "form";
    location.hash = `#/spiel/${ziel.dataset.spiel}`;
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "zurueck") {
    if (history.length > 1) history.back();
    else location.hash = "#/";
  } else if (ziel.dataset.aktion === "neu") {
    neuLaden();
  } else if (ziel.dataset.aktion === "schein") {
    location.hash = "#/schein";
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "bilanz") {
    location.hash = "#/bilanz";
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "schein-leeren") {
    if (confirm("Alle Tipps vom Schein nehmen?")) {
      schreiben(SCHEIN_SPEICHER, null);
      zeigeSchein();
    }
  } else if (ziel.dataset.einsatz) {
    const schein = scheinLesen();
    schein.einsatz = ziel.dataset.einsatz;
    scheinSchreiben(schein);
    app.querySelectorAll("[data-einsatz]").forEach((k) => k.setAttribute("aria-pressed", String(k === ziel)));
    const eigen = app.querySelector("[data-einsatz-feld]");
    if (eigen) eigen.value = "";
    const ergebnis = document.getElementById("kombi-ergebnis");
    if (ergebnis) ergebnis.innerHTML = scheinErgebnisHtml(scheinAktuell());
  } else if (ziel.dataset.weg != null) {
    const schein = scheinLesen();
    schein.tipps.splice(Number(ziel.dataset.weg), 1);
    scheinSchreiben(schein);
    zeigeSchein();
  } else if (ziel.dataset.spielerDetail) {
    const live = document.getElementById("live");
    const spielId = live ? Number(live.dataset.id) : Number(location.hash.replace(/^#\/?/, "").split("/")[1]);
    if (spielId) spielerBlattOeffnen(spielId, ziel.dataset.spielerDetail);
  } else if (ziel.dataset.kombiUebernehmen) {
    const [art, nummer] = ziel.dataset.kombiUebernehmen.split(":");
    const kombi = art === "z" ? kombiLetzte.ziel && kombiLetzte.ziel.kombi
      : art === "s" ? kombiLetzte.spiel[Number(nummer)] : kombiLetzte.vorschlaege[Number(nummer)];
    if (!kombi) return;
    kombiAlsSchein(kombi, art === "z" ? kombiLetzte.ziel.einsatz : null);
    if (!location.hash.startsWith("#/schein")) {
      location.hash = "#/schein";
      window.scrollTo(0, 0);
      return;
    }
    zeigeSchein();
    window.scrollTo(0, 0);
  } else if (ziel.dataset.aktion === "statsapi-weg") {
    schreiben(STATSAPI_SPEICHER, null);
    liveQuoten.clear();
    const live = document.getElementById("live");
    if (live) live.innerHTML = liveInhalt(Number(live.dataset.id), aktuellesSpiel(), null);
  } else if (ziel.dataset.tippGruppe) {
    zustand.tippGruppe = ziel.dataset.tippGruppe;
    const y = window.scrollY;
    route();
    window.scrollTo(0, y);
  } else if (ziel.dataset.tippAbschnitt) {
    zustand.tippAbschnitt[zustand.tippGruppe] = ziel.dataset.tippAbschnitt;
    const y = window.scrollY;
    route();
    window.scrollTo(0, y);
  } else if (ziel.dataset.tippMarkt) {
    zustand.tippMarkt = ziel.dataset.tippMarkt;
    const y = window.scrollY;
    route();
    window.scrollTo(0, y);
  } else if (ziel.dataset.tippTeam) {
    zustand.tippTeam = ziel.dataset.tippTeam;
    const y = window.scrollY;
    route();
    window.scrollTo(0, y);
  } else if (ziel.dataset.tab) {
    tabSetzen(ziel.dataset.tab);
  } else if (ziel.dataset.heatTeam) {
    zustand.heatTeam = ziel.dataset.heatTeam;
    zustand.heatQuelle = "form";
    route();
  } else if (ziel.dataset.heatQuelle) {
    zustand.heatQuelle = ziel.dataset.heatQuelle;
    route();
  } else if (ziel.dataset.metrik) {
    zustand.metrik = ziel.dataset.metrik;
    route();
  } else if (ziel.dataset.spielerTeam) {
    zustand.spielerTeam = ziel.dataset.spielerTeam;
    route();
  }
});

app.addEventListener("change", (ereignis) => {
  const feld = ereignis.target;
  if (feld.id === "leiter-start" || feld.id === "leiter-ziel") {
    // nur die Vorschau neu zeichnen, damit ein Tipp auf "Leiter starten" nicht verloren geht
    leiterFormLesen();
    const vorschau = document.getElementById("leiter-vorschau");
    if (vorschau) vorschau.innerHTML = leiterVorschauHtml();
    return;
  }
  if (feld.matches("[data-bereich]")) {
    zustand.bereichWahl[feld.dataset.bereich] = feld.value;
    if (feld.dataset.bereich === "von" && zustand.bereichWahl.bis !== "+" && Number(zustand.bereichWahl.bis) < Number(feld.value)) zustand.bereichWahl.bis = feld.value;
    const s = aktuellesSpiel();
    const block = document.getElementById("bereich-wahl");
    if (s && block) block.innerHTML = bereichWahlHtml(s);
    return;
  }
  if (feld.matches("[data-auszahlung]")) {
    const wert = parseFloat(String(feld.value).replace(",", "."));
    if (Number.isFinite(wert) && wert >= 0) {
      wetteAendern(feld.dataset.auszahlung, { auszahlung: runden2(wert) });
      wettenListeNeu();
    }
  }
});

app.addEventListener("toggle", (ereignis) => {
  const d = ereignis.target;
  if (!d.matches || !d.matches("[data-schnell-gruppe]")) return;
  if (d.open) zustand.schnellGruppen.add(d.dataset.schnellGruppe);
  else zustand.schnellGruppen.delete(d.dataset.schnellGruppe);
}, true);

app.addEventListener("keydown", (ereignis) => {
  const feld = ereignis.target;
  if (ereignis.key !== "Enter" || !feld.matches || !feld.matches("[data-b365]")) return;
  ereignis.preventDefault();
  const felder = [...app.querySelectorAll("[data-b365]")].filter((f) => f.offsetParent !== null);
  const naechstes = felder[felder.indexOf(feld) + 1];
  if (naechstes) naechstes.focus();
  else feld.blur();
});

app.addEventListener("input", (ereignis) => {
  const feld = ereignis.target;
  if (feld.matches("[data-quote], [data-gesamt], [data-einsatz-feld]")) scheinEingabe(feld);
  if (feld.matches("[data-b365]")) {
    const [spiel, ...rest] = feld.dataset.b365.split("|");
    const pW = Number(feld.dataset.b365P);
    b365Merken(Number(spiel), rest.join("|"), pW, feld.value);
    const q = quoteLesen(feld.value);
    const auswahl = CSS.escape(feld.dataset.b365);
    for (const ziel of app.querySelectorAll(`[data-b365-urteil="${auswahl}"]`)) {
      ziel.innerHTML = q ? pruefUrteil(pW, q) : ziel.dataset.leer ? "" : `<span class="leise">geschätzt ≈ ${esc(feld.placeholder.replace(/^≈\s*/, ""))}</span>`;
    }
    for (const anderes of app.querySelectorAll(`[data-b365="${auswahl}"]`)) if (anderes !== feld) anderes.value = feld.value;
    const zaehler = app.querySelector(`[data-b365-zaehler="${CSS.escape(spiel)}"]`);
    if (zaehler) zaehler.textContent = schnellZaehler(Number(spiel));
  }
  if (feld.matches("[data-check]")) {
    const alle = quotenLesen();
    if (feld.value.trim()) alle[feld.dataset.check] = feld.value.trim();
    else delete alle[feld.dataset.check];
    schreiben(QUOTEN_SPEICHER, JSON.stringify(alle));
    const ziel = app.querySelector(`[data-check-ergebnis="${CSS.escape(feld.dataset.check)}"]`);
    if (ziel) ziel.innerHTML = checkErgebnis(Number(feld.dataset.checkP), feld.value);
  }
});

app.addEventListener("submit", (ereignis) => {
  const leiterForm = ereignis.target.closest("[data-leiter-form]");
  if (leiterForm) {
    ereignis.preventDefault();
    leiterFormLesen();
    const fehler = leiterStarten();
    if (fehler) { alertLos(leiterForm, fehler); return; }
    leiterNeu();
    window.scrollTo(0, 0);
    return;
  }
  const setzen = ereignis.target.closest("[data-leiter-setzen]");
  if (setzen) {
    ereignis.preventDefault();
    const index = Number(setzen.dataset.leiterSetzen);
    const fehler = leiterSetzen(index, setzen.querySelector("input").value);
    const feld = document.querySelector(`[data-leiter-fehler="${index}"]`);
    if (fehler) { if (feld) feld.textContent = fehler; return; }
    leiterNeu();
    window.scrollTo(0, 0);
    return;
  }
  const zielForm = ereignis.target.closest("[data-ziel-form]");
  if (zielForm) {
    ereignis.preventDefault();
    const einsatzText = document.getElementById("ziel-einsatz").value;
    const zielText = document.getElementById("ziel-betrag").value;
    zustand.zielSchein = { einsatz: einsatzText, ziel: zielText };
    const einsatz = parseFloat(einsatzText.replace(",", "."));
    const zielBetrag = parseFloat(zielText.replace(",", "."));
    if (!(einsatz > 0) || !(zielBetrag > einsatz)) {
      kombiLetzte.ziel = { fehler: "Bitte einen Einsatz und ein Ziel eintragen, das größer ist als der Einsatz." };
    } else {
      const quelle = kombiPool();
      const kombi = zielSchein(quelle.pool, zielBetrag / einsatz, quelle.geschaetzt);
      kombiLetzte.ziel = kombi
        ? { kombi, einsatz, ziel: zielBetrag }
        : { fehler: "Mit den Tipps, die gerade da sind, lässt sich kein solcher Schein bauen." };
    }
    const y = window.scrollY;
    zeigeSchein();
    window.scrollTo(0, y);
    return;
  }
  const kombiForm = ereignis.target.closest("[data-spiel-kombi-form]");
  if (kombiForm) {
    ereignis.preventDefault();
    zustand.spielKombi.quote = document.getElementById("spiel-kombi-quote").value.trim();
    spielKombiNeu();
    return;
  }
  const form = ereignis.target.closest("[data-statsapi-form]");
  if (!form) return;
  ereignis.preventDefault();
  const feld = document.getElementById("statsapi-feld");
  const wert = feld ? feld.value.trim() : "";
  if (wert.length < 10) return;
  schreiben(STATSAPI_SPEICHER, wert);
  liveQuoten.clear();
  const live = document.getElementById("live");
  if (live) liveAktualisieren(Number(live.dataset.id), aktuellesSpiel());
});

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const live = document.getElementById("live");
  if (live && liveTimer) liveAktualisieren(Number(live.dataset.id), aktuellesSpiel());
});
window.addEventListener("resize", () => {
  if (zustand.tab === "heatmaps") {
    const s = aktuellesSpiel();
    if (s) heatmapZeichnen(s);
  }
});

async function start() {
  if (!window.crypto || !crypto.subtle) {
    app.innerHTML = `<p class="leer">Dieser Browser kann die Daten nicht entschlüsseln. Bitte die Seite über https öffnen.</p>`;
    return;
  }
  const gemerkt = lesen(SPEICHER);
  if (!gemerkt) return zeigeSperre();
  app.innerHTML = `<p class="leer">Daten werden geöffnet</p>`;
  try {
    await laden(gemerkt);
    route();
  } catch (fehler) {
    if (fehler.passwort) schreiben(SPEICHER, null);
    zeigeSperre(fehler.message);
  }
}

start();
