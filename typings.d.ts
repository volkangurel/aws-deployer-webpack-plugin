declare namespace AWSDeployerWebpackPlugin {
  interface Options extends Partial<ProcessedOptions> {}

  /**
   * The plugin options after default values
   */
  interface ProcessedOptions {
    /**
     * Emit the file only if it was changed.
     * Default: `true`.
     */
    cache: boolean
    /**
     * The file to write the deployer script to.
     * Default: `deploy.js`.
     */
    filename: string
    /**
     * The html file to serve through CloudFront for all paths.
     * Default: `index.html`.
     */
    indexFilename: string
    /**
     * The `webpack` require path to the template.
     * Default: `default_deploy.js`.
     */
    template: string
  }

  /**
   * The properties on the deploy event
   */
  interface DeployEventProperties {
    /**
     * The S3 bucket to deploy assets to
     */
    S3Bucket?: string
    /**
     * The CloudfrontDistribution in front of the S3 bucket
     */
    CloudfrontDistribution?: string
  }

  /**
   * The CloudFormation status string
   */
  type CloudFormationStatus = "SUCCESS" | "FAILED"
}

export = AWSDeployerWebpackPlugin
