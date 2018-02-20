const BaseService = require('../service')
const Transaction = require('../models/transaction')
const Utxo = require('../models/utxo')
const {toRawTransaction, toRawScript} = require('../utils')

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

  async onReorg(_, block) {
    await Transaction.deleteMany({'block.height': block.height, index: {$in: [0, 1]}})
    await Transaction.updateMany({'block.height': block.height}, {block: {height: 0xffffffff}})
    await Utxo.updateMany({'output.height': block.height}, {'output.height': 0xffffffff})
    await Utxo.updateMany({'input.height': block.height}, {'input.height': 0xffffffff})
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
    let inputAddresses = new Set()
    let outputAddresses = new Set()
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
      await Transaction.remove({id: utxo.input.transactionId})
      utxo.input.height = 0xffffffff
      utxo.input.transactionId = tx.id
      utxo.input.index = index
      utxo.input.script = Utxo.transformScript(input.script)
      utxo.input.sequence = input.sequenceNumber
      await utxo.save()
      inputs.push(utxo._id)
      if (utxo.address) {
        inputAddresses.add(utxo.address)
      }
    }

    let outputs = []
    let outputUtxos = []
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
        address: Utxo.getAddress(tx, index, this._network),
        isStake: tx.outputs[0].script.chunks.length === 0
      })
      await utxo.save()
      outputs.push(utxo._id)
      outputUtxos.push(utxo)
      if (utxo.address) {
        outputAddresses.add(utxo.address)
      }
    }

    let transaction = new Transaction({
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
      inputAddresses: [...inputAddresses],
      outputAddresses: [...outputAddresses],
    })
    await transaction.save()
    let _transaction = await this.node.services.get('transaction').getTransaction(tx.id)
    let rawTransaction = toRawTransaction(_transaction)
    let transactionBuffer = rawTransaction.toBuffer()
    let transactionHashBuffer = rawTransaction.toHashBuffer()
    transaction.size = transactionBuffer.length
    transaction.weight = transactionBuffer.length + transactionHashBuffer.length * 3
    await transaction.save()

    let txBuffer = tx.toBuffer()
    let txHashBuffer = tx.toHashBuffer()
    let inputSatoshis = inputUtxos.map(utxo => utxo.satoshis).reduce((x, y) => x + y)
    let outputSatoshis = outputUtxos.map(utxo => utxo.satoshis).reduce((x, y) => x + y)
    let transformed = {
      id: transaction.id,
      size: txBuffer.length,
      weight: txBuffer.length + txHashBuffer.length * 3,
      valueIn: inputSatoshis,
      valueOut: outputSatoshis,
      fees: inputSatoshis - outputSatoshis
    }
    for (let subscription of this._subscriptions.transaction) {
      subscription.emit('mempool/transaction', transformed)
    }
  }
}

module.exports = MempoolService
