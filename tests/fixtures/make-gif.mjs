/**
 * 生成 GIF89a 测试素材（纯 Node，无依赖）。
 *
 * 为什么不用 ffmpeg 造：ffmpeg 的 gif 编码器会把输入**重采样成固定帧率**，
 * 实测把"4 帧、延迟 1000/300/700/200ms"的输入变成了 56 帧 @25fps，
 * 帧延迟信息直接丢失。要测"帧延迟/帧顺序/透明度/循环"，必须直接写 GIF 字节。
 *
 * 支持：逐帧延迟（centisecond）、透明色、disposal method、循环次数、全局调色板。
 */

const HEADER = 'GIF89a';

/** 构造一个 2 的幂大小的全局调色板（GIF 要求 2/4/…/256 色）。 */
function buildPalette(colors) {
  const size = 2;
  const table = Buffer.alloc(size * 3, 0);
  colors.slice(0, size).forEach(([r, g, b], index) => {
    table[index * 3] = r;
    table[index * 3 + 1] = g;
    table[index * 3 + 2] = b;
  });
  return table; // 2 色 ⇒ sizeBits = 0
}

/**
 * 最小合规 LZW 编码（只发字面量 + 频繁清表，保持码长恒为 3 位）。
 *
 * 为什么这样写：GIF 的码长会随字典增长从 3 位涨到 4/5/6… 位。为了避免实现
 * 完整的字典增长逻辑，这里每发 2 个字面量就插入一次 clear code 重置字典，
 * 使 next-code 始终 < 8，码长恒为 minCodeSize+1 = 3 位。
 * 解码器允许任意时刻的清表，所以这是合法 GIF（实测 ffmpeg 能正确解出像素）。
 */
function lzwEncodeIndices(indices, minCodeSize = 2) {
  const clearCode = 1 << minCodeSize; // 4
  const endCode = clearCode + 1; // 5
  const codes = [];
  let sinceClear = 0;
  codes.push(clearCode);
  for (const index of indices) {
    codes.push(index & ((1 << minCodeSize) - 1));
    sinceClear += 1;
    // next-code 从 clearCode+2 起，每多一个码 +1；到 8 之前必须再清表
    if (sinceClear >= 2) {
      codes.push(clearCode);
      sinceClear = 0;
    }
  }
  codes.push(endCode);

  const width = minCodeSize + 1; // 3 位
  const bits = [];
  for (const code of codes) {
    for (let i = 0; i < width; i += 1) bits.push((code >> i) & 1);
  }
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) {
      if (bits[i + j]) byte |= 1 << j;
    }
    bytes.push(byte);
  }
  const out = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return Buffer.from(out);
}

/**
 * 生成一个 GIF。
 * @param {object} options
 * @param {number} [options.width] - 画布宽
 * @param {number} [options.height] - 画布高
 * @param {Array<{delayCs:number, colorIndex?:number, transparent?:boolean, dispose?:number}>} options.frames
 * @param {Array<[number,number,number]>} options.colors - 调色板（最多 2 色）
 * @param {number} [options.loop] - 0 = 无限循环；>0 = 循环次数
 * @returns {Buffer} GIF 字节
 */
export function buildGif(options) {
  const width = options.width ?? 8;
  const height = options.height ?? 8;
  const colors = options.colors ?? [[255, 0, 0], [0, 0, 255]];
  const frames = options.frames ?? [{ delayCs: 10 }];
  const loop = options.loop ?? 0;

  const parts = [Buffer.from(HEADER, 'ascii')];

  // 逻辑屏幕描述符：宽高 + 全局调色板标记
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80; // 有全局调色板
  lsd[5] = 0; // 背景色索引
  lsd[6] = 0; // 像素宽高比
  parts.push(lsd);
  parts.push(buildPalette(colors));

  // NETSCAPE2.0 循环扩展
  if (loop >= 0) {
    const app = Buffer.concat([
      Buffer.from([0x21, 0xFF, 0x0B]),
      Buffer.from('NETSCAPE2.0', 'ascii'),
      Buffer.from([0x03, 0x01, loop & 0xFF, (loop >> 8) & 0xFF, 0x00]),
    ]);
    parts.push(app);
  }

  for (const frame of frames) {
    const delayCs = Math.max(1, Math.round(frame.delayCs));
    const colorIndex = frame.colorIndex ?? 0;
    const dispose = frame.dispose ?? 1;

    // 图形控制扩展：disposal + 透明 + 延迟
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xF9;
    gce[2] = 0x04;
    gce[3] = ((dispose & 0x07) << 2) | (frame.transparent ? 0x01 : 0x00);
    gce.writeUInt16LE(delayCs, 4);
    gce[6] = frame.transparent ? 1 : 0; // 透明色索引
    gce[7] = 0x00;
    parts.push(gce);

    // 图像描述符
    const id = Buffer.alloc(10);
    id[0] = 0x2C;
    id.writeUInt16LE(0, 1);
    id.writeUInt16LE(0, 3);
    id.writeUInt16LE(width, 5);
    id.writeUInt16LE(height, 7);
    id[9] = 0x00; // 无局部调色板、非交错
    parts.push(id);

    // 像素数据：整帧同色
    const indices = new Array(width * height).fill(colorIndex);
    parts.push(lzwEncodeIndices(indices));
  }

  parts.push(Buffer.from([0x3B])); // trailer
  return Buffer.concat(parts);
}

/** 便捷：写一个"4 段不等延迟"的 GIF，用于时间轴回归测试。 */
export function unevenDelayGif() {
  return buildGif({
    width: 8,
    height: 8,
    colors: [[255, 0, 0], [0, 0, 255]],
    // 1000ms / 300ms / 700ms / 200ms
    frames: [
      { delayCs: 100, colorIndex: 0 },
      { delayCs: 30, colorIndex: 1 },
      { delayCs: 70, colorIndex: 0 },
      { delayCs: 20, colorIndex: 1 },
    ],
    loop: 0,
  });
}
