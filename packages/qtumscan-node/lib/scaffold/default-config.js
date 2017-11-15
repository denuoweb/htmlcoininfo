const path = require('path')
const fs = require('fs')
const mkdirp = require('mkdirp')
const qtumscan = require('../..')

function getMajorVersion(versionString) {
  return Number.parseInt(versionString.slice(0, versionString.indexOf('.')))
}

function getDefaultConfig({
  datadir,
  network = 'livenet',
  additionalServices
} = {}) {
  let defaultPath = path.resolve(process.env.HOME, './.qtumscan')
  let defaultConfigFile = path.resolve(defaultPath, './qtumscan-node.json')

  if (!fs.existsSync(defaultPath)) {
    mkdirp.sync(defaultPath)
  }

  if (fs.existsSync(defaultConfigFile)) {
    let currentConfig = require(defaultConfigFile)

    if (currentConfig.version && getMajorVersion(qtumscan.version) === getMajorVersion(currentConfig.version)) {
      return {
        path: defaultPath,
        config: currentConfig
      }
    }

    console.error(`The configuration file at '${defaultConfigFile}' is incompatible with this version of Qtumscan.`)

    let now = new Date()
    let backupFileName = `qtumscan-node.${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}.${now.getTime()}.json`
    let backupFile = path.resolve(defaultPath, backupFileName)
    fs.renameSync(defaultConfigFile, backupFile)
    console.log(`The previous configuration file has been moved to: ${backupFile}.`)
  }

  console.log(`Creating a new configuration file at: ${defaultConfigFile}.`)

  let defaultServices = [
    'web'
  ]

  let config = {
    version: qtumscan.version,
    network,
    port: 3001,
    services: additionalServices ? defaultServices.concat(additionalServices) : defaultServices,
    datadir: path.resolve(defaultPath, './data')
  }
  fs.writeFileSync(defaultConfigFile, JSON.stringify(config, null, 2))

  return {
    path: defaultPath,
    config
  }
}

module.exports = getDefaultConfig
