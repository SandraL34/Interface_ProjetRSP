// Tout le code est enfermé dans cette fonction pour ne pas polluer l'espace global (variables invisibles depuis l'extérieur)
(() => {
  const $ = id => document.getElementById(id); // raccourci : $("x") au lieu de document.getElementById("x")
  const KEY = "rsp-cfg"; // nom utilisé pour sauvegarder les réglages dans le localStorage du navigateur
  const CFG = { ip: "127.0.0.1:8000", telegramApi: "127.0.0.1:8001", interval: 1000, threshold: 10, demo: true, telegramEnabled: false, telegramChatId: "" }; 
  const ESP_IP = "10.213.28.233"; // adresse IP par défaut de l'ESP8266 (modifiable dans les réglages)
  try { Object.assign(CFG, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {} // on écrase CFG avec les réglages sauvegardés, s'il y en a

  const MAX_HIST = 90, MAX_DIST = 100, ADC_MAX = 1023, SEG = 20;
  // MAX_HIST : nombre de mesures gardées pour le graphique historique
  // MAX_DIST : distance (cm) qui correspond au bord droit de la jauge/graphique
  // ADC_MAX  : valeur brute maximale renvoyée par le capteur de luminosité (résolution 10 bits = 0 à 1023)
  // SEG      : nombre de petits segments dans la barre de luminosité
  const LUM_OPEN = 80, LUM_CLOSE = 70;   // hystérésis : le panneau s'ouvre au-dessus de 80 %, se ferme en dessous de 70 %
  const DIST_CLOSE = 5;                  // si un obstacle est détecté à 5 cm ou moins, on force la fermeture (sécurité)
  let hist = [];        // tableau des dernières mesures {d: distance, l: luminosité} pour tracer le graphique
  let mode = null;      // état de connexion actuel : "live" | "demo" | "offline"
  let fails = 0;        // compteur d'échecs consécutifs de connexion à l'ESP8266
  let timer = null;     // identifiant du setTimeout de la boucle de lecture, pour pouvoir l'annuler
  let gen = 0;          // "génération" de la boucle : incrémentée à chaque changement de réglages pour stopper l'ancienne boucle
  let lastOpen = null;      // dernier état ouvert/fermé connu, pour ne logguer que les changements
  let lastAlert = null;     // dernier texte d'alerte affiché, pour ne pas le rejouer dans le journal à chaque mesure
  let panelOpen = null;     // état retenu du panneau (résultat de l'hystérésis), mémorisé d'une mesure à l'autre
  let prevDangers = [];     // libellés des dangers affichés à la mesure précédente, pour ne logguer que les nouveaux
  let telegramLastSent = 0;      // évite de renvoyer le même message pendant le délai anti-spam
  let telegramLastSignature = ""; // signature du dernier groupe de dangers notifié
  const demoT0 = Date.now(); // instant de départ, utilisé comme horloge du mode démo

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)); // force v à rester entre a et b
  const now = () => new Date().toLocaleTimeString("fr-FR"); // heure actuelle au format "HH:MM:SS"

  /* ---------- Journal ---------- */
  function log(msg, level = "info") { // ajoute une ligne dans le journal des événements (en haut de la liste)
    const li = document.createElement("li"); // une ligne de journal = un <li>
    li.dataset.level = level; // niveau ("info"/"warn"/"crit") utilisé par le CSS pour la couleur
    const t = document.createElement("time"); t.textContent = now(); // horodatage affiché à gauche
    const s = document.createElement("span"); s.textContent = msg; // le message lui-même
    li.append(t, s); // on assemble <time> et <span> dans le <li>
    const ul = $("log"); // la liste <ul id="log"> du HTML
    ul.prepend(li); // on insère la nouvelle ligne tout en haut
    while (ul.children.length > 40) ul.lastChild.remove(); // on ne garde que les 40 dernières lignes
  }

  /* ---------- Statut de connexion ---------- */
  function setMode(m) { // change le badge de statut (pastille en haut) et note le changement dans le journal
    if (m === mode) return; // rien à faire si le mode ne change pas (évite de spammer le journal)
    mode = m;
    const pill = $("pill"); // le badge <span id="pill">
    pill.dataset.mode = m; // utilisé par le CSS pour la couleur du point (vert/orange/rouge)
    if (m === "live") { pill.textContent = "Connecté à l’ESP8266"; log("Connexion à l’ESP8266 établie."); }
    if (m === "demo") { pill.textContent = "Mode démo"; log("Mode démo : les mesures sont fictives.", "warn"); }
    if (m === "offline") { pill.textContent = "ESP8266 injoignable"; log("Plus de réponse de l’ESP8266.", "crit"); }
  }

  /* ---------- Descriptions ---------- */
  function lumWord(p) { // traduit un pourcentage de luminosité en mot compréhensible
    if (p < 15) return "Sombre";
    if (p < 40) return "Faible";
    if (p < 75) return "Normale";
    return "Forte";
  }

  function showAlert(level, text) { // affiche (ou masque) le bandeau d'alerte sous les mesures
    const el = $("alert");
    if (!text) { el.hidden = true; lastAlert = null; return; } // pas de message : on cache le bandeau
    el.hidden = false; el.dataset.level = level; el.textContent = text; // sinon on l'affiche avec sa couleur de niveau
    if (lastAlert !== text) { log(text, level === "info" ? "info" : level); lastAlert = text; } // on ne logue que les nouveaux messages
  }

  function setTick() { // positionne le petit repère "seuil" sur la jauge de distance
    $("tick").style.left = clamp(CFG.threshold / MAX_DIST * 100, 0, 100) + "%";
  }

  /* ---------- Dangers détectés ---------- */
  // Calcule la liste des dangers à partir des capteurs, et de ceux éventuellement fournis par l'IA embarquée
  // (si le payload s contient un tableau s.dangers = [{level, label, detail}, ...], il est simplement ajouté).
  function computeDangers(s, dValid, lum) {
    const list = [];
    if (dValid && s.distance_cm <= DIST_CLOSE) {
      list.push({ level: "crit", label: "Obstacle proche", detail: `Objet détecté à ${s.distance_cm.toFixed(1)} cm : rétraction de sécurité du panneau.` });
    }
    if (lum < 10) {
      list.push({ level: "warn", label: "Éclipse / ombrage", detail: "Luminosité quasi nulle : vérifie l’orientation ou une éclipse en cours." });
    }
    if (Array.isArray(s.dangers)) list.push(...s.dangers); // dangers remontés par l'agent IA (format à confirmer avec l'équipe capteurs/IA)
    return list;
  }

  function renderDangers(list) { // journalise les nouveaux dangers détectés (plus de carte dédiée : voir contrôle manuel)
    const labels = list.map(d => d.label);
    const newDangers = labels.filter(l => !prevDangers.includes(l));
    newDangers.forEach(l => { // ne journalise que les dangers qui viennent d'apparaître
      const d = list.find(x => x.label === l);
      log(`Danger détecté : ${d.label}`, d.level === "crit" ? "crit" : "warn");
    });
    if (newDangers.length) notifyTelegram(list.filter(d => newDangers.includes(d.label)));
    prevDangers = labels; // mémorise pour la comparaison à la prochaine mesure
  }

  function updateTelegramStatus() {
    const enabled = Boolean(CFG.telegramEnabled && CFG.telegramChatId);
    $("telegramStatus").dataset.state = enabled ? "on" : "off";
    $("telegramStatus").textContent = enabled ? "Activées" : "Désactivées";
    $("telegramEnabled").checked = Boolean(CFG.telegramEnabled);
    $("telegramChatId").value = CFG.telegramChatId || "";
  }

  async function sendTelegram(message, isTest = false) {
    if (!CFG.telegramChatId) {
      $("telegramMessage").textContent = "Ajoutez un Chat ID Telegram avant l’envoi.";
      return false;
    }
    try {
      const response = await fetch(`http://${CFG.telegramApi}/api/alerts/telegram`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ chatId: CFG.telegramChatId, message, test: isTest })
      });
      if (!response.ok) {
        let detail = "HTTP " + response.status;
        try {
          const errorBody = await response.json();
          detail = (errorBody.telegram && errorBody.telegram.description)
            || errorBody.error
            || errorBody.detail
            || detail;
        } catch (e) {}
        throw new Error(detail);
      }
      $("telegramMessage").textContent = isTest ? "Message Telegram de test envoyé." : "Alerte Telegram envoyée.";
      log(isTest ? "Message Telegram de test envoyé." : "Alerte Telegram envoyée.");
      return true;
    } catch (e) {
      $("telegramMessage").textContent = "Échec Telegram : " + e.message;
      if (isTest) log("Échec du message Telegram : " + e.message, "warn");
      return false;
    }
  }

  function notifyTelegram(dangers) {
    if (!CFG.telegramEnabled || !CFG.telegramChatId) return;
    const signature = dangers.map(d => d.label).join("|");
    const nowMs = Date.now();
    if (signature === telegramLastSignature && nowMs - telegramLastSent < 10 * 60 * 1000) return;
    telegramLastSignature = signature;
    telegramLastSent = nowMs;
    const details = dangers.map(d => `${d.label}: ${d.detail}`).join("\n");
    sendTelegram(`RSP - ALERTE\n${details}`);
  }

  /* ---------- Contrôle manuel (utile si l'ESP8266 ne répond plus) ---------- */
  function applyManualState(open) { // force l'affichage du panneau sans attendre une mesure
    panelOpen = open; lastOpen = open;
    const st = open ? "open" : "closed";
    $("hero").dataset.state = st;
    $("panelSvg").dataset.state = st;
    $("stateWord").textContent = open ? "Déployé" : "Rentré";
    $("stateSub").textContent = open
      ? "Commande manuelle : ailes sorties."
      : "Commande manuelle : ailes rangées dans le coffre.";
  }

  async function manualCommand(action) { // "deploy" ou "retract", déclenché par les boutons du contrôle manuel
    const open = action === "deploy";
    applyManualState(open);
    log(open ? "Commande manuelle : déploiement forcé du panneau." : "Commande manuelle : repli forcé du panneau.", "warn");
    const status = $("manualStatus");
    status.textContent = "Commande envoyée…";
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`http://${ESP_IP}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      status.textContent = "Commande confirmée par l’ESP8266.";
    } catch (e) { // pas de réponse (ex. perte de connexion) : l'affichage reste forcé localement
      status.textContent = "ESP8266 injoignable : commande appliquée seulement à l’affichage.";
    } finally {
      clearTimeout(to);
    }
  }

  $("btnDeploy").addEventListener("click", () => manualCommand("deploy"));
  $("btnRetract").addEventListener("click", () => manualCommand("retract"));

  $("telegramForm").addEventListener("submit", e => {
    e.preventDefault();
    CFG.telegramChatId = $("telegramChatId").value.trim();
    CFG.telegramEnabled = $("telegramEnabled").checked;
    try { localStorage.setItem(KEY, JSON.stringify(CFG)); } catch (e) {}
    updateTelegramStatus();
    $("telegramMessage").textContent = CFG.telegramEnabled
      ? "Alertes Telegram activées."
      : "Alertes Telegram désactivées.";
  });

  $("telegramTest").addEventListener("click", () => sendTelegram("RSP - message Telegram de test : la liaison d’alerte fonctionne.", true));


  /* ---------- Affichage d'une mesure ---------- */
  function render(s) { // met à jour toute l'interface à partir d'une mesure s = {distance_cm, luminosity, panel_open?}
    const dValid = typeof s.distance_cm === "number" && s.distance_cm >= 0; // la distance est-elle exploitable ?
    const raw = clamp(Number(s.luminosity) || 0, 0, ADC_MAX); // valeur brute du capteur, sécurisée entre 0 et 1023
    const lum = Math.round(raw / ADC_MAX * 100); // conversion en pourcentage (0 à 100)

      // ---------- État réel du panneau ----------
    // L'ESP8266 est la source de vérité.
    const open = s.panel_open;

    // Mise à jour de l'état mémorisé
    panelOpen = open;
    
    // distance
    $("dist").textContent = dValid ? s.distance_cm.toFixed(1) : "—"; // affiche la valeur avec 1 décimale, ou un tiret si invalide
    $("distNote").textContent = dValid
      ? `Le panneau est considéré rentré sous ${CFG.threshold} cm.`
      : "Hors de portée du capteur.";
    const mk = $("marker"); // le curseur mobile sur la jauge de distance
    mk.style.visibility = dValid ? "visible" : "hidden";
    if (dValid) mk.style.left = clamp(s.distance_cm / MAX_DIST * 100, 0, 100) + "%"; // position en % de la jauge

    // luminosité
    $("lum").textContent = lum; // pourcentage affiché en gros
    $("lumRaw").textContent = Math.round(raw); // valeur brute affichée en petit ("sur 1023")
    $("lumWord").textContent = lumWord(lum); // mot descriptif ("Faible", "Forte"...)
    const on = Math.round(lum / 100 * SEG); // nombre de segments à allumer dans la barre
    [...$("segs").children].forEach((el, i) => el.classList.toggle("on", i < on)); // allume les segments 0..on-1

    // panneau
    const st = open ? "open" : "closed"; // état texte utilisé pour l'attribut data-state (piloté par le CSS)
    $("hero").dataset.state = st; // change la couleur du cadre du panneau
    $("panelSvg").dataset.state = st; // déclenche l'animation d'ouverture/fermeture du SVG
    $("stateWord").textContent = open ? "Déployé" : "Rentré"; // gros mot d'état
    $("stateSub").textContent = open
      ? "Les ailes sont sorties et captent la lumière."
      : "Les ailes sont rangées dans le coffre : aucune production.";
    $("sun").style.opacity = (0.25 + lum / 100 * 0.75).toFixed(2); // le soleil dessiné brille plus fort si la luminosité est forte

    if (lastOpen !== null && lastOpen !== open) log(open ? "Panneau déployé." : "Panneau rentré."); // note le changement d'état dans le journal
    lastOpen = open; // mémorise l'état pour la prochaine comparaison

    // alertes
    if (open && lum < 15) showAlert("warn", "Panneau déployé mais presque dans le noir : éclipse ou ombrage.");
    else if (!open && lum >= 75) showAlert("info", "Panneau rentré alors que la lumière est forte : production perdue.");
    else showAlert("", ""); // pas de cas particulier : on cache le bandeau

    setTick(); // remet à jour le repère de seuil (au cas où CFG.threshold aurait changé)
    pushHist(dValid ? Math.min(s.distance_cm, MAX_DIST) : null, lum); // ajoute ce point au graphique historique
    renderDangers(computeDangers(s, dValid, lum)); // met à jour la carte "Dangers détectés"
  }

  function renderOffline() { // affiche l'interface en mode "aucune donnée" quand l'ESP8266 ne répond plus
    $("dist").textContent = "—";
    $("distNote").textContent = "Aucune mesure.";
    $("marker").style.visibility = "hidden";
    $("lum").textContent = "—";
    $("lumRaw").textContent = "—";
    $("lumWord").textContent = "";
    [...$("segs").children].forEach(el => el.classList.remove("on")); // éteint tous les segments de la barre
    $("hero").dataset.state = "unknown"; // couleur neutre du cadre
    $("panelSvg").dataset.state = "unknown"; // le schéma SVG passe en état "inconnu" (ailes semi-transparentes)
    $("stateWord").textContent = "Inconnu";
    $("stateSub").textContent = "Aucune donnée reçue de l’ESP8266.";
    showAlert("crit", `Pas de réponse de http://${CFG.ip}/data. Vérifie l’alimentation, le Wi-Fi et l’adresse IP.`);
    lastOpen = null; panelOpen = null; // on oublie l'état connu : il faudra le redéterminer à la reconnexion
    pushHist(null, null); // trou dans le graphique pendant la coupure
    renderDangers([{ level: "crit", label: "Perte de liaison", detail: "Plus de mesures reçues : impossible de surveiller les dangers." }]);
  }

  /* ---------- Historique et courbes ---------- */
  function pushHist(d, l) { // ajoute un point {distance, luminosité} à l'historique et redessine le graphique
    hist.push({ d, l });
    if (hist.length > MAX_HIST) hist.shift(); // on ne garde que les MAX_HIST derniers points
    drawChart();
  }

  function drawChart() { // dessine les deux courbes (distance et luminosité) dans le <canvas>
    const c = $("chart");
    const dpr = window.devicePixelRatio || 1; // densité de pixels de l'écran, pour un rendu net sur écrans HiDPI
    const w = c.clientWidth, h = c.clientHeight; // taille affichée du canvas en CSS
    if (!w || !h) return; // rien à dessiner si le canvas n'a pas encore de taille (ex : onglet caché)
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); // taille réelle du canvas en pixels physiques
    const g = c.getContext("2d"); // contexte de dessin 2D
    g.setTransform(dpr, 0, 0, dpr, 0, 0); // on redimensionne le contexte pour dessiner en coordonnées CSS
    const st = getComputedStyle(document.documentElement); // pour lire les couleurs du thème actuel
    const col = n => st.getPropertyValue(n).trim(); // lit une variable CSS comme --ok ou --warn
    const L = 30, R = 8, T = 8, B = 8, pw = w - L - R, ph = h - T - B; // marges (Left/Right/Top/Bottom) et zone de tracé utile

    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle"; g.textAlign = "right";
    for (const v of [0, 25, 50, 75, 100]) { // lignes horizontales de repère à 0/25/50/75/100 %
      const y = Math.round(T + ph - v / 100 * ph) + .5; // +.5 pour un trait net (pas flou) sur canvas
      g.strokeStyle = col("--line"); g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke(); // trace la ligne horizontale
      g.fillStyle = col("--muted"); g.fillText(String(v), L - 6, y); // écrit la graduation à gauche
    }

    for (const [key, color] of [["l", col("--warn")], ["d", col("--ok")]]) { // une passe pour la luminosité, une pour la distance
      g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = "round";
      g.beginPath();
      let pen = false; // "stylo levé" : true si on est en train de tracer une ligne continue
      hist.forEach((p, i) => {
        const v = p[key]; // valeur (distance ou luminosité) de ce point d'historique
        if (v == null) { pen = false; return; } // valeur manquante (coupure) : on lève le stylo
        const x = L + (MAX_HIST - hist.length + i) / (MAX_HIST - 1) * pw; // position horizontale du point
        const y = T + ph - clamp(v, 0, 100) / 100 * ph; // position verticale du point (0 en bas, 100 en haut)
        if (pen) g.lineTo(x, y); else g.moveTo(x, y); // continue la ligne, ou démarre un nouveau segment
        pen = true;
      });
      g.stroke(); // trace effectivement la courbe
    }
  }

  /* ---------- Mesures fictives (mode démo) ---------- */
  function demoSample() { // génère une fausse mesure réaliste, utilisée quand "Mode démo" est coché
    const t = (Date.now() - demoT0) / 1000; // secondes écoulées depuis le démarrage du tableau de bord
    const open = (t % 24) < 15;                       // cycle de 24 s : 15 s "déployé", 9 s "rentré"
    const d = open ? 32 + Math.sin(t * 1.7) * 1.2 : 3.5 + Math.random() * .4; // simule un obstacle proche pendant la phase repliée
    let lum = 620 + Math.sin(t / 4) * 260 + (Math.random() - .5) * 20; // luminosité simulée qui varie lentement
    const m = t % 60;
    if (m > 44 && m < 52) lum = 60 + Math.random() * 20;   // simule une "éclipse" (chute brutale de lumière) 8 s par minute
    return {
      distance_cm: +d.toFixed(1), // arrondi à 1 décimale
      luminosity: Math.round(clamp(lum, 0, ADC_MAX)), // valeur brute bornée entre 0 et 1023
      panel_open: open
    };
  }

  /* ---------- Lecture périodique ---------- */
  async function poll(myGen) {
    let s = null;

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);

    try {
        const response = await fetch(
            "http://127.0.0.1:8000/api/measurements",
            {
                signal: ctrl.signal,
                cache: "no-store",
                headers: {
                "Authorization": `Bearer ${localStorage.getItem("rsp-token")}`
              }
            }
        );

        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }

        const measurements = await response.json();

        if (!Array.isArray(measurements) || measurements.length === 0) {
            throw new Error("Aucune mesure reçue");
        }

        /*
         * L'API renvoie les mesures de la plus récente
         * à la plus ancienne.
         */
        const latest = measurements[0];

        /*
         * Adaptation du format Symfony vers le format
         * attendu par ton dashboard.
         */
        s = {
            distance_cm: Number(latest.distance),
            luminosity: Number(latest.light),
            panel_open:
              latest.panel_open === true ||
              latest.panel_open === 1 ||
              latest.panel_open === "1" ||
              latest.panel_open === "true",
            createdAt: latest.createdAt
        };

        fails = 0;
        setMode("live");

    } catch (e) {
        console.error("Erreur API :", e);
        fails++;

      if (CFG.demo) {
        s = demoSample();
        fails = 0;
        setMode("demo");
      } else if (fails >= 2) {
        setMode("offline");
        }

    } finally {
        clearTimeout(to);
    }

    if (myGen !== gen) {
        return;
    }

    if (s) {
        render(s);
    } else if (mode === "offline") {
        renderOffline();
    }

    timer = setTimeout(() => poll(myGen), CFG.interval);
  }

  function restart() {
    gen++;
    clearTimeout(timer);

    // Réinitialise quelques états liés à la connexion
    fails = 0;
    mode = null;
    lastOpen = null;
    lastAlert = null;
    prevDangers = [];
    telegramLastSignature = "";
    telegramLastSent = 0;
    panelOpen = null;

    // Démarre une nouvelle boucle
    poll(gen);
}

  /* ---------- Filtre du journal ---------- */
  $("logFilter").addEventListener("change", e => { // "Tous les niveaux" / "Critique" / "Attention" / "Info"
    $("log").dataset.filter = e.target.value; // le CSS masque les lignes qui ne correspondent pas (voir style.css)
  });

  /* ---------- Thème clair / sombre ---------- */
  const root = document.documentElement; // la balise <html>, qui porte l'attribut data-theme
  const storedTheme = () => { try { return localStorage.getItem("rsp-theme"); } catch (e) { return null; } }; // thème choisi manuellement, s'il existe
  function applyTheme(t, save) { // applique un thème ("dark" ou "light") à toute la page
    root.setAttribute("data-theme", t); // le CSS réagit à cet attribut pour changer toutes les couleurs
    $("themeBtn").setAttribute("aria-label", t === "dark" ? "Passer en mode clair" : "Passer en mode sombre"); // texte pour les lecteurs d'écran
    if (save) { try { localStorage.setItem("rsp-theme", t); } catch (e) {} } // mémorise le choix seulement si l'utilisateur a cliqué
    drawChart();                       // les courbes doivent être redessinées avec les nouvelles couleurs du thème
  }
  $("themeBtn").addEventListener("click", () => // clic sur le bouton soleil/lune : bascule le thème
    applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true));
  const mq = window.matchMedia("(prefers-color-scheme: light)"); // détecte le thème préféré du système d'exploitation
  if (mq.addEventListener) mq.addEventListener("change", e => { // si l'utilisateur change le thème de son PC
    if (!storedTheme()) applyTheme(e.matches ? "light" : "dark", false);   // on suit le système tant que rien n'est choisi manuellement
  });
  applyTheme(root.getAttribute("data-theme"), false); // applique le thème initial (déjà posé par theme-init.js) sans le re-sauvegarder

  
  updateTelegramStatus();

  /* ---------- Démarrage ---------- */
  for (let i = 0; i < SEG; i++) $("segs").appendChild(document.createElement("span")); // crée les 20 petits segments de la barre de luminosité
  setTick(); // positionne le repère de seuil
  setInterval(() => { $("clock").textContent = now(); }, 1000); // met à jour l'horloge affichée chaque seconde
  $("clock").textContent = now(); // affiche l'heure tout de suite, sans attendre la première seconde
  window.addEventListener("resize", drawChart); // redessine le graphique si la fenêtre change de taille
  log("Tableau de bord démarré."); // première ligne du journal
  restart(); // démarre la toute première boucle de lecture des mesures
})();