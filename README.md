# KeyboardRage

Arcade-style typing game — type words before they fall. Multiple speeds, 108 languages, real-time leaderboard with Google sign-in.

https://keyboardrage.em95.org

## Galaxy — 3D Semantic Word Universe

2.25 million words across 108 languages embedded with IBM Granite and projected into a navigable 3D space via UMAP.

**Precomputed models (~16 GB)** on HuggingFace:
→ **[emrd95/keyboardrage-semantic](https://huggingface.co/emrd95/keyboardrage-semantic)**

To download:
```bash
./setup.sh
```

The semantic neighbors API runs at `http://localhost:8703`. Neighbor queries are precomputed — sub-millisecond lookups.

## Quick Start (development)

Requirements: **Node.js 22**, **MongoDB 8.0**.

```bash
git clone https://github.com/EMRD95/keyboardrage
cd keyboardrage
npm ci
npm run build
node server.js
```

The game runs at `http://localhost:3000`. In-memory MongoDB is used automatically in development mode.

## Production Deployment

Set these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | yes | Set to `production` |
| `PORT` | no | Default `3000` |
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | 64-char hex secret for session tokens |
| `GOOGLE_CLIENT_ID` | yes | Google OAuth client ID |

MongoDB must be running and accessible. In production the in-memory fallback is disabled.

### Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /semantic/ {
        proxy_pass http://127.0.0.1:8703/;
    }

    location /atlas-service/ {
        proxy_pass http://127.0.0.1:5055/;
    }
}
```

### Visualization services (optional)

```bash
# Semantic neighbors API (port 8703)
cd galaxy/semantic
uvicorn semantic_neighbors_server:app --host 127.0.0.1 --port 8703

# Apple Embedding Atlas (port 5055)
cd galaxy/atlas
./launch_atlas_language.sh
```

## Project Layout

```
keyboardrage/
├── public/          Client-side assets (HTML, CSS, JS, TS sources)
├── server.js        Express app entry point
├── auth.js          Google OAuth + JWT session management
├── themes/          Game visual themes
├── galaxy/          Semantic backend (embeddings, neighbors, atlas)
├── words/           Word lists per language
├── fonts/           Web fonts
├── docs/            Documentation
└── scripts/         Data generation utilities
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | TypeScript, Three.js, CSS custom properties |
| Backend | Node.js, Express, Mongoose |
| Auth | Google Identity Services, JWT |
| Database | MongoDB 8.0 |
| Embeddings | IBM Granite (384-dim), UMAP projection |
| Semantic API | FastAPI, DuckDB, NumPy |

## Language Pack

Word lists sourced from [monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype).
