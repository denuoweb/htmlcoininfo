const assert = require('assert')
const {Transform} = require('stream')
const BN = require('bn.js')
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
    if (!('queryMempool' in options)) {
      options.queryMempool = true
    }
    if (typeof addresses === 'string') {
      addresses = [addresses]
    }
    let unique = new Map()
    await Promise.all(addresses.map(async address => {
      let list = await this._getAddressTxidHistory(address, options)
      for (let txId of list) {
        unique.set(txId.txid, txId)
      }
    }))
    let txIdList = [...unique.values()].sort((a, b) => b.height - a.height)
    return {
      totalCount: txIdList.length,
      transactions: txIdList.slice(options.from, options.to).map(tx => tx.txid)
    }
  }

  async getAddressSummary(address, options = {}) {
    options.from = options.from || 0
    options.to = options.to || 0xffffffff
    if (!('queryMempool' in options)) {
      options.queryMempool = true
    }
    options.listUsed = true
    let {totalCount, transactions} = await this.getAddressHistory(address, options)
    let utxos = await this.getAddressUnspentOutputs(address, options)
    let balance = new BN(0)
    let totalReceived = new BN(0)
    let totalSent = new BN(0)
    let unconfirmedBalance = new BN(0)
    for (let utxo of utxos) {
      let value = new BN(utxo.satoshis)
      totalReceived.iadd(value)
      if (utxo.used) {
        totalSent.iadd(value)
      } else {
        balance.iadd(value)
      }
      if (utxo.confirmations === 0 && !utxo.used) {
        unconfirmedBalance.iadd(value)
      }
    }
    return {
      address,
      totalCount,
      transactions,
      balance: balance.toString(),
      totalReceived: totalReceived.toString(),
      totalSent: totalSent.toString(),
      unconfirmedBalance: unconfirmedBalance.toString()
    }
  }

  async getAddressUnspentOutputs(address, options = {}) {
    options.from = options.from || 0
    options.to = options.to || 0xffffffff
    if (!('queryMempool' in options)) {
      options.queryMempool = true
    }
    let results = []
    let start = this._encoding.encodeUtxoIndexKey(address)
    let final = Buffer.from('f'.repeat(72), 'hex')
    let end = Buffer.concat([start.slice(0, -36), final])
    let mempoolTxids = options.queryMempool ? await this._mempool.getTxidsByAddress(address, 'output') : []
    let mempoolInputPrevTxidSet = new Set()
    await Promise.all(mempoolTxids.map(async id => {
      let tx = await this._mempool.getMempoolTransaction(id.txid)
      assert(tx, 'Address Service: missing tx: ' + id.txid)
      results.push(...(await this._getMempoolUtxos(tx, address, mempoolInputPrevTxidSet)))
    }))
    for (let utxo of results) {
      utxo.used = mempoolInputPrevTxidSet.has(utxo.txid)
    }

    return new Promise((resolve, reject) => {
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(results.sort((x, y) => x.confirmations - y.confirmations)))
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let key = this._encoding.decodeUtxoIndexKey(data.key)
        let value = this._encoding.decodeUtxoIndexValue(data.value)
        if (options.listUsed || !value.used) {
          results.push({
            address,
            txid: key.txid,
            vout: key.outputIndex,
            timestamp: value.timestamp,
            scriptPubKey: value.scriptBuffer.toString('hex'),
            height: value.height,
            satoshis: value.satoshis,
            confirmations: this._block.getTip().height - value.height + 1,
            used: value.used || mempoolInputPrevTxidSet.has(key.txid)
          })
        }
      })
    })
  }

  async _getMempoolUtxos(tx, address, mempoolInputPrevTxidSet) {
    let results = []
    for (let i = 0; i < tx.outputs.length; ++i) {
      let output = tx.outputs[i]
      if (await getAddress(output, this._transaction, this._network) !== address) {
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
    for (let input of tx.inputs) {
      mempoolInputPrevTxidSet.add(input.prevTxId.toString('hex'))
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

  async _getAddressTxidHistory(address, options = {}) {
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
      txIdTransformStream.on('end', () => resolve(results))
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
    for (let i = block.transactions.length; --i >= 0;) {
      operations.push(...(await this._removeTx(block.transactions[i], block)))
    }
    return operations
  }

  async _removeTx(tx, block) {
    let operations = []
    for (let i = 0; i < tx.inputs.length; ++i) {
      operations.push(...(await this._removeInput(tx, i, block)))
    }
    for (let i = 0; i < tx.outputs.length; ++i) {
      operations.push(...(await this._removeOutput(tx, i, block)))
    }
    return operations
  }

  async _removeInput(tx, index, block) {
    let input = tx.inputs[index]
    let address = await getAddress(input, this._transaction, this._network)
    if (!address) {
      return []
    }
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
          _tx.outputs[input.outputIndex].script.toBuffer()
        )
      }
    ]
  }

  async _removeOutput(tx, index, block) {
    let output = tx.outputs[index]
    let address = await getAddress(output, this._transaction, this._network)
    if (!address) {
      return []
    }
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

  onReorg(_, block) {
    return this._removeBlock(block)
  }

  async onBlock(block) {
    if (this.node.stopping) {
      return
    }
    let operations = []
    let utxoOperations = new Map()
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        operations.push(...(await this._processOutput(tx, i, block, utxoOperations)))
      }
      for (let i = 0; i < tx.inputs.length; ++i) {
        operations.push(...(await this._processInput(tx, i, block, utxoOperations)))
      }
    }
    for (let {key, value} of utxoOperations.values()) {
      operations.push({
        type: 'put',
        key,
        value: this._encoding.encodeUtxoIndexValue(
          value.height, value.satoshis, value.timestamp, value.scriptBuffer, value.used
        )
      })
    }
    return operations
  }

  async _processInput(tx, index, block, utxoOperations) {
    let input = tx.inputs[index]
    let address = await getAddress(input, this._transaction, this._network)
    if (!address) {
      return []
    }
    let utxoKey = this._encoding.encodeUtxoIndexKey(address, input.prevTxId, input.outputIndex)
    let utxoKeyHexString = utxoKey.toString('hex')
    if (utxoOperations.has(utxoKeyHexString)) {
      let item = utxoOperations.get(utxoKeyHexString)
      item.value.used = true
    } else {
      let utxoValue = await this._db.get(utxoKey)
      let {height, satoshis, timestamp, scriptBuffer} = this._encoding.decodeUtxoIndexValue(utxoValue)
      utxoOperations.set(
        utxoKeyHexString,
        {
          key: utxoKey,
          value: {height, satoshis, timestamp, scriptBuffer, used: true}
        }
      )
    }
    return [{
      type: 'put',
      key: this._encoding.encodeAddressIndexKey(address, block.height, tx.hash, index, 1, block.header.time)
    }]
  }

  async _processOutput(tx, index, block, utxoOperations) {
    let output = tx.outputs[index]
    let address = await getAddress(output, this._transaction, this._network)
    if (!address) {
      return []
    }
    let utxoKey = this._encoding.encodeUtxoIndexKey(address, tx.hash, index)
    utxoOperations.set(
      utxoKey.toString('hex'),
      {
        key: utxoKey,
        value: {
          height: block.height,
          satoshis: output.satoshis,
          timestamp: block.header.time,
          scriptBuffer: output.script.toBuffer()
        }
      }
    )
    return [{
      type: 'put',
      key: this._encoding.encodeAddressIndexKey(address, block.height, tx.hash, index, 0, block.header.time)
    }]
  }
}

module.exports = AddressService
