# Web worker performance

How the browser worker runs hex27x3 fast, and what was tried.
Measured on an NVIDIA Ampere GPU, Linux Chrome, float32 (no `shader-f16`).

## Results

Tree search, stats page benchmark, 11×11:

| Job                          | onnxruntime (start) | Final   | Gain |
|------------------------------|---------------------|---------|------|
| Bot move, visits/s           | 141                 | 413     | ×2.9 |
| Position analysis, visits/s  | 146                 | 393     | ×2.7 |
| Move analysis, visits/s      | 146                 | 405     | ×2.8 |
| Game analysis, intuition     | 435 ms              | 148 ms  | ×2.9 |

Model only, positions/s (experiments.html):

| Board, batch 8 | onnxruntime (start) | onnxruntime, best options | Own shaders | + Winograd |
|----------------|---------------------|---------------------------|-------------|------------|
| 11×11          | 127                 | 164                       | 265         | ~310       |
| 14×14          | -                   | 95                        | 173         | ~230       |

Outputs differ from onnxruntime by at most ~5e-5 on logits.

## Optimizations, in order

1. **onnxruntime options, +20%, then replaced.**
   Batch norms merged into conv weights, static shapes (one session per board size, batches padded).
   No gain from: NHWC or NCHW layout, float16, board size as input, disabled graph optimizations,
   onnxruntime 1.21, Winograd as onnx ops. Graph capture: +2 to 7%, not used.
   Ceiling around 165 positions/s, convs at ~0.8 TFLOPS.

2. **Own WebGPU shaders (`src/network/`), ×1.8.**
   Reads katahex `.bin.gz` directly, no onnx, batch norms merged at load.
   Convs as tiled matrix products in workgroup memory, vec4 accesses (×1.8 vs scalar), 4×4 or 8×4 outputs per thread.
   Bias, residual, next layer batch norm and Mish computed in conv output: ~75 GPU passes instead of ~600.
   Tile chosen by positions per run: 4×4 k 16 below 1500 positions, 8×4 k 32 above.
   One instance for all board and batch sizes.

3. **Pipelined search (`mcts/search.ts`), +8%.**
   Two batches of 8 leaves in flight: GPU computes one while CPU selects and backs up the other.

4. **Winograd F(2,3), +40%.**
   2.25× fewer multiplications for 3×3 convs, which took 85% of GPU time.
   Input transform, 16 matrix products in one pass, output transform with same fused output as convs.
   Transformed weights computed at load. Not faster: input transform fused into matrix products.

## Tools

- `experiments.html`: onnxruntime options vs own shaders on the real model, `?only=profile` gives GPU time by op.
- `kernels.html`: shader variants on a chain of 10 residual blocks (`model-conversion/chain.py`).

## Not verified

- GPUs with `shader-f16`: own shaders run float32, onnxruntime could use float16 there.
- GPUs with 16KB workgroup memory: only small tiles are used.

## Other ideas

Winograd F(4,3) (fewer multiplications, less precise), dedicated 1×1 conv kernel (~15% of GPU time),
hiding remaining ~7ms per run spent outside GPU.
