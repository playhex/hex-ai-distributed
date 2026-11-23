# Katahex model to ONNX

Converts a katahex model (`.bin.gz`, model version 11, like `hex27x3.bin.gz`) to ONNX,
to run it in a browser with onnxruntime-web (see `web/`).

The network is rebuilt layer by layer from the katahex model file format
(`katahex/cpp/neuralnet/desc.cpp`) and forward pass (`eigenbackend.cpp`).
Boards are evaluated at their exact size, without padding.

| Input     | Shape          |                                                                       |
|-----------|----------------|-----------------------------------------------------------------------|
| `spatial` | `[N, 22, H, W]` | plane 0: on board, 1: stones of player to play, 2: opponent stones   |
| `global`  | `[N, 19]`       | 0: 1 if white to play                                                |

When white is to play, board is transposed (`spatial[n, c, x, y]`), and policy must be transposed back, like katahex does.

| Output   | Shape          |                                                               |
|----------|----------------|---------------------------------------------------------------|
| `policy` | `[N, H*W + 1]` | logits, cells `y * W + x`, then pass                          |
| `value`  | `[N, 3]`       | logits of win, loss, no result, for player to play           |

## Convert

``` bash
cd model-conversion

# No venv needed, dependencies in a local folder
python3 -m pip install --target .deps onnx onnxruntime numpy

PYTHONPATH=.deps python3 bin_to_onnx.py hex27x3.bin.gz out/hex27x3.onnx --fp16 out/hex27x3.fp16.onnx
```

## Check against katahex

Compares policy and win rate with `kata-raw-nn` on random positions, black and white to play:

``` bash
# Worker config, with float32 on GPU and default policy temperature
sed -e '/^nnPolicyTemperature/d' -e 's/^logDir.*/logDir = out\/gtp_logs/' ../katahex/config.cfg > out/compare.cfg
echo "cudaUseFP16 = false" >> out/compare.cfg

PYTHONPATH=.deps python3 compare.py path/to/katahex hex27x3.bin.gz out/hex27x3.onnx
PYTHONPATH=.deps python3 compare.py path/to/katahex hex27x3.bin.gz out/hex27x3.fp16.onnx --tolerance 0.05
```

With `hex27x3.bin.gz`, on board sizes 5 to 32: max difference is 5e-4 for float32, 1e-3 for float16, and best move is always the same.

## Publish

Copy `hex27x3.fp16.onnx` to PlayHex `var/katahex-models/`, served at `https://playhex.org/katahex-models/hex27x3.fp16.onnx`.
