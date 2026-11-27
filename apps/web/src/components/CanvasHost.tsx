import { useEffect, useRef, type DragEvent, type ReactNode } from 'react';
import { useEditor } from '../editor/context';
import { isImageFile, isShibaFile, openDroppedDocument, placeImageFiles } from '../files';

/** 编辑器画布的容器。编辑器自己在里面创建和管理 canvas 元素 */
export function CanvasHost(): ReactNode {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    editor.mount(ref.current);
    return () => editor.unmount();
  }, [editor]);

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  /** 拖进来的图片放在松手的位置；拖进来的 .shiba 文件直接打开 */
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    const document = files.find(isShibaFile);
    if (document) {
      void openDroppedDocument(editor, document);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    const at = editor.screenToWorld(event.clientX - box.left, event.clientY - box.top);
    void placeImageFiles(editor, files.filter(isImageFile), at);
  };

  return <div className="canvas-host" ref={ref} onDragOver={onDragOver} onDrop={onDrop} />;
}
