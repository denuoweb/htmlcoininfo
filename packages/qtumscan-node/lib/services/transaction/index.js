const assert = require('assert')
const LRU = require('lru-cache')
const qtumscan = require('qtumscan-lib')
const BaseService = require('../../service')
const Block = require('../../models/block')
const Transaction = require('../../models/transaction')
const Utxo = require('../../models/utxo')

class TransactionService extends BaseService {
  constructor(options) {
    super(options)
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._header = this.node.services.get('header')
    this._network = this.node.network
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
    this._tip = null
    this._cacheTx = LRU(1000)
  }

  static get dependencies() {
    return ['block', 'db', 'header']
  }

  get APIMethods() {
    return [
      ['getTransaction', this.getTransaction.bind(this), 1],
      ['setTxMetaInfo', this.setTxMetaInfo.bind(this), 2]
    ]
  }

  async getTransaction(txid, options) {
    let cacheTx = this._cacheTx.get(txid)
    if (cacheTx) {
      return cacheTx
    }
    let tx = await this._getTransaction(txid)
    if (tx) {
      await this.setTxMetaInfo(tx, options)
      this._cacheTx.set(txid, tx)
      return tx
    }
  }

  async toRawTransaction(transaction) {
    let inputs = await Promise.all(transaction.inputs.map(async input => {
      let utxo = await Utxo.findById(input)
      return {
        prevTxId: utxo.output.transactionId,
        outputIndex: utxo.output.index,
        sequenceNumber: utxo.input.sequence,
        script: utxo.toRawScript(utxo.input.script)
      }
    }))
    let outputs = await Promise.all(transaction.outputs.map(async output => {
      let utxo = await Utxo.findById(output)
      return {
        satoshis: utxo.satoshis,
        script: utxo.toRawScript(utxo.output.script)
      }
    }))
    return new qtumscan.Transaction({
      version: transaction.version,
      dummy: transaction.dummy,
      flags: transaction.flags,
      inputs,
      outputs,
      witnessStack: transaction.witnessStack.map(
        witness => witness.map(item => Buffer.from(item, 'hex'))
      ),
      nLockTime: transaction.nLockTime
    })
  }

  toRawScript(script) {
    return new qtumscan.Script({
      chunks: script.map(chunk => ({
        buf: chunk.buffer && Buffer.from(chunk.buffer, 'hex'),
        opcodenum: chunk.opcode
      }))
    })
  }

  async setTxMetaInfo(tx, options) {
    tx.outputSatoshis = 0
    for (let output of tx.outputs) {
      tx.outputSatoshis += output.satoshis
    }
    if (tx.inputs.length === 1) {
      let utxo = await Utxo.findById(tx.inputs[0]._id)
      if (utxo.output.transactionId === '0'.repeat(64) && utxo.output.index === 0xffffffff) {
        tx.isCoinbase = true
        return
      }
    }
    tx.inputSatoshis = 0
    for (let input of tx.inputs) {
      tx.inputSatoshis += input.satoshis
    }
    tx.feeSatoshis = tx.inputSatoshis - tx.outputSatoshis
  }

  async _getTransaction(txid) {
    let list = await Transaction.aggregate(
      {$match: {id: txid}},
      {$unwind: '$inputs'},
      {
        $lookup: {
          from: 'utxos',
          localField: 'inputs',
          foreignField: '_id',
          as: 'input'
        }
      },
      {
        $group: {
          _id: '$_id',
          id: {$first: '$id'},
          hash: {$first: '$hash'},
          version: {$first: '$version'},
          dummy: {$first: '$dummy'},
          flags: {$first: '$flags'},
          inputs: {
            $push: {
              _id: {$arrayElemAt: ['$input._id', 0]},
              prevTxId: {$arrayElemAt: ['$input.output.transactionId', 0]},
              outputIndex: {$arrayElemAt: ['$input.output.index', 0]},
              script: {
                $map: {
                  input: {$arrayElemAt: ['$input.input.script', 0]},
                  as: 'chunk',
                  in: {
                    opcode: '$$chunk.opcode',
                    buffer: '$$chunk.buffer'
                  }
                }
              },
              sequence: {$arrayElemAt: ['$input.input.sequence', 0]},
              satoshis: {$arrayElemAt: ['$input.satoshis', 0]},
              address: {$arrayElemAt: ['$input.address', 0]}
            }
          },
          outputs: {$first: '$outputs'},
          witnessStack: {$first: '$witnessStack'},
          nLockTime: {$first: '$nLockTime'},
          block: {$first: '$block'},
          isStake: {$first: '$isStake'},
          receipts: {$first: '$receipts'}
        }
      },
      {$unwind: '$outputs'},
      {
        $lookup: {
          from: 'utxos',
          localField: 'outputs',
          foreignField: '_id',
          as: 'output'
        }
      },
      {
        $group: {
          _id: '$_id',
          id: {$first: '$id'},
          hash: {$first: '$hash'},
          version: {$first: '$version'},
          dummy: {$first: '$dummy'},
          flags: {$first: '$flags'},
          inputs: {$first: '$inputs'},
          outputs: {
            $push: {
              _id: {$arrayElemAt: ['$output._id', 0]},
              satoshis: {$arrayElemAt: ['$output.satoshis', 0]},
              script: {
                $map: {
                  input: {$arrayElemAt: ['$output.output.script', 0]},
                  as: 'chunk',
                  in: {
                    opcode: '$$chunk.opcode',
                    buffer: '$$chunk.buffer'
                  }
                }
              },
              address: {$arrayElemAt: ['$output.address', 0]}
            }
          },
          witnessStack: {$first: '$witnessStack'},
          nLockTime: {$first: '$nLockTime'},
          block: {$first: '$block'},
          isStake: {$first: '$isStake'},
          receipts: {$first: '$receipts'}
        }
      },
      {
        $lookup: {
          from: 'blocks',
          localField: 'block.hash',
          foreignField: 'hash',
          as: 'block'
        }
      },
      {$addFields: {block: {$arrayElemAt: ['$block', 0]}}}
    )
    return list[0]
  }

  async start() {
    this._tip = await this._db.getServiceTip(this.name)
    let blockTip = this._block.getTip()
    if (this._tip.height > blockTip.height) {
      this._tip = blockTip
      await this._db.updateServiceTip(this._tip)
    }
    await Transaction.deleteMany({'block.height': {$gt: blockTip.height}})
    await Utxo.deleteMany({createHeight: {$gt: blockTip.height}})
    await Utxo.updateMany(
      {useHeight: {$gt: blockTip.height}},
      {
        'input.transactionId': '0'.repeat(64),
        'input.index': null,
        'input.script': [],
        'input.sequence': null,
        useHeight: null
      }
    )
  }

  async onBlock(block) {
    if (this.node.stopping) {
      return
    }
    for (let tx of block.transactions) {
      await this._processTransaction(tx, block)
    }
    this._tip.height = block.height
    this._tip.hash = block.hash
    await this._db.updateServiceTip(this.name, this._tip)
  }

  async _processTransaction(tx, block) {
    let inputs = []
    for (let index = 0; index < tx.inputs.length; ++index) {
      let input = tx.inputs[index]
      let utxo
      if (Buffer.compare(input.prevTxId, Buffer.alloc(32)) === 0) {
        utxo = new Utxo({
          input: {
            transactionId: tx.id,
            index,
            script: Utxo.transformScript(input.script),
            sequence: input.sequenceNumber
          },
          createHeight: block.height,
          useHeight: block.height
        })
      } else {
        utxo = await Utxo.findOne({
          'output.transactionId': input.prevTxId.toString('hex'),
          'output.index': input.outputIndex
        })
        utxo.input.transactionId = tx.id
        utxo.input.index = index
        utxo.input.script = Utxo.transformScript(input.script)
        utxo.input.sequence = input.sequenceNumber
        utxo.useHeight = block.height
      }
      await utxo.save()
      inputs.push(utxo._id)
    }

    let outputs = []
    for (let index = 0; index < tx.outputs.length; ++index) {
      let output = tx.outputs[index]
      let utxo = await Utxo.findOne({'output.transactionId': tx.id, 'output.index': index})
      if (utxo) {
        utxo.createHeight = block.height
      } else {
        utxo = new Utxo({
          satoshis: output.satoshis,
          output: {
            transactionId: tx.id,
            index,
            script: Utxo.transformScript(output.script)
          },
          address: Utxo.getAddress(tx, index),
          createHeight: block.height
        })
      }
      await utxo.save()
      outputs.push(utxo._id)
    }

    let transaction = await Transaction.findOne({id: tx.id})
    if (transaction) {
      transaction.block.hash = block.hash
      transaction.block.height = block.height
    } else {
      transaction = new Transaction({
        id: tx.id,
        hash: tx.hash,
        version: tx.version,
        dummy: tx.dummy,
        flags: tx.flags,
        inputs,
        outputs,
        witnessStack: tx.witnessStack.map(witness => witness.map(item => item.toString('hex'))),
        nLockTime: tx.nLockTime,
        block: {
          hash: block.hash,
          height: block.height,
        },
        isStake: tx.outputs[0].script.chunks.length === 0
      })
    }
    await transaction.save()
  }
}

module.exports = TransactionService
