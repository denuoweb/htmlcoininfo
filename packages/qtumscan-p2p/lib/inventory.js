const qtumscan = require('qtumscan-lib')
const BufferUtil = qtumscan.util.buffer
const {BufferReader, BufferWriter} = qtumscan.encoding

const TYPE = {
  ERROR: 0,
  TX: 1,
  BLOCK: 2,
  FILTERED_BLOCK: 3
}
const TYPE_NAME = ['ERROR', 'TX', 'BLOCK', 'FILTERED_BLOCK']

class Inventory {
  constructor(obj) {
    this.type = obj.type
    if (!Buffer.isBuffer(obj.hash)) {
      throw new TypeError('Unexpected hash, expected to be a buffer')
    }
    this.hash = obj.hash
  }

  static forItem(type, hash) {
    assert(hash)
    if (typeof hash === 'string') {
      hash = Buffer.from(hash, 'hex')
      hash = BufferUtil.reverse(hash)
    }
    return new Inventory({type, hash})
  }

  static forBlock(hash) {
    return Inventory.forItem(TYPE.BLOCK, hash)
  }

  static forFilteredBlock(hash) {
    return Inventory.forItem(TYPE.FILTERED_BLOCK, hash)
  }

  static forTransaction(hash) {
    return Inventory.forItem(TYPE.TX, hash)
  }

  toBuffer() {
    let bw = new BufferWriter()
    bw.writeUInt32LE(this.type)
    bw.write(this.hash)
    return bw.concat()
  }

  toBufferWriter(bw) {
    bw.writeUInt32LE(this.type)
    bw.write(this.hash)
    return bw
  }

  static fromBuffer(payload) {
    let parser = new BufferReader(payload)
    let type = parser.readUInt32LE()
    let hash = parser.read(32)
    return new Inventory({type, hash})
  }

  static fromBufferReader(br) {
    let type = br.readUInt32LE()
    let hash = br.read(32)
    return new Inventory({type, hash})
  }
}

module.exports = Inventory
