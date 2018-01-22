const Liftoff = require('liftoff')

function main(parentServicePath, additionalServices) {
  let liftoff = new Liftoff({
    name: 'qtuminfo',
    moduleName: 'qtuminfo-node',
    configName: 'qtuminfo-node',
    processTitle: 'qtuminfod'
  }).on('require', name => {
    console.log('Loading:', name)
  }).on('requireFail', (name, err) => {
    console.error('Unable to load:', name, err)
  }).on('respawn', (flags, child) => {
    console.log('Detected node flags:', flags)
    console.log('Respawned to PID', child.pid)
  })

  liftoff.launch({cwd: process.cwd}, env => {
    let node
    if (env.configPath && env.modulePath) {
      node = require(env.modulePath)
      node.cli.daemon()
    } else {
      node = require('../..')
      node.cli.daemon(parentServicePath, additionalServices)
    }
  })
}

module.exports = main
