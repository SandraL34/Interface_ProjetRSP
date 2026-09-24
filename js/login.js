const themeBtn = document.getElementById("themeBtn");

// Permet de changer le thème depuis la page de connexion et mémorise ce choix.
themeBtn?.addEventListener("click", () => {
    const root = document.documentElement;
    const currentTheme = root.dataset.theme || "dark";
    const newTheme = currentTheme === "dark" ? "light" : "dark";
    root.dataset.theme = newTheme;
    try {
        localStorage.setItem("rsp-theme", newTheme);
    } catch (e) {}
});

const API_BASE = "http://127.0.0.1:8000";

const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");

// Authentifie l'utilisateur auprès de Symfony puis conserve le JWT pour le dashboard.
loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;

    const username = document.getElementById("loginUser").value;
    const password = document.getElementById("loginPass").value;

    try {
        // Envoie les identifiants à la route de connexion configurée par Lexik JWT.
        const response = await fetch(`${API_BASE}/api/login_check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });

        if (!response.ok) {
            throw new Error("Identifiants incorrects");
        }

        const data = await response.json();
        // data.token contient le JWT renvoyé par Lexik

        // Le token sera relu par les requêtes protégées du tableau de bord.
        localStorage.setItem("rsp-token", data.token);

        // Redirection côté front, pas côté serveur
        window.location.href = "dashboard.html";

    } catch (err) {
        // Affiche une erreur générique sans révéler si le nom ou le mot de passe est incorrect.
        loginError.hidden = false;
    }
});