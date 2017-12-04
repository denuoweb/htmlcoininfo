const assert = require('assert')
const LRU = require('lru-cache')
const BaseService = require('../../service')
const Encoding = require('./encoding')

class TransactionService extends BaseService {
  constructor(options) {
    super(options)
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._header = this.node.services.get('header')
    this._mempool = this.node.services.get('mempool')
    this._p2p = this.node.services.get('p2p')
    this._timestamp = this.node.services.get('timestamp')
    this._network = this.node.network
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
    this._cacheTx = LRU(1000)
  }

  static get dependencies() {
    return ['block', 'db', 'header', 'mempool', 'p2p', 'timestamp']
  }

  get APIMethods() {
    return [
      ['getTransaction', this.getTransaction.bind(this), 1],
      ['getDetailedTransaction', this.getDetailedTransaction.bind(this), 1],
      ['setTxMetaInfo', this.setTxMetaInfo.bind(this), 2]
    ]
  }

  async getDetailedTransaction(txid, options) {
    let tx = await this.getTransaction(txid, options)
    if (!tx) {
      return
    }
    await Promise.all([
      (async () => {
        for (let i = 0; i < tx.outputs.length; ++i) {
          let output = tx.outputs[i]
          let value = await this._db.get(this._encoding.encodeSpentKey(txid, i))
          if (value) {
            let spentIndex = this._encoding.decodeSpentValue(value)
            output.spentTxId = spentIndex.txid
            output.spentIndex = spentIndex.inputIndex
            output.spentHeight = spentIndex.blockHeight
            output.spentBlockHash = spentIndex.blockHash
          }
        }
      })(),
      (async () => {
        for (let input of tx.inputs) {
          let value = await this._db.get(this._encoding.encodeDoubleSpentKey(input.prevTxId))
          if (value) {
            let doubleSpentInfo = this._encoding.decodeDoubleSpentValue(value)
            input.doubleSpentTxID = doubleSpentInfo.txid
          }
        }
      })()
    ])
    return tx
  }

  async getTransaction(txid, options) {
    let cacheTx = this._cacheTx.get(txid)
    if (cacheTx) {
      return cacheTx
    }
    let tx = await this._getTransaction(txid, options)
    tx = await this._getMempoolTransaction(txid, tx, options)
    await this.setTxMetaInfo(tx, options)
    if (tx) {
      this._cacheTx.set(txid, tx)
    }
    return tx
  }

  async setTxMetaInfo(tx, options) {
    if (!tx) {
      return
    }
    if (!tx.__inputValues) {
      tx.__inputValues = await this._getInputValues(tx, options)
      tx.confirmations = 0
      tx.blockHash = null
      tx.__blockHash = null
    }
    tx.outputSatoshis = 0
    for (let output of tx.outputs) {
      tx.outputSatoshis += output.satoshis
    }
    if (!tx.isCoinbase()) {
      tx.inputSatoshis = 0
      assert(
        tx.__inputValues.length === tx.inputs.length,
        'Transaction Service: input values length is not the same as the number of inputs.'
      )
      for (let value of tx.__inputValues) {
        tx.inputSatoshis += value
      }
      tx.feeSatoshis = tx.inputSatoshis - tx.outputSatoshis
    }
    return tx
  }

  _getMempoolTransaction(txid, tx, options = {}) {
    let queryMempool = 'queryMempool' in options ? true : options.queryMempool
    if (tx || !queryMempool) {
      return tx
    }
    return this._mempool.getMempoolTransaction(txid)
  }

  async _getTransaction(txid, options) {
    if (options && options.processedTxs && options.processedTxs[txid]) {
      return options.processedTxs[txid]
    }
    let key = this._encoding.encodeTransactionKey(txid)
    let txBuffer = await this._db.get(key)
    if (txBuffer) {
      let tx = this._encoding.decodeTransactionValue(txBuffer)
      tx.__confirmations = tx.confirmations = this._block.getTip().height - tx.__height + 1
      tx.height = tx.__height
      tx.blockhash = tx.__blockhash
      return tx
    }
  }

  async _getInputValues(transaction, options) {
    if (transaction.isCoinbase()) {
      return [0]
    }
    return Promise.all(transaction.inputs.map(async input => {
      let outputIndex = input.outputIndex
      let txid = input.prevTxId.toString('hex')
      let tx = await this._getTransaction(txid, options)
      if (!tx) {
        tx = await this._mempool.getMempoolTransaction(txid)
        if (!tx) {
          throw new Error([
            'Transaction Service:',
            `prev transaction: (${txid}) for tx: ${transaction.hash} at input index ${outputIndex}`,
            'is missing from the index or not in the memory pool.',
            'It could be that the parent tx has not yet been relayed to us,',
            'but will be relayed in the near future.'
          ].join(' '))
        }
      }
      let output = tx.outputs[outputIndex]
      assert(output, `Expected an output, but did not get one for tx: ${tx.hash} outputIndex: ${outputIndex}`)
      return output.satoshis
    }))
  }

  async start() {
    this.prefix = await this._db.getPrefix(this.name)
    this._encoding = new Encoding(this.prefix)
  }

  _getBlockTimestamp(hash) {
    return this._timestamp.getTimestampSync(hash)
  }

  async onBlock(block) {
    if (this.node.stopping) {
      return
    }
    let processedTxs = {}
    let operations = []
    for (let tx of block.transactions) {
      processedTxs[tx.hash] = tx
      operations.push(...(await this._processTransaction(tx, {block, processedTxs})))
    }
    return operations
  }

  onReorg(args) {
    let oldBlockList = args[1]
    let removalOps = []
    for (let block of oldBlockList) {
      for (let tx of block.transactions) {
        removalOps.push({type: 'del', key: this._encoding.encodeTransactionKey(tx.hash)})
        for (let input of tx.inputs) {
          removalOps.push({type: 'del', key: this._encoding.encodeSpentKey(input.prevTxId, input.outputIndex)})
        }
      }
    }
    return removalOps
  }

  _getSpentInfo(input) {
    if (!this.node.stopping) {
      return this._db.get(this._encoding.encodeSpentKey(input.prevTxId, input.outputIndex))
    }
  }

  async _getSpentTxOperations(tx) {
    return Promise.all(tx.inputs.map(async(input, index) => {
      let info = await this._getSpentInfo(input)
      if (info) {
        return {
          type: 'put',
          key: this._encoding.encodeDoubleSpentKey(input.prevTxId, input.outputIndex),
          value: this._encoding.encodeDoubleSpentValue(tx.hash, index, tx.__height, tx.__blockhash)
        }
      } else {
        return {
          type: 'put',
          key: this._encoding.encodeSpentKey(input.prevTxId, input.outputIndex),
          value: this._encoding.encodeSpentValue(tx.hash, index, tx.__height, tx.__blockhash)
        }
      }
    }))
  }

  async _processTransaction(tx, options) {
    tx.__inputValues = await this._getInputValues(tx, options)
    tx.__timestamp = this._getBlockTimestamp(options.block.hash)
    assert(tx.__timestamp, 'Timestamp is required when saving a transaction')
    tx.__height = options.block.height
    assert(tx.__height !== undefined, 'Block height is required when saving a transaction')
    tx.__blockhash = options.block.hash
    return [
      {
        type: 'put',
        key: this._encoding.encodeTransactionKey(tx.hash),
        value: this._encoding.encodeTransactionValue(tx)
      },
      ...(await this._getSpentTxOperations(tx))
    ]
  }
}

module.exports = TransactionService
