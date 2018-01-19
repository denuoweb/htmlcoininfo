const BaseService = require('../../service')
const Transaction = require('../../models/transaction')
const Utxo = require('../../models/utxo')

class MempoolService extends BaseService {
  constructor(options) {
    super(options)
    this._subscriptions = {transaction: []}
    this.log = this.node.log
    this._db = this.node.services.get('db')
    this._p2p = this.node.services.get('p2p')
    this._network = this.node.network
    this._flush = options.flush
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

  async onReorg(_, block) {
    await Transaction.updateMany({'block.height': block.height}, {$set: {block: {height: 0xffffffff}}})
    await Utxo.updateMany({createHeight: block.height}, {$set: {createHeight: 0xffffffff}})
    await Utxo.updateMany({useHeight: block.height}, {$set: {useHeight: 0xffffffff}})
    await Utxo.deleteMany({
      $or: [
        {'output.transactionId': {$in: [block.transactions[0].id, block.transactions[1].id]}},
        {'input.transactionId': block.transactions[0].id}
      ]
    })
  }

  _startSubscriptions() {
    if (this._subscribed) {
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

  async _getAddressOperations(tx, action) {
    let transactionService = this.node.services.get('transaction')
    let operations = []
    for (let i = 0; i < tx.outputs.length; ++i) {
      let output = tx.outputs[i]
      let address = getOutputAddress(output, transactionService, this._network)
      if (address) {
        operations.push({
          type: action,
          key: this._encoding.encodeMempoolAddressKey(address, tx.id, i, 0)
        })
      }
    }
    for (let i = 0; i < tx.inputs.length; ++i) {
      let input = tx.inputs[i]
      let address = await getInputAddress(input, transactionService, this._network)
      if (address) {
        operations.push({
          type: action,
          key: this._encoding.encodeMempoolAddressKey(address, tx.id, i, 1)
        })
      }
    }
    return operations
  }

  async _onTransaction(tx) {
    let inputs = []
    for (let index = 0; index < tx.inputs.length; ++index) {
      let input = tx.inputs[index]
      let utxo = await Utxo.findOne({
        'output.transactionId': input.prevTxId.toString('hex'),
        'output.index': input.outputIndex
      })
      if (utxo.useHeight) {
        let transaction = await Transaction.findOne({id: utxo.input.transactionId})
        assert(transaction.block.height === 0xffffffff)
        await transaction.remove()
      }
      utxo.input.transactionId = tx.id
      utxo.input.index = index
      utxo.input.script = Utxo.transformScript(input.script)
      utxo.input.sequence = input.sequenceNumber
      utxo.useHeight = 0xffffffff
      await utxo.save()
      inputs.push(utxo._id)
    }

    let outputs = []
    for (let index = 0; index < tx.outputs.length; ++index) {
      let output = tx.outputs[index]
      let utxo = new Utxo({
        satoshis: output.satoshis,
        output: {
          transactionId: tx.id,
          index,
          script: Utxo.transformScript(output.script)
        },
        address: Utxo.getAddress(tx, index),
        createHeight: 0xffffffff
      })
      await utxo.save()
      outputs.push(utxo._id)
    }

    await new Transaction({
      id: tx.id,
      hash: tx.hash,
      version: tx.version,
      dummy: tx.dummy,
      flags: tx.flags,
      inputs,
      outputs,
      witnessStack: tx.witnessStack.map(witness => witness.map(item => item.toString('hex'))),
      nLockTime: tx.nLockTime,
      block: {height: 0xffffffff},
      isStake: tx.outputs[0].script.chunks.length === 0
    }).save()

    for (let transaction of this._subscriptions.transaction) {
      transaction.emit('mempool/transaction')
    }
  }

  async getMempoolTransaction(txid) {
    let tx = await this._db.get(this._encoding.encodeMempoolTransactionKey(txid))
    if (tx) {
      return this._encoding.decodeMempoolTransactionValue(tx)
    }
  }

  getTxidsByAddress(address, type) {
    let txids = new Set()
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
          txids.add(addressInfo.txid)
        }
      })
      stream.on('end', () => resolve([...txids].map(txid => ({txid, height: 0xffffffff}))))
      stream.on('error', reject)
    })
  }
}

module.exports = MempoolService
