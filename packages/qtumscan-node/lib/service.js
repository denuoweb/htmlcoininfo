const {EventEmitter} = require('events')

class Service extends EventEmitter {
  constructor({node, name}) {
    super()
    this.node = node
    this.name = name
  }

  async blockHandler(block, add) {
    return []
  }

  static get dependencies() {
    return []
  }

  get publishEvents() {
    return []
  }

  get APIMethods() {
    return []
  }

  async start() {}

  async stop() {}

  setupRoutes(app) {}

  get routePrefix() {
    return null
  }
}

module.exports = Service
