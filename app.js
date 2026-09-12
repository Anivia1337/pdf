/* PDF Editor - Dokumente zusammenfuehren, Seiten drehen, sortieren, bearbeiten.
 * Oberflaeche englisch, Bezeichner und Kommentare deutsch wie im uebrigen Code.
 *
 * Alles laeuft im Browser: pdf.js zeichnet die Vorschau, pdf-lib baut das
 * Ergebnis. Keine Datei verlaesst den Rechner, es gibt keinen Serverteil.
 *
 * Koordinaten - der wichtigste Punkt im ganzen Modul:
 * Notizen (Text, Striche, Flaechen) werden IMMER in PDF-Punkten der
 * ungedrehten Seite gespeichert, umgerechnet ueber viewport.convertToPdfPoint().
 * Damit bleiben sie am Papier kleben, egal wie oft die Seite spaeter gedreht
 * wird - und pdf-lib kann sie beim Export ohne weitere Umrechnung setzen.
 */

(function () {
  'use strict';

  var PDFDocument = PDFLib.PDFDocument;
  var StandardFonts = PDFLib.StandardFonts;
  var degrees = PDFLib.degrees;
  var rgb = PDFLib.rgb;
  var LineCapStyle = PDFLib.LineCapStyle;

  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf/vendor/pdf.worker.min.js';

  // --- Zustand ------------------------------------------------------------

  var zustand = {
    doks: [],       // {id, name, farbe, pdfjs, lib, seiten, leerdok}
    boegen: [],     // {uid, dokId, quelle, dreh, notizen, k, w0, h0, bildUrl, format}
    wahl: new Set(),
    verlauf: [],
    naechsteDokId: 1,
    naechsteBogenId: 1,
    ziehen: null,
    zielIndex: -1
  };

  var QUELLFARBEN = ['#1ba7cd', '#e0a32a', '#c2557a', '#5aa86a',
                     '#8b7fd4', '#d97742', '#4b8fd4', '#a8a03c'];

  var STIFTFARBEN = ['#111111', '#d32d1f', '#1668c4', '#1a8a4a', '#f2c014', '#ffffff'];

  // Jedes Werkzeug merkt sich seine eigene Farbe. Ein Marker faengt gelb an,
  // ein Stift schwarz - alles andere waere beim Umschalten eine Ueberraschung.
  var WZ_FARBE = { text: '#111111', stift: '#111111', marker: '#f2c014' };

  var THUMB_BREITE = 320;
  var VERLAUF_TIEFE = 40;

  // --- Kurzgriffe ---------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  var el = {
    raster: $('raster'), leerbild: $('leerbild'), tisch: $('flaeche'),
    quellen: $('quellen'),
    dateiFeld: $('dateiFeld'), ablegen: $('ablegen'),
    wahlpille: $('wahlpille'), wahlAnzahl: $('wahlAnzahl'),
    hilfeBlase: $('hilfeBlase'), speichernText: $('speichernText'),
    statSeiten: $('statSeiten'), statDoks: $('statDoks'), statFormat: $('statFormat'),
    statHinweis: $('statHinweis'), meldung: $('meldung'),
    arbeit: $('arbeit'), arbeitBalken: $('arbeitBalken'), arbeitText: $('arbeitText'),
    speichernDialog: $('speichernDialog'), speichernForm: $('speichernForm'),
    dateiName: $('dateiName'), nurAuswahl: $('nurAuswahl'),
    dlgAnzahl: $('dlgAnzahl'), dlgUmfang: $('dlgUmfang'),
    lupe: $('lupe'), lupeCanvas: $('lupeCanvas'), lupeBlatt: $('lupeBlatt'),
    lupeBuehne: $('lupeBuehne'), lupeNr: $('lupeNr'), lupeQuelle: $('lupeQuelle'),
    lupeEingabe: $('lupeEingabe'), lupeZurueck: $('lupeZurueck'),
    lupeOptionen: $('lupeOptionen'), farbwahl: $('farbwahl'),
    optGrad: $('optGrad'), optGradWert: $('optGradWert'),
    optStaerke: $('optStaerke'), optStaerkeWert: $('optStaerkeWert'),
    zoomWert: $('zoomWert')
  };

  // --- Kleine Helfer ------------------------------------------------------

  var meldungsUhr = null;
  function melden(text, warnung) {
    el.meldung.textContent = text || '';
    el.meldung.classList.toggle('warnung', !!warnung);
    // Der Daueranzeiger tritt zurueck, solange eine Meldung steht - sonst
    // stehen zwei Saetze nebeneinander in derselben Zeile.
    el.statHinweis.hidden = !!text;
    if (meldungsUhr) clearTimeout(meldungsUhr);
    if (text) {
      meldungsUhr = setTimeout(function () {
        el.meldung.textContent = '';
        el.statHinweis.hidden = false;
      }, 6000);
    }
  }

  function arbeitZeigen(text, anteil) {
    el.arbeit.hidden = false;
    el.arbeitText.textContent = text;
    el.arbeitBalken.style.width = Math.round(Math.max(0, Math.min(1, anteil || 0)) * 100) + '%';
  }
  function arbeitVerbergen() { el.arbeit.hidden = true; }

  function dokVon(id) {
    for (var i = 0; i < zustand.doks.length; i++) {
      if (zustand.doks[i].id === id) return zustand.doks[i];
    }
    return null;
  }

  function bogenVon(uid) {
    for (var i = 0; i < zustand.boegen.length; i++) {
      if (zustand.boegen[i].uid === uid) return zustand.boegen[i];
    }
    return null;
  }

  function bogenIndex(uid) {
    for (var i = 0; i < zustand.boegen.length; i++) {
      if (zustand.boegen[i].uid === uid) return i;
    }
    return -1;
  }

  var FORMATE = [
    ['A3', 841.89, 1190.55], ['A4', 595.28, 841.89], ['A5', 419.53, 595.28],
    ['A6', 297.64, 419.53], ['B5', 498.90, 708.66],
    ['Letter', 612, 792], ['Legal', 612, 1008], ['Tabloid', 792, 1224]
  ];

  function formatName(b, h) {
    var kurz = Math.min(b, h), lang = Math.max(b, h);
    for (var i = 0; i < FORMATE.length; i++) {
      if (Math.abs(kurz - FORMATE[i][1]) < 4 && Math.abs(lang - FORMATE[i][2]) < 4) {
        return FORMATE[i][0];
      }
    }
    return Math.round(b / 72 * 25.4) + '×' + Math.round(h / 72 * 25.4) + ' mm';
  }


  function normDreh(g) { return ((Math.round(g / 90) * 90) % 360 + 360) % 360; }

  // Helvetica im PDF kann nur WinAnsi. Alles andere wuerde pdf-lib beim
  // Speichern mit einer Ausnahme quittieren - also vorher aussortieren.
  // Neben Latin-1 kennt WinAnsi die 27 Zeichen, die im Block 0x80 liegen.
  var WINANSI_ZUSATZ = [
    0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
    0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
    0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178
  ];

  function winAnsiOnly(text) {
    var raus = '';
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0x7E) ||
          (c >= 0xA0 && c <= 0xFF) || WINANSI_ZUSATZ.indexOf(c) >= 0) {
        raus += text.charAt(i);
      }
    }
    return raus;
  }

  function hexZuRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  // --- Verlauf ------------------------------------------------------------

  function verlaufMerken() {
    zustand.verlauf.push({
      boegen: zustand.boegen.map(function (b) {
        return {
          uid: b.uid, dokId: b.dokId, quelle: b.quelle, dreh: b.dreh,
          notizen: JSON.parse(JSON.stringify(b.notizen)),
          k: b.k, w0: b.w0, h0: b.h0, bildUrl: b.bildUrl, format: b.format
        };
      }),
      wahl: Array.from(zustand.wahl)
    });
    if (zustand.verlauf.length > VERLAUF_TIEFE) zustand.verlauf.shift();
    $('btnZurueck').disabled = false;
  }

  function zurueck() {
    var stand = zustand.verlauf.pop();
    if (!stand) return;
    zustand.boegen = stand.boegen;
    zustand.wahl = new Set(stand.wahl.filter(function (u) { return bogenIndex(u) >= 0; }));
    $('btnZurueck').disabled = zustand.verlauf.length === 0;
    boegenZeichnen();
    melden('Last step undone.');
  }

  // --- Dateien aufnehmen --------------------------------------------------

  function istBild(datei) {
    return /^image\//.test(datei.type) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(datei.name);
  }

  async function dateienAufnehmen(dateien) {
    var liste = Array.from(dateien || []);
    if (!liste.length) return;

    verlaufMerken();
    var fehler = [];
    var neueBoegen = 0;

    for (var i = 0; i < liste.length; i++) {
      var datei = liste[i];
      arbeitZeigen('Reading ' + datei.name, i / liste.length);
      try {
        var roh = new Uint8Array(await datei.arrayBuffer());
        var bytes;
        if (istBild(datei)) {
          bytes = await bildZuPdf(roh, datei);
        } else {
          bytes = roh;
        }
        neueBoegen += await dokumentAufnehmen(bytes, datei.name);
      } catch (f) {
        fehler.push(datei.name + ': ' + fehlerText(f));
      }
    }

    arbeitVerbergen();
    boegenZeichnen();
    await vorschauenNachziehen();

    if (fehler.length) {
      melden(fehler[0], true);
      if (fehler.length > 1) console.warn('PDF Editor:', fehler);
    } else if (neueBoegen) {
      melden(neueBoegen + (neueBoegen === 1 ? ' page' : ' pages') + ' added.');
    }
  }

  function fehlerText(f) {
    var n = (f && f.name) || '';
    if (n === 'PasswordException') return 'This file is password protected.';
    if (/Encrypted/i.test(n) || /encrypt/i.test(String(f && f.message))) {
      return 'This file is encrypted and cannot be combined.';
    }
    if (n === 'InvalidPDFException') return 'This is not a readable PDF file.';
    return (f && f.message) ? f.message : 'unknown error';
  }

  // Bilder werden sofort in eine einseitige PDF verpackt. Danach ist im ganzen
  // Rest der Anwendung alles gleich - eine Seite ist eine Seite.
  async function bildZuPdf(roh, datei) {
    var jpeg = /^image\/jpe?g$/i.test(datei.type) || /\.jpe?g$/i.test(datei.name);
    var pdf = await PDFDocument.create();
    var bild;

    if (jpeg) {
      bild = await pdf.embedJpg(roh);
    } else {
      // PNG, WebP, GIF und alles andere geht ueber die Leinwand nach PNG.
      var png = await ueberLeinwandZuPng(roh, datei.type || 'image/png');
      bild = await pdf.embedPng(png);
    }

    // In A4 einpassen, Hoch- oder Querformat nach Seitenverhaeltnis.
    var A = bild.width >= bild.height ? [841.89, 595.28] : [595.28, 841.89];
    var rand = 0;
    var faktor = Math.min((A[0] - rand * 2) / bild.width, (A[1] - rand * 2) / bild.height);
    var b = bild.width * faktor, h = bild.height * faktor;
    var seite = pdf.addPage(A);
    seite.drawImage(bild, { x: (A[0] - b) / 2, y: (A[1] - h) / 2, width: b, height: h });
    return await pdf.save();
  }

  function ueberLeinwandZuPng(roh, typ) {
    return new Promise(function (loesen, ablehnen) {
      var url = URL.createObjectURL(new Blob([roh], { type: typ }));
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        c.toBlob(function (blob) {
          if (!blob) { ablehnen(new Error('The browser cannot read this image format.')); return; }
          blob.arrayBuffer().then(function (ab) { loesen(new Uint8Array(ab)); });
        }, 'image/png');
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        ablehnen(new Error('The browser cannot read this image format.'));
      };
      img.src = url;
    });
  }

  async function dokumentAufnehmen(bytes, name, leerdok) {
    // pdf.js uebergibt den Puffer an den Worker und leert ihn dabei - deshalb
    // bekommt jede Bibliothek ihre eigene Kopie.
    var lib = await PDFDocument.load(bytes.slice(0), { ignoreEncryption: false });
    var pdfjs = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;

    var dok = {
      id: zustand.naechsteDokId++,
      name: name,
      farbe: QUELLFARBEN[(zustand.doks.length) % QUELLFARBEN.length],
      pdfjs: pdfjs,
      lib: lib,
      seiten: pdfjs.numPages,
      leerdok: !!leerdok
    };
    zustand.doks.push(dok);

    for (var s = 0; s < dok.seiten; s++) {
      zustand.boegen.push(await bogenAnlegen(dok, s));
    }
    return dok.seiten;
  }

  async function bogenAnlegen(dok, quelle) {
    var seite = await dok.pdfjs.getPage(quelle + 1);
    var sicht = seite.getViewport({ scale: 1, rotation: seite.rotate });
    return {
      uid: zustand.naechsteBogenId++,
      dokId: dok.id,
      quelle: quelle,
      dreh: 0,
      notizen: [],
      w0: sicht.width,
      h0: sicht.height,
      k: sicht.width / sicht.height,
      format: formatName(sicht.width, sicht.height),
      bildUrl: null
    };
  }

  // --- Leerseite ----------------------------------------------------------

  async function leerseiteAnfuegen() {
    var vorlage = zustand.boegen[zustand.boegen.length - 1];
    var b = vorlage ? vorlage.w0 : 595.28;
    var h = vorlage ? vorlage.h0 : 841.89;

    verlaufMerken();
    arbeitZeigen('Adding a blank page', .5);

    var leer = null;
    for (var i = 0; i < zustand.doks.length; i++) {
      if (zustand.doks[i].leerdok) { leer = zustand.doks[i]; break; }
    }

    try {
      if (!leer) {
        var neu = await PDFDocument.create();
        neu.addPage([b, h]);
        await dokumentAufnehmen(await neu.save(), 'Leerseiten', true);
      } else {
        // Vorhandenes Leerseiten-Dokument waechst um eine Seite. Die schon
        // vergebenen Seitenindizes bleiben gueltig, es wird nur angehaengt.
        leer.lib.addPage([b, h]);
        var bytes = await leer.lib.save();
        var alt = leer.pdfjs;
        leer.pdfjs = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
        alt.destroy();
        leer.seiten = leer.pdfjs.numPages;
        zustand.boegen.push(await bogenAnlegen(leer, leer.seiten - 1));
      }
      boegenZeichnen();
      await vorschauenNachziehen();
      melden('Blank page added at the end.');
    } catch (f) {
      melden('Could not add a blank page: ' + fehlerText(f), true);
    }
    arbeitVerbergen();
  }

  // --- Vorschaubilder -----------------------------------------------------

  var zeichneLaeuft = false;

  async function vorschauenNachziehen() {
    if (zeichneLaeuft) return;
    zeichneLaeuft = true;
    try {
      // Vorschauen laden nach und erscheinen einzeln. Das ist kein Grund, die
      // Seite zu sperren - der Fortschritt steht in der Statusleiste, bedienen
      // laesst sich alles weiter.
      var offen = zustand.boegen.filter(function (b) { return !b.bildUrl; });
      for (var i = 0; i < offen.length; i++) {
        if (offen.length > 3) melden('Preview ' + (i + 1) + ' of ' + offen.length);
        await vorschauErzeugen(offen[i]);
        bogenBildSetzen(offen[i]);
      }
      if (offen.length > 3) melden('');
    } finally {
      zeichneLaeuft = false;
    }
  }

  async function vorschauErzeugen(bogen) {
    var dok = dokVon(bogen.dokId);
    if (!dok) return;
    var seite = await dok.pdfjs.getPage(bogen.quelle + 1);
    var basis = seite.rotate;

    var eins = seite.getViewport({ scale: 1, rotation: basis });
    var skala = Math.min(THUMB_BREITE / eins.width, 2.4);
    var sicht = seite.getViewport({ scale: skala, rotation: basis });

    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sicht.width));
    c.height = Math.max(1, Math.round(sicht.height));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await seite.render({ canvasContext: ctx, viewport: sicht }).promise;

    // Die Vorschau zeigt die Seite aufrecht; die Nutzerdrehung besorgt CSS.
    // Text muss deshalb um genau diese Drehung zurueckgedreht werden.
    notizenMalen(ctx, bogen.notizen, sicht, -bogen.dreh, -1);

    var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
    if (bogen.bildUrl) URL.revokeObjectURL(bogen.bildUrl);
    bogen.bildUrl = URL.createObjectURL(blob);
  }

  function vorschauNeu(bogen) {
    if (bogen.bildUrl) { URL.revokeObjectURL(bogen.bildUrl); bogen.bildUrl = null; }
    vorschauenNachziehen();
  }

  // --- Notizen zeichnen (Leinwand) ---------------------------------------

  function rechteckSicht(n, sicht) {
    var a = sicht.convertToViewportPoint(n.x, n.y);
    var b = sicht.convertToViewportPoint(n.x + n.b, n.y + n.h);
    return {
      x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
      b: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1])
    };
  }

  function notizenMalen(ctx, notizen, sicht, drehGrad, markiert) {
    var s = sicht.scale;
    for (var i = 0; i < notizen.length; i++) {
      var n = notizen[i];
      ctx.save();
      if (n.art === 'text') {
        var a = sicht.convertToViewportPoint(n.x, n.y);
        ctx.translate(a[0], a[1]);
        if (drehGrad) ctx.rotate(drehGrad * Math.PI / 180);
        ctx.fillStyle = n.farbe;
        ctx.font = Math.max(1, n.grad * s) + 'px Helvetica, Arial, sans-serif';
        ctx.textBaseline = 'alphabetic';
        var zeilen = n.text.split('\n');
        for (var z = 0; z < zeilen.length; z++) {
          ctx.fillText(zeilen[z], 0, n.grad * s * (0.80 + z * 1.25));
        }
      } else if (n.art === 'stift' && n.punkte.length) {
        ctx.strokeStyle = n.farbe;
        ctx.lineWidth = Math.max(0.6, n.staerke * s);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        var letzt = null;
        for (var p = 0; p < n.punkte.length; p++) {
          letzt = sicht.convertToViewportPoint(n.punkte[p][0], n.punkte[p][1]);
          if (p === 0) ctx.moveTo(letzt[0], letzt[1]); else ctx.lineTo(letzt[0], letzt[1]);
        }
        // Ein einzelner Punkt braucht ein Mindeststueck, sonst zeichnet
        // Canvas mit lineCap "round" gar nichts.
        if (n.punkte.length === 1) ctx.lineTo(letzt[0] + 0.01, letzt[1]);
        ctx.stroke();
      } else {
        var r = rechteckSicht(n, sicht);
        ctx.fillStyle = n.art === 'weiss' ? '#ffffff' : n.farbe;
        ctx.globalAlpha = n.art === 'weiss' ? 1 : 0.38;
        ctx.fillRect(r.x, r.y, r.b, r.h);
      }
      ctx.restore();

      if (markiert === i) {
        var kasten = notizKasten(n, sicht);
        ctx.save();
        ctx.strokeStyle = '#1ba7cd';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(kasten.x - 3.5, kasten.y - 3.5, kasten.b + 7, kasten.h + 7);
        ctx.restore();
      }
    }
  }

  // Umriss einer Notiz in Sichtkoordinaten - fuer Auswahl und Treffertest.
  var messCtx = document.createElement('canvas').getContext('2d');

  function notizKasten(n, sicht) {
    var s = sicht.scale;
    if (n.art === 'text') {
      var a = sicht.convertToViewportPoint(n.x, n.y);
      messCtx.font = Math.max(1, n.grad * s) + 'px Helvetica, Arial, sans-serif';
      var zeilen = n.text.split('\n');
      var breit = 1;
      for (var z = 0; z < zeilen.length; z++) {
        breit = Math.max(breit, messCtx.measureText(zeilen[z]).width);
      }
      return { x: a[0], y: a[1], b: breit, h: n.grad * s * (0.25 + 1.25 * zeilen.length) };
    }
    if (n.art === 'stift') {
      var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (var p = 0; p < n.punkte.length; p++) {
        var v = sicht.convertToViewportPoint(n.punkte[p][0], n.punkte[p][1]);
        x1 = Math.min(x1, v[0]); y1 = Math.min(y1, v[1]);
        x2 = Math.max(x2, v[0]); y2 = Math.max(y2, v[1]);
      }
      var d = Math.max(2, n.staerke * s) / 2;
      return { x: x1 - d, y: y1 - d, b: (x2 - x1) + d * 2, h: (y2 - y1) + d * 2 };
    }
    return rechteckSicht(n, sicht);
  }

  // --- Tisch zeichnen -----------------------------------------------------

  var knoten = new Map();

  // Die Sinnbilder stehen als <symbol> im Dokument und werden hier nur
  // referenziert - so liegt jeder Pfad genau einmal auf der Seite.
  function symbol(name) {
    return '<svg class="sym" aria-hidden="true" focusable="false"><use href="#s-' + name + '"/></svg>';
  }

  function griffKnopf(tat, name, beschriftung, warn) {
    return '<button type="button" class="griff' + (warn ? ' griff-weg' : '') +
      '" data-tat="' + tat + '" title="' + beschriftung + '" aria-label="' + beschriftung + '">' +
      symbol(name) + '</button>';
  }

  function bogenElementBauen(bogen) {
    var fig = document.createElement('figure');
    fig.className = 'blatt';
    fig.setAttribute('role', 'listitem');
    fig.draggable = true;
    fig.dataset.uid = String(bogen.uid);
    fig.tabIndex = 0;

    fig.innerHTML =
      '<div class="blatt-herkunft"></div>' +
      '<div class="blatt-rahmen">' +
        '<span class="blatt-lade">loading</span>' +
        '<button type="button" class="blatt-haken" data-tat="haken" role="checkbox" aria-checked="false">' +
          symbol('haken') + '</button>' +
        '<div class="griffe">' +
          griffKnopf('links', 'links', 'Rotate 90° left') +
          griffKnopf('rechts', 'rechts', 'Rotate 90° right') +
          griffKnopf('bearbeiten', 'stift', 'Edit this page') +
          griffKnopf('doppeln', 'doppeln', 'Duplicate this page') +
          griffKnopf('weg', 'weg', 'Delete this page', true) +
        '</div>' +
      '</div>' +
      '<figcaption class="blatt-fuss">' +
        '<span class="blatt-nr"></span>' +
        '<span class="blatt-notiz"></span>' +
        '<span class="blatt-mass"></span>' +
      '</figcaption>';

    return fig;
  }

  function bogenBildSetzen(bogen) {
    var fig = knoten.get(bogen.uid);
    if (!fig || !bogen.bildUrl) return;
    var rahmen = fig.querySelector('.blatt-rahmen');
    var img = rahmen.querySelector('.blatt-bild');
    if (!img) {
      img = document.createElement('img');
      img.className = 'blatt-bild';
      img.alt = '';
      rahmen.insertBefore(img, rahmen.firstChild);
      var lade = rahmen.querySelector('.blatt-lade');
      if (lade) lade.remove();
    }
    if (img.src !== bogen.bildUrl) img.src = bogen.bildUrl;
  }

  function bogenAktualisieren(fig, bogen, nr) {
    var dok = dokVon(bogen.dokId);
    var quer = bogen.dreh === 90 || bogen.dreh === 270;
    var gewaehlt = zustand.wahl.has(bogen.uid);

    fig.dataset.quer = quer ? '1' : '0';
    fig.style.setProperty('--k', String(bogen.k));
    fig.style.setProperty('--ar', String(quer ? 1 / bogen.k : bogen.k));
    fig.style.setProperty('--dreh', bogen.dreh + 'deg');
    fig.style.setProperty('--farbe', dok ? dok.farbe : '#8a8a8a');
    fig.classList.toggle('gewaehlt', gewaehlt);

    var haken = fig.querySelector('.blatt-haken');
    haken.setAttribute('aria-checked', gewaehlt ? 'true' : 'false');
    haken.title = gewaehlt ? 'Clear selection' : 'Select this page';

    fig.setAttribute('aria-label', 'Page ' + nr + ' of ' + zustand.boegen.length + ', ' +
      (dok ? dok.name : 'unknown') + ', originally page ' + (bogen.quelle + 1) +
      ', ' + bogen.format + (bogen.dreh ? ', rotated ' + bogen.dreh + ' degrees' : ''));

    fig.querySelector('.blatt-nr').textContent = String(nr);
    fig.querySelector('.blatt-mass').innerHTML = bogen.format +
      (bogen.dreh ? ' <span class="blatt-dreh">' + bogen.dreh + '°</span>' : '');

    var notiz = fig.querySelector('.blatt-notiz');
    notiz.textContent = bogen.notizen.length ? '●' : '';
    notiz.title = bogen.notizen.length
      ? bogen.notizen.length + (bogen.notizen.length === 1 ? ' annotation' : ' annotations') : '';
  }

  function boegenZeichnen() {
    var vorhanden = new Set();

    for (var i = 0; i < zustand.boegen.length; i++) {
      var bogen = zustand.boegen[i];
      vorhanden.add(bogen.uid);
      var fig = knoten.get(bogen.uid);
      if (!fig) {
        fig = bogenElementBauen(bogen);
        knoten.set(bogen.uid, fig);
      }
      el.raster.appendChild(fig);            // schiebt vorhandene Knoten mit
      bogenAktualisieren(fig, bogen, i + 1);
      if (bogen.bildUrl) bogenBildSetzen(bogen);
    }

    knoten.forEach(function (fig, uid) {
      if (!vorhanden.has(uid)) { fig.remove(); knoten.delete(uid); }
    });

    el.leerbild.hidden = zustand.boegen.length > 0;
    quellenZeichnen();
    statusZeichnen();
    auswahlZeichnen();
  }

  function quellenZeichnen() {
    el.quellen.innerHTML = '';
    var sichtbar = 0;

    zustand.doks.forEach(function (dok) {
      var anzahl = zustand.boegen.filter(function (b) { return b.dokId === dok.id; }).length;
      if (!anzahl) return;
      sichtbar++;

      var chip = document.createElement('span');
      chip.className = 'quelle';
      chip.style.setProperty('--fabe', dok.farbe);
      chip.innerHTML =
        '<span class="quelle-punkt"></span>' +
        '<span class="quelle-name"></span>' +
        '<span class="quelle-zahl">' + anzahl + '</span>' +
        '<button type="button" class="quelle-weg" aria-label="Remove every page from this file">×</button>';
      chip.querySelector('.quelle-name').textContent = dok.name;
      chip.querySelector('.quelle-name').title = dok.name;
      chip.querySelector('.quelle-weg').title = 'Remove every page from ' + dok.name;
      chip.querySelector('.quelle-weg').addEventListener('click', function () {
        dokumentEntfernen(dok.id);
      });
      el.quellen.appendChild(chip);
    });

    el.quellen.hidden = sichtbar === 0;
  }

  function statusZeichnen() {
    var n = zustand.boegen.length;
    el.statSeiten.textContent = !n ? 'No pages' : n + (n === 1 ? ' page' : ' pages');

    var dokIds = new Set(zustand.boegen.map(function (b) { return b.dokId; }));
    el.statDoks.textContent = !dokIds.size ? 'No documents'
      : dokIds.size + (dokIds.size === 1 ? ' document' : ' documents');

    var formate = new Set(zustand.boegen.map(function (b) { return b.format; }));
    el.statFormat.textContent = !n ? '–'
      : formate.size === 1 ? Array.from(formate)[0]
      : formate.size + ' mixed sizes';

    var leer = n === 0;
    $('btnAlleDrehen').disabled = leer;
    $('btnUmkehren').disabled = leer;
    $('btnAlleWaehlen').disabled = leer;
    $('btnSpeichern').disabled = leer;
    $('btnNachQuelle').disabled = leer || dokIds.size < 2;
    el.speichernText.textContent = leer ? 'Save PDF' : 'Save PDF (' + n + ')';
  }

  // Die Befehle fuer einzelne Seiten haengen an der Auswahl. Ausgegraut statt
  // versteckt: so ist zu sehen, dass es sie gibt und was ihnen fehlt.
  function auswahlZeichnen() {
    var n = zustand.wahl.size;

    el.wahlpille.hidden = n === 0;
    el.wahlAnzahl.textContent = String(n);
    $('wahlWort').textContent = n === 1 ? 'page selected' : 'pages selected';

    $('btnDrehLinks').disabled = n === 0;
    $('btnDrehRechts').disabled = n === 0;
    $('btnDoppeln').disabled = n === 0;
    $('btnLoeschen').disabled = n === 0;
    $('btnBearbeiten').disabled = n !== 1;

    knoten.forEach(function (fig, uid) {
      var an = zustand.wahl.has(uid);
      fig.classList.toggle('gewaehlt', an);
      var haken = fig.querySelector('.blatt-haken');
      if (haken) {
        haken.setAttribute('aria-checked', an ? 'true' : 'false');
        haken.title = an ? 'Clear selection' : 'Select this page';
      }
    });
  }

  // --- Seitenoperationen --------------------------------------------------

  function zielBoegen(uid) {
    // Aktion trifft die Auswahl, wenn der angefasste Bogen dazugehoert -
    // sonst nur ihn selbst.
    if (uid != null && !zustand.wahl.has(uid)) return [bogenVon(uid)].filter(Boolean);
    return zustand.boegen.filter(function (b) { return zustand.wahl.has(b.uid); });
  }

  function drehen(boegen, richtung) {
    if (!boegen.length) return;
    verlaufMerken();
    boegen.forEach(function (b) { b.dreh = normDreh(b.dreh + richtung * 90); });
    boegenZeichnen();
  }

  function loeschen(boegen) {
    if (!boegen.length) return;
    verlaufMerken();
    var weg = new Set(boegen.map(function (b) { return b.uid; }));
    zustand.boegen = zustand.boegen.filter(function (b) { return !weg.has(b.uid); });
    weg.forEach(function (u) { zustand.wahl.delete(u); });
    boegenZeichnen();
    melden(weg.size + (weg.size === 1 ? ' page' : ' pages') + ' removed. Ctrl+Z brings them back.');
  }

  function doppeln(boegen) {
    if (!boegen.length) return;
    verlaufMerken();
    // Von hinten nach vorn einfuegen, damit die Indizes waehrend der Schleife
    // stimmen bleiben.
    var sortiert = boegen.slice().sort(function (a, b) {
      return bogenIndex(b.uid) - bogenIndex(a.uid);
    });
    sortiert.forEach(function (b) {
      var kopie = {
        uid: zustand.naechsteBogenId++,
        dokId: b.dokId, quelle: b.quelle, dreh: b.dreh,
        notizen: JSON.parse(JSON.stringify(b.notizen)),
        w0: b.w0, h0: b.h0, k: b.k, format: b.format, bildUrl: null
      };
      zustand.boegen.splice(bogenIndex(b.uid) + 1, 0, kopie);
    });
    boegenZeichnen();
    vorschauenNachziehen();
  }

  function verschieben(boegen, ziel) {
    if (!boegen.length) return;
    verlaufMerken();
    var uids = new Set(boegen.map(function (b) { return b.uid; }));
    var genommen = zustand.boegen.filter(function (b) { return uids.has(b.uid); });
    var rest = zustand.boegen.filter(function (b) { return !uids.has(b.uid); });

    if (ziel === 'anfang') zustand.boegen = genommen.concat(rest);
    else if (ziel === 'ende') zustand.boegen = rest.concat(genommen);
    else {
      // Um eine Position nach links oder rechts ruecken. Beim Ruecken nach
      // links zuerst die vorderste Seite, nach rechts die hinterste - sonst
      // ueberholen sich mehrere ausgewaehlte Seiten gegenseitig.
      var schritt = ziel;
      var neu = zustand.boegen.slice();
      var reihe = genommen.slice().sort(function (a, b) {
        return schritt < 0 ? neu.indexOf(a) - neu.indexOf(b) : neu.indexOf(b) - neu.indexOf(a);
      });
      for (var i = 0; i < reihe.length; i++) {
        var von = neu.indexOf(reihe[i]);
        var nach = von + schritt;
        if (nach < 0 || nach >= neu.length) continue;
        if (uids.has(neu[nach].uid)) continue;
        neu[von] = neu[nach];
        neu[nach] = reihe[i];
      }
      zustand.boegen = neu;
    }
    boegenZeichnen();
  }

  function dokumentEntfernen(dokId) {
    verlaufMerken();
    zustand.boegen = zustand.boegen.filter(function (b) {
      if (b.dokId !== dokId) return true;
      if (b.bildUrl) URL.revokeObjectURL(b.bildUrl);
      zustand.wahl.delete(b.uid);
      return false;
    });
    var dok = dokVon(dokId);
    if (dok) {
      try { dok.pdfjs.destroy(); } catch (f) { /* egal */ }
      zustand.doks = zustand.doks.filter(function (d) { return d.id !== dokId; });
    }
    boegenZeichnen();
  }

  // --- Auswahl ------------------------------------------------------------

  var letzteWahl = null;

  function bogenAnklicken(uid, ereignis) {
    if (ereignis.shiftKey && letzteWahl != null) {
      var a = bogenIndex(letzteWahl), b = bogenIndex(uid);
      if (a >= 0 && b >= 0) {
        var von = Math.min(a, b), bis = Math.max(a, b);
        for (var i = von; i <= bis; i++) zustand.wahl.add(zustand.boegen[i].uid);
      }
    } else if (ereignis.ctrlKey || ereignis.metaKey) {
      if (zustand.wahl.has(uid)) zustand.wahl.delete(uid); else zustand.wahl.add(uid);
      letzteWahl = uid;
    } else {
      zustand.wahl.clear();
      zustand.wahl.add(uid);
      letzteWahl = uid;
    }
    auswahlZeichnen();
  }

  // --- Ziehen und Ablegen im Raster --------------------------------------

  function markenLoeschen() {
    knoten.forEach(function (f) { f.classList.remove('ziel-vor', 'ziel-nach'); });
  }

  function zielBestimmen(x, y) {
    var beste = null, bestAbstand = Infinity, vor = true;
    knoten.forEach(function (fig, uid) {
      var r = fig.getBoundingClientRect();
      var mx = r.left + r.width / 2, my = r.top + r.height / 2;
      var d = Math.hypot(x - mx, y - my);
      if (d < bestAbstand) { bestAbstand = d; beste = { fig: fig, uid: uid }; vor = x < mx; }
    });
    markenLoeschen();
    if (!beste) { zustand.zielIndex = zustand.boegen.length; return; }
    beste.fig.classList.add(vor ? 'ziel-vor' : 'ziel-nach');
    zustand.zielIndex = bogenIndex(beste.uid) + (vor ? 0 : 1);
  }

  function ablegenAusfuehren() {
    var ziehe = zustand.ziehen;
    markenLoeschen();
    if (!ziehe || zustand.zielIndex < 0) { zustand.ziehen = null; return; }

    verlaufMerken();
    var uids = new Set(ziehe);
    var vorher = zustand.boegen.slice(0, zustand.zielIndex)
      .filter(function (b) { return !uids.has(b.uid); }).length;
    var genommen = zustand.boegen.filter(function (b) { return uids.has(b.uid); });
    var rest = zustand.boegen.filter(function (b) { return !uids.has(b.uid); });

    zustand.boegen = rest.slice(0, vorher).concat(genommen, rest.slice(vorher));
    zustand.ziehen = null;
    zustand.zielIndex = -1;
    boegenZeichnen();
  }

  el.raster.addEventListener('dragstart', function (e) {
    var fig = e.target.closest('.blatt');
    if (!fig) return;
    var uid = Number(fig.dataset.uid);
    zustand.ziehen = zustand.wahl.has(uid) && zustand.wahl.size > 1
      ? zustand.boegen.filter(function (b) { return zustand.wahl.has(b.uid); }).map(function (b) { return b.uid; })
      : [uid];
    zustand.ziehen.forEach(function (u) {
      var f = knoten.get(u); if (f) f.classList.add('zieht');
    });
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(uid)); } catch (f) { /* Safari */ }
  });

  el.raster.addEventListener('dragend', function () {
    knoten.forEach(function (f) { f.classList.remove('zieht'); });
    markenLoeschen();
    zustand.ziehen = null;
  });

  el.tisch.addEventListener('dragover', function (e) {
    if (!zustand.ziehen) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zielBestimmen(e.clientX, e.clientY);
  });

  el.tisch.addEventListener('drop', function (e) {
    if (!zustand.ziehen) return;
    e.preventDefault();
    ablegenAusfuehren();
  });

  // --- Klicks im Raster ---------------------------------------------------

  el.raster.addEventListener('click', function (e) {
    var griff = e.target.closest('.griff');
    var haken = e.target.closest('.blatt-haken');
    var fig = e.target.closest('.blatt');
    if (!fig) return;
    var uid = Number(fig.dataset.uid);

    // Das Kaestchen schaltet immer nur diese eine Seite um - unabhaengig von
    // Zusatztasten, so wie man es von Dateilisten kennt.
    if (haken) {
      e.stopPropagation();
      if (zustand.wahl.has(uid)) zustand.wahl.delete(uid); else zustand.wahl.add(uid);
      letzteWahl = uid;
      auswahlZeichnen();
      return;
    }

    if (griff) {
      e.stopPropagation();
      var tat = griff.dataset.tat;
      if (tat === 'links') drehen(zielBoegen(uid), -1);
      else if (tat === 'rechts') drehen(zielBoegen(uid), 1);
      else if (tat === 'weg') loeschen(zielBoegen(uid));
      else if (tat === 'doppeln') doppeln(zielBoegen(uid));
      else if (tat === 'bearbeiten') lupeOeffnen(uid);
      return;
    }
    bogenAnklicken(uid, e);
  });

  el.raster.addEventListener('dblclick', function (e) {
    var fig = e.target.closest('.blatt');
    if (fig && !e.target.closest('.griff')) lupeOeffnen(Number(fig.dataset.uid));
  });

  el.tisch.addEventListener('mousedown', function (e) {
    if (e.target === el.tisch || e.target === el.raster) {
      zustand.wahl.clear();
      auswahlZeichnen();
    }
  });

  // --- Tastatur -----------------------------------------------------------

  document.addEventListener('keydown', function (e) {
    if (el.lupe.open) return;                       // der Kasten hoert selbst zu
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (el.speichernDialog.open) return;

    var strg = e.ctrlKey || e.metaKey;
    var taste = (e.key || '').toLowerCase();

    if (strg && taste === 'z') { e.preventDefault(); zurueck(); return; }
    if (strg && taste === 'a') {
      e.preventDefault();
      zustand.boegen.forEach(function (b) { zustand.wahl.add(b.uid); });
      auswahlZeichnen();
      return;
    }
    if (strg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      verschieben(zielBoegen(null), e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (e.key === 'Escape') {
      if (!el.hilfeBlase.hidden) { hilfeSchliessen(); return; }
      zustand.wahl.clear();
      auswahlZeichnen();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (zustand.wahl.size) { e.preventDefault(); loeschen(zielBoegen(null)); }
      return;
    }
    if (taste === 'r' && !strg) {
      if (zustand.wahl.size) { e.preventDefault(); drehen(zielBoegen(null), e.shiftKey ? -1 : 1); }
    }
  });

  // --- Dateien annehmen ---------------------------------------------------

  $('btnDateien').addEventListener('click', function () { el.dateiFeld.click(); });
  $('btnDateien2').addEventListener('click', function () { el.dateiFeld.click(); });
  el.dateiFeld.addEventListener('change', function () {
    dateienAufnehmen(el.dateiFeld.files);
    el.dateiFeld.value = '';
  });

  var ziehZaehler = 0;
  window.addEventListener('dragenter', function (e) {
    if (zustand.ziehen) return;
    if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
    ziehZaehler++;
    el.ablegen.hidden = false;
  });
  window.addEventListener('dragleave', function () {
    if (zustand.ziehen) return;
    ziehZaehler = Math.max(0, ziehZaehler - 1);
    if (!ziehZaehler) el.ablegen.hidden = true;
  });
  window.addEventListener('dragover', function (e) {
    if (zustand.ziehen) return;
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  window.addEventListener('drop', function (e) {
    if (zustand.ziehen) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      ziehZaehler = 0;
      el.ablegen.hidden = true;
      dateienAufnehmen(e.dataTransfer.files);
    }
  });

  // --- Pult ---------------------------------------------------------------

  $('btnLeerseite').addEventListener('click', leerseiteAnfuegen);
  $('btnZurueck').addEventListener('click', zurueck);

  $('btnAlleDrehen').addEventListener('click', function () {
    drehen(zustand.boegen, 1);
  });

  $('btnUmkehren').addEventListener('click', function () {
    verlaufMerken();
    zustand.boegen.reverse();
    boegenZeichnen();
  });

  $('btnNachQuelle').addEventListener('click', function () {
    verlaufMerken();
    var rang = {};
    zustand.doks.forEach(function (d, i) { rang[d.id] = i; });
    zustand.boegen.sort(function (a, b) {
      return (rang[a.dokId] - rang[b.dokId]) || (a.quelle - b.quelle);
    });
    boegenZeichnen();
    melden('Sorted by document and original page order.');
  });

  $('btnDrehLinks').addEventListener('click', function () { drehen(zielBoegen(null), -1); });
  $('btnDrehRechts').addEventListener('click', function () { drehen(zielBoegen(null), 1); });
  $('btnDoppeln').addEventListener('click', function () { doppeln(zielBoegen(null)); });
  $('btnLoeschen').addEventListener('click', function () { loeschen(zielBoegen(null)); });

  $('btnBearbeiten').addEventListener('click', function () {
    var ziel = zielBoegen(null);
    if (ziel.length === 1) lupeOeffnen(ziel[0].uid);
  });

  $('btnAlleWaehlen').addEventListener('click', function () {
    // Zweiter Druck hebt die Auswahl wieder auf - ein Knopf, zwei Richtungen.
    if (zustand.wahl.size === zustand.boegen.length) zustand.wahl.clear();
    else zustand.boegen.forEach(function (b) { zustand.wahl.add(b.uid); });
    auswahlZeichnen();
  });

  // --- Hilfeblase ---------------------------------------------------------

  function hilfeSchliessen() {
    el.hilfeBlase.hidden = true;
    $('btnHilfe').setAttribute('aria-expanded', 'false');
  }

  $('btnHilfe').addEventListener('click', function (e) {
    e.stopPropagation();
    var auf = el.hilfeBlase.hidden;
    el.hilfeBlase.hidden = !auf;
    $('btnHilfe').setAttribute('aria-expanded', auf ? 'true' : 'false');
  });

  document.addEventListener('click', function (e) {
    if (el.hilfeBlase.hidden) return;
    if (!e.target.closest('#hilfeBlase') && !e.target.closest('#btnHilfe')) hilfeSchliessen();
  });

  // --- Helligkeit ---------------------------------------------------------

  var THEMA_SCHLUESSEL = 'pdf-editor-thema';
  function themaSetzen(wert) {
    if (wert) document.documentElement.setAttribute('data-theme', wert);
    else document.documentElement.removeAttribute('data-theme');
    try { wert ? localStorage.setItem(THEMA_SCHLUESSEL, wert) : localStorage.removeItem(THEMA_SCHLUESSEL); }
    catch (f) { /* privater Modus */ }
  }
  try {
    var gemerkt = localStorage.getItem(THEMA_SCHLUESSEL);
    if (gemerkt) document.documentElement.setAttribute('data-theme', gemerkt);
  } catch (f) { /* privater Modus */ }

  $('btnThema').addEventListener('click', function () {
    var jetzt = document.documentElement.getAttribute('data-theme');
    if (!jetzt) {
      var dunkelSystem = window.matchMedia('(prefers-color-scheme: dark)').matches;
      themaSetzen(dunkelSystem ? 'light' : 'dark');
    } else {
      themaSetzen(jetzt === 'dark' ? 'light' : 'dark');
    }
  });

  // --- Leuchtkasten: Seite bearbeiten ------------------------------------

  var lupe = {
    bogen: null, seite: null, sicht: null, basis: null,
    skala: 1, zoom: 1, drehung: 0,
    notizen: [], gewaehlt: -1, verlauf: [],
    wz: 'wahl', farbe: STIFTFARBEN[0], grad: 14, staerke: 3,
    zieht: null, eingabeAn: null
  };

  var lctx = el.lupeCanvas.getContext('2d');

  STIFTFARBEN.forEach(function (hex, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'farbe';
    b.style.background = hex;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
    b.setAttribute('aria-label', 'Color ' + hex);
    b.dataset.hex = hex;
    b.addEventListener('click', function () {
      lupe.farbe = hex;
      if (WZ_FARBE[lupe.wz]) WZ_FARBE[lupe.wz] = hex;
      farbeMarkieren(hex);
      if (lupe.gewaehlt >= 0) {
        var n = lupe.notizen[lupe.gewaehlt];
        if (n.art !== 'weiss') { lupeMerken(); n.farbe = hex; lupeMalen(); }
      }
    });
    el.farbwahl.appendChild(b);
  });

  function farbeMarkieren(hex) {
    Array.prototype.forEach.call(el.farbwahl.children, function (k) {
      k.setAttribute('aria-checked', k.dataset.hex === hex ? 'true' : 'false');
    });
  }

  function werkzeugSetzen(wz) {
    lupe.wz = wz;
    if (WZ_FARBE[wz]) { lupe.farbe = WZ_FARBE[wz]; farbeMarkieren(lupe.farbe); }
    Array.prototype.forEach.call(el.lupe.querySelectorAll('.wz'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.wz === wz ? 'true' : 'false');
    });
    el.lupeBlatt.dataset.wz = wz;
    if (wz !== 'wahl') { lupe.gewaehlt = -1; }
    Array.prototype.forEach.call(el.lupeOptionen.querySelectorAll('.opt-gruppe[data-fuer]'), function (g) {
      g.hidden = g.dataset.fuer.split(' ').indexOf(wz) < 0;
    });
    lupeMalen();
  }

  el.lupe.addEventListener('click', function (e) {
    var b = e.target.closest('.wz');
    if (b) { textEingabeAbschliessen(); werkzeugSetzen(b.dataset.wz); }
  });

  async function lupeOeffnen(uid) {
    var bogen = bogenVon(uid);
    if (!bogen) return;
    var dok = dokVon(bogen.dokId);
    if (!dok) return;

    lupe.bogen = bogen;
    lupe.notizen = JSON.parse(JSON.stringify(bogen.notizen));
    lupe.verlauf = [];
    lupe.gewaehlt = -1;
    lupe.zoom = 1;
    el.lupeZurueck.disabled = true;

    el.lupeNr.textContent = String(bogenIndex(uid) + 1);
    el.lupeQuelle.textContent = dok.name + ' · page ' + (bogen.quelle + 1);
    el.lupeQuelle.style.setProperty('--farbe', dok.farbe);

    lupe.seite = await dok.pdfjs.getPage(bogen.quelle + 1);
    lupe.drehung = normDreh(lupe.seite.rotate + bogen.dreh);

    el.lupe.showModal();
    werkzeugSetzen('wahl');
    await lupeRendern();
  }

  function lupeSkalaBerechnen() {
    var eins = lupe.seite.getViewport({ scale: 1, rotation: lupe.drehung });
    var r = el.lupeBuehne.getBoundingClientRect();
    var platzB = Math.max(200, r.width - 48);
    var platzH = Math.max(200, r.height - 48);
    var passt = Math.min(platzB / eins.width, platzH / eins.height);
    return Math.max(0.08, passt * lupe.zoom);
  }

  async function lupeRendern() {
    lupe.skala = lupeSkalaBerechnen();
    lupe.sicht = lupe.seite.getViewport({ scale: lupe.skala, rotation: lupe.drehung });

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var geraet = lupe.seite.getViewport({ scale: lupe.skala * dpr, rotation: lupe.drehung });

    var basis = document.createElement('canvas');
    basis.width = Math.max(1, Math.round(geraet.width));
    basis.height = Math.max(1, Math.round(geraet.height));
    var bctx = basis.getContext('2d');
    bctx.fillStyle = '#ffffff';
    bctx.fillRect(0, 0, basis.width, basis.height);
    await lupe.seite.render({ canvasContext: bctx, viewport: geraet }).promise;
    lupe.basis = basis;

    el.lupeCanvas.width = basis.width;
    el.lupeCanvas.height = basis.height;
    el.lupeCanvas.style.width = Math.round(lupe.sicht.width) + 'px';
    el.lupeCanvas.style.height = Math.round(lupe.sicht.height) + 'px';
    lupe.dpr = dpr;

    el.zoomWert.textContent = Math.round(lupe.zoom * 100) + ' %';
    lupeMalen();
  }

  function lupeMalen() {
    if (!lupe.basis) return;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, el.lupeCanvas.width, el.lupeCanvas.height);
    lctx.setTransform(lupe.dpr, 0, 0, lupe.dpr, 0, 0);
    lctx.drawImage(lupe.basis, 0, 0, lupe.sicht.width, lupe.sicht.height);
    notizenMalen(lctx, lupe.notizen, lupe.sicht, 0, lupe.gewaehlt);
  }

  function lupeMerken() {
    lupe.verlauf.push(JSON.parse(JSON.stringify(lupe.notizen)));
    if (lupe.verlauf.length > VERLAUF_TIEFE) lupe.verlauf.shift();
    el.lupeZurueck.disabled = false;
  }

  el.lupeZurueck.addEventListener('click', function () {
    var stand = lupe.verlauf.pop();
    if (!stand) return;
    lupe.notizen = stand;
    lupe.gewaehlt = -1;
    el.lupeZurueck.disabled = lupe.verlauf.length === 0;
    lupeMalen();
  });

  function zeigerPunkt(e) {
    var r = el.lupeCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function pdfPunkt(vx, vy) { return lupe.sicht.convertToPdfPoint(vx, vy); }

  function trefferIndex(vx, vy) {
    for (var i = lupe.notizen.length - 1; i >= 0; i--) {
      var k = notizKasten(lupe.notizen[i], lupe.sicht);
      if (vx >= k.x - 4 && vx <= k.x + k.b + 4 && vy >= k.y - 4 && vy <= k.y + k.h + 4) return i;
    }
    return -1;
  }

  el.lupeCanvas.addEventListener('pointerdown', function (e) {
    if (lupe.eingabeAn) { textEingabeAbschliessen(); return; }
    var p = zeigerPunkt(e);

    if (lupe.wz === 'text') {
      // preventDefault ist hier der ganze Kniff: auf pointerdown folgt ein
      // mousedown, dessen Standardablauf den Fokus auf die Leinwand zieht.
      // Das frisch geoeffnete Textfeld verloere ihn im selben Wimpernschlag
      // wieder, der blur-Handler schloesse es leer - und Text schreiben waere
      // unmoeglich. Der Zeiger wird deshalb auch nicht eingefangen.
      e.preventDefault();
      textEingabeOeffnen(p[0], p[1]);
      return;
    }

    // Ohne echten Zeiger (Stiftersatz, Automatisierung) wirft das Einfangen -
    // gezeichnet wird trotzdem, es fehlt nur das Nachfuehren ausserhalb.
    try { el.lupeCanvas.setPointerCapture(e.pointerId); } catch (f) { /* egal */ }

    if (lupe.wz === 'wahl') {
      lupe.gewaehlt = trefferIndex(p[0], p[1]);
      if (lupe.gewaehlt >= 0) {
        lupeMerken();
        lupe.zieht = { art: 'schieben', vonV: p, vonPdf: pdfPunkt(p[0], p[1]),
                       start: JSON.parse(JSON.stringify(lupe.notizen[lupe.gewaehlt])) };
      }
      lupeMalen();
      return;
    }

    lupeMerken();

    if (lupe.wz === 'stift') {
      var a = pdfPunkt(p[0], p[1]);
      lupe.notizen.push({ art: 'stift', punkte: [[a[0], a[1]]], staerke: lupe.staerke, farbe: lupe.farbe });
      lupe.zieht = { art: 'stift' };
    } else {
      var b = pdfPunkt(p[0], p[1]);
      lupe.notizen.push({
        art: lupe.wz === 'weiss' ? 'weiss' : 'marker',
        x: b[0], y: b[1], b: 0, h: 0,
        farbe: lupe.wz === 'weiss' ? '#ffffff' : lupe.farbe
      });
      lupe.zieht = { art: 'rechteck', ankerPdf: b };
    }
    lupeMalen();
  });

  el.lupeCanvas.addEventListener('pointermove', function (e) {
    if (!lupe.zieht) return;
    var p = zeigerPunkt(e);

    if (lupe.zieht.art === 'stift') {
      var a = pdfPunkt(p[0], p[1]);
      lupe.notizen[lupe.notizen.length - 1].punkte.push([a[0], a[1]]);
    } else if (lupe.zieht.art === 'rechteck') {
      var b = pdfPunkt(p[0], p[1]);
      var n = lupe.notizen[lupe.notizen.length - 1];
      var anker = lupe.zieht.ankerPdf;
      n.x = Math.min(anker[0], b[0]);
      n.y = Math.min(anker[1], b[1]);
      n.b = Math.abs(b[0] - anker[0]);
      n.h = Math.abs(b[1] - anker[1]);
    } else if (lupe.zieht.art === 'schieben' && lupe.gewaehlt >= 0) {
      var jetzt = pdfPunkt(p[0], p[1]);
      var dx = jetzt[0] - lupe.zieht.vonPdf[0];
      var dy = jetzt[1] - lupe.zieht.vonPdf[1];
      var start = lupe.zieht.start;
      var ziel = lupe.notizen[lupe.gewaehlt];
      if (ziel.art === 'stift') {
        ziel.punkte = start.punkte.map(function (q) { return [q[0] + dx, q[1] + dy]; });
      } else {
        ziel.x = start.x + dx;
        ziel.y = start.y + dy;
      }
    }
    lupeMalen();
  });

  function ziehenBeenden() {
    if (!lupe.zieht) return;
    if (lupe.zieht.art === 'rechteck') {
      var n = lupe.notizen[lupe.notizen.length - 1];
      if (n.b < 2 || n.h < 2) { lupe.notizen.pop(); lupe.verlauf.pop(); }
    }
    if (lupe.zieht.art === 'stift') {
      var s = lupe.notizen[lupe.notizen.length - 1];
      if (s.punkte.length < 2) { lupe.notizen.pop(); lupe.verlauf.pop(); }
    }
    el.lupeZurueck.disabled = lupe.verlauf.length === 0;
    lupe.zieht = null;
    lupeMalen();
  }

  el.lupeCanvas.addEventListener('pointerup', ziehenBeenden);
  el.lupeCanvas.addEventListener('pointercancel', ziehenBeenden);

  // Texteingabe: ein Feld schwebt auf dem Bogen und uebernimmt beim Verlassen.
  // Erst wenn das Feld den Fokus wirklich bekommen hat, darf sein Verlassen
  // als "fertig getippt" gelten. Sonst schliesst ein Fokuswechsel, der noch
  // zum Oeffnen gehoert, das Feld sofort wieder.
  var textFeldBereit = false;

  function textEingabeOeffnen(vx, vy, vorhanden) {
    lupe.eingabeAn = { vx: vx, vy: vy, index: vorhanden != null ? vorhanden : -1 };
    textFeldBereit = false;

    var feld = el.lupeEingabe;
    feld.hidden = false;
    feld.style.left = vx + 'px';
    feld.style.top = vy + 'px';
    feld.style.fontSize = (lupe.grad * lupe.skala) + 'px';
    feld.style.color = lupe.farbe === '#ffffff' ? '#444' : lupe.farbe;
    feld.value = vorhanden != null ? lupe.notizen[vorhanden].text : '';
    textFeldAnpassen();

    feld.focus();
    feld.setSelectionRange(feld.value.length, feld.value.length);
    // Zweiter Versuch nach dem laufenden Ereignis, falls ein Browser den
    // Fokus doch noch verschiebt.
    setTimeout(function () {
      if (lupe.eingabeAn && document.activeElement !== feld) feld.focus();
    }, 0);
  }

  function textFeldAnpassen() {
    var e = el.lupeEingabe;
    var zeilen = e.value.split('\n');
    var laengste = zeilen.reduce(function (a, b) { return b.length > a.length ? b : a; }, '');
    e.rows = zeilen.length;
    e.style.width = Math.max(3, laengste.length + 1) + 'ch';
    e.style.height = (zeilen.length * lupe.grad * lupe.skala * 1.25 + 6) + 'px';
  }

  function textEingabeAbschliessen() {
    if (!lupe.eingabeAn) return;
    var stelle = lupe.eingabeAn;
    var text = winAnsiOnly(el.lupeEingabe.value).replace(/\s+$/, '');
    lupe.eingabeAn = null;
    textFeldBereit = false;
    el.lupeEingabe.hidden = true;
    el.lupeEingabe.value = '';

    if (!text) return;
    lupeMerken();
    var a = pdfPunkt(stelle.vx, stelle.vy);
    if (stelle.index >= 0) {
      lupe.notizen[stelle.index].text = text;
    } else {
      lupe.notizen.push({ art: 'text', text: text, x: a[0], y: a[1], grad: lupe.grad, farbe: lupe.farbe });
    }
    lupeMalen();
  }

  el.lupeEingabe.addEventListener('input', textFeldAnpassen);
  el.lupeEingabe.addEventListener('focus', function () { textFeldBereit = true; });
  el.lupeEingabe.addEventListener('blur', function () {
    if (textFeldBereit) textEingabeAbschliessen();
  });
  el.lupeEingabe.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textEingabeAbschliessen(); el.lupeCanvas.focus(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      lupe.eingabeAn = null;
      textFeldBereit = false;
      el.lupeEingabe.hidden = true;
      el.lupeEingabe.value = '';
    }
  });

  el.optGrad.addEventListener('input', function () {
    lupe.grad = Number(el.optGrad.value);
    el.optGradWert.textContent = lupe.grad + ' pt';
    if (lupe.gewaehlt >= 0 && lupe.notizen[lupe.gewaehlt].art === 'text') {
      lupe.notizen[lupe.gewaehlt].grad = lupe.grad;
      lupeMalen();
    }
  });

  el.optStaerke.addEventListener('input', function () {
    lupe.staerke = Number(el.optStaerke.value);
    el.optStaerkeWert.textContent = lupe.staerke + ' pt';
    if (lupe.gewaehlt >= 0 && lupe.notizen[lupe.gewaehlt].art === 'stift') {
      lupe.notizen[lupe.gewaehlt].staerke = lupe.staerke;
      lupeMalen();
    }
  });

  $('zoomRein').addEventListener('click', function () {
    lupe.zoom = Math.min(4, lupe.zoom * 1.25);
    lupeRendern();
  });
  $('zoomRaus').addEventListener('click', function () {
    lupe.zoom = Math.max(0.25, lupe.zoom / 1.25);
    lupeRendern();
  });

  el.lupe.addEventListener('keydown', function (e) {
    if (lupe.eingabeAn) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (lupe.gewaehlt >= 0) {
        e.preventDefault();
        lupeMerken();
        lupe.notizen.splice(lupe.gewaehlt, 1);
        lupe.gewaehlt = -1;
        lupeMalen();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      lupeSchliessen(false);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      el.lupeZurueck.click();
    }
  });

  el.lupeCanvas.addEventListener('dblclick', function (e) {
    if (lupe.wz !== 'wahl') return;
    var p = zeigerPunkt(e);
    var i = trefferIndex(p[0], p[1]);
    if (i >= 0 && lupe.notizen[i].art === 'text') {
      var v = lupe.sicht.convertToViewportPoint(lupe.notizen[i].x, lupe.notizen[i].y);
      lupe.grad = lupe.notizen[i].grad;
      lupe.farbe = lupe.notizen[i].farbe;
      textEingabeOeffnen(v[0], v[1], i);
    }
  });

  function lupeSchliessen(uebernehmen) {
    textEingabeAbschliessen();
    if (uebernehmen && lupe.bogen) {
      var vorher = JSON.stringify(lupe.bogen.notizen);
      var nachher = JSON.stringify(lupe.notizen);
      if (vorher !== nachher) {
        verlaufMerken();
        lupe.bogen.notizen = lupe.notizen;
        vorschauNeu(lupe.bogen);
        boegenZeichnen();
        melden('Changes applied.');
      }
    }
    lupe.bogen = null;
    lupe.seite = null;
    lupe.basis = null;
    lupe.notizen = [];
    el.lupe.close();
  }

  $('lupeOk').addEventListener('click', function () { lupeSchliessen(true); });
  $('lupeAbbruch').addEventListener('click', function () { lupeSchliessen(false); });
  el.lupe.addEventListener('cancel', function (e) { e.preventDefault(); lupeSchliessen(false); });

  var groesseUhr = null;
  window.addEventListener('resize', function () {
    if (!el.lupe.open || !lupe.seite) return;
    clearTimeout(groesseUhr);
    groesseUhr = setTimeout(function () { lupeRendern(); }, 160);
  });

  // --- Zusammenfuehren ----------------------------------------------------

  $('btnSpeichern').addEventListener('click', function () {
    if (!zustand.boegen.length) return;
    el.nurAuswahl.disabled = zustand.wahl.size === 0;
    if (!zustand.wahl.size) el.nurAuswahl.checked = false;
    el.dlgAnzahl.textContent = String(zustand.wahl.size);
    umfangZeigen();
    el.speichernDialog.showModal();
    el.dateiName.select();
  });

  function umfangZeigen() {
    var n = el.nurAuswahl.checked ? zustand.wahl.size : zustand.boegen.length;
    var doks = new Set((el.nurAuswahl.checked
      ? zustand.boegen.filter(function (b) { return zustand.wahl.has(b.uid); })
      : zustand.boegen).map(function (b) { return b.dokId; }));
    el.dlgUmfang.textContent = n + (n === 1 ? ' page' : ' pages') + ' from ' +
      doks.size + (doks.size === 1 ? ' document' : ' documents');
    $('dlgOk').disabled = n === 0;
  }

  el.nurAuswahl.addEventListener('change', umfangZeigen);
  $('dlgAbbruch').addEventListener('click', function () { el.speichernDialog.close(); });

  el.speichernForm.addEventListener('submit', function (e) {
    e.preventDefault();
    el.speichernDialog.close();
    var name = (el.dateiName.value || 'combined').replace(/[\\/:*?"<>|]/g, '-').trim();
    zusammenfuehren(name || 'combined', el.nurAuswahl.checked);
  });

  async function zusammenfuehren(name, nurWahl) {
    var liste = nurWahl
      ? zustand.boegen.filter(function (b) { return zustand.wahl.has(b.uid); })
      : zustand.boegen.slice();
    if (!liste.length) return;

    arbeitZeigen('Combining', 0.05);
    try {
      var ziel = await PDFDocument.create();
      var schrift = await ziel.embedFont(StandardFonts.Helvetica);

      // Nach Quelldokument buendeln, damit pdf-lib je Dokument nur einmal den
      // Objektgraphen durchlaeuft. Mehrfach benutzte Seiten brauchen dabei
      // getrennte Runden: der Kopierer merkt sich bereits kopierte Objekte und
      // liefert sonst zweimal dieselbe Seite zurueck.
      var proDok = new Map();
      liste.forEach(function (b, i) {
        if (!proDok.has(b.dokId)) proDok.set(b.dokId, []);
        proDok.get(b.dokId).push({ i: i, s: b.quelle });
      });

      var kopien = new Array(liste.length);
      var erledigt = 0;

      for (var eintrag of proDok) {
        var dok = dokVon(eintrag[0]);
        if (!dok) continue;
        var runden = [];
        var zaehler = new Map();
        eintrag[1].forEach(function (e2) {
          var n = zaehler.get(e2.s) || 0;
          zaehler.set(e2.s, n + 1);
          if (!runden[n]) runden[n] = [];
          runden[n].push(e2);
        });
        for (var r = 0; r < runden.length; r++) {
          var runde = runden[r];
          var kopiert = await ziel.copyPages(dok.lib, runde.map(function (e3) { return e3.s; }));
          runde.forEach(function (e4, k) { kopien[e4.i] = kopiert[k]; });
        }
        erledigt += eintrag[1].length;
        arbeitZeigen('Copying pages', 0.1 + 0.6 * (erledigt / liste.length));
      }

      for (var i = 0; i < liste.length; i++) {
        var bogen = liste[i];
        var seite = kopien[i];
        if (!seite) continue;
        ziel.addPage(seite);

        var R = normDreh(seite.getRotation().angle + bogen.dreh);
        seite.setRotation(degrees(R));
        if (bogen.notizen.length) notizenSetzen(seite, bogen.notizen, R, schrift);

        if (i % 12 === 0) arbeitZeigen('Placing pages', 0.7 + 0.25 * (i / liste.length));
      }

      ziel.setTitle(name);
      ziel.setProducer('PDF Editor');
      ziel.setCreator('PDF Editor');
      ziel.setCreationDate(new Date());
      ziel.setModificationDate(new Date());

      arbeitZeigen('Writing the file', 0.96);
      var bytes = await ziel.save();
      arbeitVerbergen();

      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 20000);

      melden(liste.length + (liste.length === 1 ? ' page' : ' pages') +
             ' saved as “' + name + '.pdf”.');
    } catch (f) {
      arbeitVerbergen();
      melden('Could not save the PDF: ' + fehlerText(f), true);
      console.error(f);
    }
  }

  // Notizen liegen in PDF-Punkten der ungedrehten Seite. Fuer den Text zaehlt
  // zusaetzlich die Enddrehung R: der Anker ist die linke obere Ecke in der
  // Ansicht, die Grundlinie liegt davon aus in "Ansicht unten" - und welche
  // Richtung das im Papierkoordinatensystem ist, haengt an R.
  var UNTEN = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };

  function notizenSetzen(seite, notizen, R, schrift) {
    var unten = UNTEN[R] || UNTEN[0];

    notizen.forEach(function (n) {
      if (n.art === 'text') {
        var zeilen = n.text.split('\n');
        zeilen.forEach(function (z, k) {
          var weg = n.grad * (0.80 + k * 1.25);
          seite.drawText(winAnsiOnly(z), {
            x: n.x + unten[0] * weg,
            y: n.y + unten[1] * weg,
            size: n.grad,
            font: schrift,
            color: hexZuRgb(n.farbe),
            rotate: degrees(R)
          });
        });
      } else if (n.art === 'stift') {
        for (var p = 1; p < n.punkte.length; p++) {
          seite.drawLine({
            start: { x: n.punkte[p - 1][0], y: n.punkte[p - 1][1] },
            end: { x: n.punkte[p][0], y: n.punkte[p][1] },
            thickness: n.staerke,
            color: hexZuRgb(n.farbe),
            lineCap: LineCapStyle.Round
          });
        }
      } else {
        seite.drawRectangle({
          x: n.x, y: n.y, width: n.b, height: n.h,
          color: n.art === 'weiss' ? rgb(1, 1, 1) : hexZuRgb(n.farbe),
          opacity: n.art === 'weiss' ? 1 : 0.38,
          borderWidth: 0
        });
      }
    });
  }

  // --- Start --------------------------------------------------------------

  window.addEventListener('beforeunload', function (e) {
    if (!zustand.boegen.length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  boegenZeichnen();
})();
