import type { AiJobType } from '../../src/shared/protocol';
import { JOB_TITLES, JOB_TYPES } from './jobTypes';
import { getJobHistory, type JobHistoryEntry } from './stats';
import { storage } from './storage';
import { getBenchTasks, type BenchResult } from '../../src/shared/benchTasks';
import type { FromWorker, ToWorker } from './messages';

/*
 * Durations of jobs done in this browser: one chart per job type,
 * duration by board size.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 220;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 48 };

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const formatSeconds = (ms: number): string => ms < 1000 ? `${Math.round(ms)}ms` : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;

const el = <K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] => {
    const element = document.createElementNS(SVG_NS, name);

    for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value));
    }

    return element;
};

/**
 * Axis max as 4 round gridline steps.
 */
const niceMax = (max: number): number => {
    const quarter = max / 4;
    const power = 10 ** Math.floor(Math.log10(quarter));
    const step = [1, 2, 5, 10].map(m => m * power).find(m => m >= quarter) ?? quarter;

    return step * 4;
};

const tooltip = document.getElementById('tooltip')!;

const showTooltip = (event: MouseEvent, text: string): void => {
    tooltip.hidden = false;
    tooltip.textContent = text;
    tooltip.style.left = `${event.pageX + 12}px`;
    tooltip.style.top = `${event.pageY - 32}px`;
};

const renderChart = (container: HTMLElement, jobs: JobHistoryEntry[]): void => {
    const width = container.clientWidth;
    const sizes = [...new Set(jobs.map(job => job.size))].sort((a, b) => a - b);
    const maxMs = niceMax(Math.max(...jobs.map(job => job.durationMs)) / 1000) * 1000;

    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const band = plotWidth / sizes.length;
    const x = (size: number): number => MARGIN.left + (sizes.indexOf(size) + 0.5) * band;
    const y = (ms: number): number => MARGIN.top + plotHeight * (1 - ms / maxMs);

    const svg = el('svg', { width, height: HEIGHT, role: 'img' });

    // Gridlines and y labels
    for (let i = 0; i <= 4; ++i) {
        const ms = (maxMs * i) / 4;

        svg.append(el('line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(ms), y2: y(ms), class: i === 0 ? 'axis' : 'grid' }));

        const label = el('text', { x: MARGIN.left - 8, y: y(ms) + 4, 'text-anchor': 'end', class: 'tick' });
        label.textContent = `${Math.round(ms / 1000)}s`;
        svg.append(label);
    }

    for (const size of sizes) {
        const label = el('text', { x: x(size), y: HEIGHT - 8, 'text-anchor': 'middle', class: 'tick' });
        label.textContent = `${size}×${size}`;
        svg.append(label);

        const sizeJobs = jobs.filter(job => job.size === size);

        // Spread dots over band, so that close durations stay visible
        const spread = Math.min(band * 0.6, 60);

        sizeJobs.forEach((job, i) => {
            const offset = sizeJobs.length > 1 ? (((i * 0.618) % 1) - 0.5) * spread : 0;
            const dot = el('circle', { cx: x(size) + offset, cy: y(job.durationMs), r: 4, class: 'dot' });

            dot.addEventListener('mousemove', event => showTooltip(event, `${size}×${size} · ${formatSeconds(job.durationMs)} · ${new Date(job.finishedAt).toLocaleString('en-GB')}`));
            dot.addEventListener('mouseleave', () => tooltip.hidden = true);
            svg.append(dot);
        });

        const medianMs = median(sizeJobs.map(job => job.durationMs));
        const line = el('line', { x1: x(size) - spread / 2 - 6, x2: x(size) + spread / 2 + 6, y1: y(medianMs), y2: y(medianMs), class: 'median' });
        line.addEventListener('mousemove', event => showTooltip(event, `${size}×${size} · median ${formatSeconds(medianMs)} · ${sizeJobs.length} jobs`));
        line.addEventListener('mouseleave', () => tooltip.hidden = true);
        svg.append(line);
    }

    container.innerHTML = '';
    container.append(svg);
};

const render = (): void => {
    const jobs = getJobHistory().filter(job => job.accepted);
    const charts = document.getElementById('charts')!;
    const summary = document.getElementById('summary')!;

    charts.innerHTML = '';
    summary.innerHTML = '';
    document.getElementById('summary-section')!.hidden = jobs.length === 0;

    if (jobs.length === 0) {
        charts.innerHTML = '<p class="stats-intro">No job completed yet.</p>';
        return;
    }

    for (const type of JOB_TYPES) {
        const typeJobs = jobs.filter(job => job.jobType === type);

        if (typeJobs.length === 0) {
            continue;
        }

        const section = document.createElement('section');
        section.className = 'chart';
        section.innerHTML = '<h2></h2><div class="chart-plot"></div>';
        section.querySelector('h2')!.textContent = `${JOB_TITLES[type as AiJobType] ?? type} · ${typeJobs.length} jobs`;
        charts.append(section);
        renderChart(section.querySelector('.chart-plot')!, typeJobs);

        for (const size of [...new Set(typeJobs.map(job => job.size))].sort((a, b) => a - b)) {
            const durations = typeJobs.filter(job => job.size === size).map(job => job.durationMs);
            const tr = document.createElement('tr');

            for (const value of [
                JOB_TITLES[type] ?? type,
                `${size}×${size}`,
                String(durations.length),
                formatSeconds(median(durations)),
                formatSeconds(durations.reduce((a, b) => a + b, 0) / durations.length),
                formatSeconds(Math.max(...durations)),
            ]) {
                const td = document.createElement('td');
                td.textContent = value;
                tr.append(td);
            }

            summary.append(tr);
        }
    }
};

render();

let resizeTimeout: undefined | ReturnType<typeof setTimeout>;

window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(render, 100);
});

// Jobs done in worker tab
window.addEventListener('storage', render);

/*
 * Benchmark: same jobs on every worker, see benchTasks.ts.
 */

const benchKey = (result: Pick<BenchResult, 'type' | 'size'>): string => `${result.type} ${result.size}`;

/**
 * Last web results, kept to compare without running again.
 */
let webBench = new Map((storage.get<BenchResult[]>('benchResults') ?? []).map(result => [benchKey(result), result]));

let modelBench: { batchSize: number, msPerRun: number }[] = storage.get('benchModel') ?? [];

/**
 * Environment and where time goes in each job, to debug slow workers later.
 */
let benchDebug: string[] = storage.get('benchDebug') ?? [];

const renderBenchDebug = (): void => {
    const container = document.getElementById('bench-debug')!;

    container.innerHTML = '';

    for (const line of benchDebug) {
        const div = document.createElement('div');
        div.textContent = line;
        container.append(div);
    }
};

const environment = (): string => {
    const nav = navigator as Navigator & { deviceMemory?: number, userAgentData?: { brands: { brand: string, version: string }[], platform: string } };
    const browser = nav.userAgentData?.brands.filter(({ brand }) => !/not.?a.?brand/i.test(brand)).map(({ brand, version }) => `${brand} ${version}`).join(', ') ?? nav.userAgent;

    return [browser, nav.userAgentData?.platform, `${nav.hardwareConcurrency} CPU threads`, nav.deviceMemory ? `${nav.deviceMemory}GB memory` : null]
        .filter(Boolean).join(' · ');
};

const renderModelBench = (): void => {
    const tbody = document.getElementById('bench-model')!;

    tbody.innerHTML = '';

    for (const { batchSize, msPerRun } of modelBench) {
        const tr = document.createElement('tr');

        for (const value of ['', String(batchSize), `${msPerRun.toFixed(1)}ms`, String(Math.round(batchSize * 1000 / msPerRun))]) {
            const td = document.createElement('td');
            td.textContent = value;
            tr.append(td);
        }

        tbody.append(tr);
    }
};

const renderBench = (): void => {
    const tbody = document.getElementById('bench')!;

    tbody.innerHTML = '';

    for (const task of getBenchTasks()) {
        const size = 'game' in task.data ? task.data.game.size : task.data.size;
        const web = webBench.get(benchKey({ type: task.type, size }));
        const tr = document.createElement('tr');

        for (const value of [
            JOB_TITLES[task.type as AiJobType] ?? task.type,
            `${size}×${size}`,
            web ? formatSeconds(web.durationMs) : '–',
            web?.visitsPerSecond ? String(web.visitsPerSecond) : '–',
        ]) {
            const td = document.createElement('td');
            td.textContent = value;
            tr.append(td);
        }

        tbody.append(tr);
    }
};

const runBenchButton = document.getElementById('bench-run') as HTMLButtonElement;
const benchStatus = document.getElementById('bench-status')!;

runBenchButton.addEventListener('click', () => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const total = getBenchTasks().length;
    let done = 0;
    let engine = '';

    runBenchButton.disabled = true;
    benchStatus.textContent = 'Loading model, warming up…';
    webBench = new Map();
    modelBench = [];
    benchDebug = [environment()];
    renderBench();
    renderModelBench();
    renderBenchDebug();

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const message = event.data;

        switch (message.type) {
            case 'benchResult':
                webBench.set(benchKey(message.result), message.result);
                benchStatus.textContent = `${++done} / ${total} jobs`;
                renderBench();
                break;

            case 'benchModel':
                modelBench.push({ batchSize: message.batchSize, msPerRun: message.msPerRun });
                renderModelBench();
                break;

            case 'gpu':
                engine = message.engine;
                benchDebug.push(
                    `GPU ${message.name} · ${message.float16 ? 'float16' : 'float32'} · loaded in ${formatSeconds(message.loadMs)}`,
                    `Engine ${message.engine} (${message.details.join(', ')})`,
                );
                renderBenchDebug();
                break;

            case 'benchStats': {
                const { jobType, modelBusyPercent, runs, positionsPerRun, cacheHitPercent } = message;

                benchDebug.push([
                    `${JOB_TITLES[jobType] ?? jobType}: model busy ${modelBusyPercent}% of time`,
                    `${runs} runs of ${positionsPerRun.toFixed(1)} positions`,
                    cacheHitPercent === null ? null : `${cacheHitPercent}% cache hits`,
                ].filter(Boolean).join(', '));
                renderBenchDebug();
                break;
            }

            case 'noGpu':
                benchStatus.textContent = 'No GPU available with WebGPU';
                break;

            case 'error':
                benchStatus.textContent = `Error: ${message.message}`;
                break;

            case 'benchDone':
                storage.set('benchResults', [...webBench.values()]);
                storage.set('benchModel', modelBench);
                storage.set('benchDebug', benchDebug);
                runBenchButton.disabled = false;

                if (done === total && modelBench.length > 0) {
                    benchStatus.textContent = `Done, with ${engine}`;
                }

                worker.terminate();
                break;
        }
    };

    worker.postMessage({ type: 'bench' } satisfies ToWorker);
});

renderBench();
renderModelBench();
renderBenchDebug();
