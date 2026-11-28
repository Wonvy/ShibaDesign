import { Component, Crosshair, Diamond, RotateCcw, Unlink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  descendants,
  instancesOf,
  isComponent,
  isInstance,
  isInstanceCopy,
  outerInstanceOf,
  type SceneNode,
} from '@shiba/core';
import { mainOf, type Editor } from '@shiba/editor';
import { displayName } from '../names';
import type { PanelProps } from './registry';

/** 组件面板对这个选区有没有话说 */
export function showComponentPanel(editor: Editor, nodes: readonly SceneNode[]): boolean {
  return (
    editor.commands.canRun('component.create') ||
    nodes.some((n) => isComponent(n) || isInstance(n) || isInstanceCopy(n))
  );
}

/** 这个节点（连同里面的东西）改过几项 */
function overrideCount(editor: Editor, node: SceneNode): number {
  return [node, ...descendants(editor.store, node.id)].reduce((sum, n) => sum + (n.overrides?.length ?? 0), 0);
}

function ActionButton(props: { onClick: () => void; disabled?: boolean; children: ReactNode }): ReactNode {
  return (
    <button type="button" className="text-btn action-btn" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

/**
 * 组件：选中主组件时显示有几个实例、放一个实例；选中实例时可以跳到主组件、重置、分离；
 * 选中实例里的对象时说明能改什么，可以只重置它；其余能做成组件的选区显示"创建组件"
 */
export function ComponentPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const { store } = editor;
  const only = nodes.length === 1 ? nodes[0]! : null;

  if (only && isComponent(only)) {
    const count = instancesOf(store, only.id).length;
    return (
      <div className="component-info">
        <p className="component-kind">
          <Component size={14} />
          {t('component.main')}
          <span className="field-note">{t('component.instances', { count })}</span>
        </p>
        <div className="action-row">
          <ActionButton onClick={() => editor.commands.run('component.place', { componentId: only.id })}>
            {t('component.place')}
          </ActionButton>
        </div>
      </div>
    );
  }

  if (only && isInstance(only) && !isInstanceCopy(only)) {
    const main = mainOf(editor, only);
    const changed = overrideCount(editor, only);
    return (
      <div className="component-info">
        <p className="component-kind">
          <Diamond size={14} />
          {main ? t('component.instanceOf', { name: displayName(main, t) }) : t('component.missing')}
        </p>
        {changed > 0 && <p className="menu-hint">{t('component.overrides', { count: changed })}</p>}
        <div className="action-row">
          <ActionButton disabled={!main} onClick={() => editor.commands.run('component.goToMain')}>
            <Crosshair size={13} />
            {t('component.goToMain')}
          </ActionButton>
          <ActionButton disabled={changed === 0} onClick={() => editor.commands.run('component.reset')}>
            <RotateCcw size={13} />
            {t('component.reset')}
          </ActionButton>
          <ActionButton onClick={() => editor.commands.run('component.detach')}>
            <Unlink size={13} />
            {t('component.detach')}
          </ActionButton>
        </div>
      </div>
    );
  }

  if (only && isInstanceCopy(only)) {
    const outer = outerInstanceOf(store, only.id);
    const changed = overrideCount(editor, only);
    const source = only.source ? store.get(only.source) : undefined;
    return (
      <div className="component-info">
        <p className="menu-hint">{t('component.copyHint', { name: outer ? displayName(outer, t, store) : '' })}</p>
        {changed > 0 && <p className="menu-hint">{t('component.overrides', { count: changed })}</p>}
        <div className="action-row">
          <ActionButton disabled={!source} onClick={() => source && editor.reveal(source.id)}>
            <Crosshair size={13} />
            {t('component.findInMain')}
          </ActionButton>
          <ActionButton disabled={changed === 0} onClick={() => editor.commands.run('component.reset')}>
            <RotateCcw size={13} />
            {t('component.resetItem')}
          </ActionButton>
        </div>
      </div>
    );
  }

  return (
    <div className="action-row">
      <ActionButton
        disabled={!editor.commands.canRun('component.create')}
        onClick={() => editor.commands.run('component.create')}
      >
        <Component size={13} />
        {t('component.create')}
      </ActionButton>
    </div>
  );
}
