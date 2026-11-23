"""
Converts a KataGo/Katahex model (.bin.gz, model version <= 11) to ONNX.

Network is rebuilt from katahex cpp/neuralnet/desc.cpp (file format) and eigenbackend.cpp (forward pass).

Inputs:
    spatial  float [N, C, H, W]  NCHW, H and W are board size (no padding, so mask is full)
    global   float [N, G]
Outputs:
    policy   float [N, H*W + 1]  raw logits, row-major cells (y * W + x), then pass
    value    float [N, 3]        raw logits: win, loss, no result, for player to play

Usage:
    PYTHONPATH=.deps python3 bin_to_onnx.py hex27x3.bin.gz hex27x3.onnx [--fp16 hex27x3.fp16.onnx]
"""

import argparse
import gzip

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

OPSET = 17


class Reader:
    """Whitespace separated tokens, with "@BIN@" binary float blocks."""

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def token(self) -> str:
        while self.data[self.pos] in b' \t\r\n':
            self.pos += 1
        start = self.pos
        while self.pos < len(self.data) and self.data[self.pos] not in b' \t\r\n':
            self.pos += 1
        return self.data[start:self.pos].decode()

    def int(self) -> int:
        return int(self.token())

    def float(self) -> float:
        return float(self.token())

    def bool(self) -> bool:
        return self.int() != 0

    def floats(self, n: int, name: str) -> np.ndarray:
        at = self.data.index(b'@', self.pos)
        if at - self.pos > 100 or self.data[at:at + 5] != b'@BIN@':
            raise ValueError(f'{name}: expected binary float block')
        start = at + 5
        self.pos = start + 4 * n
        values = np.frombuffer(self.data[start:self.pos], dtype='<f4').astype(np.float32)
        if not np.all(np.isfinite(values)):
            raise ValueError(f'{name}: non finite weights')
        return values


def read_conv(r: Reader) -> dict:
    name = r.token()
    ky, kx, ic, oc, dy, dx = (r.int() for _ in range(6))
    # File order is y, x, ic, oc
    weights = r.floats(ky * kx * ic * oc, name).reshape(ky, kx, ic, oc).transpose(3, 2, 0, 1)
    return {'kind': 'conv', 'name': name, 'w': np.ascontiguousarray(weights), 'dilation': (dy, dx), 'ic': ic, 'oc': oc}


def read_bn(r: Reader) -> dict:
    name = r.token()
    c = r.int()
    eps = r.float()
    has_scale = r.bool()
    has_bias = r.bool()
    mean = r.floats(c, name)
    var = r.floats(c, name)
    scale = r.floats(c, name) if has_scale else np.ones(c, np.float32)
    # Same as katahex: missing bias defaults to 1
    bias = r.floats(c, name) if has_bias else np.ones(c, np.float32)
    merged_scale = scale / np.sqrt(var + eps)
    merged_bias = bias - merged_scale * mean
    return {'name': name, 'scale': merged_scale.astype(np.float32), 'bias': merged_bias.astype(np.float32)}


def read_act(r: Reader, version: int) -> str:
    r.token()  # name
    return r.token() if version >= 11 else 'ACTIVATION_RELU'


def read_matmul(r: Reader) -> np.ndarray:
    name = r.token()
    ic, oc = r.int(), r.int()
    return r.floats(ic * oc, name).reshape(ic, oc)


def read_matbias(r: Reader) -> np.ndarray:
    name = r.token()
    c = r.int()
    return r.floats(c, name)


def read_blocks(r: Reader, version: int, count: int) -> list:
    blocks = []
    for _ in range(count):
        kind = r.token()
        name = r.token()
        if kind == 'ordinary_block':
            blocks.append({
                'kind': kind, 'name': name,
                'preBN': read_bn(r), 'preAct': read_act(r, version), 'regularConv': read_conv(r),
                'midBN': read_bn(r), 'midAct': read_act(r, version), 'finalConv': read_conv(r),
            })
        elif kind == 'gpool_block':
            blocks.append({
                'kind': kind, 'name': name,
                'preBN': read_bn(r), 'preAct': read_act(r, version), 'regularConv': read_conv(r),
                'gpoolConv': read_conv(r), 'gpoolBN': read_bn(r), 'gpoolAct': read_act(r, version),
                'gpoolToBiasMul': read_matmul(r),
                'midBN': read_bn(r), 'midAct': read_act(r, version), 'finalConv': read_conv(r),
            })
        elif kind == 'nested_bottleneck_block':
            n = r.int()
            block = {'kind': kind, 'name': name, 'preBN': read_bn(r), 'preAct': read_act(r, version), 'preConv': read_conv(r)}
            block['blocks'] = read_blocks(r, version, n)
            block.update({'postBN': read_bn(r), 'postAct': read_act(r, version), 'postConv': read_conv(r)})
            blocks.append(block)
        else:
            raise ValueError(f'Unknown block kind {kind}')
    return blocks


def read_model(data: bytes) -> dict:
    r = Reader(data)
    model = {'name': r.token(), 'version': r.int()}
    version = model['version']
    if version > 11:
        raise ValueError(f'Model version {version} not supported')
    model['numSpatial'] = r.int()
    model['numGlobal'] = r.int()

    r.token()  # trunk name
    num_blocks = r.int()
    for _ in range(5):
        r.int()  # trunk, mid, regular, dilated, gpool channels
    model['trunk'] = {
        'initialConv': read_conv(r),
        'initialMatMul': read_matmul(r),
        'blocks': read_blocks(r, version, num_blocks),
        'tipBN': read_bn(r),
        'tipAct': read_act(r, version),
    }

    r.token()  # policy head name
    model['policy'] = {
        'p1Conv': read_conv(r), 'g1Conv': read_conv(r), 'g1BN': read_bn(r), 'g1Act': read_act(r, version),
        'gpoolToBiasMul': read_matmul(r), 'p1BN': read_bn(r), 'p1Act': read_act(r, version),
        'p2Conv': read_conv(r), 'gpoolToPassMul': read_matmul(r),
    }

    r.token()  # value head name
    model['value'] = {
        'v1Conv': read_conv(r), 'v1BN': read_bn(r), 'v1Act': read_act(r, version),
        'v2Mul': read_matmul(r), 'v2Bias': read_matbias(r), 'v2Act': read_act(r, version),
        'v3Mul': read_matmul(r), 'v3Bias': read_matbias(r),
        'sv3Mul': read_matmul(r), 'sv3Bias': read_matbias(r),
        'ownershipConv': read_conv(r),
    }

    if r.data[r.pos:].strip() != b'':
        raise ValueError(f'Unexpected data after value head, at byte {r.pos}')

    if model['policy']['p2Conv']['oc'] != 1:
        raise ValueError('Only models with a single policy output are supported')

    return model


class Graph:
    def __init__(self, dtype):
        self.dtype = dtype
        self.elem_type = helper.np_dtype_to_tensor_dtype(np.dtype(dtype))
        self.nodes = []
        self.initializers = []
        self.counter = 0

    def name(self, prefix: str) -> str:
        self.counter += 1
        return f'{prefix}_{self.counter}'

    def const(self, value: np.ndarray, prefix: str = 'c') -> str:
        """Float constants are stored in graph float type."""
        name = self.name(prefix)
        value = np.asarray(value)
        if np.issubdtype(value.dtype, np.floating):
            value = value.astype(self.dtype)
        self.initializers.append(numpy_helper.from_array(value, name))
        return name

    def op(self, op_type: str, inputs: list, prefix: str = None, **attrs) -> str:
        out = self.name(prefix or op_type.lower())
        self.nodes.append(helper.make_node(op_type, inputs, [out], name=out, **attrs))
        return out

    def conv(self, x: str, conv: dict, bn: dict = None) -> str:
        """With bn, batch norm of conv output is merged into conv weights and bias."""
        w = conv['w']
        inputs = [x, self.const(w if bn is None else w * bn['scale'].reshape(-1, 1, 1, 1), conv['name'])]
        if bn is not None:
            inputs.append(self.const(bn['bias'], bn['name'] + '_bias'))
        dy, dx = conv['dilation']
        ky, kx = w.shape[2], w.shape[3]
        return self.op(
            'Conv', inputs, 'conv',
            strides=[1, 1], dilations=[dy, dx], pads=[(ky // 2) * dy, (kx // 2) * dx, (ky // 2) * dy, (kx // 2) * dx],
        )

    def conv_bn_act(self, x: str, conv: dict, bn: dict, act: str) -> str:
        return self.act(self.conv(x, conv, bn), act)

    def act(self, x: str, kind: str) -> str:
        if kind == 'ACTIVATION_IDENTITY':
            return x
        if kind == 'ACTIVATION_RELU':
            return self.op('Relu', [x])
        if kind == 'ACTIVATION_MISH':
            # x * tanh(softplus(x)), with only basic ops, supported by all execution providers.
            # tanh(softplus(10)) is already 1 in float32, and exp(10) fits in float16.
            clamped = self.op('Min', [x, self.const(np.float32(10.0))])
            softplus = self.op('Log', [self.op('Add', [self.op('Exp', [clamped]), self.const(np.float32(1.0))])])
            return self.op('Mul', [x, self.op('Tanh', [softplus])], 'mish')
        raise ValueError(f'Unknown activation {kind}')

    def bn_act(self, x: str, bn: dict, act: str) -> str:
        c = len(bn['scale'])
        scaled = self.op('Mul', [x, self.const(bn['scale'].reshape(1, c, 1, 1), bn['name'] + '_scale')])
        return self.act(self.op('Add', [scaled, self.const(bn['bias'].reshape(1, c, 1, 1), bn['name'] + '_bias')]), act)

    def matmul(self, x: str, w: np.ndarray) -> str:
        return self.op('MatMul', [x, self.const(w, 'w')])

    def as_nc11(self, x: str) -> str:
        return self.op('Unsqueeze', [x, self.const(np.array([2, 3], np.int64))])


def build_graph(model: dict, dtype=np.float32) -> onnx.ModelProto:
    """Inputs and outputs are always float32, computations in dtype."""
    g = Graph(dtype)

    spatial = g.op('Cast', ['spatial'], 'spatial_in', to=g.elem_type)
    glob = g.op('Cast', ['global'], 'global_in', to=g.elem_type)

    # (sqrt(area) - 14) / 10, from dynamic board size
    shape = g.op('Shape', [spatial])
    hw = g.op('Slice', [shape, g.const(np.array([2], np.int64)), g.const(np.array([4], np.int64))])
    area = g.op('Cast', [g.op('ReduceProd', [hw], keepdims=0)], to=g.elem_type)
    size_scale = g.op('Mul', [g.op('Sub', [g.op('Sqrt', [area]), g.const(np.float32(14.0))]), g.const(np.float32(0.1))], 'size_scale')

    def gpool(x: str) -> str:
        mean = g.op('ReduceMean', [x], axes=[2, 3], keepdims=0)
        maximum = g.op('ReduceMax', [x], axes=[2, 3], keepdims=0)
        return g.op('Concat', [mean, g.op('Mul', [mean, size_scale]), maximum], axis=1)

    def value_pool(x: str) -> str:
        mean = g.op('ReduceMean', [x], axes=[2, 3], keepdims=0)
        squared = g.op('Sub', [g.op('Mul', [size_scale, size_scale]), g.const(np.float32(0.1))])
        return g.op('Concat', [mean, g.op('Mul', [mean, size_scale]), g.op('Mul', [mean, squared])], axis=1)

    def blocks(x: str, descs: list) -> str:
        for b in descs:
            if b['kind'] == 'ordinary_block':
                y = g.conv_bn_act(g.bn_act(x, b['preBN'], b['preAct']), b['regularConv'], b['midBN'], b['midAct'])
                y = g.conv(y, b['finalConv'])
            elif b['kind'] == 'gpool_block':
                a = g.bn_act(x, b['preBN'], b['preAct'])
                # midBN merged into regularConv, and into pooled bias: bn(conv + bias) = conv' + bias * scale
                regular = g.conv(a, b['regularConv'], b['midBN'])
                pooled = gpool(g.conv_bn_act(a, b['gpoolConv'], b['gpoolBN'], b['gpoolAct']))
                regular = g.op('Add', [regular, g.as_nc11(g.matmul(pooled, b['gpoolToBiasMul'] * b['midBN']['scale']))])
                y = g.conv(g.act(regular, b['midAct']), b['finalConv'])
            else:
                y = g.conv(g.bn_act(x, b['preBN'], b['preAct']), b['preConv'])
                y = blocks(y, b['blocks'])
                y = g.conv(g.bn_act(y, b['postBN'], b['postAct']), b['postConv'])
            x = g.op('Add', [x, y], 'residual')
        return x

    t = model['trunk']
    x = g.op('Add', [g.conv(spatial, t['initialConv']), g.as_nc11(g.matmul(glob, t['initialMatMul']))])
    x = blocks(x, t['blocks'])
    trunk = g.bn_act(x, t['tipBN'], t['tipAct'])

    p = model['policy']
    p1 = g.conv(trunk, p['p1Conv'], p['p1BN'])
    g1 = gpool(g.conv_bn_act(trunk, p['g1Conv'], p['g1BN'], p['g1Act']))
    p1 = g.op('Add', [p1, g.as_nc11(g.matmul(g1, p['gpoolToBiasMul'] * p['p1BN']['scale']))])
    p2 = g.conv(g.act(p1, p['p1Act']), p['p2Conv'])
    p2 = g.op('Flatten', [p2], axis=1)
    pass_logit = g.matmul(g1, p['gpoolToPassMul'])
    policy = g.op('Concat', [p2, pass_logit], axis=1)
    g.nodes.append(helper.make_node('Cast', [policy], ['policy'], name='policy', to=TensorProto.FLOAT))

    v = model['value']
    v1 = value_pool(g.conv_bn_act(trunk, v['v1Conv'], v['v1BN'], v['v1Act']))
    v2 = g.op('Add', [g.matmul(v1, v['v2Mul']), g.const(v['v2Bias'])])
    v2 = g.act(v2, v['v2Act'])
    value = g.op('Add', [g.matmul(v2, v['v3Mul']), g.const(v['v3Bias'])])
    g.nodes.append(helper.make_node('Cast', [value], ['value'], name='value', to=TensorProto.FLOAT))

    graph = helper.make_graph(
        g.nodes,
        model['name'],
        [
            helper.make_tensor_value_info('spatial', TensorProto.FLOAT, ['N', model['numSpatial'], 'H', 'W']),
            helper.make_tensor_value_info('global', TensorProto.FLOAT, ['N', model['numGlobal']]),
        ],
        [
            helper.make_tensor_value_info('policy', TensorProto.FLOAT, ['N', 'P']),
            helper.make_tensor_value_info('value', TensorProto.FLOAT, ['N', 3]),
        ],
        g.initializers,
    )

    onnx_model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', OPSET)], producer_name='hex-ai-distributed')
    onnx_model.ir_version = 8
    onnx_model.doc_string = f'{model["name"]} (model version {model["version"]})'
    onnx.checker.check_model(onnx_model)

    return onnx_model


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input', help='Katahex model, .bin.gz')
    parser.add_argument('output', help='ONNX model, float32')
    parser.add_argument('--fp16', help='Also write a float16 model here, inputs and outputs kept as float32')
    args = parser.parse_args()

    with gzip.open(args.input, 'rb') as f:
        model = read_model(f.read())

    print(f'{model["name"]}, version {model["version"]}, {model["numSpatial"]} spatial and {model["numGlobal"]} global inputs')

    onnx_model = build_graph(model)
    onnx.save(onnx_model, args.output)
    print(f'Wrote {args.output}')

    if args.fp16:
        onnx.save(build_graph(model, np.float16), args.fp16)
        print(f'Wrote {args.fp16}')


if __name__ == '__main__':
    main()
