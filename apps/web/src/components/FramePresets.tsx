import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, useEditorState } from '../editor/context';
import { BLANK_PRESETS } from '../templates/presets';

/**
 * 画框工具（F）选中、没选东西时属性栏里列出的预设尺寸：界面的几种屏幕在前，演示、印刷、社交的在后。
 * 点一下放一个这么大的画框（幻灯片视图里放在这一页中间）或画板（画布视图里放在最右边）
 */
export function FramePresets(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const viewMode = useEditorState((s) => s.viewMode);
  const presets = [...BLANK_PRESETS.filter((p) => p.group === 'ui'), ...BLANK_PRESETS.filter((p) => !p.group)];
  return (
    <div className="frame-presets">
      <p className="panel-hint">{t(viewMode === 'slides' ? 'framePresets.hintFrame' : 'framePresets.hintBoard')}</p>
      {presets.map((preset) => {
        const name = t(`template.preset.${preset.id}`);
        return (
          <button
            key={preset.id}
            type="button"
            className="frame-preset"
            onClick={() => editor.commands.run('frame.place', { size: preset.size, name })}
          >
            <span>{name}</span>
            <span className="frame-preset-size">
              {preset.size[0]} × {preset.size[1]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
