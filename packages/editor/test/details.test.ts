import { beforeAll, describe, expect, it } from 'vitest';
import type { PathNode } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { canvasKit, pointer, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

const key = (name: string) => ({ key: name }) as KeyboardEvent;

describe('钢笔的修饰键', () => {
  it('按住 Shift 新锚点相对上一个锁定 45°；按住 Alt 拖控制柄只动出去的那根；按住空格挪动正在放的锚点', () => {
    const s = scene(ck, []);
    s.editor.setTool('pen');
    const pen = s.editor.tool;
    // 第一个锚点 (100,100)
    pen.onPointerDown!(pointer({ x: 100, y: 100 }, { mod: true }), s.editor);
    pen.onPointerUp!(pointer({ x: 100, y: 100 }, { down: false }), s.editor);
    // 第二个：按住 Shift 点在 (300, 120)，锁定成水平
    pen.onPointerDown!(pointer({ x: 300, y: 120 }, { shift: true, mod: true }), s.editor);
    // 拖出控制柄到 (350, 100)，再按住 Alt 拖到 (350, 60)：进来的那根留在 (250, 100)
    pen.onPointerMove!(pointer({ x: 350, y: 100 }), s.editor);
    pen.onPointerMove!(pointer({ x: 350, y: 60 }, { alt: true }), s.editor);
    // 按住空格挪 (10, 10)：锚点连同两根控制柄一起挪
    pen.onPointerMove!(pointer({ x: 360, y: 70 }, { space: true }), s.editor);
    pen.onPointerUp!(pointer({ x: 360, y: 70 }, { down: false }), s.editor);
    pen.onKeyDown!(key('Enter'), s.editor);
    const path = s.store.get(s.editor.selection[0]!) as PathNode;
    const [x0, y0] = [path.transform[4], path.transform[5]];
    const a = path.subpaths[0]!.anchors[1]!;
    expect([a.x + x0, a.y + y0]).toEqual([310, 110]);
    expect([a.inX + x0, a.inY + y0]).toEqual([260, 110]);
    expect([a.outX + x0, a.outY + y0]).toEqual([360, 70]);
  });
});

describe('选择的细节', () => {
  it('在组里双击空白处退回上一层，选中这个组', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [200, 100, 50, 50],
    ]);
    s.editor.select([...s.rects]);
    s.editor.commands.run('group.create');
    const group = s.editor.selection[0]!;
    s.editor.select([s.rects[0]!]);
    const select = s.editor.tools.get('select')!;
    // 第一下点在空白处（选区被清掉），紧接着双击
    select.onPointerDown!(pointer({ x: 600, y: 400 }), s.editor);
    select.onPointerUp!(pointer({ x: 600, y: 400 }, { down: false }), s.editor);
    select.onDoubleClick!(pointer({ x: 600, y: 400 }), s.editor);
    expect(s.editor.selection).toEqual([group]);
  });

  it('框选要整个框住：打开后只选整个在框里的', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [200, 100, 50, 50],
    ]);
    const select = s.editor.tools.get('select')!;
    const marquee = () => {
      select.onPointerDown!(pointer({ x: 90, y: 90 }), s.editor);
      select.onPointerMove!(pointer({ x: 160, y: 120 }), s.editor);
      select.onPointerMove!(pointer({ x: 220, y: 160 }), s.editor);
      select.onPointerUp!(pointer({ x: 220, y: 160 }, { down: false }), s.editor);
    };
    marquee();
    expect(s.editor.selection).toEqual([s.rects[0], s.rects[1]]);
    s.editor.select([]);
    s.editor.setView({ marqueeContain: true });
    marquee();
    expect(s.editor.selection).toEqual([s.rects[0]]);
  });
});
