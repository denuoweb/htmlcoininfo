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
    if (!'queryMempool' in options) {
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
      txs: txIdList.slice(options.from, options.to)
    }
  }

  async getAddressSummary(address, options = {}) {
    options.from = options.from || 0
    options.to = options.to || 0xffffffff
    if (!'queryMempool' in options) {
      options.queryMempool = true
    }
    let results = await this.getAddressHistory(address, options)
    return Object.assign({address}, await this._getAddressSummaryResult(results, address, options))
  }

  async _getAddressSummaryResult({txs, totalCount}, address, {noTxList}) {
    let result = {totalCount}
    let balanceBuffer = await this._db.get(this._encoding.encodeAddressBalanceKey(address))
    if (balanceBuffer) {
      let balance = this._encoding.decodeAddressBalanceValue(balanceBuffer)
      result.balance = balance.balance.toString()
      result.totalReceived = balance.totalReceived.toString()
      result.totalSent = balance.totalSent.toString()
      result.unconfirmedBalance = balance.unconfirmedBalance.toString()
      result.txAppearances = balance.txAppearances
      result.unconfirmedTxAppearances = balance.unconfirmedTxAppearances
    } else {
      result.balance = '0'
      result.totalReceived = '0'
      result.totalSent = '0'
      result.unconfirmedBalance = '0'
      result.txAppearances = 0
      result.unconfirmedTxAppearances = 0
    }
    if (!noTxList) {
      result.transactions = txs.map(tx => tx.txid)
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
      results.push(...(await this._getMempoolUtxos(tx, address)))
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
          scriptPubKey: value.scriptBuffer.toString('hex'),
          height: value.height,
          satoshis: value.satoshis,
          confirmations: this._block.getTip().height - value.height + 1
        })
      })
    })
  }

  async _getMempoolUtxos(tx, address) {
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
          operations.push(...(await this._removeOutput(tx.outputs[i], tx, block, i)))
        }
      }
    ])
    return operations
  }

  async _removeInput(input, tx, block, index) {
    let address = await getAddress(input, this._transaction, this._network)
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

  async _removeOutput(output, tx, block, index) {
    let address = await getAddress(output, this._transaction, this._network)
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

  async onReorg([_, oldBlockList]) {
    let differences = new Map()
    let operations = []
    for (let block of oldBlockList) {
      operations.push(...(await this._removeBlock(block)))
      for (let tx of block.transactions) {
        await this._transaction.setTxMetaInfo(tx)
        for (let i = 0; i < tx.outputs.length; ++i) {
          await this._processOutput(tx, tx.outputs[i], i, block, differences)
        }
        for (let i = 0; i < tx.inputs.length; ++i) {
          await this._processInput(tx, tx.inputs[i], i, block, differences)
        }
      }
    }
    for (let [address, diff] of differences.entries()) {
      let addressKey = this._encoding.encodeAddressBalanceKey(address)
      let balanceValue = await this._db.get(addressKey)
      let balance
      if (balanceValue) {
        balance = this._encoding.decodeAddressBalanceValue(balanceValue)
        balance.balance.isub(diff.balance)
        balance.totalReceived.isub(diff.totalReceived)
        balance.totalSent.isub(diff.totalSent)
        balance.txAppearances -= diff.txAppearances
      } else {
        balance = diff
      }
      operations.push({
        type: 'put',
        key: addressKey,
        value: this._encoding.encodeAddressBalanceValue(balance)
      })
    }
    return operations
  }

  async onBlock(block) {
    if (this.node.stopping) {
      return
    }
    let differences = new Map()
    let operations = []
    for (let tx of block.transactions) {
      await this._transaction.setTxMetaInfo(tx)
      for (let i = 0; i < tx.outputs.length; ++i) {
        operations.push(...(await this._processOutput(tx, tx.outputs[i], i, block, differences)))
      }
      for (let i = 0; i < tx.inputs.length; ++i) {
        operations.push(...(await this._processInput(tx, tx.inputs[i], i, block, differences)))
      }
    }
    for (let [address, diff] of differences.entries()) {
      let addressKey = this._encoding.encodeAddressBalanceKey(address)
      let balanceValue = await this._db.get(addressKey)
      let balance
      if (balanceValue) {
        balance = this._encoding.decodeAddressBalanceValue(balanceValue)
        balance.balance.iadd(diff.balance)
        balance.totalReceived.iadd(diff.totalReceived)
        balance.totalSent.iadd(diff.totalSent)
        balance.unconfirmedBalance = diff.unconfirmedBalance
        balance.txAppearances += diff.txAppearances
        balance.unconfirmedTxAppearances = diff.unconfirmedTxAppearances
      } else {
        balance = diff
      }
      operations.push({
        type: 'put',
        key: addressKey,
        value: this._encoding.encodeAddressBalanceValue(balance)
      })
    }
    return operations
  }

  async _processInput(tx, input, index, block, differences) {
    let address = await getAddress(input, this._transaction, this._network)
    if (!address) {
      return []
    }
    let diff = differences.get(address)
    if (!diff) {
      diff = {
        balance: new BN(0),
        totalReceived: new BN(0),
        totalSent: new BN(0),
        unconfirmedBalance: new BN(0),
        txAppearances: 0,
        unconfirmedTxAppearances: 0
      }
      differences.set(address, diff)
    }
    let value = tx.__inputValues[index]
    diff.balance.isub(new BN(value))
    diff.totalSent.iadd(new BN(value))
    diff.unconfirmedBalance.iadd(new BN(value))
    ++diff.txAppearances
    ++diff.unconfirmedTxAppearances
    let timestamp = this._timestamp.getTimestampSync(block.hash)
    assert(timestamp, 'Must have a timestamp in order to process input.')
    return [
      {
        type: 'put',
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.hash, index, 1, timestamp)
      },
      {
        type: 'del',
        key: this._encoding.encodeUtxoIndexKey(address, input.prevTxId, input.outputIndex)
      }
    ]
  }

  async _processOutput(tx, output, index, block, differences) {
    let address = await getAddress(output, this._transaction, this._network)
    if (!address) {
      return []
    }
    let diff = differences.get(address)
    if (!diff) {
      diff = {
        balance: new BN(0),
        totalReceived: new BN(0),
        totalSent: new BN(0),
        unconfirmedBalance: new BN(0),
        txAppearances: 0,
        unconfirmedTxAppearances: 0
      }
      differences.set(address, diff)
    }
    diff.balance.iadd(new BN(output.satoshis))
    diff.totalReceived.iadd(new BN(output.satoshis))
    diff.unconfirmedBalance.iadd(new BN(output.satoshis))
    ++diff.txAppearances
    ++diff.unconfirmedTxAppearances
    let timestamp = this._timestamp.getTimestampSync(block.hash)
    assert(timestamp, 'Must have a timestamp in order to process output.')
    return [
      {
        type: 'put',
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.hash, index, 0, timestamp)
      },
      {
        type: 'put',
        key: this._encoding.encodeUtxoIndexKey(address, tx.hash, index),
        value: this._encoding.encodeUtxoIndexValue(
          block.height, output.satoshis, timestamp, output.script.toBuffer()
        )
      }
    ]
  }
}

module.exports = AddressService
