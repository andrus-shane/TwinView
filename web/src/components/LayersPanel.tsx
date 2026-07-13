import type { GroupDisplay } from '@twinview/shared';
import { useStore } from '../state/store';

const NEXT: Record<GroupDisplay, GroupDisplay> = { solid: 'xray', xray: 'hidden', hidden: 'solid' };
const ICON: Record<GroupDisplay, string> = { solid: '●', xray: '◐', hidden: '○' };
const TITLE: Record<GroupDisplay, string> = {
  solid: 'Solid — click for x-ray',
  xray: 'X-ray — click to hide',
  hidden: 'Hidden — click to show',
};

/** Visibility layers: each group cycles solid → x-ray → hidden. */
export function LayersPanel() {
  const groups = useStore((s) => s.rig.groups);
  const { setGroupDisplay, setAllGroups } = useStore.getState();

  if (!groups?.length) return null;

  return (
    <div className="layers-panel">
      <div className="card-title sub row-between">
        <span>Layers</span>
        <span className="layer-presets">
          <button className="btn tiny" title="Everything solid" onClick={() => void setAllGroups('solid')}>
            Full
          </button>
          <button
            className="btn tiny"
            title="Plastics & console go x-ray to reveal the drivetrain and electronics"
            onClick={() => void setAllGroups('xray', ['Drivetrain', 'Frame & structure'])}
          >
            Strip
          </button>
        </span>
      </div>
      {groups.map((g) => (
        <div key={g.name} className={`layer-row display-${g.display}`}>
          <button
            className="layer-toggle"
            title={TITLE[g.display]}
            onClick={() => void setGroupDisplay(g.name, NEXT[g.display])}
          >
            {ICON[g.display]}
          </button>
          <span className="part-name">{g.name}</span>
          <span className="part-meta">{g.parts.length}</span>
        </div>
      ))}
    </div>
  );
}
