# FacturePilot AI — Guide de déploiement production

## 🚀 Déploiement rapide (VPS Linux)

### 1. Prérequis sur le serveur

```bash
# Node.js 20+ (via nvm recommandé)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20 && nvm use 20

# PM2 (gestionnaire de processus)
npm install -g pm2

# Nginx (reverse proxy)
sudo apt install nginx -y
```

### 2. Déployer le code

```bash
# Clone ou upload le projet
git clone https://github.com/votre-repo/facturepilot-ai.git /var/www/facturepilot
cd /var/www/facturepilot/backend

# Installer les dépendances
npm install --production

# Configurer l'environnement
cp .env.example .env
nano .env   # Remplir JWT_SECRET, SMTP_USER, SMTP_PASS, ALLOWED_ORIGINS
```

### 3. Démarrer avec PM2

```bash
cd /var/www/facturepilot/backend

# Démarrer
pm2 start pm2.config.js --env production

# Sauvegarder pour redémarrage automatique
pm2 save
pm2 startup   # suivre les instructions affichées

# Vérifier l'état
pm2 status
pm2 logs facturepilot-ai
```

### 4. Configurer Nginx (reverse proxy + HTTPS)

```nginx
# /etc/nginx/sites-available/facturepilot
server {
    listen 80;
    server_name votre-domaine.fr www.votre-domaine.fr;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name votre-domaine.fr www.votre-domaine.fr;

    ssl_certificate     /etc/letsencrypt/live/votre-domaine.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/votre-domaine.fr/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;

    # Sécurité
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/javascript application/json;

    location / {
        proxy_pass         http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeout
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;

        # Upload size (logos base64)
        client_max_body_size 6M;
    }
}
```

```bash
# Activer le site
sudo ln -s /etc/nginx/sites-available/facturepilot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Certificat SSL Let's Encrypt
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d votre-domaine.fr -d www.votre-domaine.fr
```

### 5. Backup automatique (cron)

```bash
# Rendre le script exécutable
chmod +x /var/www/facturepilot/backend/scripts/backup-db.sh

# Ajouter au cron (backup à 2h du matin chaque jour)
crontab -e
# Ajouter :
0 2 * * * /var/www/facturepilot/backend/scripts/backup-db.sh >> /var/log/facturepilot-backup.log 2>&1
```

---

## 📧 Configuration SMTP (Brevo — recommandé)

1. Créer un compte sur [brevo.com](https://brevo.com) (300 emails/jour gratuits)
2. Aller dans **SMTP & API → Paramètres SMTP**
3. Copier l'identifiant et le mot de passe SMTP
4. Mettre à jour le `.env` :

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=votre-email@domaine.com
SMTP_PASS=votre-cle-smtp
SMTP_FROM=noreply@votre-domaine.fr
```

5. Tester dans l'app : **Paramètres → Notifications → Envoyer un email de test**

---

## 🔑 Générer un JWT_SECRET fort

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copiez la valeur générée dans `.env` comme `JWT_SECRET`.

---

## 🌐 Variables d'environnement de production

```env
NODE_ENV=production
PORT=3333
ALLOWED_ORIGINS=https://votre-domaine.fr,https://www.votre-domaine.fr
JWT_SECRET=<généré ci-dessus>
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=noreply@votre-domaine.fr
```

---

## 📊 Monitoring

```bash
# Logs en temps réel
pm2 logs facturepilot-ai --lines 100

# Métriques CPU/mémoire
pm2 monit

# Health check API
curl https://votre-domaine.fr/api/health
```

---

## 🔄 Mise à jour

```bash
cd /var/www/facturepilot
git pull

cd backend
npm install --production

pm2 restart facturepilot-ai
```

---

## 🔒 Accès démo par défaut

| Email | Mot de passe | Note |
|-------|-------------|------|
| hamza@facturepilot.ai | demo1234 | Compte démo (données fictives) |

**Important** : Changez ou supprimez ce compte en production !

Pour supprimer les données de démo :
```bash
# Supprimer la DB pour repartir de zéro
rm /var/www/facturepilot/backend/facturepilot.db
pm2 restart facturepilot-ai  # Recrée la DB vide
```
