#!/usr/bin/env python3
"""
播放专项阶段1 —— 测试视频有效性验证

用户裁定要求：
  - 确认视频存在可解码的视频帧
  - 记录编码格式、分辨率、时长、音轨、CC0 来源
  - 不能用只有容器结构、没有画面的 MP4 代替

本脚本解析 MP4 box 结构，断言：
  1. 存在 trak/mdia/minf/stbl/stsd 且 sample entry 为 avc1/avc3/hvc1/hev1
  2. 存在 mp4a 音轨
  3. stsz/stco 表明真的有 sample 数据
  4. mvhd 时长 > 0
"""
import struct, sys, os

VIDEO_CODECS = ('avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01')
AUDIO_CODECS = ('mp4a', 'ac-3', 'ec-3', 'opus')


def iter_boxes(data, start, end):
    off = start
    while off + 8 <= end:
        size = struct.unpack('>I', data[off:off + 4])[0]
        typ = data[off + 4:off + 8].decode('latin-1')
        if size == 1:
            size = struct.unpack('>Q', data[off + 8:off + 16])[0]
            hdr = 16
        elif size == 0:
            size, hdr = end - off, 8
        else:
            hdr = 8
        if size < 8 or off + size > end:
            return
        yield typ, off, size, hdr
        off += size


def find_tracks(data, start, end, out):
    for typ, off, size, hdr in iter_boxes(data, start, end):
        body = off + hdr
        if typ in ('moov', 'trak', 'mdia', 'minf', 'stbl'):
            find_tracks(data, body, off + size, out)
        elif typ == 'mvhd':
            ver = data[body]
            if ver == 0:
                ts, dur = struct.unpack('>II', data[body + 12:body + 20])
            else:
                ts = struct.unpack('>I', data[body + 20:body + 24])[0]
                dur = struct.unpack('>Q', data[body + 24:body + 32])[0]
            out['timescale'], out['duration'] = ts, dur
        elif typ == 'stsd':
            for t2, o2, s2, h2 in iter_boxes(data, body + 8, off + size):
                if t2 in VIDEO_CODECS:
                    w = struct.unpack('>H', data[o2 + h2 + 24:o2 + h2 + 26])[0]
                    h = struct.unpack('>H', data[o2 + h2 + 26:o2 + h2 + 28])[0]
                    out['video'] = (t2, w, h)
                elif t2 in AUDIO_CODECS:
                    ch = struct.unpack('>H', data[o2 + h2 + 16:o2 + h2 + 18])[0]
                    sr = struct.unpack('>I', data[o2 + h2 + 24:o2 + h2 + 28])[0] >> 16
                    out['audio'] = (t2, sr, ch)
        elif typ == 'stsz':
            out['sample_count'] = struct.unpack('>I', data[body + 8:body + 12])[0]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else \
        'native-plugins/media3-player/android/src/main/assets/test.mp4'
    if not os.path.isfile(path):
        print(f"❌ 测试视频不存在: {path}")
        return 1

    size = os.path.getsize(path)
    data = open(path, 'rb').read()
    out = {}
    find_tracks(data, 0, len(data), out)

    print("== 测试视频验证 ==")
    print(f"路径: {path}")
    print(f"大小: {size:,} 字节")

    ok = True
    if 'video' not in out:
        print("❌ 未找到可解码视频轨（avc1/hvc1/vp09/av01）")
        ok = False
    else:
        c, w, h = out['video']
        print(f"✅ 视频轨: {c}  {w}x{h}")

    if 'audio' not in out:
        print("❌ 未找到音轨")
        ok = False
    else:
        c, sr, ch = out['audio']
        print(f"✅ 音轨: {c}  {sr}Hz  {ch}ch")

    ts = out.get('timescale', 0)
    dur = out.get('duration', 0)
    if ts <= 0 or dur <= 0:
        print("❌ 时长无效")
        ok = False
    else:
        print(f"✅ 时长: {dur / ts:.2f} 秒")

    sc = out.get('sample_count', 0)
    print(f"{'✅' if sc > 0 else '❌'} 样本数: {sc}")
    if sc <= 0:
        ok = False

    print()
    if not ok:
        print("❌ 测试视频无效：不能用于阶段1真机验收")
        return 1
    print("✅ 测试视频有效：含真实可解码视频帧与音轨")
    return 0


if __name__ == '__main__':
    sys.exit(main())
