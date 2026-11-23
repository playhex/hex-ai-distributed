/**
 * Replaces src/shared/logger.ts (winston) in browser, see vite.config.ts.
 */
const logger = {
    debug: (message: string, meta?: object) => console.debug(message, meta ?? ''),
    info: (message: string, meta?: object) => console.info(message, meta ?? ''),
    notice: (message: string, meta?: object) => console.info(message, meta ?? ''),
    warning: (message: string, meta?: object) => console.warn(message, meta ?? ''),
    error: (message: string, meta?: object) => console.error(message, meta ?? ''),
    crit: (message: string, meta?: object) => console.error(message, meta ?? ''),
    alert: (message: string, meta?: object) => console.error(message, meta ?? ''),
    emerg: (message: string, meta?: object) => console.error(message, meta ?? ''),
};

export default logger;
