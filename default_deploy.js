// Import types
/** @typedef {import("aws-lambda").CloudFormationCustomResourceEvent} CloudFormationCustomResourceEvent */
/** @typedef {import("aws-lambda").Context} LambdaContext */
/** @typedef {import("aws-lambda").Callback} LambdaCallback */
/** @typedef {import("./typings").CloudFormationStatus} CloudFormationStatus */
/** @typedef {import("./typings").DeployEventProperties} DeployEventProperties */
"use strict"

const fs = require("fs")
const path = require("path")
const https = require("https")
const url = require("url")

const AWS = require("aws-sdk")

// index filename is used as the default asset to serve for all CloudFront paths
const INDEX_FILENAME = "<%= indexFilename %>"
// content hash is used as the physical resource id in CloudFormation
const CONTENT_HASH = "<%= contentHash %>"

/**
 * This is the handler that's invoked by AWS Lambda
 * @param {CloudFormationCustomResourceEvent} event
 * @param {LambdaContext} context
 */
exports.handler = async (event, context) => {
  console.log(`REQUEST RECEIVED:\n${JSON.stringify(event)}`)

  /** @type {CloudFormationStatus} */
  let status = "FAILED"
  /** @type {{[key:string]: string}} */
  let responseData = {}

  try {
    switch (event.RequestType) {
      case "Create":
      case "Update":
        /** @type {DeployEventProperties} */
        const defaultProps = {}
        /** @type {DeployEventProperties} */
        const props = Object.assign(defaultProps, event.ResourceProperties)

        await deploy(
          event.RequestId,
          props.S3Bucket,
          props.CloudfrontDistribution,
        )
        status = "SUCCESS"
        responseData.Message = "Deploy successful"
        break
      case "Delete":
        status = "SUCCESS"
        break
      default:
        console.log(`FAILED! Unknown request type`)
    }
  } catch (err) {
    console.log(`Caught error: ${err}`)
  }
  await sendResponse(event, context, status, responseData, CONTENT_HASH)
}

/**
 * This is the handler that's invoked while developing locally
 */
const init = async () => {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    return
  }

  const s3BucketKey = "s3-bucket"
  const cfDistroKey = "cloudfront-distribution"
  const args = require("minimist")(argv, {
    string: [s3BucketKey, cfDistroKey],
  })

  const s3BucketName = args[s3BucketKey]
  const cfDistroId = args[cfDistroKey]
  if (!s3BucketName || !cfDistroId) {
    return
  }

  await deploy(`cli-${Math.random().toString(36)}`, s3BucketName, cfDistroId)
}

/**
 * Deploys the assets in the current directory to the S3 bucket with the given
 * name and then invalidates all paths on the CloudFront distribution
 * @param {string} requestId
 * @param {string} [s3BucketName]
 * @param {string} [cfDistroId]
 */
async function deploy(requestId, s3BucketName, cfDistroId) {
  if (s3BucketName) {
    const s3Client = new AWS.S3({})
    await uploadFilesToS3(s3Client, s3BucketName)
    if (cfDistroId) {
      const cfClient = new AWS.CloudFront({})
      await invalidateCache(cfClient, cfDistroId, requestId)
    }
  }
}

/**
 * Uploads the assets in the current directory to the given S3 bucket
 * @param {AWS.S3} s3Client
 * @param {string} s3BucketName
 */
async function uploadFilesToS3(s3Client, s3BucketName) {
  console.log("Uploading assets to S3")
  const scriptName = path.basename(__filename)

  const items = fs.readdirSync(__dirname)

  // create a list of items ordered by upload priority
  const orderedItems = []
  items.forEach(item => {
    if (item !== INDEX_FILENAME && item !== scriptName) {
      orderedItems.push(item)
    }
  })
  // index html needs to be uploaded last in order to avoid prematurely pointing to
  // new assets
  orderedItems.push(INDEX_FILENAME)

  // upload the ordered items
  for (let item of orderedItems) {
    await uploadFileToS3(s3Client, s3BucketName, item)
  }
}

/**
 * Uploads the given asset to the given S3 bucket
 * @param {AWS.S3} s3Client
 * @param {string} s3BucketName
 * @param {string} filename
 */
async function uploadFileToS3(s3Client, s3BucketName, filename) {
  /** @type {AWS.S3.Types.PutObjectRequest} */
  const params = {
    Bucket: s3BucketName,
    Key: filename,
    ContentType: getContentType(filename),
  }
  console.log(`Uploading ${filename}:\n${JSON.stringify(params)}`)
  params.Body = fs.readFileSync(filename)
  return new Promise((resolve, reject) => {
    s3Client.upload(params, (err, data) => {
      if (err) {
        reject(err)
        return
      }
      console.log(`Uploaded ${filename}:\n${JSON.stringify(data)}`)
      resolve(data)
    })
  })
}

/**
 * Invalidates all paths on the CloudFront distribution
 * @param {AWS.CloudFront} cfClient
 * @param {string} cfDistroId
 * @param {string} requestId
 */
async function invalidateCache(cfClient, cfDistroId, requestId) {
  console.log("Invalidating CloudFront cache")
  return new Promise((resolve, reject) => {
    cfClient.createInvalidation(
      {
        DistributionId: cfDistroId,
        InvalidationBatch: {
          CallerReference: requestId,
          Paths: {
            Quantity: 1,
            Items: ["/*"],
          },
        },
      },
      (err, data) => {
        if (err) {
          reject(err)
          return
        }
        console.log(`Invalidated all paths:\n${JSON.stringify(data)}`)
        resolve(data)
      },
    )
  })
}

/**
 * Send response to CloudFormation
 * @param {CloudFormationCustomResourceEvent} event
 * @param {LambdaContext} context
 * @param {CloudFormationStatus} responseStatus
 * @param {{[key:string]: string}} responseData
 * @param {string} physicalResourceId
 * @param {boolean} [noEcho]
 */
async function sendResponse(
  event,
  context,
  responseStatus,
  responseData,
  physicalResourceId,
  noEcho,
) {
  return new Promise((resolve, reject) => {
    const responseBody = JSON.stringify({
      Status: responseStatus,
      Reason:
        "See the details in CloudWatch Log Stream: " + context.logStreamName,
      PhysicalResourceId: physicalResourceId || context.logStreamName,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      NoEcho: noEcho || false,
      Data: responseData,
    })

    console.log("Response body:\n", responseBody)

    const parsedUrl = url.parse(event.ResponseURL)
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.path,
      method: "PUT",
      headers: {
        "content-type": "",
        "content-length": responseBody.length,
      },
    }

    const request = https.request(options, response => {
      console.log("Status code: " + response.statusCode)
      console.log("Status message: " + response.statusMessage)
      resolve()
    })

    request.on("error", error => {
      console.log("send(..) failed executing https.request(..): " + error)
      reject(error)
    })

    request.write(responseBody)
    request.end()
  })
}

/**
 * Return the content type for the given filename
 * @param {string} filename
 */
function getContentType(filename) {
  return (
    extensionToMimeTypes[path.extname(filename)] || "application/octet-stream"
  )
}

/**
 * extensionToMimeTypes, taken from https://github.com/aws/aws-vsts-tools/blob/f075957db6f15f9f779f01e0f15d100e285dccbb/Tasks/S3Upload/helpers/UploadTaskOperations.ts
 * @type {{[key:string]: string}}
 */
const extensionToMimeTypes = {
  ".ai": "application/postscript",
  ".aif": "audio/x-aiff",
  ".aifc": "audio/x-aiff",
  ".aiff": "audio/x-aiff",
  ".asc": "text/plain",
  ".au": "audio/basic",
  ".avi": "video/x-msvideo",
  ".bcpio": "application/x-bcpio",
  ".bin": "application/octet-stream",
  ".c": "text/plain",
  ".cc": "text/plain",
  ".ccad": "application/clariscad",
  ".cdf": "application/x-netcdf",
  ".class": "application/octet-stream",
  ".cpio": "application/x-cpio",
  ".cpp": "text/plain",
  ".cpt": "application/mac-compactpro",
  ".cs": "text/plain",
  ".csh": "application/x-csh",
  ".css": "text/css",
  ".dcr": "application/x-director",
  ".dir": "application/x-director",
  ".dms": "application/octet-stream",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dot": "application/msword",
  ".drw": "application/drafting",
  ".dvi": "application/x-dvi",
  ".dwg": "application/acad",
  ".dxf": "application/dxf",
  ".dxr": "application/x-director",
  ".eps": "application/postscript",
  ".etx": "text/x-setext",
  ".exe": "application/octet-stream",
  ".ez": "application/andrew-inset",
  ".f": "text/plain",
  ".f90": "text/plain",
  ".fli": "video/x-fli",
  ".gif": "image/gif",
  ".gtar": "application/x-gtar",
  ".gz": "application/x-gzip",
  ".h": "text/plain",
  ".hdf": "application/x-hdf",
  ".hh": "text/plain",
  ".hqx": "application/mac-binhex40",
  ".htm": "text/html",
  ".html": "text/html",
  ".ice": "x-conference/x-cooltalk",
  ".ief": "image/ief",
  ".iges": "model/iges",
  ".igs": "model/iges",
  ".ips": "application/x-ipscript",
  ".ipx": "application/x-ipix",
  ".jpe": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/x-javascript",
  ".kar": "audio/midi",
  ".latex": "application/x-latex",
  ".lha": "application/octet-stream",
  ".lsp": "application/x-lisp",
  ".lzh": "application/octet-stream",
  ".m": "text/plain",
  ".m3u8": "application/x-mpegURL",
  ".man": "application/x-troff-man",
  ".me": "application/x-troff-me",
  ".mesh": "model/mesh",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".mime": "www/mime",
  ".mov": "video/quicktime",
  ".movie": "video/x-sgi-movie",
  ".mp2": "audio/mpeg",
  ".mp3": "audio/mpeg",
  ".mpe": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mpga": "audio/mpeg",
  ".ms": "application/x-troff-ms",
  ".msi": "application/x-ole-storage",
  ".msh": "model/mesh",
  ".nc": "application/x-netcdf",
  ".oda": "application/oda",
  ".pbm": "image/x-portable-bitmap",
  ".pdb": "chemical/x-pdb",
  ".pdf": "application/pdf",
  ".pgm": "image/x-portable-graymap",
  ".pgn": "application/x-chess-pgn",
  ".png": "image/png",
  ".pnm": "image/x-portable-anymap",
  ".pot": "application/mspowerpoint",
  ".ppm": "image/x-portable-pixmap",
  ".pps": "application/mspowerpoint",
  ".ppt": "application/mspowerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppz": "application/mspowerpoint",
  ".pre": "application/x-freelance",
  ".prt": "application/pro_eng",
  ".ps": "application/postscript",
  ".qt": "video/quicktime",
  ".ra": "audio/x-realaudio",
  ".ram": "audio/x-pn-realaudio",
  ".ras": "image/cmu-raster",
  ".rgb": "image/x-rgb",
  ".rm": "audio/x-pn-realaudio",
  ".roff": "application/x-troff",
  ".rpm": "audio/x-pn-realaudio-plugin",
  ".rtf": "text/rtf",
  ".rtx": "text/richtext",
  ".scm": "application/x-lotusscreencam",
  ".set": "application/set",
  ".sgm": "text/sgml",
  ".sgml": "text/sgml",
  ".sh": "application/x-sh",
  ".shar": "application/x-shar",
  ".silo": "model/mesh",
  ".sit": "application/x-stuffit",
  ".skd": "application/x-koan",
  ".skm": "application/x-koan",
  ".skp": "application/x-koan",
  ".skt": "application/x-koan",
  ".smi": "application/smil",
  ".smil": "application/smil",
  ".snd": "audio/basic",
  ".sol": "application/solids",
  ".spl": "application/x-futuresplash",
  ".src": "application/x-wais-source",
  ".step": "application/STEP",
  ".stl": "application/SLA",
  ".stp": "application/STEP",
  ".sv4cpio": "application/x-sv4cpio",
  ".sv4crc": "application/x-sv4crc",
  ".svg": "image/svg+xml",
  ".swf": "application/x-shockwave-flash",
  ".t": "application/x-troff",
  ".tar": "application/x-tar",
  ".tcl": "application/x-tcl",
  ".tex": "application/x-tex",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".tr": "application/x-troff",
  ".ts": "video/MP2T",
  ".tsi": "audio/TSP-audio",
  ".tsp": "application/dsptype",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".unv": "application/i-deas",
  ".ustar": "application/x-ustar",
  ".vcd": "application/x-cdlink",
  ".vda": "application/vda",
  ".vrml": "model/vrml",
  ".wav": "audio/x-wav",
  ".wrl": "model/vrml",
  ".xbm": "image/x-xbitmap",
  ".xlc": "application/vnd.ms-excel",
  ".xll": "application/vnd.ms-excel",
  ".xlm": "application/vnd.ms-excel",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlw": "application/vnd.ms-excel",
  ".xml": "text/xml",
  ".xpm": "image/x-xpixmap",
  ".xwd": "image/x-xwindowdump",
  ".xyz": "chemical/x-pdb",
  ".zip": "application/zip",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".ogv": "video/ogv",
  ".xap": "application/x-silverlight-app",
  ".mp4": "video/mp4",
  ".wmv": "video/x-ms-wmv",
}

init()
