# PR Article Tracker

AI-powered PR coverage tracker. Paste any article URL and get instant analysis.

## Setup

```bash
npm install
npm run dev        # local: http://localhost:3000
npm run build
npm start          # production
```

## AWS EC2 Deploy

```bash
git clone <your-repo>
cd pr-tracker
npm install
npm run build
npm install -g pm2
pm2 start npm --name pr-tracker -- start
pm2 save
```

## Nginx Config

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## n8n Webhooks (already active)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook/pr-analyze` | POST | Analyze + save article |
| `/webhook/pr-articles` | GET | Fetch all articles |
| `/webhook/pr-delete` | POST | Delete article by `_id` |

## MongoDB Atlas — Required Step

Go to Atlas → Network Access → Add IP Address → `0.0.0.0/0`
(allows n8n to connect)
