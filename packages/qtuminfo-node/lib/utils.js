const assert = require('assert')
const BN = require('bn.js')
const mongoose = require('mongoose')
const qtuminfo = require('qtuminfo-lib')
const Block = require('./models/block')
const Transaction = require('./models/transaction')
const Utxo = require('./models/utxo')

exports.parseParamsWithJSON = function(paramsArg) {
  return paramsArg.map(paramArg => {
    try {
      return JSON.parse(paramArg)
    } catch (err) {
      return paramArg
    }
  })
}

exports.fromCompact = function(compact) {
  if (compact === 0) {
    return new BN(0)
  }
  let exponent = compact >>> 24
  let negative = (compact >>> 23) & 1
  let mantissa = compact & 0x7fffff
  let num
  if (exponent <= 3) {
    mantissa >>>= 8 * (3 - exponent)
    num = new BN(mantissa)
  } else {
    num = new BN(mantissa)
    num.iushln(8 * (exponent - 3))
  }
  if (negative) {
    num.ineg()
  }
  return num
}

exports.getTarget = function(bits) {
  let target = fromCompact(bits)
  assert(!target.isNeg(), 'Target is negative.')
  assert(!target.isZero(), 'Target is zero.')
  return target.toArrayLike(Buffer, 'le', 32);
}

exports.double256 = function(target) {
  assert(target.length === 32)
  let hi = target.readUInt32LE(28, true)
  let lo = target.readUInt32LE(24, true)
  let n = (hi * 2 ** 32 + lo) * 2 ** 192
  hi = target.readUInt32LE(20, true)
  lo = target.readUInt32LE(16, true)
  n += (hi * 2 ** 32 + lo) * 2 ** 128
  hi = target.readUInt32LE(12, true)
  lo = target.readUInt32LE(8, true)
  n += (hi * 2 ** 32 + lo) * 2 ** 64
  hi = target.readUInt32LE(4, true)
  lo = target.readUInt32LE(0, true)
  return n + hi * 2 ** 32 + lo
}

exports.getDifficulty = function(target) {
  let d = 2 ** 224 - 2 ** 208
  let n = double256(target)
  return n === 0 ? d : Math.floor(d / n)
}

exports.revHex = function(data) {
  let buffer = []
  for (let i = 0; i < data.length; i += 2) {
    buffer.push(data.slice(i, i + 2))
  }
  return buffer.reverse().join('')
}

exports.convertSecondsToHumanReadable = function(seconds) {
  assert(Number.isInteger(seconds))
  let result = ''
  let minutes
  if (seconds >= 60) {
    minutes = Math.floor(seconds / 60)
    seconds %= 60
  }
  if (minutes) {
    result = minutes + ' minute(s) '
  }
  if (seconds) {
    result += seconds + ' second(s)'
  }
  return result
}

class AsyncQueue {
  constructor(fn) {
    this._fn = fn
    this._waiting = []
    this._running = false
  }

  get length() {
    return this._waiting.length
  }

  get running() {
    return this._running
  }

  push(data, callback) {
    this._waiting.push({data, callback})
    if (!this._running) {
      this._process()
    }
  }

  _process() {
    this._running = true
    let {data, callback} = this._waiting.pop()
    this._fn(data).then(data => {
      callback(null, data)
      if (this._waiting.length) {
        this._process()
      } else {
        this._running = false
      }
    }, callback)
  }
}
exports.AsyncQueue = AsyncQueue

const PROGRESSBAR_STATES = '|/-\\'
class IndeterminateProgressBar {
  constructor() {
    let states = ['|', '/', '-', '\\']
    this.state = 0
  }
  tick() {
    process.stdout.clearLine()
    process.stdout.cursorTo(0)
    process.stdout.write(PROGRESSBAR_STATES[this.state++ % PROGRESSBAR_STATES.length])
  }
}
exports.IndeterminateProgressBar = IndeterminateProgressBar

async function toRawBlock(block) {
  let list = await Transaction.find({id: {$in: block.transactions}})
  let map = new Map(list.map(tx => [tx.id, tx]))
  let transactions = await Promise.all(block.transactions.map(
    async id => toRawTransaction(map.get(id), true)
  ))
  return new qtuminfo.Block({
    header: {
      hash: block.hash,
      version: block.version,
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      timestamp: block.timestamp,
      bits: block.bits,
      nonce: block.nonce,
      hashStateRoot: block.hashStateRoot,
      hashUTXORoot: block.hashUTXORoot,
      prevOutStakeHash: block.prevOutStakeHash,
      prevOutStakeN: block.prevOutStakeN,
      vchBlockSig: block.vchBlockSig
    },
    transactions
  })
}
exports.toRawBlock = toRawBlock

async function toRawTransaction(transaction, raw) {
  let inputs, outputs
  if (raw) {
    let inputList = await Utxo.find({_id: {$in: transaction.inputs}})
    let inputMap = {}
    for (let utxo of inputList) {
      inputMap[utxo._id] = utxo
    }
    inputs = transaction.inputs.map(_id => {
      let utxo = inputMap[_id]
      return {
        prevTxId: utxo.output.transactionId,
        outputIndex: utxo.output.index,
        sequenceNumber: utxo.input.sequence,
        script: toRawScript(utxo.input.script)
      }
    })
    let outputList = await Utxo.find({_id: {$in: transaction.outputs}})
    let outputMap = {}
    for (let utxo of outputList) {
      outputMap[utxo._id] = utxo
    }
    outputs = transaction.outputs.map(_id => {
      let utxo = outputMap[_id]
      return {
        satoshis: utxo.satoshis,
        script: toRawScript(utxo.output.script)
      }
    })
  } else {
    inputs = transaction.inputs.map(input => ({
      prevTxId: input.prevTxId,
      outputIndex: input.outputIndex,
      sequenceNumber: input.sequence,
      script: toRawScript(input.script)
    }))
    outputs = transaction.outputs.map(output => ({
      satoshis: output.satoshis,
      script: toRawScript(output.script)
    }))
  }
  return new qtuminfo.Transaction({
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
exports.toRawTransaction = toRawTransaction

function toRawScript(script) {
  return new qtuminfo.Script({
    chunks: script.map(chunk => ({
      buf: chunk.buffer && Buffer.from(chunk.buffer, 'hex'),
      opcodenum: chunk.opcode
    }))
  })
}
exports.toRawScript = toRawScript
