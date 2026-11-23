/*
 * WebGPU detection, shared by page and compute worker.
 */

export type GpuAdapter = {
    features: Set<string>;
    isFallbackAdapter?: boolean;
    info?: { vendor?: string, architecture?: string, description?: string, isFallbackAdapter?: boolean };
};

export type GpuDetection =
    | { ok: true, adapter: GpuAdapter, name: string }
    | { ok: false, reason: 'unsupported' | 'noAdapter' | 'software', name?: string };

const adapterName = (adapter: GpuAdapter): string =>
    adapter.info?.description || [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || 'GPU';

/**
 * Hardware WebGPU adapter. Software ones (SwiftShader, llvmpipe) are too slow for tree search.
 */
export const detectGpu = async (): Promise<GpuDetection> => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(options?: object): Promise<null | GpuAdapter> } }).gpu;

    if (!gpu) {
        return { ok: false, reason: 'unsupported' };
    }

    // Hybrid laptops: discrete GPU may be unsupported while integrated one works
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
        ?? await gpu.requestAdapter().catch(() => null);

    if (adapter === null) {
        return { ok: false, reason: 'noAdapter' };
    }

    const name = adapterName(adapter);
    const software = adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter || /swiftshader|llvmpipe|lavapipe/i.test(name + (adapter.info?.architecture ?? ''));

    return software ? { ok: false, reason: 'software', name } : { ok: true, adapter, name };
};
