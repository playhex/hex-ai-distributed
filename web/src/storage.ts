/**
 * localStorage as json, never throws: storage may be unavailable (private mode, blocked).
 */
const PREFIX = 'hex-web-worker:';

export const storage = {
    get<T>(key: string): null | T {
        try {
            const value = localStorage.getItem(PREFIX + key);

            return value === null ? null : JSON.parse(value) as T;
        } catch {
            return null;
        }
    },

    set(key: string, value: unknown): void {
        try {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
        } catch {
            // Not persisted, still works for this session
        }
    },

    remove(key: string): void {
        try {
            localStorage.removeItem(PREFIX + key);
        } catch {
            // Nothing to remove
        }
    },
};
