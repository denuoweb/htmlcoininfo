const BaseService = require('../../service')
const {getAddress} = require('../../utils')
const Encoding = require('./encoding')

class MempoolService extends BaseService {
  constructor(options) {
    super(options)
    this._subscriptions = {transaction: []}
    this.log = this.node.log
    this._db = this.node.services.get('db')
    this._p2p = this.node.services.get('p2p')
    this._network = this.node.network
    this.flush = options.flush
    this._enabled = false

    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
  }

  static get dependencies() {
    return ['db', 'p2p']
  }

  get APIMethods() {
    return [
      ['getMempoolTransaction', this.getMempoolTransaction.bind(this), 1],
      ['getTxidsByAddress', this.getTxidsByAddress.bind(this), 2]
    ]
  }

  get publishEvents() {
    return [{
      name: 'mempool/transaction',
      subscribe: this.subscribe.bind(this, 'transaction'),
      unsubscribe: this.unsubscribe.bind(this, 'transaction')
    }]
  }

  async start() {
    let prefix = await this._db.getPrefix(this.name)
    this._encoding = new Encoding(prefix)
    if (this._flush) {
      return this._flushMempool()
    }
    this.log.info('Mempool service: mempool disabled until full sync.')
  }

  subscribe(name, emitter) {
    let subscriptions = this.subscriptions[name]
    subscriptions.push(emitter)
    this.log.info(emitter.remoteAddress, 'subscribe:', 'mempool/' + name, 'total:', subscriptions.length)
  }

  unsubscribe(name, emitter) {
    let subscriptions = this.subscriptions[name]
    let index = subscriptions.indexOf(emitter)
    if (index >= 0) {
      subscriptions.splice(index, 1)
      this.log.info(emitter.remoteAddress, 'unsubscribe:', 'mempool/' + name, 'total:', subscriptions.length)
    }
  }

  _flushMempool() {
    this.log.warn('Mempool service: flushing mempool, this could take a minute.')
    let totalCount = 0
    let criteria = {
      gte: this._encoding.encodeMempoolTransactionKey('0'.repeat(64)),
      lte: this._encoding.encodeMempoolTransactionKey('f'.repeat(64))
    }

    let timer = setInterval(() => {
      this.log.info('Mempool service: removed:', totalCount, 'records during mempool flush.')
    }, 5000)
    timer.unref()

    return new Promise(resolve => {
      let stream = this._db.createReadStream(criteria)
      stream.on('data', async data => {
        let operations = await this._getAddressOperations(
          this._encoding.decodeMempoolTransactionValue(data.value),
          'del'
        )
        operations.push({type: 'del', key: data.key})
        totalCount += operations.length
        await this._db.batch(operations)
      })
      steam.on('end', () => {
        clearInterval(timer)
        this.node.log.info('Mempool service: complete flushing:', totalCount, 'tx mempool records.')
        resolve()
      })
    })
  }

  async onReorg(_, block) {
    let removalOperations = []
    for (let i = 2; i < block.transactions.length; ++i) {
      let tx = block.transactions[i]
      removalOperations.push(
        {
          type: 'put',
          key: this._encoding.encodeMempoolTransactionKey(tx.hash),
          value: this._encoding.encodeMempoolTransactionValue(tx)
        },
        ...(await this._getAddressOperations(tx, 'put'))
      )
    }
    return removalOperations
  }

  _startSubscriptions() {
    if (!this._subscribed) {
      return
    }
    this._subscribed = true

    if (!this._bus) {
      this._bus = this.node.openBus({remoteAddress: 'localhost-mempool'})
    }
    this._bus.on('p2p/transaction', this._onTransaction.bind(this))
    this._bus.subscribe('p2p/transaction')
  }

  enable() {
    this.node.log.info('Mempool service: Mempool enabled.')
    this._startSubscriptions()
    this._enabled = true
  }

  async onBlock(block) {
    let operations = []
    for (let tx of block.transactions) {
      operations.push(
        {type: 'del', key: this._encoding.encodeMempoolTransactionKey(tx.hash)},
        ...(await this._getAddressOperations(tx, 'del'))
      )
    }
    return operations
  }

  async _getAddressOperations(tx, action) {
    let transactionService = this.node.services.get('transaction')
    let operations = []
    for (let i = 0; i < tx.outputs.length; ++i) {
      let output = tx.outputs[i]
      let address = await getAddress(output, transactionService, this._network)
      if (address) {
        operations.push({
          type: action,
          key: this._encoding.encodeMempoolAddressKey(address, tx.hash, i, 0)
        })
      }
    }
    for (let i = 0; i < tx.inputs.length; ++i) {
      let input = tx.inputs[i]
      let address = await getAddress(input, transactionService, this._network)
      if (address) {
        operations.push({
          type: action,
          key: this._encoding.encodeMempoolAddressKey(address, tx.hash, i, 1)
        })
      }
    }
    return operations
  }

  async _onTransaction(tx) {
    let ops = [
      {
        type: 'put',
        key: this._encoding.encodeMempoolTransactionKey(tx.hash),
        value: this._encoding.encodeMempoolTransactionValue(tx)
      },
      ...(await this._getAddressOperations(tx, 'put'))
    ]

    try {
      await this._db.batch(operations)
      for (let transaction of this._subscriptions.transaction) {
        transaction.emit('mempool/transaction')
      }
    } catch (err) {
      this.node.log.error(err)
      this.node.stop()
    }
  }

  async getMempoolTransaction(txid) {
    let tx = await this._db.get(this._encoding.encodeMempoolTransactionKey(txid))
    if (tx) {
      return this._encoding.decodeMempoolTransactionValue(tx)
    }
  }

  getTxidsByAddress(address, type) {
    let results = []
    let start = this._encoding.encodeMempoolAddressKey(address)
    let end = Buffer.concat([start.slice(0, -37), Buffer.from('f'.repeat(74), 'hex')])

    return new Promise((resolve, reject) => {
      let stream = this._db.createKeyStream({gte: start, lte: end})
      stream.on('data', key => {
        let addressInfo = this._encoding.decodeMempoolAddressKey(key)
        if (type === 'input') {
          type = 1
        } else if (type === 'output') {
          type = 0
        }
        if (type === 'both' || type === addressInfo.input) {
          results.push({txid: addressInfo.txid, height: 0xffffffff})
        }
      })
      stream.on('end', () => resolve(results))
      stream.on('error', reject)
    })
  }
}

module.exports = MempoolService
