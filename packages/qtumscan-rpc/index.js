const http = require('http')
const https = require('https')

const cl = console.log.bind(console)
function noop() {}

class RpcClient {
  constructor({
    host = '127.0.0.1',
    port = 3889,
    user = 'user',
    pass = 'pass',
    protocol,
    disableAgent = false,
    rejectUnauthorized = true
  } = {}) {
    this.host = host
    this.port = port
    this.user = user
    this.pass = pass
    this.protocol = protocol === 'http' ? http : https
    this.batchedCalls = null
    this.disableAgent = disableAgent
    this.rejectUnauthorized = rejectUnauthorized
    this.log = RpcClient.config.log || RpcClient.loggers[RpcClient.config.logger || 'normal']
  }

  rpc(request) {
    request = JSON.stringify(request)
    let auth = Buffer.from(this.user + ':' + this.pass).toString('base64')
    let options = {
      host: this.host,
      port: this.port,
      method: 'POST',
      path: '/',
      rejectUnauthorized: this.rejectUnauthorized,
      agent: this.disableAgent ? false : undefined
    }
    if (this.httpOptions) {
      Object.assign(options, this.httpOptions)
    }
    let called = false
    let errorMessage = 'Qtum JSON-RPC: '

    return new Promise((resolve, reject) => {
      let req = this.protocol.request(options, res => {
        let buffer = ''
        res.on('data', data => buffer += data)
        res.on('end', () => {
          if (res.statusCode === 401) {
            reject(new Error(errorMessage + 'Connection Rejected: 401 Unauthorized'))
          } else if (res.statusCode === 403) {
            reject(new Error(errorMessage + 'Connection Rejected: 403 Forbidden'))
          } else if (res.statusCode === 500 && buffer === 'Work queue depth exceeded') {
            let exceededError = new Error(errorMessage + buffer)
            exceededError.code = 429
            reject(exceededError)
          } else {
            try {
              let parsedBuffer = JSON.parse(buffer)
              if (parsedBuffer.error) {
                reject(parsedBuffer.error)
              } else {
                resolve(parsedBuffer.result)
              }
            } catch (err) {
              this.log.error(err.stack)
              this.log.error(buffer)
              this.log.error('HTTP Status code: ' + res.statusCode)
              reject(new Error(errorMessage + 'Error Parsing JSON: ' + err.message))
            }
          }
        })
      })
      req.on('error', err => reject(new Error(errorMessage + 'Request Error: ' + err.message)))
      req.setHeader('Content-Length', request.length)
      req.setHeader('Content-Type', 'application/json')
      req.setHeader('Authorization', 'Basic ' + auth)
      req.write(request)
      req.end()
    })
  }

  async batch(batchCallback) {
    this.batchedCalls = []
    batchCallback()
    await this.rpc(this.batchedCalls)
    this.batchedCalls = null
  }
}

RpcClient.loggers = {
  none: {info: noop, warn: noop, error: noop, debug: noop},
  normal: {info: cl, warn: cl, error: cl, debug: noop},
  debug: {info: cl, warn: cl, error: cl, debug: cl}
}

RpcClient.config = {logger: 'normal'}

const callspec = {
  callContract: '',
  createMultiSig: 'int',
  createRawTransaction: 'obj',
  decodeRawTransaction: '',
  decodeScript: '',
  estimateFee: 'int',
  estimatePriority: 'int',
  estimateSmartFee: 'int',
  estimateSmartPriority: 'int',
  fromHexAddress: '',
  fundRawTransaction: '',
  getBestBlockHash: '',
  getBlock: 'str bool',
  getBlockchainInfo: '',
  getBlockCount: '',
  getBlockHash: 'int',
  getBlockHeader: 'str bool',
  getChainTips: '',
  getDifficulty: '',
  getHexAddress: '',
  getInfo: '',
  getMemoryInfo: '',
  getMempoolAncestors: 'str bool',
  getMempoolDescendants: 'str bool',
  getMempoolEntry: '',
  getMempoolInfo: '',
  getRawMemPool: 'bool',
  getRawTransaction: 'str bool',
  getStorage: '',
  getTransactionReceipt: '',
  getTxOut: 'str int bool',
  getTxOutProof: 'obj',
  getTxOutSetInfo: '',
  listContracts: '',
  preciousBlock: '',
  searchLogs: 'int int',
  sendRawTransaction: '',
  signMessageWithPrivkey: '',
  signRawTransaction: 'str obj',
  validateAddress: '',
  verifyChain: '',
  verifyMessage: '',
  verifyTxOutProof: '',
  waitForLogs: ''
}

function getRandomId() {
  return Math.floor(Math.random() * 100000)
}

function generateRPCMethods() {
  function createRPCMethod(methodName, argMap) {
    return function(...args) {
      for (let i = 0; i < args.length; i++) {
        if (argMap[i]) {
          args[i] = argMap[i](args[i])
        }
      }
      if (this.batchedCalls) {
        this.batchedCalls.push({
          jsonrpc: '2.0',
          method: methodName,
          params: args,
          id: getRandomId()
        });
      } else {
        return this.rpc({
          method: methodName,
          params: args,
          id: getRandomId()
        })
      }
    }
  }

  let types = {
    str: arg => arg.toString(),
    int: arg => Number.parseFloat(arg),
    float: arg => Number.parseFloat(arg),
    bool: arg => [true, 1, '1'].includes(arg) || arg.toString().toLowerCase() === 'true',
    obj: arg => typeof arg === 'string' ? JSON.parse(arg) : arg
  }

  for (let [key, value] of Object.entries(callspec)) {
    let spec = value.split(' ')
    for (let i = 0; i < spec.length; ++i) {
      if (types[spec[i]]) {
        spec[i] = types[spec[i]]
      } else {
        spec[i] = types.str
      }
    }
    let methodName = key.toLowerCase()
    RpcClient.prototype[methodName] = RpcClient.prototype[key] = createRPCMethod(methodName, spec)
  }
}

generateRPCMethods()

module.exports = RpcClient
