const required = (name: keyof ImportMetaEnv, value: undefined | string): string => {
    if (!value) {
        throw new Error(`Missing ${name}, see .env.dist`);
    }

    return value;
};

/**
 * Set at build time: .env in development, .env.playhex.prod for published build.
 */
export const config = {
    playhexUrl: required('VITE_PLAYHEX_URL', import.meta.env.VITE_PLAYHEX_URL).replace(/\/+$/, ''),
    oauthClientId: required('VITE_OAUTH_CLIENT_ID', import.meta.env.VITE_OAUTH_CLIENT_ID),

    /**
     * float16 model, see model-conversion/.
     */
    modelUrl: required('VITE_MODEL_URL', import.meta.env.VITE_MODEL_URL),

    /**
     * For GPU without float16 support.
     */
    modelUrlFloat32: required('VITE_MODEL_URL_FLOAT32', import.meta.env.VITE_MODEL_URL_FLOAT32),

    /**
     * Katahex model file, for WebGpuNetwork. Onnx models are a fallback if it fails.
     */
    katahexModelUrl: required('VITE_KATAHEX_MODEL_URL', import.meta.env.VITE_KATAHEX_MODEL_URL),
};
