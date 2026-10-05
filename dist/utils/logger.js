"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.silentLogger = exports.logger = void 0;
const pino_1 = __importDefault(require("pino"));
const level = process.env.LOG_LEVEL || 'info';
const options = {
    level,
    timestamp: pino_1.default.stdTimeFunctions.isoTime,
    redact: {
        /* هرگز محتوای سشن وارد log نشود */
        paths: ['req.headers.authorization', 'headers.authorization', '*.creds', '*.session', '*.noiseKey', '*.advSecretKey'],
        censor: '[REDACTED]'
    },
    base: { service: 'wa-multibot' }
};
if (process.env.NODE_ENV !== 'production') {
    options.transport = {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' }
    };
}
exports.logger = (0, pino_1.default)(options);
/* logger خام برای Baileys (خاموش) */
exports.silentLogger = (0, pino_1.default)({ level: 'silent' });
