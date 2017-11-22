const assert = require('assert')
const {isObject} = require('util')
const BN = require('../crypto/bn')
const {sha256sha256} = require('../crypto/hash')
const BufferReader = require('../encoding/bufferreader')
const BufferWriter = require('../encoding/bufferwriter')
const BufferUtil = require('../util/buffer')

const GENESIS_BITS = 0x1d00ffff
const START_OF_HEADER = 8
const MAX_TIME_OFFSET = 2 * 60 * 60

class BlockHeader {
  constructor(arg) {
    let info = BlockHeader._from(arg)
    this.version = info.version
    this.prevHash = info.prevHash
    this.merkleRoot = info.merkleRoot
    this.time = info.time
    this.timestamp = info.time
    this.bits = info.bits
    this.nonce = info.nonce
    this.hashStateRoot = info.hashStateRoot
    this.hashUTXORoot = info.hashUTXORoot
    this.prevOutStakeHash = info.prevOutStakeHash
    this.prevOutStakeN = info.prevOutStakeN
    this.vchBlockSig = info.vchBlockSig

    if (info.hash) {
      assert(this.hash === info.hash, 'Argument object hash property does not match block hash.')
    }
  }

  static _from(arg) {
    if (Buffer.isBuffer(arg)) {
      return BlockHeader._fromBufferReader(new BufferReader(arg))
    } else if (isObject(arg)) {
      return BlockHeader._fromObject(arg)
    } else {
      throw new TypeError('Unrecognized argument for BlockHeader')
    }
  }

  static _fromObject(data) {
    assert(data, 'data is required')
    let {prevHash, merkleRoot, vchBlockSig, prevOutStakeHash, hashStateRoot, hashUTXORoot} = data
    if (typeof data.prevHash === 'string') {
      prevHash = BufferUtil.reverse(Buffer.from(data.prevHash, 'hex'))
    }
    if (typeof data.merkleRoot === 'string') {
      merkleRoot = BufferUtil.reverse(Buffer.from(data.merkleRoot, 'hex'))
    }
    if (typeof data.vchBlockSig === 'string') {
      vchBlockSig = BufferUtil.reverse(Buffer.from(data.vchBlockSig, 'hex'))
    }
    if (typeof data.prevOutStakeHash === 'string') {
      prevOutStakeHash = BufferUtil.reverse(Buffer.from(data.prevOutStakeHash, 'hex'))
    }
    if (typeof data.hashStateRoot === 'string') {
      hashStateRoot = BufferUtil.reverse(Buffer.from(data.hashStateRoot, 'hex'))
    }
    if (typeof data.hashUTXORoot === 'string') {
      hashUTXORoot = BufferUtil.reverse(Buffer.from(data.hashUTXORoot, 'hex'))
    }

    return {
      hash: data.hash,
      version: data.version,
      prevHash,
      merkleRoot,
      time: data.time,
      timestamp: data.time,
      bits: data.bits,
      nonce: data.nonce,
      hashStateRoot,
      hashUTXORoot,
      prevOutStakeHash,
      prevOutStakeN: data.prevOutStakeN,
      vchBlockSig
    }
  }

  static fromObject(obj) {
    return new BlockHeader(BlockHeader._fromObject(obj))
  }

  static fromRawBlock(data) {
    if (!Buffer.isBuffer(data)) {
      data = Buffer.from(data, 'binary')
    }
    let br = new BufferReader(data)
    br.pos = START_OF_HEADER
    return new BlockHeader(BlockHeader._fromBufferReader(br))
  }

  static fromBuffer(buffer) {
    let info = BlockHeader._fromBufferReader(new BufferReader(buffer))
    return new BlockHeader(info)
  }

  static fromString(string) {
    return BlockHeader.fromBuffer(Buffer.from(string, 'hex'))
  }

  static _fromBufferReader(br) {
    let version = br.readInt32LE()
    let prevHash = br.read(32)
    let merkleRoot = br.read(32)
    let time = br.readUInt32LE()
    let bits = br.readUInt32LE()
    let nonce = br.readUInt32LE()
    let hashStateRoot = br.read(32)
    let hashUTXORoot = br.read(32)
    let prevOutStakeHash = br.read(32)
    let prevOutStakeN = br.readUInt32LE()
    let num = br.readVarintNum()
    let vchBlockSig = br.read(num)
    return {
      version,
      prevHash,
      merkleRoot,
      time,
      bits,
      nonce,
      hashStateRoot,
      hashUTXORoot,
      prevOutStakeHash,
      prevOutStakeN,
      vchBlockSig
    }
  }

  static fromBufferReader(br) {
    return new BlockHeader(BlockHeader._fromBufferReader(br))
  }

  toObject() {
    return {
      hash: this.hash,
      version: this.version,
      prevHash: BufferUtil.reverse(this.prevHash).toString('hex'),
      merkleRoot: BufferUtil.reverse(this.merkleRoot).toString('hex'),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce,
      hashStateRoot: BufferUtil.reverse(this.hashStateRoot).toString('hex'),
      hashUTXORoot: BufferUtil.reverse(this.hashUTXORoot).toString('hex'),
      prevOutStakeHash: BufferUtil.reverse(this.prevOutStakeHash).toString('hex'),
      prevOutStakeN: this.prevOutStakeN,
      vchBlockSig: this.vchBlockSig.toString('hex')
    }
  }

  toJSON() {
    return this.toObject()
  }

  toBuffer() {
    return this.toBufferWriter().concat()
  }

  toString() {
    return this.toBuffer().toString('hex')
  }

  toBufferWriter(bw = new BufferWriter()) {
    bw.writeInt32LE(this.version)
    bw.write(this.prevHash)
    bw.write(this.merkleRoot)
    bw.writeUInt32LE(this.time)
    bw.writeUInt32LE(this.bits)
    bw.writeUInt32LE(this.nonce)
    bw.write(this.hashStateRoot)
    bw.write(this.hashUTXORoot)
    bw.write(this.prevOutStakeHash)
    bw.writeUInt32LE(this.prevOutStakeN)
    bw.writeVarintNum(this.vchBlockSig.length)
    bw.write(this.vchBlockSig)
    return bw
  }

  getTargetDifficulty(bits) {
    bits = bits || this.bits
    let target = new BN(bits & 0xffffff)
    let mov = ((bits >>> 24) - 3) << 3
    while (mov--) {
      target = target.mul(new BN(2))
    }
    return target
  }

  getDifficulty() {
    let difficultyTargetBN = this.getTargetDifficulty(GENESIS_BITS).mul(new BN(100000000))
    let currentTargetBN = this.getTargetDifficulty()
    let difficultyString = difficultyTargetBN.div(currentTargetBN).toString(10)
    let decimalPos = difficultyString.length - 8
    difficultyString = difficultyString.slice(0, decimalPos) + '.' + difficultyString.slice(decimalPos)
    return Number.parseFloat(difficultyString)
  }

  _getHash(hash) {
    return sha256sha256(this.toBuffer())
  }

  get id() {
    this._id = this._id || new BufferReader(this._getHash()).readReverse().toString('hex')
    return this._id
  }

  get hash() {
    return this.id
  }

  validTimestamp() {
    let currentTime = Math.floor(Date.now() / 1000)
    return this.time <= currentTime + MAX_TIME_OFFSET
  }

  validProofOfWork() {
    let pow = new BN(this.id, 'hex')
    let target = this.getTargetDifficulty()
    return pow.cmp(target) <= 0
  }

  isProofOfStake() {
    return this.prevOutStakeHash.toString('hex') !== '0'.repeat(64) && this.prevOutStakeN != 0xffffffff
  }

  inspect() {
    return `<BlockHeader ${this.id}>`
  }
}

module.exports = BlockHeader
