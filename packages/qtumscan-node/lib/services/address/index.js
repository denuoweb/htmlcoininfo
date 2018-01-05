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

  async getAddressHistory(addresses, {from = 0, to = 0xffffffff, queryMempool = true} = {}) {
    if (typeof addresses === 'string') {
      addresses = [addresses]
    }
    let unique = new Map()
    await Promise.all(addresses.map(async address => {
      let list = await this._getAddressTxidHistory(address, {queryMempool})
      for (let txId of list) {
        unique.set(txId.txid, txId)
      }
    }))
    let txIdList = [...unique.values()].sort((a, b) => b.height - a.height)
    return {
      totalCount: txIdList.length,
      transactions: txIdList.slice(from, to).map(tx => tx.txid)
    }
  }

  async getAddressSummary(address, options = {}) {
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
    let stakingBalance = new BN(0)
    let txidMap = new Map()
    for (let utxo of utxos) {
      let value = new BN(utxo.satoshis)
      let inputItem
      if (txidMap.has(utxo.txid)) {
        inputItem = txidMap.get(utxo.txid)
        inputItem.received += utxo.satoshis
      } else {
        inputItem = {received: utxo.satoshis, sent: 0}
        txidMap.set(utxo.txid, inputItem)
      }
      if (utxo.outputTxid) {
        let outputItem
        if (txidMap.has(utxo.outputTxid)) {
          outputItem = txidMap.get(utxo.outputTxid)
          outputItem.sent += utxo.satoshis
        } else {
          outputItem = {received: 0, sent: utxo.satoshis}
          txidMap.set(utxo.outputTxid, outputItem)
        }
      } else {
        balance.iadd(value)
        if (utxo.confirmations === 0) {
          unconfirmedBalance.iadd(new BN(value))
        }
      }
      if (utxo.staking) {
        stakingBalance.iadd(new BN(value))
      }
    }
    for (let {received, sent} of txidMap.values()) {
      if (received > sent) {
        totalReceived.iadd(new BN(received - sent))
      } else {
        totalSent.iadd(new BN(sent - received))
      }
    }
    return {
      address,
      totalCount,
      transactions,
      balance: balance.toString(),
      totalReceived: totalReceived.toString(),
      totalSent: totalSent.toString(),
      unconfirmedBalance: unconfirmedBalance.toString(),
      stakingBalance: stakingBalance.toString()
    }
  }

  async getAddressUnspentOutputs(address, {queryMempool = true, listUsed = false} = {}) {
    let results = []
    let mempoolTxids = queryMempool ? await this._mempool.getTxidsByAddress(address, 'output') : []
    let mempoolOutputTxidMap = new Map()
    await Promise.all(mempoolTxids.map(async id => {
      let tx = await this._mempool.getMempoolTransaction(id.txid)
      assert(tx, 'Address Service: missing tx: ' + id.txid)
      results.push(...(await this._getMempoolUtxos(tx, address, mempoolOutputTxidMap)))
    }))
    for (let utxo of results) {
      utxo.outputTxid = utxo.outputTxid || mempoolOutputTxidMap.get(utxo.txid)
    }

    await new Promise((resolve, reject) => {
      let start = this._encoding.encodeUtxoIndexKey(address)
      let final = Buffer.from('f'.repeat(72), 'hex')
      let end = Buffer.concat([start.slice(0, -36), final])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', resolve)
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let key = this._encoding.decodeUtxoIndexKey(data.key)
        let value = this._encoding.decodeUtxoIndexValue(data.value)
        let outputTxid = mempoolOutputTxidMap.get(key.txid)
        if (!listUsed && outputTxid) {
          return
        }
        let confirmations = this._block.getTip().height - value.height + 1
        results.push({
          address,
          txid: key.txid,
          vout: key.outputIndex,
          timestamp: value.timestamp,
          staking: value.isStake && confirmations < 500,
          outputTxid,
          scriptPubKey: value.scriptBuffer.toString('hex'),
          height: value.height,
          satoshis: value.satoshis,
          confirmations
        })
      })
    })

    if (listUsed) {
      await new Promise((resolve, reject) => {
        let start = this._encoding.encodeUsedUtxoIndexKey(address)
        let final = Buffer.from('f'.repeat(72), 'hex')
        let end = Buffer.concat([start.slice(0, -36), final])
        let utxoStream = this._db.createReadStream({gte: start, lt: end})
        utxoStream.on('end', resolve)
        utxoStream.on('error', reject)
        utxoStream.on('data', data => {
          let key = this._encoding.decodeUsedUtxoIndexKey(data.key)
          let value = this._encoding.decodeUsedUtxoIndexValue(data.value)
          results.push({
            address,
            txid: key.txid,
            vout: key.outputIndex,
            timestamp: value.timestamp,
            staking: false,
            outputTxid: value.outputTxid,
            scriptPubKey: value.scriptBuffer.toString('hex'),
            height: value.height,
            satoshis: value.satoshis,
            confirmations: this._block.getTip().height - value.height + 1,
          })
        })
      })
    }

    return results.sort((x, y) => x.confirmations - y.confirmations)
  }

  async _getMempoolUtxos(tx, address, mempoolOutputTxidMap) {
    let results = []
    for (let i = 0; i < tx.outputs.length; ++i) {
      let output = tx.outputs[i]
      if (await getAddress(output, this._transaction, this._network) !== address) {
        continue
      }
      results.push({
        address,
        txid: tx.id,
        vout: i,
        staking: tx.outputs[0].script.chunks.length === 0,
        scriptPubKey: output.script.toBuffer().toString('hex'),
        height: null,
        satoshis: output.satoshis,
        confirmations: 0
      })
    }
    for (let input of tx.inputs) {
      if (await getAddress(input, this._transaction, this._network) === address) {
        mempoolOutputTxidMap.set(input.prevTxId.toString('hex'), tx.id)
      }
    }
    return results
  }

  get APIMethods() {
    return [
      ['getAddressHistory', this.getAddressHistory.bind(this), 2],
      ['getAddressSummary', this.getAddressSummary.bind(this), 1],
      ['getAddressUnspentOutputs', this.getAddressUnspentOutputs.bind(this), 1],
      ['snapshot', this.snapshot.bind(this), 2]
    ]
  }

  async start() {
    let prefix = await this._db.getPrefix(this.name)
    this._encoding = new Encoding(prefix)
  }

  _getTxidStream(address, {endHeight}) {
    let endHeightBuf = Buffer.alloc(4)
    endHeightBuf.writeUInt32BE(endHeight)
    let start = this._encoding.encodeAddressIndexKey(address)
    let end = Buffer.concat([
      start.slice(0, address.length + 4),
      endHeightBuf,
      Buffer.from('f'.repeat(82), 'hex')
    ])
    let txidStream = this._db.createKeyStream({gte: start, lte: end, reverse: true})
    txidStream.on('close', () => txidStream.unpipe())
    return txidStream
  }

  async _getAddressTxidHistory(address, {end = 0xffffffff, queryMempool = true} = {}) {
    let results = queryMempool ? await this._mempool.getTxidsByAddress(address, 'both') : []
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
      let txidStream = this._getTxidStream(address, {endHeight: end})
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
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.id, index, 1, block.header.time)
      },
      {
        type: 'put',
        key: this._encoding.encodeUtxoIndexKey(address, _tx.id, input.outputIndex),
        value: this._encoding.encodeUtxoIndexValue(
          _tx.__height,
          _tx.outputs[input.outputIndex].satoshis,
          _tx.__timestamp,
          _tx.outputs[0].script.chunks.length === 0,
          _tx.outputs[input.outputIndex].script.toBuffer()
        )
      },
      {
        type: 'del',
        key: this._encoding.encodeUsedUtxoIndexKey(address, _tx.id, input.outputIndex)
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
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.id, index, 0, block.header.time)
      },
      {
        type: 'del',
        key: this._encoding.encodeUtxoIndexKey(address, tx.id, index)
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
    let utxoMap = new Map()
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        operations.push(...(await this._processOutput(tx, i, block, utxoMap)))
      }
      for (let i = 0; i < tx.inputs.length; ++i) {
        operations.push(...(await this._processInput(tx, i, block, utxoMap)))
      }
    }
    return operations
  }

  async _processInput(tx, index, block, utxoMap) {
    let input = tx.inputs[index]
    let address = await getAddress(input, this._transaction, this._network)
    if (!address) {
      return []
    }
    let utxoKey = this._encoding.encodeUtxoIndexKey(address, input.prevTxId, input.outputIndex)
    let utxoKeyHexString = utxoKey.toString('hex')
    let utxoValue
    if (utxoMap.has(utxoKeyHexString)) {
      utxoValue = utxoMap.get(utxoKeyHexString)
      utxoMap.delete(utxoKeyHexString)
    } else {
      utxoValue = this._encoding.decodeUtxoIndexValue(await this._db.get(utxoKey))
    }
    return [
      {
        type: 'put',
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.id, index, 1, block.header.time)
      },
      {type: 'del', key: utxoKey},
      {
        type: 'put',
        key: this._encoding.encodeUsedUtxoIndexKey(address, input.prevTxId, input.outputIndex),
        value: this._encoding.encodeUsedUtxoIndexValue(
          utxoValue.height, utxoValue.satoshis, utxoValue.timestamp, utxoValue.isStake,
          tx.id, block.height, utxoValue.scriptBuffer
        )
      }
    ]
  }

  async _processOutput(tx, index, block, utxoMap) {
    let output = tx.outputs[index]
    let address = await getAddress(output, this._transaction, this._network)
    if (!address) {
      return []
    }
    let utxoKey = this._encoding.encodeUtxoIndexKey(address, tx.id, index)
    let utxoValue = {
      height: block.height,
      satoshis: output.satoshis,
      timestamp: block.header.time,
      isStake: tx.outputs[0].script.chunks.length === 0,
      scriptBuffer: output.script.toBuffer()
    }
    utxoMap.set(utxoKey.toString('hex'), utxoValue)
    return [
      {
        type: 'put',
        key: this._encoding.encodeAddressIndexKey(address, block.height, tx.id, index, 0, block.header.time)
      },
      {
        type: 'put',
        key: utxoKey,
        value: this._encoding.encodeUtxoIndexValue(
          utxoValue.height, utxoValue.satoshis, utxoValue.timestamp, utxoValue.isStake, utxoValue.scriptBuffer
        )
      }
    ]
  }

  async snapshot(height, minBalance = 0) {
    if (!height) {
      height = this._block.getTip().height + 1
    }
    let balanceMap = new Map()

    await new Promise((resolve, reject) => {
      let prefix = this._encoding.encodeUtxoIndexKey('Q'.repeat(34)).slice(0, 3)
      let start = Buffer.concat([prefix, Buffer.alloc(70)])
      let end = Buffer.concat([prefix, Buffer.alloc(70, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', resolve)
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let key = this._encoding.decodeUtxoIndexKey(data.key)
        let value = this._encoding.decodeUtxoIndexValue(data.value)
        if (value.height <= height) {
          let balance = balanceMap.get(key.address) || 0
          balance += value.satoshis
          balanceMap.set(key.address, balance)
        }
      })
    })

    await new Promise((resolve, reject) => {
      let prefix = this._encoding.encodeUsedUtxoIndexKey('Q'.repeat(34)).slice(0, 3)
      let start = Buffer.concat([prefix, Buffer.alloc(70)])
      let end = Buffer.concat([prefix, Buffer.alloc(70, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', resolve)
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let key = this._encoding.decodeUsedUtxoIndexKey(data.key)
        let value = this._encoding.decodeUsedUtxoIndexValue(data.value)
        if (value.height <= height && value.spentHeight > height) {
          let balance = balanceMap.get(key.address) || 0
          balance += value.satoshis
          balanceMap.set(key.aaddress, balance)
        }
      })
    })

    let results = []
    for (let [address, balance] of balanceMap.entries()) {
      if (balance >= minBalance) {
        results.push([address, balance])
      }
    }
    return results.sort((x, y) => y[1] - x[1])
  }
}

module.exports = AddressService
