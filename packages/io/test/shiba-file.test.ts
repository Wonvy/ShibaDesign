import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  AssetStore,
  DocStore,
  createNode,
  referencedAssetIds,
  rgba,
  solid,
  translation,
  validateDocument,
  type DocumentData,
} from '@shiba/core';
import { ShibaFileError, packShiba, unpackShiba } from '../src';

const PIXELS = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]);

async function sample() {
  const store = DocStore.create();
  const assets = new AssetStore();
  const used = await assets.add(PIXELS, { mime: 'image/png', width: 4, height: 2, name: 'photo.png' });
  const unused = await assets.add(new Uint8Array([9, 9, 9]), { mime: 'image/jpeg', width: 1, height: 1 });
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size: [800, 600],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  );
  store.transact('content', (tx) => {
    tx.create(
      createNode('rect', {
        parent: board.id,
        index: 'a0',
        seq: 1,
        transform: translation(10, 20),
        size: [400, 200],
        fill: { type: 'image', assetId: used.id, fit: 'cover' },
        stroke: null,
        cornerRadius: 12,
      }),
    );
    tx.create(
      createNode('text', {
        parent: board.id,
        index: 'a1',
        seq: 1,
        text: '你好 Shiba',
        style: {
          fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
          fontSize: 32,
          fontWeight: 400,
          lineHeight: 1.4,
          letterSpacing: 0,
        },
        align: 'left',
        sizing: 'auto',
        fill: solid(rgba(0, 0, 0)),
      }),
    );
  });
  return { store, assets, used, unused };
}

function expectReason(fn: () => unknown, reason: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ShibaFileError);
    expect((error as ShibaFileError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ${reason}，但没有抛错`);
}

describe('资源库', () => {
  it('内容相同的图片只存一份，id 由内容决定', async () => {
    const assets = new AssetStore();
    const a = await assets.add(PIXELS, { mime: 'image/png', width: 4, height: 2 });
    const b = await assets.add(PIXELS.slice(), { mime: 'image/png', width: 4, height: 2, name: 'copy.png' });
    expect(b.id).toBe(a.id);
    expect(assets.all()).toHaveLength(1);
    expect(a.size).toBe(PIXELS.length);
    expect(a.id).toMatch(/^[a-f0-9]{40}$/);
  });

  it('能找出文档实际引用的资源', async () => {
    const { store, used } = await sample();
    expect([...referencedAssetIds(store)]).toEqual([used.id]);
  });
});

describe('.shiba 文件', () => {
  it('打包再解包，文档和图片原样回来', async () => {
    const { store, assets, used } = await sample();
    const referenced = referencedAssetIds(store);
    const packed = packShiba({
      document: store.toJSON(),
      assets: assets.all().filter((a) => referenced.has(a.meta.id)),
    });
    const file = unpackShiba(packed);
    expect(file.document).toEqual(JSON.parse(JSON.stringify(store.toJSON())));
    expect(file.assets).toHaveLength(1);
    expect(file.assets[0]!.meta).toEqual(used);
    expect([...file.assets[0]!.bytes]).toEqual([...PIXELS]);
    // 解出来的文档能直接装进存储
    expect(DocStore.fromJSON(file.document).size).toBe(store.size);
  });

  it('是标准的 ZIP：改个扩展名就能用普通工具解开', async () => {
    const { store, assets, used } = await sample();
    const packed = packShiba({ document: store.toJSON(), assets: assets.all() });
    expect([...packed.slice(0, 2)]).toEqual([0x50, 0x4b]);
    const names = Object.keys(unzipSync(packed)).sort();
    expect(names).toContain('manifest.json');
    expect(names).toContain('document.json');
    expect(names).toContain(`assets/${used.id}.png`);
  });

  it('不是 ZIP、缺清单、不是本应用的文件，都给出明确原因', () => {
    expectReason(() => unpackShiba(strToU8('这不是一个压缩包')), 'notZip');
    expectReason(() => unpackShiba(zipSync({ 'readme.txt': strToU8('hi') })), 'noManifest');
    const foreign = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'something-else', formatVersion: 1 })),
      'document.json': strToU8('{}'),
    });
    expectReason(() => unpackShiba(foreign), 'notShiba');
  });

  it('拒绝比当前版本新的文件', async () => {
    const { store } = await sample();
    const future = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'shibadesign', formatVersion: 99, assets: [] })),
      'document.json': strToU8(JSON.stringify(store.toJSON())),
    });
    expectReason(() => unpackShiba(future), 'newerVersion');
  });

  it('文档结构不对时拒绝打开', async () => {
    const { store } = await sample();
    const manifest = strToU8(JSON.stringify({ format: 'shibadesign', formatVersion: 1, assets: [] }));
    const broken = JSON.parse(JSON.stringify(store.toJSON())) as DocumentData;
    const anyId = Object.keys(broken.nodes).find((id) => id !== broken.rootId)!;
    (broken.nodes[anyId] as unknown as { transform: unknown }).transform = [1, 0, 0, 1, 'NaN', 0];
    expectReason(
      () => unpackShiba(zipSync({ 'manifest.json': manifest, 'document.json': strToU8(JSON.stringify(broken)) })),
      'badDocument',
    );
    expectReason(
      () => unpackShiba(zipSync({ 'manifest.json': manifest, 'document.json': strToU8('{ not json') })),
      'badDocument',
    );
  });

  it('忽略包里不认识的条目和伪造的资源清单', async () => {
    const { store, used } = await sample();
    const sneaky = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          format: 'shibadesign',
          formatVersion: 1,
          assets: [
            { id: used.id, mime: 'image/png', width: 4, height: 2 },
            { id: '../../etc/passwd', mime: 'image/png', width: 1, height: 1 },
            { id: 'abcdef0123456789', mime: 'text/html', width: 1, height: 1 },
            { id: 'abcdef0123456789', mime: 'image/png', width: -5, height: 1 },
          ],
        }),
      ),
      'document.json': strToU8(JSON.stringify(store.toJSON())),
      [`assets/${used.id}.png`]: PIXELS,
      '../outside.txt': strToU8('escape attempt'),
      'assets/../../evil.png': PIXELS,
      'scripts/run.js': strToU8('alert(1)'),
    });
    const file = unpackShiba(sneaky);
    expect(file.assets.map((a) => a.meta.id)).toEqual([used.id]);
  });

  it('图片缺失时仍然能打开，只是少了那张图', async () => {
    const { store, used } = await sample();
    const missing = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'shibadesign', formatVersion: 1, assets: [used] })),
      'document.json': strToU8(JSON.stringify(store.toJSON())),
    });
    const file = unpackShiba(missing);
    expect(file.assets).toEqual([]);
    expect(Object.keys(file.document.nodes)).toHaveLength(store.size);
  });
});

describe('文档校验', () => {
  const base = (): DocumentData => {
    const store = DocStore.create();
    const board = store.transact('b', (tx) =>
      tx.create(
        createNode('artboard', { parent: store.root.id, index: 'a0', seq: 1, size: [10, 10], fill: null, deck: null }),
      ),
    );
    store.transact('r', (tx) =>
      tx.create(
        createNode('rect', {
          parent: board.id,
          index: 'a0',
          seq: 1,
          size: [1, 1],
          fill: null,
          stroke: null,
          cornerRadius: 0,
        }),
      ),
    );
    return JSON.parse(JSON.stringify(store.toJSON())) as DocumentData;
  };
  const nodesOf = (doc: DocumentData) => Object.values(doc.nodes) as unknown as Record<string, unknown>[];

  it('接受正常的文档', () => {
    expect(() => validateDocument(base())).not.toThrow();
  });

  it('父子关系成环时拒绝，不会死循环', () => {
    const doc = base();
    const board = nodesOf(doc).find((n) => n.type === 'artboard')!;
    const rect = nodesOf(doc).find((n) => n.type === 'rect')!;
    board.parent = rect.id;
    expect(() => validateDocument(doc)).toThrow(/cycle/);
  });

  it('拒绝指向不存在的父节点、游离的节点、非法数值', () => {
    const orphan = base();
    nodesOf(orphan).find((n) => n.type === 'rect')!.parent = 'nope';
    expect(() => validateDocument(orphan)).toThrow(/badNode/);

    const detached = base();
    nodesOf(detached).find((n) => n.type === 'rect')!.parent = null;
    expect(() => validateDocument(detached)).toThrow(/badNode/);

    const infinite = base();
    nodesOf(infinite).find((n) => n.type === 'rect')!.size = [1, null];
    expect(() => validateDocument(infinite)).toThrow(/badNode/);

    expect(() => validateDocument(null)).toThrow(/notObject/);
    expect(() => validateDocument({ version: 1, rootId: 'x', nodes: {} })).toThrow(/noRoot/);
    expect(() => validateDocument({ ...base(), version: 999 })).toThrow(/newerVersion/);
  });

  it('不认识的节点类型放行，方便旧版本打开新文件', () => {
    const doc = base();
    nodesOf(doc).find((n) => n.type === 'rect')!.type = 'hologram';
    expect(() => validateDocument(doc)).not.toThrow();
  });
});
