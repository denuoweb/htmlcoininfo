const Transaction = require('qtuminfo-node/lib/models/transaction')
const {toRawTransaction, toRawScript} = require('qtuminfo-node/lib/utils')
const {ErrorResponse} = require('../components/utils')

class TransactionController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
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
    } else if (ctx.transactions) {
      ctx.body = ctx.transactions
    }
  }

  async transaction(ctx, next) {
    let txid = ctx.params.txid
    try {
      let tx = await Transaction.findOne({$or: [{id: txid}, {hash: txid}]})
      let transaction = await this.node.getTransaction(tx.id)
      if (transaction) {
        ctx.transaction = await this.transformTransaction(transaction)
        await next()
      } else {
        ctx.throw(404)
      }
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async transactions(ctx, next) {
    let txids = ctx.params.txids.split(',')
    let list = []
    try {
      for (let txid of txids) {
        let transaction = await this.node.getTransaction(txid)
        if (transaction) {
          list.push(transaction)
        } else {
          ctx.throw(404)
        }
      }
      ctx.transactions = await Promise.all(list.map(this.transformTransaction.bind(this)))
      await next()
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async transformTransaction(transaction, options = {}) {
    let confirmations = 'block' in transaction ? this.node.getBlockTip().height - transaction.block.height + 1 : 0
    let transformed = {
      id: transaction.id,
      hash: transaction.hash,
      version: transaction.version,
      lockTime: transaction.nLockTime,
      blockHash: transaction.block && transaction.block.hash,
      blockHeight: transaction.block && transaction.block.height,
      confirmations,
      timestamp: transaction.block && transaction.block.timestamp,
      isCoinbase: transaction.isCoinbase,
      valueOut: transaction.outputSatoshis,
      size: transaction.size,
      weight: transaction.weight,
      receipts: transaction.receipts,
      tokenTransfers: []
    }

    if (transaction.isCoinbase) {
      transformed.vin = [{
        coinbase: toRawScript(transaction.inputs[0].script).toBuffer().toString('hex'),
        sequence: transaction.inputs[0].sequence,
        n: 0
      }]
    } else {
      transformed.vin = transaction.inputs.map((input, index) => {
        let rawScript = toRawScript(input.script)
        return {
          txid: input.prevTxId,
          vout: input.outputIndex,
          sequence: input.sequence,
          n: index,
          value: input.satoshis,
          address: input.address,
          scriptSig: {
            hex: rawScript.toBuffer().toString('hex'),
            asm: rawScript.toString()
          }
        }
      })
      transformed.valueIn = transaction.inputSatoshis
      transformed.fees = transaction.feeSatoshis
    }
    transformed.vout = transaction.outputs.map((output, index) => {
      let rawScript = toRawScript(output.script)
      let address = rawScript.toAddress(this._network)
      let type
      if (address) {
        type = address.type
      } else if (rawScript.isDataOut()) {
        type = 'nulldata'
      } else if (rawScript.isContractCreate()) {
        type = 'create'
      } else if (rawScript.isContractCall()) {
        type = 'call'
      } else if (rawScript.chunks.length === 0) {
        type = 'nonstandard'
      }
      return {
        value: output.satoshis,
        n: index,
        address: output.address,
        scriptPubKey: {
          type,
          hex: rawScript.toBuffer().toString('hex'),
          asm: rawScript.toString()
        }
      }
    })
    transformed.tokenTransfers = await this.node.getTokenTransfers(transaction)
    return transformed
  }

  async rawTransaction(ctx, next) {
    let txid = ctx.params.txid

    try {
      let transaction = await this.node.getTransaction(txid)
      if (!transaction) {
        ctx.throw(404)
      }
      ctx.rawTransaction = {rawtx: toRawTransaction(transaction).toBuffer().toString('hex')}
      await next()
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
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
        let block = await this.node.getBlockOverview(blockHash)
        if (!block) {
          ctx.throw(404)
        }
        let totalTxs = block.txids.length
        let start = page * pageLength
        let txids = block.txids.slice(start, start + pageLength)
        let pagesTotal = Math.ceil(totalTxs / pageLength)

        let transactions = []
        for (let txid of txids) {
          let transaction = await this.node.getTransaction(txid)
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
        let result = await this.node.getAddressHistory(address, options)
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
      let txid = await this.node.sendTransaction(rawtx)
      ctx.body = {txid}
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }
}

module.exports = TransactionController
