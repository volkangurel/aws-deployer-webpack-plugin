"use strict"

const PrettyError = require("pretty-error")
const prettyError = new PrettyError()
prettyError.withoutColors()
prettyError.skipNodeFiles()

const header = "AWS Deployer Webpack Plugin:\n"

/**
 * apply is called by the webpack main compiler during the start phase
 * @param {Error} err
 * @param {string} context
 */
module.exports = function(err, context) {
  return {
    toHtml: function() {
      return `${header}<pre>\n${this.toString()}</pre>`
    },
    toJsonHtml: function() {
      return JSON.stringify(this.toHtml())
    },
    toString: function() {
      return (
        header + prettyError.render(err).replace(/webpack:\/\/\/\./g, context)
      )
    },
  }
}
