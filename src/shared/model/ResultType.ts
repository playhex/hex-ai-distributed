/**
 * Used for all output types, from worker output to api output.
 */
export type ResultType<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: string;
};
