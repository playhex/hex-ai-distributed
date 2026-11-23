import iconPlay from 'bootstrap-icons/icons/play-fill.svg?raw';
import iconStop from 'bootstrap-icons/icons/stop-fill.svg?raw';
import iconOk from 'bootstrap-icons/icons/check-square-fill.svg?raw';
import iconKo from 'bootstrap-icons/icons/exclamation-square-fill.svg?raw';
import iconPending from 'bootstrap-icons/icons/square.svg?raw';
import iconGithub from 'bootstrap-icons/icons/github.svg?raw';
import iconLogout from 'bootstrap-icons/icons/box-arrow-right.svg?raw';
import iconStats from 'bootstrap-icons/icons/bar-chart.svg?raw';
import iconHexagonFill from 'bootstrap-icons/icons/hexagon-fill.svg?raw';
import type { AiJobType } from '../../src/shared/protocol';
import { DEFAULT_JOB_TYPES, JOB_ICONS, JOB_TITLES, JOB_TYPES } from './jobTypes';
import { handleLoginCallback, login, type AiWorkerKey } from './auth';
import { storage } from './storage';
import { getActivity, getJobHistory, getStats, recordJob, recordJobHistory } from './stats';
import { detectGpu, type GpuDetection } from './gpu';
import { config } from './config';
import type { FromWorker, ToWorker, WorkerState } from './messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const app = document.querySelector<HTMLElement>('.app')!;





const GPU_ERRORS: Record<Exclude<GpuDetection, { ok: true }>['reason'], string> = {
    unsupported: 'WebGPU not available in this browser',
    noAdapter: 'WebGPU found no GPU',
    software: 'WebGPU only found a software GPU',
};

/**
 * How to enable WebGPU, for current browser.
 */
const gpuHelpUrl = (): string => {
    const wiki = 'https://github.com/gpuweb/gpuweb/wiki/Implementation-Status';
    const ua = navigator.userAgent;

    if (ua.includes('Firefox')) {
        return `${wiki}#firefox`;
    }

    if (ua.includes('Chrome')) {
        return `${wiki}#chromium-chrome-edge-etc`;
    }

    if (ua.includes('Safari')) {
        return `${wiki}#safari`;
    }

    return wiki;
};

/*
 * State
 */

/**
 * starting, stopping: click acknowledged, waiting for compute worker.
 */
type UiState = 'login' | 'starting' | 'stopping' | WorkerState;

let keys: AiWorkerKey[] = storage.get<AiWorkerKey[]>('keys') ?? [];
let selectedKey: null | string = storage.get<string>('selectedKey');
let state: UiState = keys.length > 0 ? 'stopped' : 'login';
let jobTypes: AiJobType[] = (storage.get<AiJobType[]>('jobTypes') ?? DEFAULT_JOB_TYPES).filter(type => JOB_TYPES.includes(type));

/**
 * Logged in, but account has no enabled key.
 */
let noKey = false;

/**
 * Pseudo of logged in PlayHex account, if known.
 */
let account: null | string = storage.get<string>('account');
let gpu: null | GpuDetection = null;

let job: null | { jobType: AiJobType, size: number, startedAt: number } = null;
/**
 * Null ratio: unknown duration.
 */
let progress: null | { ratio: null | number, text: string } = null;

const currentKey = (): null | string => keys.find(k => k.key === selectedKey)?.key ?? keys[0]?.key ?? null;

let worker: null | Worker = null;

const send = (message: ToWorker): void => worker?.postMessage(message);

/*
 * Rendering
 */

const boardSize = (size: number): string => `${size}×${size}`;

const setCheck = (id: string, status: 'ok' | 'ko' | 'pending', label: string): void => {
    const check = $(id);
    check.className = `check ${status}`;
    check.querySelector('.check-icon')!.innerHTML = status === 'ok' ? iconOk : status === 'ko' ? iconKo : iconPending;
    check.querySelector('.check-label')!.textContent = label;
};

const renderChecklist = (): boolean => {
    const loggedIn = keys.length > 0;
    const connected = loggedIn || noKey;

    setCheck('check-login', connected ? 'ok' : 'ko', connected ? (account ? 'Connected with account ' : 'Connected') : 'Not logged in');

    if (connected && account) {
        const pseudo = document.createElement('strong');
        pseudo.textContent = account;
        $('check-login').querySelector('.check-label')!.append(pseudo);
    }

    setCheck('check-key', 'ko', 'No AI worker key on this account, ask PlayHex admins for one');
    $('check-key').hidden = !noKey;

    if (gpu === null) {
        setCheck('check-gpu', 'pending', 'Checking GPU…');
    } else if (gpu.ok) {
        setCheck('check-gpu', 'ok', 'WebGPU');
    } else {
        setCheck('check-gpu', 'ko', GPU_ERRORS[gpu.reason]);
    }

    $('gpu-help').hidden = gpu === null || gpu.ok;

    setCheck('check-jobs', 'ko', 'No job type selected');
    $('check-jobs').hidden = jobTypes.length > 0;

    const ready = loggedIn && gpu !== null && gpu.ok && jobTypes.length > 0;

    $('checklist').hidden = ready;

    return ready;
};

const statusTexts = (): [title: string, detail: string] => {
    switch (state) {
        case 'login':
        case 'stopped': return ['Not connected', ''];
        case 'starting': return ['Starting…', ''];
        case 'stopping': return ['Stopping…', ''];
        case 'loading': return ['Loading model', progress?.text ?? 'Starting on GPU…'];
        case 'waiting': return ['Connected', 'Waiting for a job'];
        case 'working': return ['Connected', job ? [JOB_TITLES[job.jobType] ?? job.jobType, boardSize(job.size), progress?.text].filter(Boolean).join(' · ') : ''];
        case 'offline': return ['Reconnecting…', 'PlayHex unreachable'];
    }
};

let ringRatio = 0;

const renderRing = (ratio: number): void => {
    const ring = $('ring-progress');

    // Next job restarts from 0 instantly, instead of animating back down
    ring.style.transition = ratio < ringRatio ? 'none' : '';
    ring.style.strokeDashoffset = String(1 - ratio);
    ring.style.opacity = ratio > 0 ? '1' : '0';

    if (ratio < ringRatio) {
        // Apply now, so that next increase animates from 0
        void getComputedStyle(ring).strokeDashoffset;
    }

    ringRatio = ratio;
};

const render = (): void => {
    app.dataset.state = state;

    const ready = renderChecklist();
    const running = state !== 'stopped' && state !== 'login';
    const toggle = $<HTMLButtonElement>('toggle');
    const [title, detail] = statusTexts();

    toggle.disabled = (!running && !ready) || state === 'stopping';
    $('toggle-icon').innerHTML = running ? iconStop : iconPlay;
    $('toggle-label').textContent = running ? 'Stop' : 'Start';
    toggle.setAttribute('aria-label', running ? 'Stop' : 'Start');

    renderRing(state === 'working' ? Math.max(0, Math.min(1, progress?.ratio ?? 0)) : 0);

    // Model download, then GPU initialization
    const loadingRatio = state === 'loading' ? progress?.ratio ?? null : null;
    // Space kept so that button does not move
    $('progress').style.visibility = state === 'loading' || state === 'starting' ? 'visible' : 'hidden';
    $('progress').classList.toggle('indeterminate', loadingRatio === null);
    $('progress-fill').style.width = `${(loadingRatio ?? 0) * 100}%`;

    $('status-text').textContent = title;
    document.title = `${state === 'waiting' || state === 'working' ? '🟢 ' : ''}${title} · PlayHex AI worker`;
    $('status-detail').textContent = detail;
    $('forget').hidden = keys.length === 0 && !noKey;
};

const renderKeys = (): void => {
    const select = $<HTMLSelectElement>('key');

    // Choice only shown with multiple keys
    $('key-field').hidden = keys.length < 2;
    select.innerHTML = '';

    for (const key of keys) {
        const option = document.createElement('option');
        option.value = key.key;
        option.textContent = key.name;
        option.selected = key.key === currentKey();
        select.append(option);
    }
};

const renderJobTypes = (): void => {
    const container = $('job-types');
    container.innerHTML = '';

    for (const type of JOB_TYPES) {
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox">${JOB_ICONS[type] ?? ''}<span></span>`;
        label.querySelector('span')!.textContent = JOB_TITLES[type] ?? type;

        const checkbox = label.querySelector('input')!;
        checkbox.checked = jobTypes.includes(type);
        checkbox.addEventListener('change', () => {
            // Keep priority order
            jobTypes = JOB_TYPES.filter(t => t === type ? checkbox.checked : jobTypes.includes(t));
            storage.set('jobTypes', jobTypes);

            if (jobTypes.length > 0) {
                send({ type: 'setJobTypes', jobTypes });
            } else if (state !== 'stopped' && state !== 'login') {
                // Nothing to take
                state = 'stopping';
                send({ type: 'stop' });
            }

            render();
        });

        container.append(label);
    }
};

const formatDuration = (ms: number): string => ms === 0 ? '–' : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}min`;

const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Current job first, then last jobs, with duration of each.
 */
/**
 * Finished jobs shown in list, more with "Show more".
 */
let jobsShown = 5;

const renderJobs = (): void => {
    const rows: { jobType: AiJobType, size: number, durationMs: number, time: string, className: string }[] = [];

    if (job !== null) {
        rows.push({ ...job, durationMs: Date.now() - job.startedAt, time: 'now', className: 'current' });
    }

    const history = getJobHistory();

    for (const entry of history.slice(0, jobsShown)) {
        rows.push({ ...entry, time: formatTime(entry.finishedAt), className: entry.accepted ? '' : 'given-back' });
    }

    $('jobs').hidden = rows.length === 0;
    $('jobs-more').hidden = history.length <= jobsShown;
    $('jobs-list').innerHTML = '';

    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.className = row.className;
        tr.title = row.className === 'given-back' ? 'Not completed, given back' : '';
        tr.innerHTML = `<td class="job-icon">${JOB_ICONS[row.jobType] ?? ''}</td><td class="job-type"></td><td class="job-size num"></td><td class="job-duration num"></td><td class="job-time num"></td>`;
        tr.querySelector('.job-type')!.textContent = JOB_TITLES[row.jobType] ?? row.jobType;
        tr.querySelector('.job-size')!.textContent = boardSize(row.size);
        tr.querySelector('.job-duration')!.textContent = formatDuration(row.durationMs);
        tr.querySelector('.job-time')!.textContent = row.time;
        $('jobs-list').append(tr);
    }
};

const renderStats = (): void => {
    const { session, total, averageDurationMs } = getStats();

    $('stat-session').textContent = String(session);
    $('stat-total').textContent = String(total);
    $('stat-duration').textContent = formatDuration(averageDurationMs);

    const activity = getActivity();
    const max = Math.max(1, ...activity.map(d => d.count));

    $('activity').innerHTML = activity.map(({ day, count }) => `
        <div class="day" title="${count}">
            <span class="day-bar"><span class="${count === 0 ? 'empty' : ''}" style="height: ${(count / max) * 100}%"></span></span>
            <span class="day-label">${day.toLocaleDateString('en', { weekday: 'narrow' })}</span>
        </div>
    `).join('');
};

/**
 * Technical info, bottom of sidebar.
 */
const debugInfo: { gpu?: string, model?: string, engine?: string } = {};

const renderDebug = (): void => {
    const lines = [
        debugInfo.gpu ? `GPU ${debugInfo.gpu}` : null,
        debugInfo.model ? `Model ${debugInfo.model}` : null,
        debugInfo.engine ? `Engine ${debugInfo.engine}` : null,
        config.playhexUrl !== 'https://playhex.org' ? `Server ${config.playhexUrl.replace(/^https?:\/\//, '')}` : null,
    ];

    $('debug').innerHTML = '';

    for (const line of lines.filter(Boolean)) {
        const div = document.createElement('div');
        div.textContent = line;
        $('debug').append(div);
    }
};

/*
 * Compute worker
 */

const onWorkerMessage = (message: FromWorker): void => {
    switch (message.type) {
        case 'state':
            state = message.state;

            if (state !== 'working' && state !== 'loading') {
                job = null;
                progress = null;
                renderJobs();
            }

            render();
            break;

        case 'gpu':
            debugInfo.gpu = message.name;
            debugInfo.model = `hex27x3, ${message.float16 ? 'float16' : 'float32'}`;
            debugInfo.engine = `${message.engine === 'WebGpuNetwork' ? 'WebGPU, no onnx' : 'onnxruntime'} (${message.details.join(', ')})`;
            renderDebug();
            break;

        case 'noGpu':
            gpu = message.detection;
            render();
            break;

        case 'modelProgress': {
            const mb = (bytes: number) => (bytes / 1e6).toFixed(0);
            const downloaded = message.total > 0 && message.loaded >= message.total;
            progress = downloaded ? null : {
                ratio: message.total > 0 ? message.loaded / message.total : null,
                text: message.total > 0 ? `Downloading ${mb(message.loaded)} / ${mb(message.total)} MB` : `Downloading ${mb(message.loaded)} MB`,
            };
            render();
            break;
        }

        case 'job':
            job = { jobType: message.jobType, size: message.size, startedAt: Date.now() };
            // Intuition jobs: no tree search
            progress = message.maxPlayouts > 0 ? { ratio: 0, text: `0 / ${message.maxPlayouts}` } : null;
            render();
            renderJobs();
            break;

        case 'playouts':
            progress = {
                ratio: message.maxPlayouts > 0 ? message.playouts / message.maxPlayouts : 0,
                text: `${message.playouts} / ${message.maxPlayouts}`,
            };
            render();
            break;

        case 'jobDone':
            if (message.accepted) {
                recordJob(message.durationMs);
            }

            recordJobHistory({
                jobType: message.jobType,
                size: message.size,
                finishedAt: Date.now(),
                durationMs: message.durationMs,
                accepted: message.accepted,
            });
            job = null;
            renderStats();
            renderJobs();
            break;

        case 'unauthorized':
            // Key revoked: log in again to get current keys
            keys = keys.filter(key => key.key !== currentKey());
            storage.set('keys', keys);
            state = keys.length > 0 ? 'stopped' : 'login';
            renderKeys();
            render();
            break;

        case 'error':
            console.error(message.message);
            $('status-detail').textContent = message.message;
            break;
    }
};

const getWorker = (): Worker => {
    if (worker === null) {
        worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = event => onWorkerMessage(event.data as FromWorker);
    }

    return worker;
};

const start = (): void => {
    const key = currentKey();

    if (key === null) {
        return;
    }

    getWorker();
    state = 'starting';
    render();
    send({ type: 'start', key, jobTypes });
};

/*
 * Events
 */

$('login').addEventListener('click', () => void login());
$('login-again').addEventListener('click', () => void login());

$('toggle').addEventListener('click', () => {
    if (state === 'stopped') {
        start();
        return;
    }

    state = 'stopping';
    render();
    send({ type: 'stop' });
});

$<HTMLSelectElement>('key').addEventListener('change', event => {
    selectedKey = (event.target as HTMLSelectElement).value;
    storage.set('selectedKey', selectedKey);

    // Restart with new key
    if (state !== 'stopped' && state !== 'login') {
        send({ type: 'stop' });
        const restart = (e: MessageEvent<FromWorker>) => {
            if (e.data.type === 'state' && e.data.state === 'stopped') {
                worker?.removeEventListener('message', restart);
                start();
            }
        };
        worker?.addEventListener('message', restart);
    }
});

const logout = (): void => {
    send({ type: 'stop' });
    keys = [];
    noKey = false;
    account = null;
    storage.remove('keys');
    storage.remove('account');
    storage.remove('selectedKey');
    state = 'login';
    renderKeys();
    render();
};

$('forget').addEventListener('click', logout);
$('logout').addEventListener('click', logout);

// Give back current job when tab closes
window.addEventListener('pagehide', () => send({ type: 'stop' }));

setInterval(renderStats, 60_000);

// Current job duration
setInterval(() => job !== null && renderJobs(), 160);

$('jobs-more').addEventListener('click', () => {
    jobsShown += 40;
    renderJobs();
});

/*
 * Init
 */

$('brand-icon').innerHTML = iconHexagonFill;
$('github-icon').innerHTML = iconGithub;
$('logout-icon').innerHTML = iconLogout;
$('stats-icon').innerHTML = iconStats;
$<HTMLAnchorElement>('gpu-help').href = gpuHelpUrl();


renderKeys();
renderJobTypes();
renderDebug();
renderJobs();
renderStats();
render();

void detectGpu().then(detection => {
    gpu = detection;

    if (detection.ok) {
        debugInfo.gpu = detection.name;

        // Load onnxruntime now, so that start is faster
        getWorker();
    } else {
        debugInfo.gpu = `none (${detection.reason}${detection.name ? `, ${detection.name}` : ''})`;
    }

    renderDebug();
    render();
    app.classList.add('ready');
});

// Shown when GPU check is done, to not flash a disabled button
setTimeout(() => app.classList.add('ready'), 1500);

handleLoginCallback().then(result => {
    if (result === null) {
        return;
    }

    keys = result.keys;
    account = result.account;
    noKey = keys.length === 0;
    storage.set('keys', keys);
    storage.set('account', account);
    state = keys.length > 0 ? 'stopped' : 'login';
    renderKeys();
    render();
}).catch(e => {
    console.error(e);
    $('status-detail').textContent = `Login failed: ${e instanceof Error ? e.message : String(e)}`;
});
