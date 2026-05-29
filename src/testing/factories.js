"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMockRecipient = createMockRecipient;
exports.createMockPayment = createMockPayment;
exports.createMockInvoice = createMockInvoice;
var DEFAULT_CREATOR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
var DEFAULT_PAYER = "GCFX3XM4DW6W46YMETX2NV7NZA3V4FS3RJV7G6J4HZ7LTQH5Y4TTWF3T";
var DEFAULT_RECIPIENT = "GDDGZXEOB43ZIYH3FQ6LSQPYBS3K5ZOVBSWJQW3NMOK6PW6JQ5TPK5Y7";
var DEFAULT_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
var SECONDS_PER_DAY = 86400;
function createMockRecipient(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return __assign({ address: DEFAULT_RECIPIENT, amount: 25000000n }, overrides);
}
function createMockPayment(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return __assign({ payer: DEFAULT_PAYER, amount: 10000000n }, overrides);
}
function createMockInvoice(overrides) {
    if (overrides === void 0) { overrides = {}; }
    var now = Math.floor(Date.now() / 1000);
    return __assign({ id: "123", creator: DEFAULT_CREATOR, recipients: [createMockRecipient()], token: DEFAULT_TOKEN, deadline: now + 30 * SECONDS_PER_DAY, funded: 10000000n, status: "Pending", payments: [createMockPayment()] }, overrides);
}
