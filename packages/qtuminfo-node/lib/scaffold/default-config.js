const path = require('path')
const fs = require('fs')
const mkdirp = require('mkdirp')
const qtuminfo = require('../..')

function getMajorVersion(versionString) {
  return Number.parseInt(versionString.slice(0, versionString.indexOf('.')))
}

function getDefaultConfig({
  datadir,
  network = 'livenet',
  additionalServices
} = {}) {
  let defaultPath = path.resolve(process.env.HOME, './.qtuminfo')
  let defaultConfigFile = path.resolve(defaultPath, './qtuminfo-node.json')

  if (!fs.existsSync(defaultPath)) {
    mkdirp.sync(defaultPath)
  }

  if (fs.existsSync(defaultConfigFile)) {
    let currentConfig = require(defaultConfigFile)

    if (currentConfig.version && getMajorVersion(qtuminfo.version) === getMajorVersion(currentConfig.version)) {
      return {
        path: defaultPath,
        config: currentConfig
      }
    }

    console.error(`The configuration file at '${defaultConfigFile}' is incompatible with this version of Qtuminfo.`)

    let now = new Date()
    let backupFileName = `qtuminfo-node.${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}.${now.getTime()}.json`
    let backupFile = path.resolve(defaultPath, backupFileName)
    fs.renameSync(defaultConfigFile, backupFile)
    console.log(`The previous configuration file has been moved to: ${backupFile}.`)
  }

  console.log(`Creating a new configuration file at: ${defaultConfigFile}.`)

  let defaultServices = [
    'web'
  ]

  let config = {
    version: qtuminfo.version,
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
