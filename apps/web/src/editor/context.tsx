import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { SceneNode } from '@shiba/core';
import type { Editor, EditorState } from '@shiba/editor';

const EditorContext = createContext<Editor | null>(null);

export const EditorProvider = EditorContext.Provider;

/** 有编辑器时返回它，没有时返回 null（通用控件在编辑器外面也能用） */
export function useEditorMaybe(): Editor | null {
  return useContext(EditorContext);
}

export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error('useEditor 必须在 EditorProvider 内使用');
  return editor;
}

/**
 * 订阅编辑器状态里的一个字段。
 * selector 必须返回原始值或状态里已有的对象，不要在里面新建对象，否则会无限重渲染。
 */
export function useEditorState<T>(selector: (state: EditorState) => T): T {
  const editor = useEditor();
  return useSyncExternalStore(editor.subscribe, () => selector(editor.getState()));
}

/** 当前选中的节点；文档或选区变化时更新 */
export function useSelectedNodes(): SceneNode[] {
  const editor = useEditor();
  const selection = useEditorState((s) => s.selection);
  const version = useEditorState((s) => s.docVersion);
  const resourceEpoch = useEditorState((s) => s.resourceEpoch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => editor.selectedNodes(), [editor, selection, version, resourceEpoch]);
}
