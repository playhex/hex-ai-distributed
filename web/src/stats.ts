import { storage } from './storage';
import type { AiJobType } from '../../src/shared/protocol';

/*
 * Jobs processed by this browser, kept in localStorage.
 */

const HOUR_MS = 3600_000;

/**
 * Activity graph length.
 */
export const ACTIVITY_HOURS = 7 * 24;

type StoredStats = {
    total: number;
    totalDurationMs: number;

    /**
     * Jobs count by hour (timestamp / HOUR_MS).
     */
    hours: { [hour: number]: number };
};

export type JobHistoryEntry = {
    jobType: AiJobType;
    size: number;
    finishedAt: number;
    durationMs: number;

    /**
     * False if given back to server (stopped), or failed.
     */
    accepted: boolean;
};

/**
 * Also used for stats page, about 100 bytes each.
 */
const HISTORY_LENGTH = 2000;

/**
 * Last jobs, most recent first.
 */
export const getJobHistory = (): JobHistoryEntry[] => storage.get<JobHistoryEntry[]>('jobs') ?? [];

export const recordJobHistory = (entry: JobHistoryEntry): void => {
    storage.set('jobs', [entry, ...getJobHistory()].slice(0, HISTORY_LENGTH));
};

const load = (): StoredStats => storage.get<StoredStats>('stats') ?? { total: 0, totalDurationMs: 0, hours: {} };

let stats = load();
let session = 0;

export const recordJob = (durationMs: number): void => {
    stats = load();

    const hour = Math.floor(Date.now() / HOUR_MS);
    const oldest = hour - ACTIVITY_HOURS - 24;

    stats.total++;
    stats.totalDurationMs += durationMs;
    stats.hours[hour] = (stats.hours[hour] ?? 0) + 1;

    for (const key of Object.keys(stats.hours)) {
        if (Number(key) <= oldest) {
            delete stats.hours[Number(key)];
        }
    }

    session++;
    storage.set('stats', stats);
};

export const getStats = () => ({
    session,
    total: stats.total,
    averageDurationMs: stats.total > 0 ? stats.totalDurationMs / stats.total : 0,
});

/**
 * Jobs count of each local day of last week, oldest first.
 */
export const getActivity = (): { day: Date, count: number }[] => {
    const days = Array.from({ length: 7 }, (_, i) => {
        const day = new Date();
        day.setHours(0, 0, 0, 0);
        day.setDate(day.getDate() - 6 + i);

        return { day, count: 0 };
    });

    for (const [hour, count] of Object.entries(stats.hours)) {
        const time = Number(hour) * HOUR_MS;

        for (let i = 6; i >= 0; i--) {
            if (time >= days[i].day.getTime()) {
                days[i].count += count;
                break;
            }
        }
    }

    return days;
};
