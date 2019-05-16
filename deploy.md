# How to deploy htmlcoininfo and htmlcoininfo-ui

## Prerequisites
* node.js v10.5+
* mongodb v4.0+

## Deploy htmlcoin core
1. `git clone --recursive https://github.com/HTMLCOIN/htmlcoin.git` 
2. Follow the instructions [https://github.com/HTMLCOIN/htmlcoin#building-htmlcoin-core]() to build htmlcoin
3. Run `htmlcoind` with `-logevents=1` enabled

## Deploy htmlcoininfo
1. `git clone https://github.com/denuoweb/htmlcoininfo.git && cd htmlcoininfo`
2. `npm install`
3. `mkdir packages/explorer` (you may change the directory name) and write files `package.json` and `htmlcoininfo-node.json` to it
    ```json
    // package.json
    {
        "name": "explorer-mainnet",
        "private": true,
        "scripts": {
            "start": "htmlcoininfo-node start"
        },
        "dependencies": {
            "htmlcoininfo-api": "^0.0.1",
            "htmlcoininfo-node": "^0.0.1",
            "htmlcoininfo-ws": "^0.0.1"
        }
    }
    ```
    ```json
    // htmlcoininfo-node.json
    {
        "chain": "mainnet",
        "port": 3001,
        "datadir": "/absolute/path/to/htmlcoininfo/packages/explorer/data",
        "services": [
            "htmlcoininfo-api",
            "htmlcoininfo-ws",
            "address",
            "balance",
            "block",
            "contract",
            "db",
            "header",
            "mempool",
            "p2p",
            "transaction",
            "web"
        ],
        "servicesConfig": {
            "db": {
            "mongodb": {
                "url": "mongodb://localhost:27017/",
                "database": "htmlcoininfo-mainnet"
            },
            "rpc": {
                "protocol": "http",
                "host": "localhost",
                "port": 3889,
                "user": "user",
                "password": "password"
            }
            },
            "p2p": {
            "peers": [
                {
                    "ip": {
                        "v4": "127.0.0.1"
                    },
                    "port": 3888
                }
            ]
            },
            "htmlcoininfo-ws": {
                "port": 3002
            }
        }
    }
    ```
4. `npm run lerna bootstrap`
5. run `npm start` in `packages/explorer` directory

## Deploy htmlcoininfo-ui
1. `git clone https://github.com/denuoweb/htmlcoininfo.git && cd htmlcoininfo`
2. `npm install` \
    You may modify `package.json` as follows:
    * rewrite `script.build` to `"build": "HTMLCOININFO_API_BASE_CLIENT=/api/ HTMLCOININFO_API_BASE_SERVER=http://localhost:3001/htmlcoininfo-api/ HTMLCOININFO_API_BASE_WS=//example.com/ws/ nuxt build"` in `package.json` to set the api URL base
    * rewrite `script.start` to `"start": "PORT=12345 nuxt start"` to frontend on port 12345
3. `npm run build`
4. `npm start`
