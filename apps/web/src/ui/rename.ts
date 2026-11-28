import type { NodeId } from '@shiba/core';

/**
 * "重命名"的请求：命令和菜单发出，图层面板收到后让那一行进入改名状态（左栏在资源页时先切到图层页）
 */
type Listener = (id: NodeId) => void;
const listeners = new Set<Listener>();

export function requestRename(id: NodeId): void {
  for (const listener of [...listeners]) listener(id);
}

export function onRenameRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
