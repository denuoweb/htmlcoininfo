const WebSocket = require('ws')
const BaseService = require('qtuminfo-node/lib/service')
const Block = require('qtuminfo-node/lib/models/block')
const {toRawBlock} = require('qtuminfo-node/lib/utils')

class QtuminfoWS extends BaseService {
  constructor(options) {
    super(options)
    this._options = options
    this._block = this.node.services.get('block')
    this._header = this.node.services.get('header')
    this._transaction = this.node.services.get('transaction')
  }

  static get dependencies() {
    return ['block', 'contract', 'header', 'mempool', 'transaction', 'web']
  }

  get routePrefix() {
    return this._routePrefix
  }

  async start() {
    if (this._subscribed) {
      return
    }
    this._subscribed = true
    if (!this._bus) {
      this._bus = this.node.openBus({remoteAddress: 'localhost-qtuminfo-ws'})
    }
    this._bus.on('mempool/transaction', this.mempoolTransactionEventHandler.bind(this))
    this._bus.subscribe('mempool/transaction')
    this._bus.on('block/block', this.blockEventHandler.bind(this))
    this._bus.subscribe('block/block')
    this._bus.on('block/transaction', this.transactionEventHandler.bind(this))
    this._bus.subscribe('block/transaction')
    this._bus.on('block/address', this.addressEventHandler.bind(this))
    this._bus.subscribe('block/address')

    this._server = new WebSocket.Server({port: this._options.port})
    this._server.on('connection', (ws, req) => {
      ws.subscriptions = new Set(['height'])
      ws.send(JSON.stringify({type: 'height', data: this._block.getTip().height}))
      ws.on('message', message => {
        if (message === '"ping"') {
          ws.send(JSON.stringify('pong'))
        } else {
          try {
            message = JSON.parse(message)
            if (message.type === 'subscribe') {
              ws.subscriptions.add(message.data)
            } else if (message.type === 'unsubscribe') {
              ws.subscriptions.delete(message.data)
            }
          } catch (err) {}
        }
      })
      ws.on('close', (code, reason) => {})
      ws.on('error', () => {})
    })
  }

  stop() {
    this._server.close()
  }

  getRemoteAddress(req) {
    return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress
  }

  mempoolTransactionEventHandler(transaction) {
    for (let client of this._server.clients) {
      if (client.subscriptions.has('mempool/transaction')) {
        client.send(JSON.stringify({
          type: 'mempool/transaction',
          data: transaction
        }))
      }
    }
  }

  async blockEventHandler(block) {
    let transformedBlock = await this.transformBlock(block)
    for (let client of this._server.clients) {
      if (client.subscriptions.has('height')) {
        client.send(JSON.stringify({
          type: 'height',
          data: block.height
        }))
      }
      if (client.subscriptions.has('block')) {
        client.send(JSON.stringify({
          type: 'block',
          data: transformedBlock
        }))
      }
    }
  }

  transactionEventHandler(transaction) {
    for (let client of this._server.clients) {
      if (client.subscriptions.has('transaction/' + transaction.id)) {
        client.send(JSON.stringify({
          type: 'transaction/' + transaction.id,
          data: transaction
        }))
      }
    }
  }

  addressEventHandler(address) {
    for (let client of this._server.clients) {
      if (client.subscriptions.has('address')) {
        client.send(JSON.stringify({
          type: 'address',
          data: address
        }))
      }
    }
  }

  async transformBlock(block) {
    let rawBlock = await toRawBlock(block)
    let blockBuffer = rawBlock.toBuffer()
    let blockHashBuffer = rawBlock.toHashBuffer()
    let {reward, minedBy, duration} = await this.getBlockReward(block, rawBlock)
    return {
      hash: block.hash,
      size: blockBuffer.length,
      weight: blockBuffer.length + blockHashBuffer.length * 3,
      height: block.height,
      version: block.version,
      merkleRoot: block.merkleRoot,
      tx: block.transactions,
      timestamp: block.timestamp,
      nonce: block.nonce,
      bits: block.bits.toString(16),
      difficulty: rawBlock.header.getDifficulty(),
      chainWork: block.chainwork,
      confirmations: this._block.getTip().height - block.height + 1,
      previousBlockHash: block.prevHash,
      nextBlockHash: block.nextHash,
      reward,
      minedBy,
      duration,
      isMainChain: true
    }
  }

  async getBlockReward(block, rawBlock) {
    let minedBy, duration
    let reward = 0
    if (rawBlock.header.isProofOfStake()) {
      let transaction = await this._transaction.getTransaction(block.transactions[1])
      reward = -transaction.feeSatoshis
      minedBy = transaction.outputs[1].address
    } else {
      let transaction = await this._transaction.getTransaction(block.transactions[0])
      reward = transaction.outputSatoshis
      minedBy = transaction.outputs[0].address
    }
    let prevHash = block.prevHash
    if (prevHash !== '0'.repeat(64)) {
      let prevBlockHeader = await this._header.getBlockHeader(prevHash)
      duration = block.timestamp - prevBlockHeader.timestamp
    }
    return {reward, minedBy, duration}
  }
}

module.exports = QtuminfoWS
