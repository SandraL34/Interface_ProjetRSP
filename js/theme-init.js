// Thème : choix enregistré, sinon préférence du système. Doit s'exécuter avant le premier rendu pour éviter un flash.
(function () { // fonction immédiatement exécutée, pour ne rien laisser de global
  var t = null; // thème qu'on va appliquer : "light" ou "dark"
  try { t = localStorage.getItem("rsp-theme"); } catch (e) {} // récupère le choix précédent de l'utilisateur, si présent
  if (t !== "light" && t !== "dark") { // aucun choix valide enregistré : on se base sur le système
    t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", t); // applique le thème sur <html> avant que la page ne s'affiche
})();
