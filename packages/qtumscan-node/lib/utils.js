exports.parseParamsWithJSON = function(paramsArg) {
  return paramsArg.map(paramArg => {
    try {
      return JSON.parse(paramArg)
    } catch (err) {
      return paramArg
    }
  })
}
