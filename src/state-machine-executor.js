const child_process = require('child_process');
const _ = require('lodash');
const fs = require('fs');
const jsonPath = require('JSONPath');
const choiceProcessor = require('./choice-processor');
const stateTypes = require('./state-types');
const StateRunTimeError = require('./state-machine-error');

const logPrefix = '[Serverless Offline Step Functions]:';

class StateMachineExecutor {
    constructor(stateMachineName, stateName, stateMachineJSONInput) {
        this.currentStateName = stateName;
        this.stateMachineName = stateMachineName;
        this.stateMachineJSON = {};
        if (stateMachineJSONInput) {
            this.stateMachineJSON.stateMachines = _.assign({}, this.stateMachineJSON.stateMachines, stateMachineJSONInput);
        } else {
            try{
                const json = require('./step-functions.json');
                if (!_.isEmpty(json)) {
                    this.stateMachineJSON = json;
                }
            } catch(e) {
                throw new Error('no state machine json found');
            }
        }
        // step execution response includes the start date
        this.startDate = Date.now();
        // step execution response includes the execution ARN
        // use this for now to give a unique id locally
        this.executionArn = `${stateMachineName}-${stateName}-${this.startDate}`;
    }

    /**
     * Spawns a new process to run a given State from a state machine
     * @param {*} stateInfo
     * @param {*} input
     * @param {*} context
     */
    spawnProcess(stateInfo, input, context, callback = null) {
        console.log(`* * * * * ${this.currentStateName} * * * * *`);
        console.log('input: \n', JSON.stringify(input, 0, 2), '\n');
        // This will be used as the parent node key for when the process
        // finishes and its output needs to be processed.
        const outputKey = `sf-${Date.now()}`;

        this.processTaskInputPath(input, stateInfo);

        const child = child_process.spawn('node',
        [
            '-e',
            this.whatToRun(stateInfo, input, outputKey, callback)],
            { stdio: 'pipe',
            env: Object.assign({}, process.env, {
                input: JSON.stringify(input),
            })});

            let outputData = null;
            child.stdout.on('data', (data) => {
                if (Buffer.isBuffer(data) &&
                stateInfo.Type !== stateTypes.FAIL) {
                    data = data.toString().trim();

                    try {
                        // check that output is a JSON string
                        const parsed = JSON.parse(data);
                        // only process data if sent as step functions output so data from
                        // other console.logs don't get processed
                        if (typeof parsed[outputKey] !== 'undefined') {
                            outputData = parsed[outputKey];
                        }
                    } catch(error) {
                        console.log(`${logPrefix} error processing data: ${data}`);
                    }
                }
            });


            child.stderr.on('data', (data) => {
                console.error(`${logPrefix} stderr:`, data.toString())
            });

            child.on('exit', () => {
                let output = null;
                // any state except the fail state may have OutputPath
                if(stateInfo.Type !== 'Fail') {
                    // state types Parallel, Pass, and Task can generate a result and can include ResultPath
                    if([stateTypes.PARALLEL, stateTypes.PASS, stateTypes.TASK].indexOf(stateInfo.Type) > -1) {
                        input = this.processTaskResultPath(input, stateInfo, (outputData || {}));
                    }

                    // NOTE:
                    // State machine data is represented by JSON text, so you can provide values using any data type supported by JSON
                    // https://docs.aws.amazon.com/step-functions/latest/dg/concepts-state-machine-data.html
                    output = this.processTaskOutputPath(input, stateInfo.OutputPath);
                }
                // kick out if it is the last one (end => true) or state is 'Success' or 'Fail
                if (stateInfo.Type === 'Succeed' || stateInfo.Type === 'Fail' || stateInfo.End === true) {
                    return this.endStateMachine(null, null, output);
                }

                // const newEvent = event ? Object.assign({}, event) : {};
                // newEvent.input = event.output;
                // newEvent.stateName = stateInfo.Next;
                this.currentStateName = stateInfo.Next;
                stateInfo = this.stateMachineJSON.stateMachines[this.stateMachineName].definition.States[stateInfo.Next];
                console.log('output: \n', JSON.stringify(output, 0, 2), '\n');
                this.spawnProcess(stateInfo, output, context, callback);
            });
    }

    endStateMachine(error, input, output, message) {
        if(error) {
            console.error(`${logPrefix} Error:`, error);
        } else {
            console.log(`${logPrefix} State Machine Completed`);
        }

        if (message) {
            console.log(`${logPrefix}`, message);
        }

        if(input) {
            console.log(`${logPrefix} input:`, input);
        }

        console.log(`${logPrefix} output: \n`, JSON.stringify(output, 0, 2), '\n');
        return true;
    }

    /**
     * tris to get the transpiled webpack function, if exists. Else, it should get the common function directly.
     */
    getWebpackOrCommonFuction(path) {
      const webpackPath = `./.webpack/service/${path}.js`
      const webpackFileExists = fs.existsSync(webpackPath);

      return (
        webpackFileExists
          ? webpackPath
          : `./${path}`
      );
    }

    /**
     * decides what to run based on state type
     * @param {object} stateInfo
     */
    whatToRun(stateInfo, input, outputKey, callback) {
        switch(stateInfo.Type) {
            case 'Task':
                // TODO: catch, retry
                // This will spin up a node child process to fire off the handler function of the given lambda
                // the output of the lambda is placed into a JSON object with the outputKey generated above as
                // the parent node and piped to stdout for processing. This is done so other callback console.logs are not
                // processed by this plugin.
                // process.exit(0) must be called in .then because a child process will not exit if it has connected
                // to another resource, such as a database or redis, which may be a source of future events.
                const handlerSplit = stateInfo.handler.split('.');
                // const cb = callback(null, { statusCode: 200, body: JSON.stringify({ startDate: sme.startDate, executionArn: sme.executionArn }) });
                // const context = ;
                let runner = `const context = require('./node_modules/serverless-offline-step-functions/node_modules/serverless-offline/src/createLambdaContext')(require('${this.getWebpackOrCommonFuction(handlerSplit[0])}').${handlerSplit[1]}, ${callback}); `;
                runner += `Promise.resolve(require("${this.getWebpackOrCommonFuction(handlerSplit[0])}").${handlerSplit[1]}(JSON.parse(process.env.input), context, ${callback}))`;
                runner += `.then((data) => { console.log(JSON.stringify({ "${outputKey}": data || {} })); process.exit(0); })`;
                runner += `.catch((e) => { console.error("${logPrefix} handler error:",e); })`;
                return runner;

            // should pass input directly to output without doing work
            case 'Pass':
                return '';
            // Waits before moving on:
            // - Seconds, SecondsPath: wait the given number of seconds
            // - Timestamp, TimestampPath: wait until the given timestamp
            case 'Wait':
                return this.buildWaitState(stateInfo, input);
            // ends the state machine execution with 'success' status
            case 'Succeed':
            // ends the state machine execution with 'fail' status
            case 'Fail':
                return this.endStateMachine(null, stateInfo);
            // adds branching logic to the state machine
            case 'Choice':
                stateInfo.Next = choiceProcessor.processChoice(stateInfo, input);
                return '';
            case 'Parallel':
                return `console.error('${logPrefix} 'Parallel' state type is not yet supported by serverless offline step functions')`;
            default:
                return `console.error('${logPrefix} Invalid state type: ${stateInfo.Type}')`
        }
    }

    buildWaitState(stateInfo, input) {
        let milliseconds;
        // SecondsPath: specified using a path from the state's input data.
        if ((stateInfo.Seconds && _.isNaN(+stateInfo.Seconds))) {
            milliseconds = +stateInfo.Seconds * 1000
        } else if (stateInfo.SecondsPath && input) {
            milliseconds = +jsonPath({ json: input, path: stateInfo.SecondsPath })[0] * 1000;
        } else if (stateInfo.Timestamp) {
            const waitDate = new Date(stateInfo.Timestamp);
            if (waitDate.getTime() < Date.now()) {
                milliseconds = 0;
            } else {
                milliseconds = waitDate.getTime() - Date.now();
            }
        } else if (stateInfo.TimestampPath && input) {
            const waitDate = new Date(jsonPath({ json: input, path: stateInfo.TimestampPath })[0]);
            if (waitDate.getTime() < Date.now()) {
                milliseconds = 0;
            } else {
                milliseconds = waitDate.getTime() - Date.now();
            }
        }

        if (_.isNaN(milliseconds)) {
            return ''+ this.endStateMachine(
                new StateRunTimeError('Specified wait time is not a number'), stateInfo);
        }

        return `setTimeout(() => {}, ${+milliseconds});`;
    }

    /**
     * Process the state's InputPath - per AWS docs:
     * The InputPath field selects a portion of the state's input to pass to the state's
     * task for processing. If you omit the field, it gets the $ value, representing the
     * entire input. If you use null, the input is discarded (not sent to the state's
     * task) and the task receives JSON text representing an empty object {}.
     * https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-input-output-processing.html
     * @param {*} input
     * @param {*} stateInfo
     */
    processTaskInputPath(input, stateInfo) {
        stateInfo.InputPath = typeof stateInfo.InputPath === 'undefined' ? '$' : stateInfo.InputPath;
        if (stateInfo.InputPath === null) {
            input = {};
        } else {
            input = input ? input : {};
            jsonPath({ json: input, path: stateInfo.InputPath, callback: (data) => {
                input = Object.assign({}, data);
            }});
        }
    }

    /**
     * Moves the result of the task to the path specified by ResultPath in
     * the task's input according to the state's config.
     * AWS docs on processing of input/output:
     * https://docs.aws.amazon.com/step-functions/latest/dg/input-output-paths.html
     * @param {*} event
     * @param {*} stateInfo
     * @param {string} resultData
     */
    processTaskResultPath(input, stateInfo, resultData) {
        // according to AWS docs:
        // ResultPath (Optional)
        // A path that selects a portion of the state's input to be passed to the state's output.
        // If omitted, it has the value $ which designates the entire input.
        // For more information, see Input and Output Processing.
        // https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-common-fields.html
        const path = typeof stateInfo.ResultPath === 'undefined' ? '$' : stateInfo.ResultPath;
        const processed = jsonPath({ json: resultData, path: path });

        if (typeof processed === 'undefined' || processed.length === 0) {
            return this.endStateMachine(
                new StateRunTimeError(`An error occurred while executing the state '${this.currentStateName}'. Invalid ResultPath '${path}': The ResultPath references an invalid value.`),
                resultData);
        }

        return processed[0];
    }

    /**
     * OutputPath:
     * If OutputPath is **NOT** specified, the entire (original) input is set to output
     * If OutputPath is specified, only the specified node (from the input) is returned
     * If the OutputPath is null, JSON text representing an empty object {} is sent to the next state.
     * If the OutputPath doesn't match an item in the state's input, an exception specifies an invalid path
     * For more information, see Input and Output Processing.
     * https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-common-fields.html
     * @param {*} event
     * @param {*} stateInfo
     */
    processTaskOutputPath(data, path) {
        let output = null;
        if (path !== null) {
            output = jsonPath({ json: data, path: path || '$', })[0];

            if (!output) {
                return this.endStateMachine(
                    new StateRunTimeError(`An error occurred while executing the state '${this.currentStateName}'. Invalid OutputPath '${path}': The Output path references an invalid value.`),
                    data);
            }
        }

        return output;
    }
}

module.exports = StateMachineExecutor;
