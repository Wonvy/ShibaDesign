import {
  DocStore,
  buildLayout,
  createNode,
  instanceNodes,
  keysBetween,
  nextSeq,
  rgba,
  translation,
  type Color,
  type ColorRole,
  type ColorStyleDef,
  type DocumentData,
  type Fill,
  type GradientFill,
  type LayoutTexts,
  type NodeId,
  type SceneNode,
  type SolidFill,
  type TextAlign,
  type TextRole,
  type TextStyle,
  type TextStyleDef,
} from '@shiba/core';

/**
 * 内置的设计模板。每个模板是一个函数，按当前语言生成一份文档：示例文字来自语言包，
 * 所以中文界面里打开是中文的示例，英文界面里是英文的。
 *
 * 演示稿模板用的就是新建幻灯片时的版式（core 的 layouts.ts），配色和字体做成带用途的颜色样式、文字样式：
 * 打开模板以后再按版式新建幻灯片，自动用模板的配色和字体；改样式时整份稿子一起变。
 * 页脚做成组件，主组件放在画板外面（导出时不会带上），每页放一个实例。
 *
 * 新增模板：在 BUILTIN_TEMPLATES 里加一项，再到两个语言包的 template 下加名字、说明和示例文字。
 */

type Translate = (key: string) => string;

export interface TemplateDef {
  id: string;
  /** 演示稿：打开后进幻灯片视图 */
  slides: boolean;
  build(t: Translate): DocumentData;
}

const GAP = 80;

interface Palette {
  background: Color;
  text: Color;
  accent: Color;
  muted: Color;
}

type TypeScale = Record<TextRole, TextStyle>;

interface Theme {
  colors: ColorStyleDef[];
  texts: TextStyleDef[];
}

function hex(value: string, a = 1): Color {
  const n = Number.parseInt(value.slice(1), 16);
  return rgba(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
}

function type(
  latin: string,
  cjk: string,
  fontSize: number,
  fontWeight: number,
  lineHeight: number,
  letterSpacing = 0,
): TextStyle {
  return { fontFamily: { latin, cjk }, fontSize, fontWeight, lineHeight, letterSpacing };
}

/** 一套带用途的颜色样式和文字样式。id 在一份文档里不重复就行，模板里用固定的 */
function theme(t: Translate, palette: Palette, scale: TypeScale): Theme {
  const colorRoles: ColorRole[] = ['background', 'text', 'accent', 'muted'];
  const textRoles: TextRole[] = ['title', 'subtitle', 'body', 'caption'];
  return {
    colors: colorRoles.map((role) => ({
      id: `color-${role}`,
      name: t(`template.styleName.${role}`),
      color: palette[role],
      role,
    })),
    texts: textRoles.map((role) => ({
      id: `text-${role}`,
      name: t(`template.styleName.${role}`),
      style: scale[role],
      role,
    })),
  };
}

function colorOf(theme: Theme, role: ColorRole): SolidFill {
  const style = theme.colors.find((c) => c.role === role)!;
  return { type: 'solid', color: style.color, colorStyle: style.id };
}

function textOf(theme: Theme, role: TextRole): TextStyleDef {
  return theme.texts.find((s) => s.role === role)!;
}

interface TextSpec {
  x: number;
  y: number;
  w: number;
  text: string;
  role: TextRole;
  color: SolidFill;
  align?: TextAlign;
  /** 不用文字样式里的字号（标题特别大的海报） */
  fontSize?: number;
}

/** 固定宽度、链接文字样式的文本 */
function textNode(store: DocStore, parent: NodeId, theme: Theme, spec: TextSpec): SceneNode {
  const def = textOf(theme, spec.role);
  const style = spec.fontSize ? { ...def.style, fontSize: spec.fontSize } : def.style;
  return createNode('text', {
    parent,
    index: store.indexOnTop(parent),
    seq: nextSeq(store, 'text'),
    transform: translation(spec.x, spec.y),
    size: [spec.w, 0],
    text: spec.text,
    style,
    align: spec.align ?? 'left',
    sizing: 'fixed',
    fill: spec.color,
    ...(spec.fontSize ? {} : { textStyle: def.id }),
  });
}

function shape(
  store: DocStore,
  parent: NodeId,
  kind: 'rect' | 'ellipse',
  box: [number, number, number, number],
  fill: Fill,
  cornerRadius = 0,
): SceneNode {
  const common = {
    parent,
    index: store.indexOnTop(parent),
    transform: translation(box[0], box[1]),
    size: [box[2], box[3]] as const,
    fill,
    stroke: null,
  };
  return kind === 'rect'
    ? createNode('rect', { ...common, seq: nextSeq(store, 'rect'), cornerRadius })
    : createNode('ellipse', { ...common, seq: nextSeq(store, 'ellipse') });
}

interface SlideSpec {
  layout: string;
  texts: LayoutTexts;
  /** 这一页放不放页脚 */
  footer?: boolean;
}

/**
 * 按版式拼一份演示稿：每页一个画板，横着排开；页脚是组件，主组件放在第一页下面、画板以外
 */
function deck(t: Translate, size: readonly [number, number], look: Theme, slides: SlideSpec[]): DocumentData {
  const store = DocStore.create();
  const root = store.root.id;
  const [w, h] = size;
  const unit = h / 720;
  const background = colorOf(look, 'background');
  store.transact('template', (tx) => {
    tx.update(root, { colorStyles: look.colors, textStyles: look.texts });
  });

  // 页脚的主组件：一段右对齐的注释文字，右边一个强调色的短横
  const footerWidth = Math.round(420 * unit);
  const main = createNode('group', {
    parent: root,
    index: store.indexOnTop(root),
    seq: 1,
    name: t('template.footerName'),
    transform: translation(0, h + GAP * 2),
    component: true,
  });
  store.transact('footer', (tx) => {
    tx.create(main);
    tx.create(
      textNode(store, main.id, look, {
        x: 0,
        y: 0,
        w: footerWidth,
        text: t('template.sample.footer'),
        role: 'caption',
        color: colorOf(look, 'muted'),
        align: 'right',
      }),
    );
    const caption = textOf(look, 'caption').style;
    const barY = (caption.fontSize * caption.lineHeight) / 2 - 2 * unit;
    tx.create(
      shape(
        store,
        main.id,
        'rect',
        [footerWidth + 12 * unit, barY, 28 * unit, 4 * unit],
        colorOf(look, 'accent'),
        2 * unit,
      ),
    );
  });

  const orders = keysBetween(null, null, slides.length);
  slides.forEach((spec, i) => {
    const board = createNode('artboard', {
      parent: root,
      index: store.indexOnTop(root),
      seq: nextSeq(store, 'artboard'),
      transform: translation(i * (w + GAP), 0),
      size,
      fill: background,
      deck: { order: orders[i]!, notes: '' },
    });
    store.transact('slide', (tx) => {
      tx.create(board);
      const nodes = buildLayout(
        spec.layout,
        {
          parent: board.id,
          size,
          texts: { image: t('layoutText.image'), ...spec.texts },
          fonts: textOf(look, 'body').style.fontFamily,
          colorStyles: look.colors,
          textStyles: look.texts,
          background: background.color,
        },
        (kind) => nextSeq(store, kind),
      );
      for (const node of nodes) tx.create(node);
    });
    if (!spec.footer) return;
    const instance = instanceNodes(store, main.id, {
      parent: board.id,
      index: store.indexOnTop(board.id),
      transform: translation(Math.round(w - w * 0.075 - footerWidth - 40 * unit), Math.round(h - h * 0.09)),
      seq: nextSeq(store, 'group'),
    });
    store.transact('footer instance', (tx) => instance.forEach((node) => tx.create(node)));
  });
  return store.toJSON();
}

/**
 * 一张画板（不是幻灯片）的设计稿。draw 返回的是一个个"做节点"的函数，按顺序一个做完、放进文档再做下一个，
 * 这样每个节点的层序和序号都排在前一个后面
 */
function design(
  look: Theme,
  size: readonly [number, number],
  fill: SolidFill | GradientFill,
  draw: (store: DocStore, board: NodeId) => (() => SceneNode)[],
): DocumentData {
  const store = DocStore.create();
  const root = store.root.id;
  store.transact('template', (tx) => {
    tx.update(root, { colorStyles: look.colors, textStyles: look.texts });
    const board = createNode('artboard', {
      parent: root,
      index: 'a0',
      seq: 1,
      size,
      fill,
      deck: null,
    });
    tx.create(board);
    for (const make of draw(store, board.id)) tx.create(make());
  });
  return store.toJSON();
}

const MINIMAL: TemplateDef = {
  id: 'minimal',
  slides: true,
  build(t) {
    const look = theme(
      t,
      { background: hex('#ffffff'), text: hex('#1b1e23'), accent: hex('#2563eb'), muted: hex('#6a717d') },
      {
        title: type('Inter', 'Noto Sans SC', 56, 700, 1.2),
        subtitle: type('Inter', 'Noto Sans SC', 28, 400, 1.4),
        body: type('Inter', 'Noto Sans SC', 26, 400, 1.6),
        caption: type('Inter', 'Noto Sans SC', 16, 400, 1.4),
      },
    );
    const s = (key: string): string => t(`template.sample.${key}`);
    return deck(t, [1280, 720], look, [
      { layout: 'title', texts: { title: s('deckTitle'), subtitle: s('deckSubtitle') } },
      { layout: 'titleContent', texts: { title: s('agendaTitle'), body: s('agendaBody') }, footer: true },
      { layout: 'section', texts: { number: '01', title: s('sectionTitle') } },
      {
        layout: 'twoColumns',
        texts: { title: s('compareTitle'), body: s('compareLeft'), body2: s('compareRight') },
        footer: true,
      },
      { layout: 'imageText', texts: { title: s('imageTitle'), body: s('imageBody') }, footer: true },
      { layout: 'quote', texts: { quote: s('quote'), caption: s('quoteBy') } },
      { layout: 'title', texts: { title: s('thanks'), subtitle: s('thanksSub') } },
    ]);
  },
};

const DARK: TemplateDef = {
  id: 'dark',
  slides: true,
  build(t) {
    const look = theme(
      t,
      { background: hex('#0f172a'), text: hex('#f8fafc'), accent: hex('#f59e0b'), muted: hex('#94a3b8') },
      {
        title: type('Tinos', 'Noto Serif SC', 60, 700, 1.2),
        subtitle: type('Inter', 'Noto Sans SC', 26, 400, 1.4),
        body: type('Inter', 'Noto Sans SC', 26, 400, 1.6),
        caption: type('Inter', 'Noto Sans SC', 16, 400, 1.4),
      },
    );
    const s = (key: string): string => t(`template.sample.${key}`);
    return deck(t, [1280, 720], look, [
      { layout: 'title', texts: { title: s('deckTitle'), subtitle: s('deckSubtitle') } },
      { layout: 'titleContent', texts: { title: s('agendaTitle'), body: s('agendaBody') }, footer: true },
      { layout: 'section', texts: { number: '01', title: s('sectionTitle') } },
      { layout: 'quote', texts: { quote: s('quote'), caption: s('quoteBy') } },
      { layout: 'title', texts: { title: s('thanks'), subtitle: s('thanksSub') } },
    ]);
  },
};

const POSTER: TemplateDef = {
  id: 'poster',
  slides: false,
  build(t) {
    const white = hex('#ffffff');
    const look = theme(
      t,
      { background: hex('#4338ca'), text: white, accent: hex('#fde047'), muted: hex('#ffffff', 0.78) },
      {
        title: type('Inter', 'Noto Sans SC', 52, 700, 1.15),
        subtitle: type('Inter', 'Noto Sans SC', 18, 700, 1.4),
        body: type('Inter', 'Noto Sans SC', 14, 400, 1.7),
        caption: type('Inter', 'Noto Sans SC', 15, 700, 1.4),
      },
    );
    const s = (key: string): string => t(`template.sample.${key}`);
    const gradient: GradientFill = {
      type: 'gradient',
      kind: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      stops: [
        { offset: 0, color: hex('#4338ca') },
        { offset: 1, color: hex('#db2777') },
      ],
    };
    return design(look, [595, 842], gradient, (store, board) => [
      () => shape(store, board, 'ellipse', [330, -90, 360, 360], { type: 'solid', color: hex('#ffffff', 0.12) }),
      () => shape(store, board, 'ellipse', [-110, 600, 300, 300], { type: 'solid', color: hex('#ffffff', 0.1) }),
      () => shape(store, board, 'rect', [48, 250, 56, 6], colorOf(look, 'accent'), 3),
      () =>
        textNode(store, board, look, {
          x: 48,
          y: 280,
          w: 499,
          text: s('posterTitle'),
          role: 'title',
          color: colorOf(look, 'text'),
        }),
      () =>
        textNode(store, board, look, {
          x: 48,
          y: 436,
          w: 499,
          text: s('posterDate'),
          role: 'subtitle',
          color: colorOf(look, 'accent'),
        }),
      () =>
        textNode(store, board, look, {
          x: 48,
          y: 480,
          w: 400,
          text: s('posterBody'),
          role: 'body',
          color: colorOf(look, 'muted'),
        }),
      () => shape(store, board, 'rect', [48, 712, 150, 46], { type: 'solid', color: white }, 23),
      () =>
        textNode(store, board, look, {
          x: 48,
          y: 724,
          w: 150,
          text: s('posterCta'),
          role: 'caption',
          color: { type: 'solid', color: hex('#4338ca') },
          align: 'center',
        }),
    ]);
  },
};

const SOCIAL: TemplateDef = {
  id: 'social',
  slides: false,
  build(t) {
    const look = theme(
      t,
      { background: hex('#fff7ed'), text: hex('#431407'), accent: hex('#fb923c'), muted: hex('#9a3412') },
      {
        title: type('Tinos', 'Noto Serif SC', 96, 700, 1.25),
        subtitle: type('Inter', 'Noto Sans SC', 40, 400, 1.4),
        body: type('Inter', 'Noto Sans SC', 32, 400, 1.5),
        caption: type('Inter', 'Noto Sans SC', 32, 400, 1.4),
      },
    );
    const s = (key: string): string => t(`template.sample.${key}`);
    return design(look, [1080, 1080], colorOf(look, 'background'), (store, board) => [
      () => shape(store, board, 'ellipse', [700, -140, 540, 540], colorOf(look, 'accent')),
      () =>
        textNode(store, board, look, {
          x: 96,
          y: 330,
          w: 888,
          text: s('socialQuote'),
          role: 'title',
          color: colorOf(look, 'text'),
        }),
      () => shape(store, board, 'rect', [96, 700, 120, 8], colorOf(look, 'accent'), 4),
      () =>
        textNode(store, board, look, {
          x: 96,
          y: 750,
          w: 888,
          text: s('socialHandle'),
          role: 'caption',
          color: colorOf(look, 'muted'),
        }),
    ]);
  },
};

/**
 * 界面模板：手机上的登录页。表单是一个竖排的自动布局画框，里面的输入框、按钮也是自动布局的画框，
 * 宽度都是"填满"，改一处间距、改按钮文字，其余的跟着排好
 */
const LOGIN: TemplateDef = {
  id: 'login',
  slides: false,
  build(t) {
    const look = theme(
      t,
      { background: hex('#ffffff'), text: hex('#111827'), accent: hex('#2563eb'), muted: hex('#6b7280') },
      {
        title: type('Inter', 'Noto Sans SC', 28, 700, 1.25),
        subtitle: type('Inter', 'Noto Sans SC', 16, 600, 1.4),
        body: type('Inter', 'Noto Sans SC', 15, 400, 1.5),
        caption: type('Inter', 'Noto Sans SC', 14, 400, 1.4),
      },
    );
    const s = (key: string): string => t(`template.sample.${key}`);
    const width = 329;
    const fill = { h: 'fill', v: 'fixed' } as const;
    /** 输入框、按钮：横排的自动布局画框，里面一段文字 */
    const field = (
      store: DocStore,
      parent: NodeId,
      y: number,
      boxFill: SolidFill,
      stroke: boolean,
      justify: 'start' | 'center',
    ): SceneNode =>
      createNode('frame', {
        parent,
        index: store.indexOnTop(parent),
        seq: nextSeq(store, 'frame'),
        transform: translation(0, y),
        size: [width, 48],
        fill: boxFill,
        stroke: stroke ? { color: hex('#d1d5db'), width: 1 } : null,
        cornerRadius: 10,
        clip: true,
        layoutSizing: fill,
        layout: {
          direction: 'horizontal',
          gap: 8,
          padding: [0, 16, 0, 16],
          justify,
          align: 'center',
          sizing: { h: 'fixed', v: 'fixed' },
        },
      });
    const label = (store: DocStore, parent: NodeId, text: string, role: TextRole, color: SolidFill): SceneNode => {
      const def = textOf(look, role);
      return createNode('text', {
        parent,
        index: store.indexOnTop(parent),
        seq: nextSeq(store, 'text'),
        transform: translation(16, 13),
        size: [0, 0],
        text,
        style: def.style,
        align: 'left',
        sizing: 'auto',
        fill: color,
        textStyle: def.id,
      });
    };
    let form = '';
    let email = '';
    let password = '';
    let button = '';
    return design(look, [393, 852], colorOf(look, 'background'), (store, board) => [
      () => {
        const node = createNode('frame', {
          parent: board,
          index: store.indexOnTop(board),
          seq: nextSeq(store, 'frame'),
          name: s('loginForm'),
          transform: translation(32, 200),
          size: [width, 300],
          fill: null,
          stroke: null,
          cornerRadius: 0,
          clip: false,
          layout: {
            direction: 'vertical',
            gap: 16,
            padding: [0, 0, 0, 0],
            justify: 'start',
            align: 'start',
            sizing: { h: 'fixed', v: 'hug' },
          },
        });
        form = node.id;
        return node;
      },
      () => ({
        ...textNode(store, form, look, {
          x: 0,
          y: 0,
          w: width,
          text: s('loginTitle'),
          role: 'title',
          color: colorOf(look, 'text'),
        }),
        layoutSizing: fill,
      }),
      () => ({
        ...textNode(store, form, look, {
          x: 0,
          y: 51,
          w: width,
          text: s('loginSubtitle'),
          role: 'body',
          color: colorOf(look, 'muted'),
        }),
        layoutSizing: fill,
      }),
      () => {
        const node = field(store, form, 90, { type: 'solid', color: hex('#ffffff') }, true, 'start');
        email = node.id;
        return node;
      },
      () => label(store, email, s('loginEmail'), 'body', colorOf(look, 'muted')),
      () => {
        const node = field(store, form, 154, { type: 'solid', color: hex('#ffffff') }, true, 'start');
        password = node.id;
        return node;
      },
      () => label(store, password, s('loginPassword'), 'body', colorOf(look, 'muted')),
      () => {
        const node = field(store, form, 218, colorOf(look, 'accent'), false, 'center');
        button = node.id;
        return node;
      },
      () => label(store, button, s('loginButton'), 'subtitle', { type: 'solid', color: hex('#ffffff') }),
      () => ({
        ...textNode(store, form, look, {
          x: 0,
          y: 282,
          w: width,
          text: s('loginForgot'),
          role: 'caption',
          color: colorOf(look, 'accent'),
          align: 'center',
        }),
        layoutSizing: fill,
      }),
    ]);
  },
};

export const BUILTIN_TEMPLATES: readonly TemplateDef[] = [MINIMAL, DARK, POSTER, SOCIAL, LOGIN];
