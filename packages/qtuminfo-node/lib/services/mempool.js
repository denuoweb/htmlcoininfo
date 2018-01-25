const BaseService = require('../service')
const Transaction = require('../models/transaction')
const Utxo = require('../models/utxo')

class MempoolService extends BaseService {
  constructor(options) {
    super(options)
    this._subscriptions = {transaction: []}
    this.log = this.node.log
    this._db = this.node.services.get('db')
    this._p2p = this.node.services.get('p2p')
    this._network = this.node.network
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
    await Utxo.updateMany({'output.height': block.height}, {$set: {'output.height': 0xffffffff}})
    await Utxo.updateMany({'input.height': block.height}, {$set: {'input.height': 0xffffffff}})
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

  async _onTransaction(tx) {
    let addresses = new Set()
    let inputUtxos = []
    for (let index = 0; index < tx.inputs.length; ++index) {
      let input = tx.inputs[index]
      let utxo = await Utxo.findOne({
        'output.transactionId': input.prevTxId.toString('hex'),
        'output.index': input.outputIndex
      })
      if (!utxo) {
        return
      }
      inputUtxos.push(utxo)
    }
    let inputs = []
    for (let index = 0; index < tx.inputs.length; ++index) {
      let input = tx.inputs[index]
      let utxo = inputUtxos[index]
      if (utxo.input && utxo.input.height != null) {
        let transaction = await Transaction.findOne({id: utxo.input.transactionId})
        await transaction.remove()
      }
      utxo.input.height = 0xffffffff
      utxo.input.transactionId = tx.id
      utxo.input.index = index
      utxo.input.script = Utxo.transformScript(input.script)
      utxo.input.sequence = input.sequenceNumber
      await utxo.save()
      inputs.push(utxo._id)
    }

    let outputs = []
    for (let index = 0; index < tx.outputs.length; ++index) {
      let output = tx.outputs[index]
      let utxo = new Utxo({
        satoshis: output.satoshis,
        output: {
          height: 0xffffffff,
          transactionId: tx.id,
          index,
          script: Utxo.transformScript(output.script)
        },
        address: Utxo.getAddress(tx, index),
        isStake: tx.outputs[0].script.chunks.length === 0
      })
      await utxo.save()
      outputs.push(utxo._id)
      if (utxo.address) {
        addresses.add(utxo.address)
      }
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
      addresses: [...addresses]
    }).save()

    for (let transaction of this._subscriptions.transaction) {
      transaction.emit('mempool/transaction')
    }
  }
}

module.exports = MempoolService
