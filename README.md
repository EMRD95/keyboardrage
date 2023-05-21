# keyboardrage
keyboardrage.com repo

To install git clone the repo

Tested and working on Ubuntu 22.04
which node
node v20.2.0
mongod --version
db version v6.0.6

npm install -g typescript
npm install express mongoose body-parser
npm install

To build the game.ts and create game.js, run tsc

Tu run, node server.js

To make a service

[Unit]
Description=Keyboardrage Node.js Application
After=network.target

[Service]
ExecStart=/home/version/bin/node /home/game/game/server.js
Restart=always
User=monkey
Group=monkey
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
WorkingDirectory=/home/game/game/

[Install]
WantedBy=multi-user.target

Nginx server

server {
    listen 80;
    server_name domainname.com www.domainname.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

Language pack from https://github.com/monkeytypegame/monkeytype
