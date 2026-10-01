# Étape 1 : Utiliser Nginx pour servir les fichiers statiques HTML/CSS/JS
FROM nginx:alpine

# Copier tous les fichiers du Frontend dans le dossier public de Nginx
COPY . /usr/share/nginx/html

# Exposer le port du serveur web Frontend
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]