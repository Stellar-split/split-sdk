"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidTransitionError = exports.InvoiceNotFoundError = void 0;
/** Error thrown when an invoice is not found. */
var InvoiceNotFoundError = /** @class */ (function (_super) {
    __extends(InvoiceNotFoundError, _super);
    function InvoiceNotFoundError(invoiceId) {
        var _this = _super.call(this, "Invoice not found: ".concat(invoiceId)) || this;
        _this.name = "InvoiceNotFoundError";
        return _this;
    }
    return InvoiceNotFoundError;
}(Error));
exports.InvoiceNotFoundError = InvoiceNotFoundError;
/** Error thrown for invalid invoice state transitions. */
var InvalidTransitionError = /** @class */ (function (_super) {
    __extends(InvalidTransitionError, _super);
    function InvalidTransitionError(from, to) {
        var _this = _super.call(this, "Invalid transition from \"".concat(from, "\" to \"").concat(to, "\"")) || this;
        _this.name = "InvalidTransitionError";
        return _this;
    }
    return InvalidTransitionError;
}(Error));
exports.InvalidTransitionError = InvalidTransitionError;
