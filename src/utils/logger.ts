import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

const options: pino.LoggerOptions = {
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
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

export const logger = pino(options);

/* logger خام برای Baileys (خاموش) */
export const silentLogger = pino({ level: 'silent' });
