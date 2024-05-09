# KeyboardRage

KeyboardRage is a typing game in an arcadce style where players have to type the words before they fall to the bottom of the box, different speeds and languages are available.






https://github.com/EMRD95/keyboardrage/assets/114953576/b17d1525-0a0a-447f-8d8f-3e937dbd9330





## Installation

Clone the repository:

```shell
git clone https://github.com/EMRD95/keyboardrage
```

The game has been tested and found to be working on Ubuntu 22.04 with the following requirements:

```shell
node v20.2.0
mongod db version v6.0.6
```

Next, install the required packages:

```shell
npm install -g typescript
npm install express mongoose body-parser
npm install
```

To build the TypeScript file `game.ts` and create `game.js`, run:

```shell
tsc
```

To run the application, execute:

```shell
node server.js
```

## Setting Up a Service

Create a service file with the following content:

```shell
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
```

## NGINX Configuration

Set up an NGINX server with the following configuration:

```shell
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
```
## Change scores TTL

Edit expire in server.js then drop and recreate the index in Mongo:

```javascript
mongosh
use typing_game
db.scores.getIndexes()
db.scores.dropIndex("timestamp_1")
db.scores.createIndex({ "timestamp": 1 }, { expireAfterSeconds: 315360000 }) //for 10 years
```

Restart the server for all changes to apply.

## Language Pack

The language pack can be sourced from [monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype) on GitHub.
