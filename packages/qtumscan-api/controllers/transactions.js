const qtumscan = require('qtumscan-lib')
const {ErrorResponse} = require('../components/utils')
const BufferUtil = qtumscan.util.buffer
const {sha256ripemd160} = qtumscan.crypto.Hash

class TransactionController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._block = this.node.services.get('block')
    this._transaction = this.node.services.get('transaction')
    this._address = this.node.services.get('address')
    this._p2p = this.node.services.get('p2p')
    this._network = this.node.network
    if (this.node.network === 'livenet') {
      this._network = 'mainnet'
    } else if (this.node.network === 'regtest') {
      this._network = 'testnet'
    }
  }

  async show(ctx) {
    if (ctx.transaction) {
      ctx.body = ctx.transaction
    }
  }

  async transaction(ctx, next) {
    let txid = ctx.params.txid

    try {
      let transaction = await this._transaction.getDetailedTransaction(txid)
      if (!transaction) {
        ctx.throw(404)
      }
      ctx.transaction = await this.transformTransaction(transaction)
      await next()
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async transformTransaction(transaction, options = {}) {
    let confirmations = 0
    if (transaction.__height >= 0) {
      confirmations = this._block.getTip().height - transaction.__height + 1
    }

    let transformed = {
      txid: transaction.id,
      hash: transaction.hash,
      version: transaction.version,
      lockTime: transaction.locktime,
      blockHash: transaction.blockHash,
      blockHeight: transaction.__height,
      confirmations,
      time: transaction.__timestamp || Math.floor(Date.now() / 1000),
      isCoinbase: transaction.isCoinbase(),
      valueOut: transaction.outputSatoshis,
      size: transaction.toBuffer().length
    }

    if (transaction.isCoinbase()) {
      transformed.vin = [{
        coinbase: transaction.inputs[0].script.toBuffer().toString('hex'),
        sequence: transaction.inputs[0].sequence,
        n: 0
      }]
    } else {
      options.inputValues = transaction.__inputValues
      transformed.vin = await Promise.all(transaction.inputs.map(
        this.transformInput.bind(this, options)
      ))
      transformed.valueIn = transaction.inputSatoshis
      transformed.fees = transaction.feeSatoshis
    }
    transformed.vout = await Promise.all(transaction.outputs.map(
      this.transformOutput.bind(this, transaction, options)
    ))

    if (transformed.confirmations) {
      transformed.blockTime = transformed.time
    }

    return transformed
  }

  async _getAddress(item, network) {
    if (item.script.isPublicKeyIn()) {
      let prevTransaction = await this._transaction.getTransaction(item.prevTxId)
      return prevTransaction.outputs[item.outputIndex].script.toAddress()
    } else {
      return item.script.toAddress(network)
    }
  }

  async transformInput({noscriptSig, noAsm, inputValues}, input, index) {
    let transformed = {
      txid: input.prevTxId.toString('hex'),
      vout: input.outputIndex,
      sequence: input.sequence,
      n: index,
      value: inputValues[index],
      doubleSpentTxId: null,
      isConfirmed: null,
      confirmations: null,
      unconfirmedInput: null
    }

    if (!noscriptSig) {
      transformed.noscriptSig = {hex: input.script.toBuffer().toString('hex')}
      if (!noAsm) {
        transformed.noscriptSig.asm = input.script.toString()
      }
    }

    let address = await this._getAddress(input, this._network)
    if (address) {
      transformed.address = address.toString()
    }
    return transformed
  }

  async transformOutput(transaction, {noAsm, noSpent}, output, index) {
    let transformed = {
      value: output.satoshis,
      n: index,
      scriptPubKey: {hex: output.script.toBuffer().toString('hex')}
    }

    if (!noAsm) {
      transformed.scriptPubKey.asm = output.script.toString()
    }

    if (!noSpent) {
      transformed.spentTxId = output.spentTxId || null
      transformed.spentIndex = 'spentIndex' in output ? output.spentIndex : null
      transformed.spentHeight = output.spentHeight || null
    }

    let address = await this._getAddress(output, this._network)
    if (address) {
      transformed.address = address.toString()
      transformed.scriptPubKey.type = address.type
    } else if (output.script.isDataOut()) {
      transformed.scriptPubKey.type = 'nulldata'
    } else if (output.script.isContractCreate()) {
      let indexBuffer = Buffer.alloc(4)
      indexBuffer.writeUInt32LE(index)
      transformed.address = sha256ripemd160(Buffer.concat([
        BufferUtil.reverse(Buffer.from(transaction.hash, 'hex')),
        indexBuffer
      ])).toString('hex')
      transformed.scriptPubKey.type = 'create'
    } else if (output.script.isContractCall()) {
      transformed.address = output.script.chunks[4].buf.toString('hex')
      transformed.scriptPubKey.type = 'call'
    } else if (output.script.chunks.length === 0) {
      transformed.scriptPubKey.type = 'nonstandard'
    }

    return transformed
  }

  transformInvTransaction(transaction) {
    let valueOut = 0
    let vout = []

    for (let output of transaction.outputs) {
      valueOut += output.satoshis
      if (output.script) {
        let address = getAddress(output, this._network)
        if (address) {
          vout.push({[address]: output.satoshis})
        }
      }
    }

    let isRBF = false
    for (let input of transaction.inputs) {
      if (input.sequenceNumber < 0xfffffffe) {
        isRBF = true
        break
      }
    }

    return {
      txid: transaction.id,
      valueOut,
      vout,
      isRBF,
    }
  }

  async rawTransaction(ctx, next) {
    let txid = ctx.params.txid

    try {
      let transaction = await this._transaction.getTransaction(txid)
      ctx.rawTransaction = {rawtx: transaction.toBuffer().toString('hex')}
      await next()
    } catch (err) {
      if (err.code === -5) {
        ctx.throw(404)
      } else {
        this.errorResponse.handleErrors(ctx, err)
      }
    }
  }

  async showRaw(ctx) {
    if (ctx.rawTransaction) {
      ctx.body = ctx.rawTransaction
    }
  }

  async list(ctx) {
    let blockHash = ctx.query.block
    let address = ctx.query.address
    let page = Number.parseInt(ctx.query.pageNum) || 0
    let pageLength = Number.parseInt(ctx.query.pageLength) || 10

    if (blockHash) {
      try {
        let block = await this._block.getBlockOverview(blockHash)
        if (!block) {
          ctx.throw(404)
        }
        let totalTxs = block.txids.length
        let start = page * pageLength
        let txids = block.txids.slice(start, start + pageLength)
        let pagesTotal = Math.ceil(totalTxs / pageLength)

        let transactions = []
        for (let txid of txids) {
          let transaction = await this.transactionService.getDetailedTransaction(txid)
          transactions.push(await this.transformTransaction(transaction))
        }

        ctx.body = {pagesTotal, transactions}
      } catch (err) {
        this.errorResponse.handleErrors(ctx, err)
      }
    } else if (address) {
      let options = {
        from: page * pageLength,
        to: (page + 1) * pageLength
      }

      try {
        let result = await this._address.getAddressHistory(address, options)
        let transactions = await result.items.map(tx => this.transformTransaction(tx))
        ctx.body = {
          pageTotal: Math.ceil(result.totalCount / pageLength),
          transactions
        }
      } catch (err) {
        this.errorResponse.handleErrors(ctx, err)
      }
    } else {
      this.errorResponse.handleErrors(ctx, new Error('Block hash or address expected'))
    }
  }

  async send(ctx) {
    let {rawtx} = ctx.request.body
    try {
      let txid = await this._p2p.sendTransaction(rawtx)
      ctx.body = {txid}
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }
}

module.exports = TransactionController
