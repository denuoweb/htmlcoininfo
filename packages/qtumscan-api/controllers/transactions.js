const qtumcore = require('qtumscan-lib')
const {ErrorResponse} = require('../components/utils')

function getAddress(item, network) {
  let address = item.script.toAddress(network)
  if (address) {
    address.network = network
    return address
  }
}

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
      ctx.transaction = this.transformTransaction(transaction)
      await next()
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  transformTransaction(transaction, options = {}) {
    let confirmations = 0
    if (transaction.__height >= 0) {
      confirmations = this._block.getTip().height - transaction.__height + 1
    }

    let transformed = {
      txid: transaction.hash,
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
      transformed.vin = transaction.inputs.map(this.transformInput.bind(this, options))
      transformed.valueIn = transaction.inputSatoshis
      transformed.fees = transaction.feeSatoshis
    }
    transformed.vout = transaction.outputs.map(this.transformOutput.bind(this, options))

    if (transformed.confirmations) {
      transformed.blockTime = transformed.time
    }

    return transformed
  }

  transformInput({noscriptSig, noAsm, inputValues}, input, index) {
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

    let address = getAddress(input, this._network)
    if (address) {
      transformed.address = address.toString()
    }
    return transformed
  }

  transformOutput({noAsm, noSpent}, output, index) {
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

    let address = getAddress(output, this._network)
    if (address) {
      transformed.scriptPubKey.addresses = [address.toString()]
      transformed.scriptPubKey.type = address.type
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
      txid: transaction.hash,
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
    let pageLength = 10

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

        let txs = []
        for (let txid of txids) {
          let transaction = await this.transactionService.getDetailedTransaction(txid)
          txs.push(this.transformTransaction(transaction))
        }

        ctx.body = {pagesTotal, txs}
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
        let txs = result.items.map(tx => this.transformTransaction(tx))
        ctx.body = {
          pageTotal: Math.ceil(result.totalCount / pageLength),
          txs
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
