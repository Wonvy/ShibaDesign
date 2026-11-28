import {
  PATH_CLOSE,
  PATH_CUBIC,
  PATH_LINE,
  PATH_MOVE,
  PATH_QUAD,
  createNode,
  nextSeq,
  toSubpaths,
  translation,
  type NodeId,
  type Point,
  type Stroke,
} from '@shiba/core';
import { toPathData } from '@shiba/renderer';
import type { Editor } from '../editor';
import { DEFAULT_STROKE, localOrigin } from '../ops';
import type { Command } from './command';

/**
 * 插入图标：图标库（lucide，ISC 许可）的一个图标变成一条普通的钢笔路径，之后可以改锚点、改颜色粗细。
 * 图标是 24 × 24 的画布上几段描边（path、circle、rect、line、polyline、polygon、ellipse），
 * 合成一条有多段子路径的路径，描边是圆头圆角、没有填充，和图标库里的样子一样
 */

/** 图标库的数据格式：[标签名, 属性][]，属性里的数可能写成字符串 */
export type IconNode = readonly (readonly [string, Readonly<Record<string, unknown>>, ...unknown[]])[];

export interface InsertIconArgs {
  name: string;
  node: IconNode;
  /** 放在哪里（世界坐标，图标的中心）；省略时放在当前画板中间或视口中间 */
  at?: Point;
  /** 边长，默认 48（图标库原来是 24，线宽 2，一起放大一倍） */
  size?: number;
}

/** 图标库的画布边长和线宽 */
const ICON_BOX = 24;
const ICON_STROKE = 2;
const DEFAULT_SIZE = 48;

const num = (attrs: Readonly<Record<string, unknown>>, key: string, fallback = 0): number => {
  const value = Number(attrs[key]);
  return Number.isFinite(value) ? value : fallback;
};

/** 一个图标的路径数据（core 的 path-data 格式），已经缩放到 size */
export function iconPathData(editor: Editor, node: IconNode, size: number): number[] {
  const { ck } = editor;
  const scale = size / ICON_BOX;
  const data: number[] = [];
  for (const [tag, attrs] of node) {
    let path = null;
    if (tag === 'path' && typeof attrs.d === 'string') {
      path = ck.Path.MakeFromSVGString(attrs.d);
    } else {
      const builder = new ck.PathBuilder();
      if (tag === 'circle') {
        const r = num(attrs, 'r');
        builder.addOval(ck.XYWHRect(num(attrs, 'cx') - r, num(attrs, 'cy') - r, r * 2, r * 2));
      } else if (tag === 'ellipse') {
        const rx = num(attrs, 'rx');
        const ry = num(attrs, 'ry');
        builder.addOval(ck.XYWHRect(num(attrs, 'cx') - rx, num(attrs, 'cy') - ry, rx * 2, ry * 2));
      } else if (tag === 'rect') {
        const rect = ck.XYWHRect(num(attrs, 'x'), num(attrs, 'y'), num(attrs, 'width'), num(attrs, 'height'));
        const rx = num(attrs, 'rx', num(attrs, 'ry'));
        const ry = num(attrs, 'ry', rx);
        if (rx > 0 || ry > 0) builder.addRRect(ck.RRectXY(rect, rx, ry));
        else builder.addRect(rect);
      } else if (tag === 'line') {
        builder.moveTo(num(attrs, 'x1'), num(attrs, 'y1'));
        builder.lineTo(num(attrs, 'x2'), num(attrs, 'y2'));
      } else if ((tag === 'polyline' || tag === 'polygon') && typeof attrs.points === 'string') {
        const values = attrs.points
          .trim()
          .split(/[\s,]+/)
          .map(Number)
          .filter(Number.isFinite);
        for (let i = 0; i + 1 < values.length; i += 2) {
          if (i === 0) builder.moveTo(values[i]!, values[i + 1]!);
          else builder.lineTo(values[i]!, values[i + 1]!);
        }
        if (tag === 'polygon') builder.close();
      }
      path = builder.detach();
      builder.delete();
    }
    if (!path) continue;
    data.push(...scalePathData(toPathData(ck, path), scale));
    path.delete();
  }
  return data;
}

/** 路径数据里的坐标都乘上 scale（命令编号不动） */
function scalePathData(data: readonly number[], scale: number): number[] {
  const counts: Record<number, number> = {
    [PATH_MOVE]: 2,
    [PATH_LINE]: 2,
    [PATH_CUBIC]: 6,
    [PATH_QUAD]: 4,
    [PATH_CLOSE]: 0,
  };
  const out: number[] = [];
  for (let i = 0; i < data.length;) {
    const command = data[i]!;
    const count = counts[command];
    if (count === undefined) break;
    out.push(command);
    for (let k = 1; k <= count; k++) out.push(data[i + k]! * scale);
    i += count + 1;
  }
  return out;
}

/** 在画布上放一个图标，返回新路径的 id；图标里什么都画不出来时返回 null */
export function insertIconNode(editor: Editor, args: InsertIconArgs): NodeId | null {
  const { store } = editor;
  const size = args.size ?? DEFAULT_SIZE;
  const subpaths = toSubpaths(iconPathData(editor, args.node, size));
  if (subpaths.length === 0) return null;
  const at = args.at ?? editor.defaultInsertPoint();
  const box = { x: at.x - size / 2, y: at.y - size / 2, w: size, h: size };
  const container = editor.containerAt(at).id;
  const origin = localOrigin(store, container, box);
  const stroke: Stroke = {
    color: DEFAULT_STROKE,
    width: (ICON_STROKE * size) / ICON_BOX,
    cap: 'round',
    join: 'round',
  };
  const node = createNode('path', {
    parent: container,
    index: store.indexOnTop(container),
    seq: nextSeq(store, 'path'),
    name: args.name,
    transform: translation(origin.x, origin.y),
    size: [size, size],
    subpaths,
    fillRule: 'nonzero',
    fill: null,
    stroke,
  });
  store.transact('insert icon', (tx) => tx.create(node));
  store.sealHistory();
  return node.id;
}

export const insertIcon: Command<InsertIconArgs> = {
  id: 'icon.insert',
  run(editor, args) {
    const id = insertIconNode(editor, args);
    if (id) editor.select([id]);
  },
};
