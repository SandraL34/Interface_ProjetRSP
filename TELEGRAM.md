# Activer les alertes Telegram

1. Ouvrez PowerShell dans ce dossier.
2. Definissez le token recu de BotFather (ne le mettez pas dans un fichier) :

```powershell
$env:TELEGRAM_BOT_TOKEN = "COLLEZ_VOTRE_TOKEN_ICI"
```

3. Lancez le serveur :

```powershell
python .\telegram_server.py
```

Gardez cette fenetre ouverte.

4. Ouvrez le tableau de bord, renseignez le Chat ID `1128623552`, cochez l'activation, puis cliquez sur **Enregistrer**.
5. Cliquez sur **Envoyer un message test** dans le panneau.

Le serveur utilise `http://127.0.0.1:8001/api/alerts/telegram` et transmet le message a Telegram. Le token n'est jamais envoye au navigateur.
