'use strict';

const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');
const _ = require('lodash');
const AWS = require('aws-sdk');
const archiver = require('archiver');
const IntegrationDataInjector = require('./integration-data-injector');

let lager;

/**
 * Lazy loading of the lager instance to avoid circular require()
 * @return {Lager} the Lager instance
 */
function getLager() {
  if (!lager) {
    lager = require('lager/lib/lager');
  }
  return lager;
}

/**
 * Constructor function
 * @param {Object} spec - base API specification
 * @constructor
 */
let Lambda = function Lambda(config, awsLambdaOptions) {
  this.config = config;
  this.awsLambda = new AWS.Lambda(awsLambdaOptions);

  this.config.params = this.config.params || {};
  this.config.params = _.assign({
    FunctionName: config.identifier,
    Handler: 'lambda.handler',
    Role: 'PLEASE-CONFIGURE-AN-EXECUTION-ROLE-FOR-' + config.identifier,
    Runtime: 'nodejs4.3',
    Timeout: 15,
    Publish: false
  }, this.config.params);

  this.config.includeLibs = this.config.includeLibs || [];
  _.forEach(this.config.includeLibs, (libDir, index) => {
    this.config.includeLibs[index] = path.join(process.cwd(), 'libs', libDir);
  });
  if (this.config.includeEndpoints) {
    this.config.includeLibs.push(path.join(process.cwd(), 'endpoints'));
  }
};

/**
 * Returns a string representation of a Lambda instance
 * @return {string}
 */
Lambda.prototype.toString =  function toString() {
  return 'Lambda ' + this.config.identifier;
};

/**
 * Deploys the lambda in AWS
 * @return {Promise<LambdaIntegrationDataInjector>} - the IntegrationDataInjector of the lambda
 */
Lambda.prototype.deploy = function deploy() {
  console.log('   * Deploy ' + this.config.identifier);
  return this.isDeployed()
  .then((isDeployed) => {
    if (isDeployed) {
      // If the function already exists
      console.log('   * The lambda ' + this.config.identifier + ' already exists');
      return this.update();
    } else {
      // If error occured because the function does not exists, we create it
      console.log('   * The lambda ' + this.config.identifier + ' does not exists');
      return this.create();
    }
  })
  .then((data) => {
    // Publish a new version
    console.log('   * Lambda ' + this.config.identifier + ' deployed');
    return this.publishVersion(data.FunctionName);
  })
  .then((data) => {
    console.log('   * Lambda ' + this.config.identifier + ' published: \x1b[0;36mversion ' + data.Version + '\x1b[0m');
    console.log('   * Function ARN: \x1b[0;36m' + data.FunctionArn + '\x1b[0m\n');
    return new IntegrationDataInjector(data);
  });
};


/**
 * Create a zip package for a lambda and provide it's content in a buffer
 * @param {String} lambdaPath - path to the function
 * @param {Array} dependenciesPaths - directories to include in the the function
 * @param {Function} cb
 */
function getPackageBufferCb(lambdaPath, dependenciesPaths, cb) {
  dependenciesPaths = dependenciesPaths || [];

  var archivePath = '/tmp/' + (new Buffer(lambdaPath).toString('base64')) + '.zip';
  var outputStream = fs.createWriteStream(archivePath);
  var archive = archiver.create('zip', {});
  outputStream.on('close', function() {
    fs.readFile(archivePath, cb);
  });

  archive.on('error', function(e) {
    cb(e);
  });

  archive.pipe(outputStream);

  // Add the Lamba code to the archive
  archive.directory(lambdaPath, '');

  // Add the library code (aka code in common for all lambdas) to the archive
  dependenciesPaths.forEach(function(dependencyPath) {
    archive.directory(dependencyPath, path.basename(dependencyPath));
  });

  // Add the application configuration of the environment to the archive
  var envConfig = process.env;
  envConfig.LAMBDA = true;
  archive.append(JSON.stringify(envConfig), { name: 'env_config.json' });

  archive.finalize();
}
// @TODO improve this to avoid using Promise.promisify()
/**
 * Creates a buffer containing the lambda package
 * @return {Promise<Buffer>}
 */
Lambda.prototype.buildPackage = function buildPackage() {
  return Promise.promisify(getPackageBufferCb)(this.config.handlerPath, this.config.includeLibs);
};


/* istanbul ignore next */
/**
 * Check if the Lambda already exists in AWS
 * @return {Promise<Boolean>}
 */
Lambda.prototype.isDeployed = function isDeployed() {
  let params = { FunctionName: this.config.params.FunctionName };
  return Promise.promisify(this.awsLambda.getFunction.bind(this.awsLambda))(params)
  .then(() => {
    return Promise.resolve(true);
  })
  .catch((e) => {
    if (e.code !== 'ResourceNotFoundException') {
      throw(e);
    }
    return Promise.resolve(false);
  });
};


/* istanbul ignore next */
/**
 * Create the lambda in AWS
 * @return {Promise<Object>} - AWS description of the lambda
 */
Lambda.prototype.create = function create() {
  let params = _.cloneDeep(this.config.params);
  return Promise.all([this.buildPackage(), getLager().retrieveRoleArn(params.Role)])
  .spread((buffer, roleArn) => {
    params.Code = { ZipFile: buffer };
    params.Role = roleArn;
    return Promise.promisify(this.awsLambda.createFunction.bind(this.awsLambda))(params);
  });
};


/* istanbul ignore next */
/**
 * Update the lambda in AWS
 * @return {Promise<Object>} - AWS description of the lambda
 */
Lambda.prototype.update = function update() {
  return this.buildPackage()
  .then((buffer) => {
    // First, update the code
    let codeParams = {
      FunctionName: this.config.params.FunctionName,
      Publish: this.config.params.Publish,
      ZipFile: buffer
    };
    return [
      Promise.promisify(this.awsLambda.updateFunctionCode.bind(this.awsLambda))(codeParams),
      getLager().retrieveRoleArn(this.config.params.Role)
    ];
  })
  .spread((codeUpdateResponse, roleArn) => {
    // Then, update the configuration
    var configParams = _.cloneDeep(this.config.params);
    delete configParams.Publish;
    configParams.Role = roleArn;
    return Promise.promisify(this.awsLambda.updateFunctionConfiguration.bind(this.awsLambda))(configParams);
  });
};


/* istanbul ignore next */
/**
 * Create a new version of the lambda
 * @return {Promise<Object>} - AWS description of the lambda
 */
Lambda.prototype.publishVersion = function publishVersion() {
  let params = {
    FunctionName: this.config.params.FunctionName
  };
  return Promise.promisify(this.awsLambda.publishVersion.bind(this.awsLambda))(params);
};

module.exports = Lambda;