const path = require('path')
const program = require('commander')
const qtuminfo = require('../..')

function main(servicesPath, additionalServices) {
  let version = qtuminfo.version
  let {start, findConfig, defaultConfig} = qtuminfo.scaffold

  program
    .version(version)
    .description('Start the current node')
    .option('-c, --config <dir>', 'Specify the directory with Qtuminfo Node configuration')

  program.parse(process.argv)

  if (program.config) {
    program.config = path.resolve(process.cwd(), program.config)
  }
  let configInfo = findConfig(program.config || process.cwd())
  if (!configInfo) {
    configInfo = defaultConfig({additionalServices})
  }
  if (servicesPath) {
    configInfo.servicesPath = servicesPath
  }

  start(configInfo)
}

module.exports = main
