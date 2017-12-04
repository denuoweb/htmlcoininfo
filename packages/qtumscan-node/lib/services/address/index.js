const assert = require('assert')
const {Transform} = require('stream')
const BaseService = require('../../service')
const Encoding = require('./encoding')
const {getAddress} = require('../../utils')

class AddressService extends BaseService {
  constructor(options) {
    super(options)
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._header = this.node.services.get('header')
    this._mempool = this.node.services.get('mempool')
    this._timestamp = this.node.services.get('timestamp')
    this._transaction = this.node.services.get('transaction')
    this._network = this.node.network
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
  }

  static get dependencies() {
    return ['block', 'db', 'header', 'mempool', 'timestamp', 'transaction']
  }

  async getAddressHistory(addresses, options = {}) {
    options.from = options.from || 0
    options.to = options.to || 0xffffffff
    options.txIdList = []
    if (!'queryMempool' in options) {
      options.queryMempool = true
    }
    if (typeof addresses === 'string') {
      addresses = [addresses]
    }
    await Promise.all(addresses.map(address => this._getAddressTxidHistory(address, options)))
    let unique = {}
    for (let txId of options.txIdList) {
      unique[txId.txid + txId.height] = txId
    }
    options.txIdList = Object.values(unique).sort((a, b) => b.height - a.height)
    let txList = await this._getAddressTxHistory(options)
    return {
      totalCount: options.txIdList.length,
      items: txList
    }
  }

  async getAddressSummary(address, options = {}) {
    options.from = options.from || 0
    options.to = options.to || 0xffffffff
    if (!'queryMempool' in options) {
      options.queryMempool = true
    }
    let result = {
      addrStr: address,
      balance: 0,
      totalReceived: 0,
      totalSent: 0,
      unconfirmedBalance: 0,
      unconfirmedTxApperances: 0,
      txApperances: 0
    }
    let results = await this.getAddressHistory(address, options)
    this._getAddressSummaryResult(result.items, address, result, options)
    return result
  }

  _setOutputResults(tx, address, result) {
    for (let output of tx.outputs) {
      if (getAddress(output, this._network) !== address) {
        continue
      }
      ++result.txApperances
      result.totalReceived += output.satoshis
      result.balance += output.satoshis
      if (tx.confirmations === 0) {
        ++result.unconfirmedTxApperances
        result.unconfirmedBalance += output.satoshis
      }
    }
    return result
  }

  _setInputResults(tx, address, result) {
    for (let i = 0; i < tx.inputs.length; ++i) {
      let input = tx.inputs[i]
      if (getAddress(input, this._network) !== address) {
        continue
      }
      result.totalSent += tx.__inputValues[i]
      result.balance -= tx.__inputValues[i]
      if (tx.confirmations === 0) {
        result.unconfirmedBalance -= tx.__inputValues[i]
      }
    }
  }

  _getAddressSummaryResult(txs, address, result, {noTxList}) {
    for (let tx of txs) {
      this._setOutputResults(tx, address, result)
      this._setInputResults(tx, address, result)
      if (!noTxList) {
        if (!result.transactions) {
          result.transactions = []
        }
        result.transactions.push(tx.hash)
      }
    }
    return result
  }

  async getAddressUnspentOutputs(address, options = {}) {
    options.from = options.from || 0
    options.to = options.to || 0xffffffff
    if (!'queryMempool' in options) {
      options.queryMempool = true
    }
    let results = []
    let start = this._encoding.encodeUtxoIndexKey(address)
    let final = Buffer.from('f'.repeat(72), 'hex')
    let end = Buffer.concat([start.slice(0, -36), final])
    let mempoolTxids = options.queryMempool ? await this._mempool.getTxidsByAddress(address, 'output') : []
    await Promise.all(mempoolTxids.map(async id => {
      let tx = await this._mempool.getMempoolTransaction(id.txid)
      if (!tx) {
        throw new Error('Address Service: missing tx: ' + id.txid)
      }
      results.push(...this._getMempoolUtxos(tx, address))
    }))

    return new Promise((resolve, reject) => {
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(results.sort((x, y) => x.confirmations - y.confirmations)))
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let key = this._encoding.decodeUtxoIndexKey(data.key)
        let value = this._encoding.decodeUtxoIndexValue(data.value)
        results.push({
          address,
          txid: key.txid,
          vout: key.outputIndex,
          ts: value.timestamp,
          scriptPubKey: value.script.toString('hex'),
          height: value.height,
          satoshis: value.satoshis,
          confirmations: this._block.getTip().height - value.height + 1
        })
      })
    })
  }

  _getMempoolUtxos(tx, address) {
    let results = []
    for (let i = 0; i < tx.outputs.length; ++i) {
      let output = tx.outputs[i]
      if (getAddress(output, this._network) !== address) {
        continue
      }
      results.push({
        address,
        txid: tx.hash,
        vout: i,
        scriptPubKey: output.script.toBuffer().toString('hex'),
        height: null,
        satoshis: output.satoshis,
        confirmations: 0
      })
    }
    return results
  }

  get APIMethods() {
    return [
      ['getAddressHistory', this.getAddressHistory.bind(this), 2],
      ['getAddressSummary', this.getAddressSummary.bind(this), 1],
      ['getAddressUnspentOutputs', this.getAddressUnspentOutputs.bind(this), 1]
    ]
  }

  async start() {
    let prefix = await this._db.getPrefix(this.name)
    this._encoding = new Encoding(prefix)
  }

  _getTxidStream(address, options) {
    let start = this._encoding.encodeAddressIndexKey(address)
    let end = Buffer.concat([
      start.slice(0, address.length + 4),
      options.endHeightBuf,
      Buffer.from('f'.repeat(82), 'hex')
    ])
    let txidStream = this._db.createKeyStream({gte: start, lte: end, reverse: true})
    txidStream.on('close', () => txidStream.unpipe())
    return txidStream
  }

  _getAddressTxHistory(options) {
    let ids = options.txIdList.slice(options.from, options.to)
    return Promise.all(ids.map(async id => {
      if (id.height === 0xffffffff) {
        let tx = await this._mempool.getMempoolTransaction(id.txid)
        if (!tx) {
          throw new Error('Address Service: could not find tx: ', id.txid)
        }
        return this._transaction.setTxMetaInfo(tx, options)
      } else {
        return this._transaction.getDetailedTransaction(id.txid, options)
      }
    }))
  }

  async _getAddressTxHistory(address, options = {}) {
    options.start = options.start || 0
    options.end = options.end || 0xffffffff
    options.endHeightBuf = Buffer.alloc(4)
    options.endHeightBuf.writeUInt32BE(options.end)
    if (!('queryMempool' in options)) {
      options.queryMempool = true
    }
    let results = options.queryMempool ? await this._mempool.getTxidsByAddress(address, 'both') : []
    return new Promise((resolve, reject) => {
      let txIdTransformStream = new Transform({objectMode: true})
      txIdTransformStream._flush = callback => {
        txIdTransformStream.emit('end')
        callback()
      }
      txIdTransformStream.on('error', err => {
        this.node.log.error('Address Service: txstream err: ' + err)
        txIdTransformStream.unpipe()
      })
      txIdTransformStream.on('end', () => {
        options.txIdList.push(...results)
        resolve()
      })
      txIdTransformStream._transform = (chunk, encoding, callback) => {
        let txInfo = this._encoding.decodeAddressIndexKey(chunk)
        results.push({txid: txInfo.txid, height: txInfo.height})
        callback()
      }
      let txidStream = this._getTxidStream(address, options)
      txidStream.pipe(txIdTransformStream)
    })
  }

  async _removeBlock(block) {
    let operations = []
    for (let tx of block.transactions) {
      operations.push(...(await this._removeTx(tx, block)))
    }
    return operations
  }

  async _removeTx(tx, block) {
    let operations = []
    await Promise.all([
      async () => {
        for (let i = 0; i < tx.inputs.length; ++i) {
          operations.push(...(await this._removeInput(tx.inputs[i], tx, block, i)))
        }
      },
      async () => {
        for (let i = 0; i < tx.outputs.length; ++i) {
          operations.push(...this._removeOutput(tx.outputs[i], tx, block, i))
        }
      }
    ])
    return operations
  }

  async _removeInput(input, tx, block, index) {
    let address = getAddress(input, this._network)
    if (!address) {
      return
    }
    assert(block && block.height && block.header.time, 'Missing block or block values.')
    let _tx = await this._transaction.getTransaction(input.prevTxId)
    assert(_tx, 'Missing prev tx to insert back into the utxo set when reorging address index.')
    assert(_tx.__height && _tx.__inputValues && _tx.__timestamp, 'Missing tx values.')
    return [
      {
        type: 'del',
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.hash, index, 1, block.header.time)
      },
      {
        type: 'put',
        key: this._encoding.encodeUtxoIndexKey(address, _tx.hash, input.outputIndex),
        value: this._encoding.encodeUtxoIndexValue(
          _tx.__height,
          _tx.__inputValues[input.outputIndex],
          _tx.__timestamp,
          _tx.outputs[index.outputIndex].script.toBuffer()
        )
      }
    ]
  }

  _removeOutput(output, tx, block, index) {
    let address = getAddress(output, this._network)
    if (!address) {
      return
    }
    assert(block && block.height && block.header.time, 'Missing block or block values.')
    return [
      {
        type: 'del',
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.hash, index, 0, block.header.time)
      },
      {
        type: 'del',
        key: this._encoding.encodeUtxoIndexKey(address, tx.hash, index)
      }
    ]
  }

  async onReorg(args) {
    let oldBlockList = args[1]
    let operations = []
    for (let block of args[1]) {
      operations.push(...(await this._removeBlock(block)))
    }
    return operations
  }

  onBlock(block) {
    if (this.node.stopping) {
      return
    }
    let operations = []
    for (let tx of block.transactions) {
      operations.push(...this._processTransaction(tx, {block}))
    }
    return operations
  }

  _processInput(tx, input, index, {block}) {
    let address = getAddress(input, this._network)
    if (!address) {
      return []
    }
    let txid = tx.hash
    let timestamp = this._timestamp.getTimestampSync(block.hash)
    assert(timestamp, 'Must have a timestamp in order to process input.')
    return [
      {
        type: 'put',
        key: this._encoding.encodeAddressIndexKey(address, block.height, txid, index, 1, timestamp)
      },
      {
        type: 'del',
        key: this._encoding.encodeUtxoIndexKey(address, input.prevTxId, input.outputIndex)
      }
    ]
  }

  _processOutput(tx, output, index, {block}) {
    let address = getAddress(output, this._network)
    if (!address) {
      return []
    }
    let txid = tx.hash
    let timestamp = this._timestamp.getTimestampSync(block.hash)
    assert(timestamp, 'Must have a timestamp in order to process output.')
    return [
      {
        type: 'put',
        key: this._encoding.encodeAddressIndexKey(address, block.height, txid, index, 0, timestamp)
      },
      {
        type: 'put',
        key: this._encoding.encodeUtxoIndexKey(address, txid, index),
        value: this._encoding.encodeUtxoIndexValue(
          block.height, output.satoshis, timestamp, output.script.toBuffer()
        )
      }
    ]
  }

  _processTransaction(tx, {block}) {
    let operations = []
    for (let i = 0; i < tx.outputs.length; ++i) {
      operations.push(...this._processOutput(tx, tx.outputs[i], i, {block}))
    }
    for (let i = 0; i < tx.inputs.length; ++i) {
      operations.push(...this._processInput(tx, tx.inputs[i], i, {block}))
    }
    return operations
  }
}

module.exports = AddressService
