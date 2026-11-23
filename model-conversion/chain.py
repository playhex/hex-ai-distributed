"""
Chain of ordinary residual blocks with random weights, to compare onnxruntime with custom WebGPU kernels
(web/kernels.html). Same ops as hex27x3 trunk: x += conv(mish(conv(mish(x * s + b)) + b1)) + b2.

Writes chain.onnx, and chain.bin: float32 s0, b0, then per block w1, b1, w2, b2, s, b,
conv weights as [ky, kx, ic, oc].

PYTHONPATH=.deps python3 chain.py out/variants
"""
import argparse
import os

import numpy as np
import onnx
from onnx import TensorProto, helper

from bin_to_onnx import OPSET, Graph

CHANNELS = 192
BLOCKS = 10

parser = argparse.ArgumentParser()
parser.add_argument('output_dir')
args = parser.parse_args()

rng = np.random.default_rng(0)
g = Graph(np.float32)
raw = []


def vector(mean: float, std: float) -> np.ndarray:
    v = rng.normal(mean, std, CHANNELS).astype(np.float32)
    raw.append(v)
    return v


def bn_mish(x: str) -> str:
    s, b = vector(1, 0.1), vector(0, 0.1)
    x = g.op('Add', [g.op('Mul', [x, g.const(s.reshape(1, -1, 1, 1))]), g.const(b.reshape(1, -1, 1, 1))])
    return g.act(x, 'ACTIVATION_MISH')


def conv(x: str) -> str:
    w = rng.normal(0, 0.5 / np.sqrt(9 * CHANNELS), (CHANNELS, CHANNELS, 3, 3)).astype(np.float32)
    raw.append(w.transpose(2, 3, 1, 0))
    b = vector(0, 0.1)
    return g.op('Conv', [x, g.const(w), g.const(b)], strides=[1, 1], pads=[1, 1, 1, 1])


x = 'x'
a = bn_mish(x)
for _ in range(BLOCKS):
    h = g.act(conv(a), 'ACTIVATION_MISH')
    x = g.op('Add', [x, conv(h)], 'residual')
    a = bn_mish(x)
g.nodes.append(helper.make_node('Identity', [a], ['out'], name='out'))

graph = helper.make_graph(
    g.nodes, 'chain',
    [helper.make_tensor_value_info('x', TensorProto.FLOAT, ['N', CHANNELS, 'H', 'W'])],
    [helper.make_tensor_value_info('out', TensorProto.FLOAT, ['N', CHANNELS, 'H', 'W'])],
    g.initializers,
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', OPSET)])
model.ir_version = 8
onnx.checker.check_model(model)

os.makedirs(args.output_dir, exist_ok=True)
onnx.save(model, os.path.join(args.output_dir, 'chain.onnx'))
with open(os.path.join(args.output_dir, 'chain.bin'), 'wb') as f:
    for v in raw:
        f.write(np.ascontiguousarray(v, np.float32).tobytes())
print(f'Wrote chain.onnx and chain.bin in {args.output_dir}')
