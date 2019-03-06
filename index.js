// Import types
/** @typedef {import("./typings").Options} AWSDeployerWebpackOptions */
/** @typedef {import("./typings").ProcessedOptions} AWSDeployerWebpackProcessedOptions */
/** @typedef {import("webpack").Compiler} WebpackCompiler */
/** @typedef {import("webpack").compilation.Compilation} WebpackCompilation */
"use strict"

const fs = require("fs")
const path = require("path")

const _ = require("lodash")
const promisify = require("util.promisify")

const prettyError = require("./lib/errors.js")

const fsReadFileAsync = promisify(fs.readFile)

const pluginName = "AWSDeployerWebpackPlugin"

class AWSDeployerWebpackPlugin {
  /**
   * @param {AWSDeployerWebpackOptions} [options]
   */
  constructor(options) {
    /** @type {AWSDeployerWebpackOptions} */
    const userOptions = options || {}

    // Default options
    /** @type {AWSDeployerWebpackProcessedOptions} */
    const defaultOptions = {
      cache: true,
      filename: "deploy.js",
      indexFilename: "index.html",
      template: path.join(__dirname, "default_deploy.js"),
    }

    /** @type {AWSDeployerWebpackProcessedOptions} */
    this.options = Object.assign(defaultOptions, userOptions)
  }

  /**
   * apply is called by the webpack main compiler during the start phase
   * @param {WebpackCompiler} compiler
   */
  apply(compiler) {
    compiler.hooks.emit.tapAsync(
      pluginName,
      /**
       * @param {WebpackCompilation} compilation
       * @param {() => void} callback
       */
      async (compilation, callback) => {
        if (!compilation.assets[this.options.indexFilename]) {
          compilation.errors.push(
            prettyError(
              new Error(`${this.options.indexFilename} not found in assets`),
              compiler.options.context || "",
            ).toString(),
          )
          callback()
          return
        }
        const getStatsConfig = {
          assets: false,
          cached: false,
          children: false,
          chunks: false,
          chunkModules: false,
          chunkOrigins: false,
          errorDetails: false,
          hash: true,
          modules: false,
          reasons: false,
          source: false,
          timings: false,
          version: false,
        }
        const stats = compilation.getStats().toJson(getStatsConfig)

        const templateSource = await fsReadFileAsync(this.options.template)

        const template = _.template(templateSource, {
          interpolate: /<%=([\s\S]+?)%>/g,
        })

        const compiledTemplate = template({
          indexFilename: this.options.indexFilename,
          contentHash: stats.hash,
        })

        const basename = path.basename(this.options.filename)
        compilation.assets[basename] = {
          source: () => compiledTemplate,
          size: () => compiledTemplate.length,
        }
        callback()
      },
    )
  }
}

module.exports = AWSDeployerWebpackPlugin
