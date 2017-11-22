const fs = require('fs')
const assert = require('assert')
const {promisify} = require('util')
const mkdirp = require('mkdirp')
const levelup = require('levelup')
const leveldown = require('leveldown')
const BaseService = require('../service')
const {QTUM_GENESIS_HASH, DB_PREFIX} = require('../constants')

const exists = promisify(fs.exists)
const mkdirpPromise = promisify(mkdirp)

class DB extends BaseService {
  constructor(options = {}) {
    super(options)
    this._dbPrefix = DB_PREFIX
    this.version = 1
    this.network = this.node.network
    this._setDataPath()
    this.levelupStore = options.store || leveldown
    this.subscriptions = {}
    this.GENESIS_HASH = QTUM_GENESIS_HASH[this.node.network]

    this.node.on(
      'stopping',
      () => this.node.log.warn('Node is stopping, gently closing the database. Please wait, this could take a while')
    )
  }

  _onError(err) {
    if (!this.stopping) {
      this.node.log.error('Db Service: error:', err)
      this.node.stop()
    }
  }

  _setDataPath() {
    assert(fs.existsSync(this.node.datadir), 'Node is expected to have a "datadir" property')
    if (['livenet', 'mainnet'].includes(this.node.network)) {
      this.dataPath = this.node.datadir + '/qtumscannode.db'
    } else if (this.node.network === 'testnet') {
      this.dataPath = this.node.datadir + '/testnet/qtumscannode.db'
    } else {
      throw new Error('Unknown network: ' + this.network)
    }
  }

  _setVersion() {
    let versionBuffer = Buffer.alloc(4)
    versionBuffer.writeUInt32BE(this.version)
    return this.put(Buffer.concat([this._dbPrefix, Buffer.from('version')]), versionBuffer)
  }

  async start() {
    if (!await exists(this.dataPath)) {
      await mkdirp(this.dataPath)
    }

    this._store = levelup(this.levelupStore(this.dataPath), {
      keyEncoding: 'binary',
      valueEncoding: 'binary',
      writeBufferSize: 1 << 23,
      cacheSize: 1 << 30
    })
  }

  stop() {
    this._stopping = true
    return this.close()
  }

  async close() {
    if (this._store && !this._store.isClosed()) {
      return promisify(this._store.close).call(this._store)
    }
  }

  async get(key, options = {}) {
    if (!this._stopping) {
      try {
        return await this._store.get(key, options)
      } catch (err) {
        if (err instanceof levelup.errors.NotFoundError) {
          return
        } else {
          throw err
        }
      }
    } else {
      throw new Error('Shutdown sequence underway, not able to complete the query')
    }
  }

  async put(key, value) {
    if (!this._stopping) {
      assert(Buffer.isBuffer(key), 'key NOT a buffer as expected')
      if (value) {
        assert(Buffer.isBuffer(value), 'value exists but NOT a buffer as expected')
      }
      return promisify(this._store.put).call(this._store, key, value)
    }
  }

  async batch(options) {
    if (!this._stopping) {
      for (let {key, value} of options) {
        assert(Buffer.isBuffer(key), 'key NOT a buffer as expected')
        if (value) {
          assert(Buffer.isBuffer(value), 'value exists but NOT a buffer as expected')
        }
      }
      return promisify(this._store.batch).call(this._store, options)
    }
  }

  createReadStream(options) {
    if (!this._stopping) {
      let stream = this._store.createReadStream(options)
      stream.on('error', this._onError.bind(this))
      return stream
    }
  }

  createKeyStream(options) {
    if (!this._stopping) {
      let stream = this._store.createKeyStream(options)
      stream.on('error', this._onError.bind(this))
      return stream
    }
  }

  async getServiceTip(serviceName) {
    let keyBuffer = Buffer.concat([this._dbPrefix, Buffer.from('tip-' + serviceName)])
    let tipBuffer = await this.get(keyBuffer)
    if (tipBuffer) {
      return {
        height: tipBuffer.readUInt32BE(0, 4),
        hash: tipBuffer.slice(4).toString('hex')
      }
    } else {
      return {
        height: 0,
        hash: this.GENESIS_HASH
      }
    }
  }

  async getPrefix(service) {
    let keyBuffer = Buffer.concat([this._dbPrefix, Buffer.from('prefix-' + service)])
    let unusedBuffer = Buffer.concat([this._dbPrefix, Buffer.from('nextUnused')])

    let prefixBuffer = await this.get(keyBuffer)
    if (prefixBuffer) {
      this.node.log.info('Db Service: service prefix for:', service, 'is:', prefixBuffer.toString('hex'))
      return prefixBuffer
    }

    let buffer = await this.get(unusedBuffer) || Buffer.from('0001', 'hex')
    await this.put(keyBuffer, buffer)
    let prefix = buffer.readUInt16BE()
    let nextUnused = Buffer.alloc(2)
    nextUnused.writeUInt16BE(prefix + 1)
    await this.put(unusedBuffer, nextUnused)
    this.node.log.info('Db Service: service prefix for:', service, 'is:', buffer.toString('hex'))
    return buffer
  }
}

module.exports = DB
