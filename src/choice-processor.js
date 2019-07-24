const _ = require('lodash');
const jsonPath = require('JSONPath');
const StateMachineError = require('./state-machine-error');

// The following comparison operators are supported:
// - And
// - BooleanEquals
// - Not
// - NumericEquals
// - NumericGreaterThan
// - NumericGreaterThanEquals
// - NumericLessThan
// - NumericLessThanEquals
// - Or
// - StringEquals
// - StringGreaterThan
// - StringGreaterThanEquals
// - StringLessThan
// - StringLessThanEquals
// - TimestampEquals
// - TimestampGreaterThan
// - TimestampGreaterThanEquals
// - TimestampLessThan
// - TimestampLessThanEquals

class ChoiceProcessor {
    processChoice(stateInfo, input) {
        let nextState = null;
        // AWS docs:
        // Step Functions examines each of the Choice Rules in the order listed
        // in the Choices field and transitions to the state specified in the
        // Next field of the first Choice Rule in which the variable matches the
        // value according to the comparison operator
        // https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-choice-state.html
        _.forEach(stateInfo.Choices, (choice) => {
            const keys = Object.keys(choice);
            let choiceComparator = '';
            if (choice.Not) {
                choiceComparator = 'Not';
                choice = choice.Not;
            } else if (choice.And) {
                if (this.evaluateAnd(choice.And) === true) {
                    nextState = choice.Next;
                    return false // short circuit forEach
                }
            } else if (choice.Or) {
                if (this.evaluateOr(choice.Or) === true) {
                    nextState = choice.Next;
                    return false // short circuit forEach
                }
            } else {
                choiceComparator = _.filter(keys, key => key !== 'Variable' && key !== 'Next');

                if (choiceComparator.length > 1) {
                    throw new StateMachineError('mulitple choice comparison keys found');
                }

                choiceComparator = choiceComparator[0];

                if (this.evaluateChoice(choiceComparator, choice, input)) {
                    nextState = choice.Next;
                    return false; // short circuit forEach
                }
            }


        });

        if (nextState !== null) {
            return nextState;
        }

        if (stateInfo.Default) {
            return stateInfo.Default;
        }

        throw new StateMachineError('No "next" state found - try adding a "Default" option');
    }

    evaluateAnd(comparisons) {
        let andResult = true;
        // choice will contain an array of choice rules
        _.forEach(choice, (item) => {
            const comparator = this.getChoiceComparator(choice);
            if (!this.processChoice(comparator, item, data)) {
                // since this is an AND, if any item is false, the statement will be false
                andResult = false;
                return false; // short circuit forEach
            }
        });
        return andResult;
    }

    evaluateOr(comparisons) {
        let orResult = false;
        // choice will contain an array of choice rules
        _.forEach(choice, (item) => {
            const comparator = this.getChoiceComparator(choice);
            if (this.processChoice(comparator, item, data)) {
                // since this is an OR, if any item is true, the statement will be true
                orResult = true;
                return false; // short circuit forEach
            }
        });
        return orResult;
    }

    evaluateChoice(choiceComparator, choice, data) {
        if (!choice.Variable) {
            throw new Error('no "Variable" attribute found in Choice rule');
        }

        let inputValue = jsonPath({ json: data, path: choice.Variable})[0];
        let choiceValue = choice[choiceComparator];
        if (choice[choiceComparator] === 'TimestampEquals' === 0) {
            choiceValue = (new Date(choiceValue)).getTime();
            inputValue = (new Date(inputValue)).getTime();
        }

        // For each of these operators, the corresponding value must be of the
        // appropriate type: string, number, Boolean, or timestamp. Step Functions
        // doesn't attempt to match a numeric field to a string value. However,
        // because timestamp fields are logically strings, it is possible that a
        // field considered to be a timestamp can be matched by a StringEquals comparator.
        switch(choiceComparator) {
            case 'BooleanEquals':
            case 'NumericEquals':
            case 'StringEquals':
            case 'TimestampEquals':
                return this.checkEquals(choiceValue, inputValue);
            case 'NumericGreaterThan':
            case 'StringGreaterThan':
            case 'TimestampGreaterThan':
                return this.checkGT(choiceValue, inputValue);
            case 'NumericGreaterThanEquals':
            case 'StringGreaterThanEquals':
            case 'TimestampGreaterThanEquals':
                return this.checkGTE(choiceValue, inputValue);
            case 'NumericLessThan':
            case 'StringLessThan':
            case 'TimestampLessThan':
                return this.checkLT(choiceValue, inputValue);
            case 'NumericLessThanEquals':
            case 'StringLessThanEquals':
            case 'TimestampLessThanEquals':
                return this.checkLTE(choiceValue, inputValue);
            case 'Not':
                const name = _.filter(keys, key => key !== 'Variable' && key !== 'Next');
                return !this.processChoice(name, choice, data);
        }
    }

    checkEquals(choiceValue, inputValue) {
        return choiceValue === inputValue;
    }

    checkGT(choice, inputValue) {
        return +inputValue > +choice.NumericGreaterThan;
    }

    checkGTE(choice, inputValue) {
        return +inputValue >= +choice.NumericGreaterThan;
    }

    checkLT(choice, inputValue) {
        return +inputValue < +choice.NumericLessThan;
    }

    checkLTE(choice, inputValue) {
        return +inputValue <= +choice.NumericLessThan;
    }

    getChoiceComparator(choice) {
        const keys = Object.keys(choice);
        choiceComparator = _.filter(keys, key => key !== 'Variable' && key !== 'Next');

        if (choiceComparator.length > 1) {
            throw new Error('mulitple choice comparison keys found');
        }

        return choiceComparator[0];
    }
}

module.exports = new ChoiceProcessor();
